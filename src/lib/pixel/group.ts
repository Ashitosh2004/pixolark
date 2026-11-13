/**
 * GroupSession - encrypted group chat over a star of existing 1:1 PeerSessions.
 *
 * Topology: the HOST is coordinator, relay and moderator. Every member keeps ONE 1:1
 * PeerSession to the host (same handshake, invite codes, signaling and AES-GCM channels
 * as private chats - nothing about the 1:1 implementation changes).
 *
 * Frames over each pairwise channel (all channel-encrypted as today):
 * - ctrl: {t:"g-snap"}, {t:"g-key"}, {t:"g-msg"}, {t:"g-read"}, {t:"g-pres"},
 *         {t:"g-note"}, {t:"g-req"}, {t:"g-hist"}, {t:"profile"}
 * - content: sender-key-sealed GroupWire carrying the same envelope shapes as 1:1
 *   ({t:"msg"}, {t:"file-start"|"file-chunk"|"file-end"|"file-cancel"}, plus group
 *   extensions {t:"g-react"|"g-edit"|"g-del"}), so rendering/file/sticker logic is reused.
 *   g-msg frames carry a coarse class claim ("msg" | "chunk") OUTSIDE the seal so the
 *   host can rate-limit without decrypting; the per-class budget still applies to
 *   whatever is inside, so a sender cannot buy unlimited relay by mislabeling.
 *
 * Enforcement is real, not UI-only: ALL member traffic relays through the host, which
 * applies roles, mute/ban lists, slow mode and rate limits before forwarding, and group
 * keys are only distributed to current roster members (removed members can't read future
 * messages). Permission checks use the connection's verified identity, not claimed names.
 *
 * Membership identity: members present a stable, NON-EXTRACTABLE pseudonymous ECDH key
 * stored per-group in IndexedDB (idb.ts). It cannot decrypt anything by itself - it only
 * proves "this device returned", keeping roles/roster stable across reconnects. All
 * message/channel keys remain memory-only.
 */
import { b64url, fromB64url } from "./bytes";
import { createIdentity, type Identity } from "./crypto";
import { memberIdOf, newSenderChain, openFromMember, openGroupMessage, peerChainFromDistribute, sealGroupMessage, sealToMember, type GroupWire, type PeerChain, type SenderChain } from "./groupcrypto";
import { loadGroupIdentity, createGroupIdentity, type GroupIdentity } from "./idb";
import { publishSignal, subscribeSignal, ROOM_CLOSED } from "./signaling";
import { publishBeacon, beaconOf, BEACON_INTERVAL_MS, type RoomBeacon } from "./discovery";
import type { Avatar } from "./pixelart";
import { PeerSession } from "./session";

// ---------- types ----------

export type GroupRole = "owner" | "admin" | "mod" | "member";
export const ROLE_RANK: Record<GroupRole, number> = { owner: 3, admin: 2, mod: 1, member: 0 };

/** Minimum role for each host-side action; enforced on every path (direct UI or member relay). */
const ACTION_RANK: Record<string, GroupRole> = {
  approve: "admin", reject: "admin", role: "admin", rules: "admin", meta: "admin",
  kick: "mod", ban: "mod", mute: "mod", unmute: "mod", pin: "mod",
};

export interface RosterEntry {
  id: string;
  pub: string; // b64url identity public key
  name: string;
  avatar: Avatar;
  status: string;
  role: GroupRole;
  joinedAt: number;
  pending?: boolean | undefined; // awaiting owner/admin approval (private groups)
}

export interface GroupMeta {
  room: string;
  name: string;
  desc: string;
  cat: string;
  region: string;
  lang: string;
  rules: string;
  cap: number;
  isPublic: boolean;
  approval: boolean; // private groups: join requests must be approved
  historyShare: boolean; // members share their recent local history with approved newcomers
  createdAt: number;
}

export interface GroupRules { slowModeSec: number; msgsPer10s: number }
export interface PinnedEntry { id: string; by: string; ts: number }

export interface GroupSnapshot {
  meta: GroupMeta;
  roster: RosterEntry[];
  epoch: number;
  pinned: PinnedEntry[];
  rules: GroupRules;
  bans: string[];
  muted: Record<string, number>; // memberId -> muted-until ts
}

export interface PresenceState { online: boolean; typing: boolean; viewing: boolean; away: boolean }

export type GroupPhase = "joining" | "awaiting" | "ready" | "reconnecting" | "closed" | "failed";

export type GroupMsgKind = "text" | "sticker" | "file" | "voice" | "gif" | "system";

/** ChatMessage-shaped group message (the UI hook maps it 1:1) with sender attribution. */
export interface GroupMessage {
  id: string;
  from: "me" | "peer" | "system";
  senderId: string;
  senderName?: string | undefined;
  kind: GroupMsgKind;
  text?: string | undefined;
  sticker?: string | undefined;
  stickerUrl?: string | undefined;
  stickerLib?: string | undefined; // sender's declared sticker-library version
  file?: { name: string; size: number; mime: string; url?: string | undefined; progress?: number; status?: "sending" | "receiving" | "done" | "cancelled" | "failed" } | undefined;
  ts: number;
  status?: "sending" | "sent" | "read" | "failed" | undefined;
  replyTo?: { id: string; author: string; preview: string } | undefined;
  reactions: Record<string, ("me" | "peer")[]>;
  forwarded?: boolean | undefined;
  recovered?: boolean | undefined;
  edited?: boolean | undefined;
  deleted?: boolean | undefined;
}

export interface AuditEntry { ts: number; actor: string; action: string; target: string }

export interface HistoryItem {
  id: string;
  senderId: string;
  senderName?: string | undefined;
  kind: GroupMsgKind;
  ts: number;
  text?: string | undefined;
  sticker?: string | undefined;
  stickerUrl?: string | undefined;
}

export interface GroupEvents {
  phase: GroupPhase;
  snapshot: GroupSnapshot;
  message: GroupMessage;
  presence: Record<string, PresenceState>;
  notice: { kind: string; text: string };
  audit: AuditEntry[];
  /** Read receipts: member `by` has read our messages `ids` (own sends only). */
  read: { by: string; ids: string[] };
}

export const GROUP_MAX_FILE_BYTES = 25 * 1024 * 1024;
const RECONNECT_GRACE_MS = 90_000;
const PRESENCE_INTERVAL_MS = 30_000;
/** File-chunk budget per member per 10 s window, in 64 KiB chunks (= 8 MB). */
const CHUNK_BUDGET_PER_10S = 128;

type Listener = (v: any) => void;

class Emitter<E extends object> {
  private l: { [K in keyof E]?: Set<Listener> } = {};
  on<K extends keyof E>(ev: K, fn: (v: E[K]) => void): () => void {
    let set = this.l[ev];
    if (!set) { set = new Set(); this.l[ev] = set; }
    set.add(fn as Listener);
    return () => { set.delete(fn as Listener); };
  }
  emit<K extends keyof E>(ev: K, v: E[K]) {
    this.l[ev]?.forEach((fn) => fn(v));
  }
}

function emptyMeta(room: string): GroupMeta {
  return { room, name: "New group", desc: "", cat: "General Chat", region: "", lang: "English", rules: "", cap: 12, isPublic: false, approval: false, historyShare: false, createdAt: Date.now() };
}

/** Monotonic per-device chain generation so re-announced chains are never mistaken for replays. */
function nextGen(roomId: string): number {
  const k = `pxc.ggen.${roomId}`;
  let g = 0;
  try { g = Number(localStorage.getItem(k)) || 0; } catch { /* ignore */ }
  try { localStorage.setItem(k, String(g + 1)); } catch { /* ignore */ }
  return g;
}

function pubB64(raw: Uint8Array<ArrayBuffer>): string {
  return b64url(raw);
}

// ---------- the engine ----------

export class GroupSession {
  readonly role: "host" | "member";
  readonly room: string;
  phase: GroupPhase = "joining";
  error: string | null = null;
  snap: GroupSnapshot;
  presence: Record<string, PresenceState> = {};
  audit: AuditEntry[] = [];
  onlineCount = 0;

  identity!: Identity; // 1:1 channel identity (host: stable for this hosting run)
  groupIdentity: GroupIdentity | null = null; // members: stable pseudonymous membership key
  myId = "";
  private em = new Emitter<GroupEvents>();
  private myChain: SenderChain | null = null;
  private peerChains = new Map<string, PeerChain>();
  private sentTo = new Set<string>(); // members my current chain was distributed to (this epoch)
  private msgOwners = new Map<string, string>(); // content id -> original sender (edit/delete authorship)
  private outbox: Array<{ header: unknown; body?: Uint8Array | undefined }> = [];
  private viewing = true;
  private timers: number[] = [];
  private closed = false;
  private recover: ((from: string, limit: number) => Promise<HistoryItem[]>) | null = null;

  // host-only state
  private conns = new Map<string, { session: PeerSession; joinedAt: number; lastMsg: number[]; lastMsgAt: number; chunkWin: number[] }>();
  private doorbell: PeerSession | null = null;
  private savedRoles = new Map<string, GroupRole>();
  private unsubAnswer: (() => void) | null = null;
  private beaconTimer = 0;
  private lostAt = new Map<string, number>(); // memberId -> disconnect time (grace)

  // member-only state
  private session: PeerSession | null = null;

  private constructor(role: "host" | "member", room: string, snap: GroupSnapshot) {
    this.role = role;
    this.room = room;
    this.snap = snap;
  }

  on<K extends keyof GroupEvents>(ev: K, fn: (v: GroupEvents[K]) => void): () => void {
    return this.em.on(ev, fn);
  }
  private emit<K extends keyof GroupEvents>(ev: K, v: GroupEvents[K]) { this.em.emit(ev, v); }
  private setPhase(p: GroupPhase) { this.phase = p; this.emit("phase", p); }
  private note(kind: string, text: string) { this.emit("notice", { kind, text }); }

  private rosterEntry(id: string): RosterEntry | undefined {
    return this.snap.roster.find((r) => r.id === id);
  }
  nameOf(id: string): string {
    if (id === this.myId) return "You";
    return this.rosterEntry(id)?.name ?? "Member";
  }
  get myRole(): GroupRole {
    return this.rosterEntry(this.myId)?.role ?? "member";
  }
  isSecure(): boolean {
    if (this.role === "host") return this.phase === "ready" || this.phase === "awaiting";
    return !!this.session?.isSecure && this.phase === "ready";
  }

  // ---------- HOST: open / doorbell ----------

  static async openAsHost(args: { room: string; meta?: Partial<GroupMeta>; saved?: GroupSnapshot | null; profile?: { name: string; avatar: Avatar; status: string } }): Promise<GroupSession> {
    const g = new GroupSession("host", args.room, GroupSession.freshSnapshot(args.room, args.meta));
    if (args.saved) {
      // Ownership recovery: same room id, epoch bumped so pre-outage keys are void.
      // The full roster (incl. still-pending requests) is preserved for re-approval.
      const s = args.saved;
      g.snap = { ...s, epoch: s.epoch + 1, pinned: s.pinned, bans: s.bans, muted: s.muted, rules: s.rules, meta: { ...s.meta, ...args.meta } };
      for (const r of s.roster) g.savedRoles.set(r.id, r.role);
    }
    g.identity = await createIdentity();
    g.myId = await memberIdOf(g.identity.publicRaw);
    // The host's roster entry always reflects the CURRENT hosting identity.
    g.snap.roster = [
      { id: g.myId, pub: pubB64(g.identity.publicRaw), name: args.profile?.name ?? "Host", avatar: (args.profile?.avatar ?? 1) as unknown as Avatar, status: args.profile?.status ?? "room coordinator", role: "owner", joinedAt: g.snap.meta.createdAt },
      ...g.snap.roster.filter((r) => r.id !== g.myId),
    ];
    g.myChain = newSenderChain(g.snap.epoch);
    await g.openDoorbell();
    g.startBeacons();
    g.setPhase("ready");
    return g;
  }

  private static freshSnapshot(room: string, meta?: Partial<GroupMeta>): GroupSnapshot {
    return {
      meta: { ...emptyMeta(room), ...meta },
      roster: [],
      epoch: 1,
      pinned: [],
      rules: { slowModeSec: 0, msgsPer10s: 12 },
      bans: [],
      muted: {},
    };
  }

  private async openDoorbell(): Promise<void> {
    if (this.closed) return;
    try {
      const db = await PeerSession.host(this.room, this.identity);
      this.doorbell = db;
      db.on("state", (st) => {
        if (st === "secure") { const s = db; this.doorbell = null; void this.adopt(s); void this.openDoorbell(); }
        if ((st === "failed" || st === "closed") && this.doorbell === db) { this.doorbell = null; this.timers.push(window.setTimeout(() => void this.openDoorbell(), 1500)); }
      });
      this.unsubAnswer?.();
      if (db.localCode) {
        void publishSignal(this.room, "offer", db.localCode);
        this.unsubAnswer = subscribeSignal(this.room, "answer", (ans) => {
          if (db.state === "waiting") db.acceptAnswer(ans).catch(() => { /* stale answer - the joiner retries with the fresh offer */ });
        });
      }
    } catch (e: any) {
      this.error = e?.message ?? "Could not open the room reception.";
      this.setPhase("failed");
    }
  }

  /** Adopt a connected member (host side). */
  private async adopt(s: PeerSession): Promise<void> {
    const pub = s.peerPublicRaw;
    if (!pub) { s.close(false); return; }
    const id = await memberIdOf(pub);
    if (this.snap.bans.includes(id)) { this.sendNote(s, "banned", "You are banned from this room."); s.close(false); return; }
    if (this.conns.size >= this.snap.meta.cap - 1) { this.sendNote(s, "full", "This room is full."); s.close(false); return; }
    const old = this.conns.get(id);
    if (old) old.session.close(false); // replacing a stale connection (rejoin within grace)
    this.lostAt.delete(id);
    const entry: RosterEntry = { id, pub: pubB64(pub), name: "Member", avatar: 1 as unknown as Avatar, status: "", role: this.savedRoles.get(id) ?? "member", joinedAt: Date.now() };
    const existing = this.rosterEntry(id);
    if (existing) {
      // Returning member: refresh their key, keep the approval state exactly as it was
      // (a pending request must NOT self-approve by simply reconnecting).
      existing.pub = entry.pub;
      entry.pending = existing.pending;
    } else {
      entry.pending = this.snap.meta.approval || undefined;
      this.snap.roster.push(entry);
    }
    this.conns.set(id, { session: s, joinedAt: Date.now(), lastMsg: [], lastMsgAt: 0, chunkWin: [] });
    s.on("message", ({ header, body }) => void this.onHostFrame(id, header, body).catch(() => {}));
    s.on("state", (st) => { if (st === "closed" || st === "failed") void this.memberLost(id); });
    if (entry.pending) {
      this.sendNote(s, "pending", "Join request sent - waiting for the group owner or an admin to approve you.");
      this.audit.push({ ts: Date.now(), actor: id, action: "requested-join", target: id });
      this.emit("audit", this.audit);
    } else {
      this.admitLocal(id);
    }
    this.broadcastSnap();
    this.pushPresence();
  }

  /** Roster entry already approved (or was never pending): make them a live member. */
  private admitLocal(id: string): void {
    const e = this.rosterEntry(id);
    if (!e) return;
    const wasPending = !!e.pending;
    e.pending = undefined;
    void this.distributeChainTo([id]);
    if (wasPending) this.systemAll(`${e.name} was approved and joined the group.`);
    else this.systemAll(`${e.name} joined the group.`);
  }

  private async memberLost(id: string): Promise<void> {
    this.conns.delete(id);
    this.lostAt.set(id, Date.now());
    const entry = this.rosterEntry(id);
    if (entry) this.systemAll(`${entry.name}'s connection dropped - waiting briefly in case they return.`);
    this.pushPresence();
    this.timers.push(window.setTimeout(() => void this.memberGone(id), RECONNECT_GRACE_MS));
  }

  private async memberGone(id: string): Promise<void> {
    if (this.conns.has(id)) return; // returned within grace
    if (!this.lostAt.has(id)) return;
    this.lostAt.delete(id);
    const e = this.rosterEntry(id);
    if (!e) return;
    this.snap.roster = this.snap.roster.filter((r) => r.id !== id);
    this.systemAll(`${e.name} left the group.`);
    this.rotate("member left");
  }

  /** Membership change: bump the epoch; every remaining member re-keys (see groupcrypto.ts). */
  private rotate(reason: string): void {
    this.snap.epoch += 1;
    this.audit.push({ ts: Date.now(), actor: this.myId, action: `rotate:${reason}`, target: "group" });
    this.emit("audit", this.audit);
    this.myChain = newSenderChain(this.snap.epoch);
    this.peerChains.clear();
    this.sentTo.clear();
    this.note("epoch", `Encryption keys updated (epoch ${this.snap.epoch}) - ${reason}.`);
    this.systemAll(`Encryption keys updated for everyone's security (${reason}).`);
    this.broadcastSnap();
    void this.distributeChainToAll();
  }

  private systemAll(text: string): void {
    const msg: GroupMessage = { id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, from: "system", senderId: "", kind: "system", text, ts: Date.now(), reactions: {} };
    this.em.emit("message", msg);
  }

  // ---------- HOST: frame handling + relay + moderation ----------

  private async onHostFrame(from: string, header: any, body?: Uint8Array): Promise<void> {
    if (this.closed) return;
    const conn = this.conns.get(from);
    if (!conn) return;
    switch (header?.t) {
      case "profile": {
        const e = this.rosterEntry(from);
        if (e) {
          e.name = String(header.name ?? "Member").slice(0, 32) || "Member";
          e.avatar = header.avatar ?? e.avatar;
          e.status = String(header.status ?? "").slice(0, 60);
          this.broadcastSnap();
        }
        break;
      }
      case "g-pres": {
        this.presence[from] = { online: true, typing: !!header.typing, viewing: !!header.viewing, away: !header.viewing };
        this.pushPresence();
        break;
      }
      case "g-key": {
        // Relay a sender-chain envelope to its target, verbatim (opaque to the host).
        const target = String(header.to ?? "");
        if (target === this.myId) { await this.onKeyEnvelope(from, header.sealed); break; }
        const tc = this.conns.get(target);
        const entry = this.rosterEntry(target);
        if (tc && entry && !entry.pending) void tc.session.send({ t: "g-key", to: target, from, sealed: header.sealed });
        break;
      }
      case "g-msg": {
        if (this.mutedUntil(from) > Date.now()) { this.sendNote(conn.session, "muted", "You are muted in this room."); break; }
        const wire = header.wire as GroupWire | undefined;
        if (!wire || wire.from !== from) break; // sender identity must match the channel
        const isChunk = header.cls === "chunk";
        if (!this.allowSend(from, isChunk)) {
          this.sendNote(conn.session, "slow", isChunk ? "Transfer too fast for this room - try a smaller file." : "Rate limit reached - slow down a little.");
          break;
        }
        await this.onGroupWire(wire); // host applies locally too
        this.relayWire(wire, from, isChunk);
        break;
      }
      case "g-read": {
        const ids: string[] = Array.isArray(header.ids) ? header.ids.map(String).slice(0, 200) : [];
        this.em.emit("read", { by: from, ids });
        for (const [cid, c] of this.conns) if (cid !== from) void c.session.send({ t: "g-read", by: from, ids });
        break;
      }
      case "g-req": {
        void this.onMemberRequest(from, header);
        break;
      }
      case "g-hist": {
        const target = String(header.to ?? "");
        if (target === this.myId) await this.onHistoryEnvelope(from, header.sealed);
        else {
          const tc = this.conns.get(target);
          if (tc) void tc.session.send({ t: "g-hist", from, sealed: header.sealed });
        }
        break;
      }
      default:
        break;
    }
    void body;
  }

  private mutedUntil(id: string): number {
    return this.snap.muted[id] ?? 0;
  }

  /** Bounded authorship memory so edit/delete forgeries are provably rejectable. */
  private rememberOwner(contentId: string, from: string): void {
    if (this.msgOwners.size > 4000) this.msgOwners.clear();
    this.msgOwners.set(contentId, from);
  }
  private isOwner(actorId: string, contentId: string): boolean {
    return this.msgOwners.get(contentId) === actorId;
  }
  private forgery(kind: string, from: string, contentId: string): void {
    this.audit.push({ ts: Date.now(), actor: from, action: `forged-${kind}-denied`, target: contentId });
    this.emit("audit", this.audit);
  }

  /**
   * Relay-side rate limiting. Class "msg" (chat content) respects slow mode and the
   * per-10 s message cap; class "chunk" (file payload) respects a byte budget instead,
   * so big file transfers work while flooding of either kind stays capped.
   */
  private allowSend(from: string, isChunk: boolean): boolean {
    const conn = this.conns.get(from);
    if (!conn) return false;
    const now = Date.now();
    if (isChunk) {
      conn.chunkWin = conn.chunkWin.filter((t) => now - t < 10_000);
      if (conn.chunkWin.length >= CHUNK_BUDGET_PER_10S) return false;
      conn.chunkWin.push(now);
      return true;
    }
    const gap = this.snap.rules.slowModeSec * 1000;
    if (gap && now - conn.lastMsgAt < gap) return false;
    conn.lastMsg = conn.lastMsg.filter((t) => now - t < 10_000);
    if (conn.lastMsg.length >= this.snap.rules.msgsPer10s) return false;
    conn.lastMsg.push(now);
    conn.lastMsgAt = now;
    return true;
  }

  private sendNote(s: PeerSession, kind: string, text: string): void {
    void s.send({ t: "g-note", kind, text }).catch(() => {});
  }

  /**
   * Member-sent control requests (moderation etc.). Every privileged request is
   * re-checked by hostAct against the REQUESTER's verified roster role - the asking
   * client's UI never decides permissions.
   */
  private async onMemberRequest(from: string, header: any): Promise<void> {
    switch (header.kind) {
      case "pin":
        this.hostAct("pin", String(header.id ?? ""), { on: !!header.on }, from);
        break;
      case "kick":
        this.hostAct("kick", String(header.target ?? ""), undefined, from);
        break;
      case "ban":
        this.hostAct("ban", String(header.target ?? ""), undefined, from);
        break;
      case "mute":
        this.hostAct("mute", String(header.target ?? ""), Number(header.ms) || 600_000, from);
        break;
      case "unmute":
        this.hostAct("unmute", String(header.target ?? ""), undefined, from);
        break;
      case "approve":
        this.hostAct("approve", String(header.target ?? ""), undefined, from);
        break;
      case "reject":
        this.hostAct("reject", String(header.target ?? ""), undefined, from);
        break;
      case "role":
        this.hostAct("role", String(header.target ?? ""), String(header.role ?? "member"), from);
        break;
      case "rules":
        this.hostAct("rules", "", header.rules, from);
        break;
      case "meta":
        this.hostAct("meta", "", header.patch, from);
        break;
      case "hist-req": {
        if (!this.snap.meta.historyShare) break; // the group declined history sharing
        const limit = Math.min(Number(header.limit) || 30, 100);
        if (this.recover) void this.recover(from, limit).then((items) => this.shareHistoryWithId(from, items));
        for (const [cid, c] of this.conns) if (cid !== from && !this.rosterEntry(cid)?.pending) void c.session.send({ t: "g-req", kind: "hist-req", to: from, limit });
        break;
      }
      case "keyreq": {
        // A rejoining member lost all peer chain state - everyone re-sends their chain.
        this.sentTo.delete(from);
        void this.distributeChainTo([from]);
        for (const [cid, c] of this.conns) if (cid !== from && !this.rosterEntry(cid)?.pending) void c.session.send({ t: "g-req", kind: "keyreq", to: from });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Host-side enforcement. `actorId` is the verified member requesting the action
   * (the host itself, or a member relaying via g-req). Rank rules are enforced here
   * for BOTH paths, and nobody can act on an equal or higher role.
   */
  private hostAct(action: string, targetId: string, arg?: unknown, actorId?: string): boolean {
    if (this.role !== "host") return false;
    const actor = this.rosterEntry(actorId ?? this.myId);
    const minRank = ACTION_RANK[action];
    if (minRank) {
      const deny = (msg: string) => {
        const ac = actorId ? this.conns.get(actorId) : null;
        if (ac) this.sendNote(ac.session, "denied", msg);
      };
      if (!actor || actor.pending || ROLE_RANK[actor.role] < ROLE_RANK[minRank]) {
        deny("You don't have permission for that action.");
        return false;
      }
      const target = this.rosterEntry(targetId);
      if (target && targetId !== (actorId ?? this.myId) && ROLE_RANK[actor.role] <= ROLE_RANK[target.role]) {
        deny("You can't do that to a member with an equal or higher role.");
        return false;
      }
    }
    const audit = (act: string, target: string) => {
      this.audit.push({ ts: Date.now(), actor: actor?.id ?? this.myId, action: act, target });
    };
    const entry = this.rosterEntry(targetId);
    switch (action) {
      case "approve": {
        if (!entry?.pending) return false;
        entry.pending = undefined;
        this.admitLocal(targetId);
        const c = this.conns.get(targetId);
        if (c) this.sendNote(c.session, "approved", "Your join request was approved. Welcome!");
        audit("approve", targetId);
        break;
      }
      case "reject": {
        if (!entry?.pending) return false;
        const c = this.conns.get(targetId);
        this.snap.roster = this.snap.roster.filter((r) => r.id !== targetId);
        c?.session.close(false);
        this.conns.delete(targetId);
        audit("reject-join", targetId);
        break;
      }
      case "kick": {
        if (!entry || entry.role === "owner") return false;
        const c = this.conns.get(targetId);
        if (c) this.sendNote(c.session, "kicked", "You were removed from the group by a moderator.");
        this.snap.roster = this.snap.roster.filter((r) => r.id !== targetId);
        c?.session.close(false);
        this.conns.delete(targetId);
        this.systemAll(`${entry.name} was removed by ${actor?.name ?? "a moderator"}.`);
        audit("kick", targetId);
        this.rotate("member removed");
        break;
      }
      case "ban": {
        if (!entry || entry.role === "owner") return false;
        if (!this.snap.bans.includes(targetId)) this.snap.bans.push(targetId);
        audit("ban", targetId);
        return this.hostAct("kick", targetId, arg, actorId);
      }
      case "mute": {
        if (!entry) return false;
        const ms = Math.max(60_000, Number(arg) || 600_000);
        this.snap.muted[targetId] = Date.now() + ms;
        const c = this.conns.get(targetId);
        if (c) this.sendNote(c.session, "muted", `You are muted for ${Math.round(ms / 60000)} minute(s).`);
        audit("mute", targetId);
        break;
      }
      case "unmute": {
        delete this.snap.muted[targetId];
        audit("unmute", targetId);
        break;
      }
      case "role": {
        const role = String(arg) as GroupRole;
        if (!["admin", "mod", "member"].includes(role)) return false;
        if (!entry || entry.role === "owner") return false;
        entry.role = role;
        this.savedRoles.set(targetId, role);
        const c = this.conns.get(targetId);
        if (c) this.sendNote(c.session, "role", `Your role is now: ${role}.`);
        audit(`role:${role}`, targetId);
        break;
      }
      case "rules": {
        const r = arg as Partial<GroupRules> | undefined;
        if (r) { this.snap.rules = { slowModeSec: Math.max(0, Math.min(300, Number(r.slowModeSec) || 0)), msgsPer10s: Math.max(1, Math.min(60, Number(r.msgsPer10s) || 12)) }; }
        audit("rules", "group");
        break;
      }
      case "meta": {
        const m = arg as Partial<Pick<GroupMeta, "name" | "desc" | "rules">> | undefined;
        if (!m) return false;
        if (typeof m.name === "string") this.snap.meta.name = m.name.slice(0, 48);
        if (typeof m.desc === "string") this.snap.meta.desc = m.desc.slice(0, 160);
        if (typeof m.rules === "string") this.snap.meta.rules = m.rules.slice(0, 500);
        audit("meta", "group");
        break;
      }
      case "pin": {
        const on = !!(arg as { on?: boolean } | undefined)?.on;
        if (on) { if (!this.snap.pinned.some((p) => p.id === targetId)) this.snap.pinned.push({ id: targetId, by: actor?.id ?? this.myId, ts: Date.now() }); }
        else this.snap.pinned = this.snap.pinned.filter((p) => p.id !== targetId);
        audit(on ? "pin" : "unpin", targetId);
        break;
      }
      default:
        return false;
    }
    this.emit("audit", this.audit);
    this.broadcastSnap();
    return true;
  }

  // ---------- public room-management API (used by the UI) ----------
  // For members these ride g-req and are re-checked by the host against their verified
  // roster role; for the host they act directly.

  async approve(id: string): Promise<boolean> {
    if (this.role === "host") return this.hostAct("approve", id);
    await this.session?.send({ t: "g-req", kind: "approve", target: id }).catch(() => {});
    return true;
  }
  async reject(id: string): Promise<boolean> {
    if (this.role === "host") return this.hostAct("reject", id);
    await this.session?.send({ t: "g-req", kind: "reject", target: id }).catch(() => {});
    return true;
  }
  async kick(id: string): Promise<boolean> {
    if (this.role === "host") return this.hostAct("kick", id);
    await this.session?.send({ t: "g-req", kind: "kick", target: id }).catch(() => {});
    return true;
  }
  async ban(id: string): Promise<boolean> {
    if (this.role === "host") return this.hostAct("ban", id);
    await this.session?.send({ t: "g-req", kind: "ban", target: id }).catch(() => {});
    return true;
  }
  async mute(id: string, ms = 600_000): Promise<boolean> {
    if (this.role === "host") return this.hostAct("mute", id, ms);
    await this.session?.send({ t: "g-req", kind: "mute", target: id, ms }).catch(() => {});
    return true;
  }
  async unmute(id: string): Promise<boolean> {
    if (this.role === "host") return this.hostAct("unmute", id);
    await this.session?.send({ t: "g-req", kind: "unmute", target: id }).catch(() => {});
    return true;
  }
  async setRole(id: string, role: GroupRole): Promise<boolean> {
    if (this.role === "host") return this.hostAct("role", id, role);
    await this.session?.send({ t: "g-req", kind: "role", target: id, role }).catch(() => {});
    return true;
  }
  async setRules(rules: Partial<GroupRules>): Promise<boolean> {
    if (this.role === "host") return this.hostAct("rules", "", rules);
    await this.session?.send({ t: "g-req", kind: "rules", rules }).catch(() => {});
    return true;
  }
  async setGroupMeta(patch: Partial<Pick<GroupMeta, "name" | "desc" | "rules">>): Promise<boolean> {
    if (this.role === "host") return this.hostAct("meta", "", patch);
    await this.session?.send({ t: "g-req", kind: "meta", patch }).catch(() => {});
    return true;
  }

  /** Register the local-history provider so this device can share recent history (opt-in). */
  setHistorySource(fn: (from: string, limit: number) => Promise<HistoryItem[]>): void {
    this.recover = fn;
  }

  /** Owner hands the room to an admin before leaving (predefined transfer policy). */
  transferOwnership(targetId: string): boolean {
    if (this.role !== "host" || this.rosterEntry(this.myId)?.role !== "owner") return false;
    const entry = this.rosterEntry(targetId);
    if (!entry || entry.role !== "admin") return false;
    entry.role = "owner";
    this.savedRoles.set(targetId, "owner");
    const me = this.rosterEntry(this.myId);
    if (me) me.role = "admin";
    this.audit.push({ ts: Date.now(), actor: this.myId, action: "transfer-ownership", target: targetId });
    this.emit("audit", this.audit);
    this.broadcastSnap();
    this.systemAll(`Ownership transferred to ${entry.name}.`);
    return true;
  }

  // ---------- broadcasting / keys ----------

  private broadcastSnap(): void {
    if (this.role !== "host") return;
    for (const c of this.conns.values()) void c.session.send({ t: "g-snap", snap: this.snap }).catch(() => {});
    this.emit("snapshot", this.snap);
  }

  /** Seal my current chain state pairwise for each target and hand the envelopes to the relay. */
  private async distributeChainTo(targets: string[]): Promise<void> {
    if (!this.myChain || !this.identity) return;
    for (const id of targets) {
      if (id === this.myId || this.sentTo.has(id)) continue;
      const entry = this.rosterEntry(id);
      if (!entry || entry.pending) continue;
      try {
        const sealed = await sealToMember(this.identity, fromB64url(entry.pub), this.room, { kind: "senderkey", epoch: this.myChain.epoch, gen: this.myChain.gen, chainKey: this.myChain.chainKey, baseSeq: this.myChain.seq });
        await this.sendKeyEnvelope(id, sealed);
        this.sentTo.add(id);
      } catch { /* key distribution failures are retried via keyreq / next snapshot */ }
    }
  }

  private async distributeChainToAll(): Promise<void> {
    const targets = this.snap.roster.map((r) => r.id);
    await this.distributeChainTo(targets);
  }

  private async sendKeyEnvelope(to: string, sealed: string): Promise<void> {
    if (this.role === "host") {
      if (to === this.myId) return;
      const c = this.conns.get(to);
      if (c) await c.session.send({ t: "g-key", to, from: this.myId, sealed }).catch(() => {});
    } else {
      await this.session?.send({ t: "g-key", to, from: this.myId, sealed }).catch(() => {});
    }
  }

  private async onKeyEnvelope(from: string, sealed: string): Promise<void> {
    if (!this.identity) return;
    const sender = this.rosterEntry(from);
    if (!sender) return;
    try {
      const payload = await openFromMember(this.identity, fromB64url(sender.pub), this.room, sealed);
      if (payload?.kind !== "senderkey") return;
      this.peerChains.set(from, peerChainFromDistribute(Number(payload.epoch), Number(payload.gen), String(payload.chainKey), Number(payload.baseSeq)));
      this.note("keys", `Received ${sender.name}'s encryption key (epoch ${payload.epoch}).`);
    } catch {
      this.note("keys", `Could not verify an encryption key from ${sender.name}.`);
    }
  }

  // ---------- content (both roles) ----------

  /** Seal with my sender chain and dispatch (host: deliver directly; member: via relay). */
  async sendContent(header: Record<string, unknown>, body?: Uint8Array): Promise<void> {
    if (!this.myChain) throw new Error("Group keys are not ready yet.");
    if (this.phase !== "ready") {
      if (this.role === "member") { this.outbox.push({ header, body }); return; }
      throw new Error("Not connected.");
    }
    const { wire, next } = await sealGroupMessage(this.myChain, this.room, this.myId, header, body);
    this.myChain = next;
    if (this.role === "host") {
      this.relayWire(wire, this.myId, header["t"] === "file-chunk");
    } else {
      await this.session?.send({ t: "g-msg", wire, cls: header["t"] === "file-chunk" ? "chunk" : "msg" }).catch((e) => { this.outbox.push({ header, body }); throw e; });
    }
  }

  private relayWire(wire: GroupWire, exceptId: string, isChunk: boolean): void {
    for (const [cid, c] of this.conns) if (cid !== exceptId) void c.session.send({ t: "g-msg", wire, cls: isChunk ? "chunk" : "msg" }).catch(() => {});
  }

  private async onGroupWire(w: GroupWire): Promise<void> {
    if (w.from === this.myId) return;
    const peer = this.peerChains.get(w.from);
    const sender = this.rosterEntry(w.from);
    if (!peer || !sender) {
      this.note("keys", `Waiting for ${sender?.name ?? "a member"}'s encryption key before their messages can be read.`);
      return;
    }
    if (sender.pending) return;
    try {
      const { header, body, next } = await openGroupMessage(w, this.room, peer);
      this.peerChains.set(w.from, next);
      this.applyContent(w.from, header, body);
    } catch (e: any) {
      if (String(e?.message ?? "").includes("Replayed")) return; // duplicates: ignore silently
      this.note("keys", `A message from ${sender.name} could not be decrypted (key state mismatch).`);
    }
  }

  /** Turn a decrypted content envelope into a GroupMessage event (both roles). */
  private applyContent(from: string, header: any, body?: Uint8Array): void {
    const sender = this.rosterEntry(from);
    const name = sender?.name ?? "Member";
    switch (header?.t) {
      case "msg": {
        const m: GroupMessage = {
          id: String(header.id), from: "peer", senderId: from, senderName: name,
          kind: (["text", "sticker", "voice", "gif", "file"].includes(header.kind) ? header.kind : "text") as GroupMsgKind,
          text: header.text ? String(header.text).slice(0, 4000) : undefined,
          sticker: typeof header.sticker === "string" ? header.sticker.slice(0, 120) : undefined,
          stickerUrl: typeof header.stickerUrl === "string" ? header.stickerUrl.slice(0, 300_000) : undefined,
          stickerLib: typeof header.stickerLib === "string" ? header.stickerLib.slice(0, 40) : undefined,
          replyTo: header.replyTo, forwarded: !!header.forwarded,
          ts: Date.now(), reactions: {},
        };
        this.rememberOwner(m.id, from);
        this.em.emit("message", m);
        break;
      }
      case "file-start": case "file-chunk": case "file-end": case "file-cancel": {
        const m: GroupMessage = {
          id: String(header.id), from: "peer", senderId: from, senderName: name, kind: header.t === "file-start" ? (header.kind === "voice" ? "voice" : "file") : "file",
          file: header.t === "file-start" ? { name: String(header.name ?? "file").slice(0, 120), size: Number(header.size) || 0, mime: String(header.mime ?? "application/octet-stream"), progress: 0, status: "receiving" } : undefined,
          ts: Date.now(), reactions: {},
          replyTo: header.replyTo, forwarded: !!header.forwarded,
        };
        if (header.t === "file-start") this.rememberOwner(m.id, from);
        (m as any).__fileFrame = { t: header.t, body };
        this.em.emit("message", m);
        break;
      }
      case "g-react": {
        const m: GroupMessage = { id: String(header.id), from: "peer", senderId: from, senderName: name, kind: "system", ts: Date.now(), reactions: {} };
        (m as any).__react = { emoji: String(header.emoji ?? "").slice(0, 8), on: !!header.on };
        this.em.emit("message", m);
        break;
      }
      case "g-edit": {
        if (!this.isOwner(from, String(header.id ?? ""))) { this.forgery("edit", from, String(header.id ?? "")); break; }
        const m: GroupMessage = { id: String(header.id), from: "peer", senderId: from, senderName: name, kind: "system", ts: Date.now(), reactions: {}, text: String(header.text ?? "").slice(0, 4000) };
        (m as any).__edit = true;
        this.em.emit("message", m);
        break;
      }
      case "g-del": {
        if (!this.isOwner(from, String(header.id ?? ""))) { this.forgery("delete", from, String(header.id ?? "")); break; }
        const m: GroupMessage = { id: String(header.id), from: "peer", senderId: from, senderName: name, kind: "system", ts: Date.now(), reactions: {} };
        (m as any).__del = true;
        this.em.emit("message", m);
        break;
      }
      default:
        break;
    }
    void body;
  }

  /** Reactions / edits / deletes are content-level; only the original sender's changes apply. */
  async react(messageId: string, emoji: string, on: boolean): Promise<void> {
    await this.sendContent({ t: "g-react", id: messageId, emoji, on });
  }
  async editMessage(messageId: string, text: string): Promise<void> {
    await this.sendContent({ t: "g-edit", id: messageId, text });
  }
  async deleteMessage(messageId: string): Promise<void> {
    await this.sendContent({ t: "g-del", id: messageId });
  }
  async pinMessage(messageId: string, on: boolean): Promise<void> {
    if (this.role === "host") this.hostAct("pin", messageId, { on });
    else await this.session?.send({ t: "g-req", kind: "pin", id: messageId, on }).catch(() => {});
  }

  async markRead(ids: string[]): Promise<void> {
    if (this.role === "host") {
      for (const [cid, c] of this.conns) void c.session.send({ t: "g-read", by: this.myId, ids }).catch(() => {});
    } else {
      await this.session?.send({ t: "g-read", ids }).catch(() => {});
    }
  }

  setViewing(v: boolean): void {
    this.viewing = v;
    void this.sendPresence();
  }
  async setTyping(on: boolean): Promise<void> {
    await this.sendPresence(on);
  }
  private async sendPresence(typing?: boolean): Promise<void> {
    const p = { t: "g-pres", viewing: this.viewing, typing: !!typing };
    if (this.role === "host") {
      this.presence[this.myId] = { online: true, typing: !!typing, viewing: this.viewing, away: !this.viewing };
      this.pushPresence();
    } else {
      await this.session?.send(p).catch(() => {});
    }
  }

  // ---------- presence broadcast (host) ----------

  private pushPresence(): void {
    if (this.role !== "host") return;
    const states: Record<string, PresenceState> = {};
    for (const [id, c] of this.conns) states[id] = { ...(this.presence[id] ?? { typing: false, viewing: false, away: true }), online: c.session.isSecure };
    states[this.myId] = this.presence[this.myId] ?? { online: true, typing: false, viewing: true, away: false };
    const n = Object.values(states).filter((s) => s.online).length;
    this.onlineCount = n;
    for (const c of this.conns.values()) void c.session.send({ t: "g-pres", states }).catch(() => {});
    this.presence = states;
    this.emit("presence", states);
  }

  // ---------- MEMBER: join / wiring ----------

  static async joinAsMember(args: { room: string; offer: string; profile: { name: string; avatar: Avatar; status: string }; onHistory?: (from: string, limit: number) => Promise<HistoryItem[]> }): Promise<GroupSession> {
    const gid = (await loadGroupIdentity(args.room)) ?? (await createGroupIdentity(args.room));
    const g = new GroupSession("member", args.room, GroupSession.placeholderSnapshot(args.room));
    g.groupIdentity = gid;
    g.myId = gid.memberId;
    g.identity = gid.keyPair as unknown as Identity; // members derive with their stable membership key
    g.recover = args.onHistory ?? null;
    g.snap.meta = { ...g.snap.meta, room: args.room };
    const s = await PeerSession.join(args.room, args.offer, gid.keyPair as unknown as Identity);
    g.session = s;
    s.on("message", ({ header, body }) => void g.onMemberFrame(header, body).catch(() => {}));
    s.on("state", (st) => {
      if (st === "secure") { void s.send({ t: "profile", name: args.profile.name, avatar: args.profile.avatar, status: args.profile.status }); g.armPresence(); }
      if (st === "closed" || st === "failed") { if (g.phase !== "closed" && g.phase !== "failed") g.setPhase("reconnecting"); }
    });
    void publishSignal(args.room, "answer", s.localCode ?? "");
    g.setPhase("joining");
    g.timers.push(window.setTimeout(() => {
      if (g.phase === "joining" || g.phase === "awaiting") {
        if (!g.session?.isSecure) { g.error = "Could not reach the room's host. The room may be closed or the host is offline."; g.setPhase("failed"); }
        else if (g.phase === "joining") { g.error = "Connected, but the host did not send the group state."; g.setPhase("failed"); }
      }
    }, 30_000));
    return g;
  }

  private static placeholderSnapshot(room: string): GroupSnapshot {
    return { meta: emptyMeta(room), roster: [], epoch: 0, pinned: [], rules: { slowModeSec: 0, msgsPer10s: 12 }, bans: [], muted: {} };
  }

  private armPresence(): void {
    this.timers.push(window.setInterval(() => void this.sendPresence(), PRESENCE_INTERVAL_MS));
  }

  private async onMemberFrame(header: any, body?: Uint8Array): Promise<void> {
    if (this.closed) return;
    switch (header?.t) {
      case "g-snap": {
        const snap = header.snap as GroupSnapshot | undefined;
        if (!snap || snap.meta?.room !== this.room) return;
        const me = snap.roster.find((r) => r.id === this.myId);
        const prevEpoch = this.snap.epoch;
        const prevIds = new Set(this.snap.roster.map((r) => r.id));
        this.snap = snap;
        this.emit("snapshot", snap);
        if (!me) {
          // Not on the roster: rejected, removed, or banned.
          this.error = "You are not on this room's member list. The join request may have been rejected, or the membership was removed.";
          this.setPhase("failed");
          return;
        }
        if (me.pending) {
          if (this.phase !== "awaiting") { this.setPhase("awaiting"); this.note("pending", "Waiting for the group owner or an admin to approve your join request."); }
        } else {
          if (this.snap.epoch !== prevEpoch) {
            // Rotation: fresh chain for everyone, old keys void.
            this.myChain = newSenderChain(this.snap.epoch, nextGen(this.room));
            this.peerChains.clear();
            this.sentTo.clear();
            this.note("epoch", `Encryption keys updated (epoch ${this.snap.epoch}).`);
          } else if (!this.myChain) {
            this.myChain = newSenderChain(this.snap.epoch, nextGen(this.room));
          }
          // Distribute my chain to members I haven't sent it to in this epoch.
          await this.distributeChainToAll();
          if (this.phase !== "ready") {
            this.setPhase("ready");
            // Rejoining members lost all peer chain state - ask everyone to re-send keys.
            await this.session?.send({ t: "g-req", kind: "keyreq" }).catch(() => {});
            const mine = this.outbox.splice(0);
            for (const item of mine) await this.sendContent(item.header as Record<string, unknown>, item.body).catch(() => {});
          }
          // Share history with newcomers when the group opted in.
          const newcomers = snap.roster.filter((r) => r.id !== this.myId && !prevIds.has(r.id) && !r.pending);
          if (this.snap.meta.historyShare && newcomers.length && this.recover) {
            for (const n of newcomers) void this.shareHistoryWith(n);
          }
        }
        break;
      }
      case "g-key": {
        if (header.to !== this.myId) return;
        await this.onKeyEnvelope(String(header.from ?? ""), header.sealed);
        break;
      }
      case "g-msg": {
        const wire = header.wire as GroupWire | undefined;
        if (wire) await this.onGroupWire(wire);
        break;
      }
      case "g-read": {
        const ids: string[] = Array.isArray(header.ids) ? header.ids.map(String).slice(0, 200) : [];
        this.em.emit("read", { by: String(header.by ?? ""), ids });
        break;
      }
      case "g-pres": {
        const states = header.states as Record<string, PresenceState> | undefined;
        if (!states) return;
        const out: Record<string, PresenceState> = {};
        for (const [id, v] of Object.entries(states)) {
          out[id] = { online: !!v?.online, typing: !!v?.typing, viewing: !!v?.viewing, away: !!v?.away };
        }
        this.presence = out;
        this.emit("presence", out);
        break;
      }
      case "g-note": {
        this.note(String(header.kind ?? "info"), String(header.text ?? ""));
        break;
      }
      case "g-req": {
        if (header.kind === "hist-req" && this.recover) {
          // The host relays the request with `to` = the member who wants the history.
          const requester = String(header.to ?? "");
          if (requester && requester !== this.myId) {
            const items = await this.recover(requester, Math.min(Number(header.limit) || 30, 100));
            await this.shareHistoryWithId(requester, items);
          }
        } else if (header.kind === "keyreq") {
          const target = String(header.to ?? "");
          if (target && target !== this.myId) {
            this.sentTo.delete(target);
            await this.distributeChainTo([target]);
          }
        }
        break;
      }
      case "g-hist": {
        // Direct from the host (no `to` needed - it arrived on our private channel),
        // or relayed member-to-member with `to` = us.
        if (header.to && header.to !== this.myId) return;
        await this.onHistoryEnvelope(String(header.from ?? ""), header.sealed);
        break;
      }
      default:
        break;
    }
    void body;
  }

  private async shareHistoryWith(target: RosterEntry): Promise<void> {
    if (!this.recover || !this.identity) return;
    const items = await this.recover(target.id, 30);
    await this.shareHistoryWithId(target.id, items);
  }

  private async shareHistoryWithId(targetId: string, items: HistoryItem[]): Promise<void> {
    if (!items.length || !this.identity) return;
    const entry = this.rosterEntry(targetId);
    if (!entry) return;
    try {
      const sealed = await sealToMember(this.identity, fromB64url(entry.pub), this.room, { kind: "history", items });
      if (this.role === "host") { const c = this.conns.get(targetId); if (c) await c.session.send({ t: "g-hist", from: this.myId, sealed }); }
      else await this.session?.send({ t: "g-hist", to: targetId, sealed });
    } catch { /* history sharing is best-effort */ }
  }

  private async onHistoryEnvelope(from: string, sealed: string): Promise<void> {
    const sender = this.rosterEntry(from);
    if (!sender || !this.identity) return;
    try {
      const payload = await openFromMember(this.identity, fromB64url(sender.pub), this.room, sealed);
      if (payload?.kind !== "history" || !Array.isArray(payload.items)) return;
      for (const it of payload.items.slice(0, 100)) {
        const m: GroupMessage = {
          id: String(it.id), from: it.senderId === this.myId ? "me" : "peer", senderId: String(it.senderId ?? from), senderName: it.senderName ?? sender.name,
          kind: it.kind, text: it.text, sticker: it.sticker, stickerUrl: it.stickerUrl,
          ts: Number(it.ts) || Date.now(), reactions: {}, recovered: true,
        };
        this.em.emit("message", m);
      }
      this.note("history", `Recovered ${payload.items.length} earlier message(s) shared by ${sender.name}.`);
    } catch {
      this.note("history", `Could not verify shared history from ${sender.name}.`);
    }
  }

  // ---------- history request ----------

  async requestHistory(limit = 30): Promise<void> {
    if (this.role === "host") return;
    await this.session?.send({ t: "g-req", kind: "hist-req", limit }).catch(() => {});
  }

  // ---------- beacons (public rooms, host) ----------

  private startBeacons(): void {
    if (this.role !== "host" || !this.snap.meta.isPublic) return;
    const publish = () => {
      if (this.closed) return;
      const b: RoomBeacon = beaconOf(this.room, {
        name: this.snap.meta.name, desc: this.snap.meta.desc, cat: this.snap.meta.cat, region: this.snap.meta.region, lang: this.snap.meta.lang,
        members: Math.max(1, this.onlineCount || 1), cap: this.snap.meta.cap, hostName: this.rosterEntry(this.myId)?.name ?? "Host", hostId: this.myId.slice(0, 16),
      });
      void publishBeacon(b);
    };
    publish();
    this.beaconTimer = window.setInterval(publish, BEACON_INTERVAL_MS);
  }

  private stopBeacons(): void {
    if (this.beaconTimer) { window.clearInterval(this.beaconTimer); this.beaconTimer = 0; }
  }

  /** Public room closed by the host: tell discovery, tombstone the signaling topic. */
  async closeRoom(): Promise<void> {
    if (this.role === "host") {
      if (this.snap.meta.isPublic) void publishBeacon(beaconOf(this.room, { name: this.snap.meta.name, desc: "", cat: this.snap.meta.cat, region: this.snap.meta.region, lang: this.snap.meta.lang, members: 0, cap: this.snap.meta.cap, hostName: "", hostId: this.myId.slice(0, 16), closed: true }));
      void publishSignal(this.room, "offer", ROOM_CLOSED);
      for (const c of [...this.conns.values()]) c.session.close(true);
      this.conns.clear();
      this.doorbell?.close(true);
      this.doorbell = null;
      this.unsubAnswer?.();
      this.unsubAnswer = null;
    }
    this.session?.close(true);
    this.session = null;
    this.stopBeacons();
    this.clearTimers();
    this.closed = true;
    this.setPhase("closed");
  }

  leave(): Promise<void> { return this.closeRoom(); }

  private clearTimers(): void {
    for (const t of this.timers) { window.clearTimeout(t); window.clearInterval(t); }
    this.timers = [];
  }

  // ---------- diagnostics ----------

  diagnostics(): Record<string, string> {
    const out: Record<string, string> = {
      "Role": this.role === "host" ? "Host (coordinator + relay)" : "Member",
      "Room": this.room,
      "Phase": this.phase,
      "Encryption": this.isSecure() ? `Sender-key chains active (epoch ${this.snap.epoch})` : "Keys not established",
      "My chain": this.myChain ? `epoch ${this.myChain.epoch}, gen ${this.myChain.gen}, next seq ${this.myChain.seq}` : "none",
      "Peer keys received": String(this.peerChains.size),
      "Roster": `${this.snap.roster.length} member(s)`,
      "Epoch": String(this.snap.epoch),
    };
    if (this.role === "host") {
      out["Member channels"] = `${this.conns.size} connected`;
      out["Reception (doorbell)"] = this.doorbell ? this.doorbell.state : "reopening.";
      out["Discovery beacon"] = this.snap.meta.isPublic ? (this.beaconTimer ? "publishing" : "stopped") : "private group";
    } else {
      out["Channel to host"] = this.session ? `${this.session.state} (pc: ${this.session.pc.connectionState})` : "none";
      out["Signaling topic"] = `pxl_${this.room.replace(/\D/g, "")}_*`;
    }
    return out;
  }
}
