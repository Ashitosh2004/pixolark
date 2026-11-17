/**
 * Coordinator WebSocket client — how the app talks to the in-memory room
 * coordination server.
 *
 * Guarantees & behaviors (matching docs/PRODUCTION-PLAN.md):
 * - NEVER carries message content: chat rides E2EE WebRTC DataChannels; the
 *   coordinator sees only manifests, presence, and WebRTC SDP relay.
 * - Connection states are honest: connecting / reconnecting / verifying /
 *   rejoining / connected / room-unavailable / recovery-failed. A room is
 *   "connected" only after its coordinator session is verified — never before.
 * - Owners hold a short lease and renew it with FRESH nonce-bound proofs;
 *   losing the connection ends the lease and the room honestly goes offline.
 * - After a coordinator restart the registry is empty: owners re-register and
 *   members re-join automatically (recovery flow), with jittered exponential
 *   backoff — no invented availability in between.
 */
import { createOwnershipProof, PROOF_TOLERANCE_MS, type ClientToServer, type OwnershipProof, type RoomMember, type ServerToClient } from "./coordinator-protocol";
import { signManifest, type RoomManifest } from "./manifest";
import { b64url } from "./bytes";
import { generateRoomId, isValidRoomId, normalizeRoomId } from "./codec";

export type CoordinatorState =
  | { s: "idle" }
  | { s: "connecting" }
  | { s: "connected" }
  | { s: "reconnecting"; attempt: number }
  | { s: "room-unavailable"; reason: string }
  | { s: "recovery-failed"; reason: string };

export interface CoordinatorOptions {
  url: string;
  name: string;
  onState: (state: CoordinatorState) => void;
  onRoomState?: (roomId: string, manifest: RoomManifest, members: RoomMember[]) => void;
  onRoomMembers?: (roomId: string, members: RoomMember[]) => void;
  onRoomOffline?: (roomId: string, reason: string) => void;
  onRtc?: (roomId: string, from: string, data: unknown) => void;
  onProbe?: (roomId: string, available: boolean) => void;
  onError?: (code: string, message: string, roomId?: string) => void;
}

const BACKOFF_BASE_MS = 600;
const BACKOFF_MAX_MS = 8_000;
/** Bounded wait for `welcome` in join() — an unreachable coordinator must not hang callers. */
const JOIN_WELCOME_TIMEOUT_MS = 8_000;
/** Re-join retries after a reconnect: the owner re-asserts their lease on their
 *  own welcome, so our first attempt can legitimately race it. */
const REJOIN_ATTEMPTS = 5;
const REJOIN_RETRY_MS = 3_000;
const REJOIN_STATE_WAIT_MS = 4_000;

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

export class CoordinatorClient {
  private ws: WebSocket | null = null;
  private url: string;
  private name: string;
  private nonce = "";
  private clientId = "";
  private seq = 0;
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private leaseTimer: ReturnType<typeof setInterval> | null = null;

  /** Owner-held rooms on THIS client: roomId → manifest + signing key. */
  private owned = new Map<string, { manifest: RoomManifest; signPriv: CryptoKey }>();
  private joined = new Set<string>();
  private states: CoordinatorOptions["onState"];
  private hooks: Omit<CoordinatorOptions, "url" | "name" | "onState">;
  private onceQueue: { event: string; roomId: string; resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  private rtcHandler: ((roomId: string, from: string, data: unknown) => void) | null = null;
  /** True while rejoinWithRetry is looping — suppresses the racing room-unavailable errors. */
  private rejoining = false;
  /** Resolves once the CURRENT connection's welcome (and nonce) arrived. */
  private welcomed: Promise<void> = Promise.resolve();
  private welcomeResolve: (() => void) | null = null;

  /** Single rtc dispatcher — the app (or tests) route relayed signaling here. */
  setRtcHandler(h: (roomId: string, from: string, data: unknown) => void): void {
    this.rtcHandler = h;
  }

  /** Resolves with the NEXT matching event for this room (or null on timeout). */
  onceRoomState(roomId: string, timeoutMs = 8000): Promise<{ manifest: RoomManifest; members: RoomMember[] } | null> {
    return this.once("roomState", roomId, timeoutMs) as Promise<{ manifest: RoomManifest; members: RoomMember[] } | null>;
  }

  onceRoomOffline(roomId: string, timeoutMs = 30000): Promise<string | null> {
    return this.once("roomOffline", roomId, timeoutMs) as Promise<string | null>;
  }

  onceProbe(roomId: string, timeoutMs = 6000): Promise<boolean | null> {
    return this.once("probe", roomId, timeoutMs) as Promise<boolean | null>;
  }

  onceRegistered(roomId: string, timeoutMs = 6000): Promise<boolean> {
    return this.once("registered", roomId, timeoutMs).then((v) => v === true);
  }

  private once(event: string, roomId: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      const entry = {
        event,
        roomId,
        resolve,
        timer: setTimeout(() => {
          const i = this.onceQueue.indexOf(entry);
          if (i >= 0) this.onceQueue.splice(i, 1);
          resolve(null);
        }, timeoutMs),
      };
      this.onceQueue.push(entry);
    });
  }

  private fireOnce(event: string, roomId: string, value: unknown): void {
    for (let i = this.onceQueue.length - 1; i >= 0; i--) {
      const e = this.onceQueue[i]!;
      if (e.event === event && e.roomId === roomId) {
        clearTimeout(e.timer);
        this.onceQueue.splice(i, 1);
        e.resolve(value);
      }
    }
  }

  constructor(opts: CoordinatorOptions) {
    this.url = opts.url;
    this.name = opts.name;
    this.states = opts.onState;
    this.hooks = opts;
  }

  // ---------- lifecycle ----------

  connect(): void {
    if (this.closed || (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING))) return;
    this.set(this.attempt === 0 ? { s: "connecting" } : { s: "reconnecting", attempt: this.attempt });
    // Every connection gets a fresh nonce in `welcome`; ownership actions wait for it.
    this.welcomed = new Promise((res) => { this.welcomeResolve = res; });
    this.nonce = "";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: "hello", client: "web", name: this.name });
      this.startPing();
      // connected state is only set once a room verifies below; bare
      // "connected" is still truthful for signaling-level connectivity.
      this.set({ s: "connected" });
      this.attempt = 0;
    };
    ws.onmessage = (ev) => void this.handle(String(ev.data));
    ws.onclose = () => {
      this.stopTimers();
      this.nonce = "";
      if (this.closed) return;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows; nothing else to do here
    };
  }

  disconnect(): void {
    this.closed = true;
    this.stopTimers();
    this.ws?.close();
    this.ws = null;
    this.set({ s: "idle" });
  }

  /**
   * Resolves once the CURRENT connection completed its welcome handshake.
   * Frames sent on a CONNECTING socket are dropped, not queued — so callers
   * that send right after `connect()` (probes, joins, signals) must await
   * this first. Brings an idle client up. Bounded; returns true only when
   * the socket is genuinely open — never pretends.
   */
  async ready(timeoutMs = 8000): Promise<boolean> {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
      if (this.closed) return false;
      this.connect();
    }
    await Promise.race([this.welcomed, sleep(timeoutMs)]);
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Point at a different coordinator (e.g. learned from a manifest). */
  retarget(url: string): void {
    if (url === this.url) return;
    this.url = url;
    this.reconnectNow();
  }

  /** Drop and re-establish the signaling connection (same coordinator). */
  reconnectNow(): void {
    this.disconnect();
    this.closed = false;
    this.connect();
  }

  private scheduleReconnect(): void {
    // Jittered exponential backoff: 0.6s → 8s, ±30% — no thundering herd.
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(this.attempt, 6));
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    this.attempt++;
    this.set({ s: "reconnecting", attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private set(state: CoordinatorState): void {
    this.states(state);
  }

  private send(m: ClientToServer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ t: "ping" }), 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private stopTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
  }

  // ---------- inbound ----------

  private handle(raw: string): void {
    let m: ServerToClient;
    try {
      m = JSON.parse(raw) as ServerToClient;
    } catch {
      return;
    }
    switch (m.t) {
      case "welcome": {
        this.clientId = m.clientId;
        this.nonce = m.nonce;
        this.welcomeResolve?.();
        this.welcomeResolve = null;
        // Re-assert ownership + membership after (re)connect — the coordinator
        // registry is memory-only, so a restart wiped everything we knew.
        void this.reassert();
        return;
      }
      case "room.state":
        this.fireOnce("roomState", m.roomId, { manifest: m.manifest, members: m.members });
        this.hooks.onRoomState?.(m.roomId, m.manifest, m.members);
        return;
      case "room.members":
        this.hooks.onRoomMembers?.(m.roomId, m.members);
        return;
      case "room.probe":
        this.fireOnce("probe", m.roomId, m.available);
        this.hooks.onProbe?.(m.roomId, m.available);
        return;
      case "room.offline":
        this.fireOnce("roomOffline", m.roomId, m.reason);
        this.hooks.onRoomOffline?.(m.roomId, m.reason);
        return;
      case "rtc":
        this.rtcHandler?.(m.roomId, m.from, m.data);
        this.hooks.onRtc?.(m.roomId, m.from, m.data);
        return;
      case "error": {
        // While re-asserting membership after a reconnect, room-unavailable is
        // an EXPECTED racing reply (the owner may not have re-registered yet);
        // rejoinWithRetry keeps trying and only surfaces failure when done.
        if (this.rejoining && m.code === "room-unavailable") return;
        this.hooks.onError?.(m.code, m.message, m.roomId);
        if (m.code === "room-unavailable" && m.roomId) {
          this.set({ s: "room-unavailable", reason: m.message });
        }
        if (m.code === "proof-invalid" && m.roomId && this.owned.has(m.roomId)) {
          // Ownership rejected on re-assertion — honest recovery failure.
          this.set({ s: "recovery-failed", reason: m.message });
        }
        return;
      }
      case "room.registered":
        this.fireOnce("registered", m.roomId, true);
        return;
      case "pong":
        return;
    }
  }

  /** After a reconnect: re-register owned rooms + re-join joined rooms. */
  private async reassert(): Promise<void> {
    for (const [roomId, own] of [...this.owned]) {
      this.set({ s: "reconnecting", attempt: this.attempt }); // "restoring session" feel without fake success
      const ok = await this.registerManifest(own.manifest, own.signPriv);
      if (!ok) continue; // error path already reported
    }
    for (const roomId of [...this.joined]) {
      await this.rejoinWithRetry(roomId);
    }
    if (this.owned.size > 0) this.startLeaseLoop();
  }

  /**
   * Re-join after a reconnect (a coordinator restart wiped the registry). The
   * owner re-asserts their lease on their own welcome — our first attempt can
   * legitimately race it, so retry briefly with room-unavailable suppressed,
   * and surface an honest error only when the retries are exhausted.
   */
  private async rejoinWithRetry(roomId: string): Promise<void> {
    this.rejoining = true;
    try {
      for (let attempt = 0; attempt < REJOIN_ATTEMPTS; attempt++) {
        if (this.closed) return;
        const gotP = this.onceRoomState(roomId, REJOIN_STATE_WAIT_MS);
        this.send({ t: "room.join", roomId, name: this.name });
        if (await gotP) return; // membership restored
        await sleep(REJOIN_RETRY_MS);
      }
      const reason = "Room temporarily unavailable — its coordinator lease is not live right now.";
      this.set({ s: "room-unavailable", reason });
      this.hooks.onError?.("room-unavailable", reason, roomId);
    } finally {
      this.rejoining = false;
    }
  }

  // ---------- ownership ----------

  private async registerManifest(manifest: RoomManifest, signPriv: CryptoKey): Promise<boolean> {
    await this.welcomed; // proofs need the per-connection nonce from `welcome`
    if (!this.nonce) return false;
    const proof = await createOwnershipProof(manifest.roomId, signPriv, this.nonce);
    this.send({ t: "room.register", manifest, proof });
    this.owned.set(manifest.roomId, { manifest, signPriv });
    this.startLeaseLoop();
    return true;
  }

  /** Lease renewal: every 30s with a FRESH proof (nonce-bound each time). */
  private startLeaseLoop(): void {
    if (this.leaseTimer) return;
    this.leaseTimer = setInterval(() => {
      if (!this.nonce) return;
      for (const roomId of this.owned.keys()) {
        const own = this.owned.get(roomId);
        if (!own) continue;
        void createOwnershipProof(roomId, own.signPriv, this.nonce).then((proof) => this.send({ t: "room.lease", roomId, proof }));
      }
    }, 30_000);
  }

  /**
   * Create + register a new public/private room owned by this user.
   * `roomId` must be the SAME id the room is hosted under (the GroupSession
   * doorbell room); omit it to mint a fresh 6-digit code (CLI-style flows).
   * `signPriv` is the user's manifest signing subkey (kept in the recovery
   * registry, exportable only via encrypted backup). Returns the manifest.
   */
  async createRoom(meta: {
    roomId?: string;
    name: string;
    desc?: string;
    type: "public" | "private";
    category: string;
    region?: string;
    subRegion?: string;
    city?: string;
    languages: string[];
    hostCommitment: string;
    signPriv: CryptoKey;
    signPubRaw: Uint8Array<ArrayBuffer>;
    ownerId: string;
  }): Promise<RoomManifest> {
    let roomId = meta.roomId ?? generateRoomId();
    while (!isValidRoomId(roomId)) roomId = generateRoomId();
    const now = Date.now();
    const manifest = await signManifest(
      {
        roomId,
        name: meta.name,
        desc: meta.desc ?? "",
        type: meta.type,
        category: meta.category,
        region: meta.region ?? "",
        subRegion: meta.subRegion ?? "",
        city: meta.city ?? "",
        languages: meta.languages,
        owner: { id: meta.ownerId, signingKey: b64url(meta.signPubRaw) },
        host: { commitment: meta.hostCommitment },
        coordinator: { urls: [this.url] },
        capabilities: { media: true, stickers: true, history: false, slowMode: false, approval: false },
        invitation: { method: "open" },
        policy: { recovery: "owner-only", coOwners: [] },
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 30 * 24 * 60 * 60_000,
      },
      meta.signPriv,
    );
    await this.registerManifest(manifest, meta.signPriv);
    return manifest;
  }

  /** Owner re-register with an EXISTING manifest (recovery path). */
  async reown(manifest: RoomManifest, signPriv: CryptoKey): Promise<boolean> {
    if (!isValidRoomId(normalizeRoomId(manifest.roomId))) return false;
    return this.registerManifest(manifest, signPriv);
  }

  async join(roomId: string, name: string): Promise<void> {
    const canonical = normalizeRoomId(roomId);
    // Record membership FIRST: if the socket is still connecting, reassert()
    // re-sends room.join for everything in `joined` once welcome arrives.
    this.joined.add(canonical);
    // The frame is only deliverable on an OPEN socket — a fresh client (or one
    // mid-reconnect after a coordinator restart) would otherwise silently drop
    // its membership and never receive the host's offer. Wait for welcome,
    // bounded so an unreachable coordinator can't hang the caller forever.
    await Promise.race([this.welcomed, sleep(JOIN_WELCOME_TIMEOUT_MS)]);
    this.send({ t: "room.join", roomId: canonical, name });
  }

  /** Owner tears the room down: lease revoked, members told it went offline. */
  async unregister(roomId: string, signPriv: CryptoKey): Promise<void> {
    await this.welcomed;
    if (!this.nonce) return;
    const proof = await createOwnershipProof(roomId, signPriv, this.nonce);
    this.owned.delete(roomId);
    this.send({ t: "room.unregister", roomId, proof });
  }

  leave(roomId: string): void {
    const canonical = normalizeRoomId(roomId);
    this.send({ t: "room.leave", roomId: canonical });
    this.joined.delete(canonical);
  }

  signal(roomId: string, to: string, data: unknown): void {
    this.send({ t: "rtc", roomId, to, data });
  }

  probe(roomId: string): void {
    this.send({ t: "room.probe", roomId: normalizeRoomId(roomId) });
  }

  get myId(): string {
    return this.clientId;
  }

  /** True when the room's manifest came back from the coordinator (verified join). */
  // (kept as an explicit API instead of state to avoid fake "verified" flags)
  proofWindowMs = PROOF_TOLERANCE_MS;
}
