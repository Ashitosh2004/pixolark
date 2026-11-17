/**
 * Coordinator-room signaling — the bridge between the in-memory coordinator
 * and WebRTC. The coordinator NEVER sees message content; it only relays
 * WebRTC offer/answer codes (public data: SDP + identity commitments, exactly
 * the class of data ntfy topics carried before).
 *
 * Flow (glare-free, joiner-initiated):
 *   member joins coordinator room → sends {kind:"want"} to the owner
 *   owner replies with its current doorbell offer {kind:"offer", code}
 *   member answers via PeerSession.join + {kind:"answer", code} to the owner
 *   owner acceptAnswer() → secure → the group adopts the session
 *
 * Honesty rules:
 * - A room is connectable ONLY while the owner's lease is live; when it dies,
 *   members get room.offline and the UI shows "Room temporarily unavailable".
 * - Concurrent joiners share one doorbell offer; the PeerSession sid guard
 *   rejects superseded answers and the member simply re-asks (retry loop).
 */
import { PeerSession } from "./session";
import type { Identity } from "./crypto";
import type { CoordinatorClient } from "./coordinator";
import type { RoomMember } from "./coordinator-protocol";

export interface RtcKinds {
  kind: "want" | "offer" | "answer" | "stale";
  code?: string;
}

export function isRtcData(d: unknown): d is RtcKinds {
  return !!d && typeof d === "object" && typeof (d as RtcKinds).kind === "string";
}

// ---------------------------------------------------------------- owner side

/**
 * Owner-side reception: hands out doorbell offers over coordinator rtc and
 * feeds answers into the current doorbell. Adopted sessions are surfaced via
 * `onConnected` so GroupSession can take them over exactly like its ntfy
 * doorbell did.
 */
export class CoordinatorReception {
  private db: PeerSession | null = null;
  private opening: Promise<PeerSession> | null = null;
  private stopped = false;
  private lastWant = new Map<string, number>();

  constructor(
    private client: CoordinatorClient,
    private roomId: string,
    private identity: Identity,
    private onConnected: (s: PeerSession) => void,
    private onError: (message: string) => void,
    /** Test seam: how a doorbell session is created (defaults to a real PeerSession host). */
    private doorbellFactory: () => Promise<PeerSession> = () => PeerSession.host(this.roomId, this.identity),
  ) {}

  stop(): void {
    this.stopped = true;
    this.db?.close(false);
    this.db = null;
    this.opening = null;
  }

  /** Pre-open a doorbell so the first `want` gets an immediate offer. */
  ensureDoorbell(): Promise<PeerSession> {
    if (this.stopped) return Promise.reject(new Error("reception stopped"));
    if (this.db && this.db.state === "waiting" && this.db.localCode) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    this.opening = this.doorbellFactory()
      .then((db) => {
        if (this.stopped) { db.close(false); throw new Error("reception stopped"); }
        this.db = db;
        this.opening = null;
        return db;
      })
      .catch((e: unknown) => {
        this.opening = null;
        this.onError?.(`Could not open the room reception: ${e instanceof Error ? e.message : e}`);
        throw e;
      });
    return this.opening;
  }

  /** Owner's rtc handler — call this from the app's rtc dispatch for this room. */
  async handleRtc(from: string, data: unknown): Promise<void> {
    if (this.stopped || !isRtcData(data)) return;
    if (data.kind === "want") {
      // Debounce re-asks (the member's want loop fires every 3s; a stale-
      // answer recovery may re-ask sooner — 1.5s keeps that responsive
      // while still blocking genuine spam).
      const now = Date.now();
      if (now - (this.lastWant.get(from) ?? 0) < 1500) return;
      this.lastWant.set(from, now);
      try {
        const db = await this.ensureDoorbell();
        if (!db.localCode) return;
        this.client.signal(this.roomId, from, { kind: "offer", code: db.localCode });
      } catch {
        // ensureDoorbell already reported; the member will re-ask.
      }
      return;
    }
    if (data.kind === "answer") {
      if (!data.code) return;
      const db = this.db;
      if (!db || db.state !== "waiting") {
        // Stale answer — its doorbell was superseded (another joiner won the
        // race). Tell the member honestly so it re-asks instead of waiting
        // for a connection that will never complete.
        this.client.signal(this.roomId, from, { kind: "stale" });
        return;
      }
      try {
        await db.acceptAnswer(data.code);
        // acceptAnswer transitions the session; read the LIVE state (a plain
        // property compare would be narrowed away by TS after the guard above).
        if (db.isSecure) {
          this.db = null;
          this.onConnected(db);
          void this.ensureDoorbell().catch(() => {}); // ready for the next member
        }
      } catch {
        // sid mismatch / duplicate — same honest reply: re-ask.
        this.client.signal(this.roomId, from, { kind: "stale" });
      }
    }
  }
}

// --------------------------------------------------------------- member side

export interface MemberLinkHooks {
  /** Verified offer from the room owner — feed it to GroupSession.joinAsMember. */
  onOffer: (code: string) => void;
  /** The owner's lease died — room is honestly unavailable until re-registered. */
  onRoomOffline: (reason: string) => void;
  onError: (message: string) => void;
}

/**
 * Member-side link: joins the coordinator room, finds the owner connection,
 * asks for the offer, and ships our answer back over the rtc relay.
 */
export class CoordinatorMemberLink {
  private ownerId: string | null = null;
  private wantTimer: ReturnType<typeof setInterval> | null = null;
  private wantCount = 0;
  private stopped = false;
  private answered = false;

  constructor(
    private client: CoordinatorClient,
    private roomId: string,
    private name: string,
    private hooks: MemberLinkHooks,
  ) {}

  stop(): void {
    this.stopped = true;
    this.clearWant();
  }

  /** Join the coordinator room and start asking the owner for an offer. */
  async connect(): Promise<{ members: RoomMember[] } | null> {
    this.stopped = false;
    this.answered = false;
    const gotP = this.client.onceRoomState(this.roomId, 15_000); // > join()'s bounded welcome wait
    void this.client.join(this.roomId, this.name).catch(() => {});
    const got = await gotP;
    if (this.stopped) return null;
    if (!got) {
      this.hooks.onError?.("Room temporarily unavailable — its coordinator lease is not live right now.");
      return null;
    }
    this.ownerId = got.members.find((m) => m.owner)?.id ?? null;
    if (!this.ownerId) {
      this.hooks.onError?.("The room's owner is not connected right now.");
      return { members: got.members };
    }
    this.startWantLoop();
    return { members: got.members };
  }

  /** Member's rtc handler — call from the app's rtc dispatch for this room. */
  handleRtc(from: string, data: unknown): void {
    if (this.stopped || !isRtcData(data)) return;
    if (data.kind === "stale" && from === this.ownerId) {
      // Our answer was refused (superseded doorbell) — ask for a fresh offer.
      this.answered = false;
      this.startWantLoop();
      return;
    }
    if (data.kind === "offer" && data.code && from === this.ownerId) {
      this.clearWant();
      this.hooks.onOffer(data.code);
    }
  }

  /** Ship our answer code back to the owner (call when the session is "waiting"). */
  publishAnswer(code: string): void {
    if (this.stopped || this.answered || !this.ownerId) return;
    this.answered = true;
    this.client.signal(this.roomId, this.ownerId, { kind: "answer", code });
  }

  /** Owner changed (re-host): find the new owner and ask again. */
  adoptMembers(members: RoomMember[]): void {
    const owner = members.find((m) => m.owner);
    if (owner && owner.id !== this.ownerId) {
      this.ownerId = owner.id;
      this.answered = false;
      this.startWantLoop();
    }
  }

  private startWantLoop(): void {
    this.clearWant();
    this.wantCount = 0;
    this.wantTimer = setInterval(() => {
      if (this.stopped || !this.ownerId) return;
      if (this.answered) return;
      this.wantCount++;
      if (this.wantCount > 20) {
        this.clearWant();
        this.hooks.onError?.("The room's owner did not respond. The room may be unavailable — try again later.");
        return;
      }
      this.client.signal(this.roomId, this.ownerId, { kind: "want" });
    }, 3000);
    // First ask immediately.
    if (this.ownerId) this.client.signal(this.roomId, this.ownerId, { kind: "want" });
  }

  private clearWant(): void {
    if (this.wantTimer) clearInterval(this.wantTimer);
    this.wantTimer = null;
  }
}
