/**
 * In-memory room registry — the coordinator's ONLY state.
 *
 * Everything here is transient by design and dies with the process:
 * - a room exists only while its owner (or an authorized co-owner) holds a live
 *   lease and proves ownership with fresh signatures;
 * - membership is exactly the set of live joined connections — no fake counts;
 * - after a restart the registry is empty and honest: rooms are re-registered
 *   by their owners and re-joined by members, and until then every join
 *   attempt gets a clear "room-unavailable" answer.
 *
 * Nothing is ever written to disk. There is no database.
 */
import type { RoomMember } from "../../src/lib/pixel/coordinator-protocol";
import type { RoomManifest as Manifest } from "../../src/lib/pixel/manifest";

/** A room lease is short-lived on purpose: coordinators must not become a
 *  hidden persistent store of "rooms that used to exist". */
export const LEASE_MS = 90_000;
/** Owners renew roughly this often (with a fresh ownership proof). */
export const RENEW_MS = 30_000;

interface RoomRecord {
  manifest: Manifest;
  ownerConn: string;
  leaseUntil: number;
  members: Map<string, { name: string; owner: boolean }>;
}

export interface RegisterResult {
  ok: boolean;
  code?: string;
  message?: string;
  leaseMs?: number;
}

export class RoomRegistry {
  private rooms = new Map<string, RoomRecord>();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  onRoomOffline: ((roomId: string, reason: "lease-expired" | "owner-left" | "unregistered") => void) | null = null;
  onMembersChanged: ((roomId: string) => void) | null = null;

  start(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), 5_000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** Wipe everything — used when a coordinator process (re)starts. */
  reset(): void {
    for (const roomId of [...this.rooms.keys()]) this.dropRoom(roomId, "unregistered");
    this.rooms.clear();
  }

  /** /health payload — live facts only, no invented numbers. */

  /** Owner (or authorized co-owner) claims the lease for a verified manifest. */
  register(manifest: Manifest, ownerConn: string, now = Date.now()): RegisterResult {
    const existing = this.rooms.get(manifest.roomId);
    if (existing && existing.ownerConn !== ownerConn) {
      // Live lease held by someone else: no takeover, ever. Honest refusal.
      return { ok: false, code: "room-held", message: "This room is already registered by its owner on this coordinator." };
    }
    const prev = existing;
    this.rooms.set(manifest.roomId, { manifest, ownerConn, leaseUntil: now + LEASE_MS, members: prev?.members ?? new Map() });
    return { ok: true, leaseMs: LEASE_MS };
  }

  renew(roomId: string, ownerConn: string, now = Date.now()): RegisterResult {
    const rec = this.rooms.get(roomId);
    if (!rec || rec.ownerConn !== ownerConn) return { ok: false, code: "room-unavailable", message: "This room is not registered on this coordinator." };
    rec.leaseUntil = now + LEASE_MS;
    return { ok: true, leaseMs: LEASE_MS };
  }

  unregister(roomId: string, ownerConn: string): boolean {
    const rec = this.rooms.get(roomId);
    if (!rec || rec.ownerConn !== ownerConn) return false;
    this.rooms.delete(roomId);
    this.onRoomOffline?.(roomId, "unregistered");
    return true;
  }

  manifestOf(roomId: string): Manifest | null {
    return this.rooms.get(roomId)?.manifest ?? null;
  }

  /** Member join — always against a live lease; the registry never invents rooms. */
  join(roomId: string, connId: string, name: string, now = Date.now()): { ok: boolean; code?: string; manifest?: Manifest; members?: RoomMember[] } {
    const rec = this.rooms.get(roomId);
    if (!rec || rec.leaseUntil <= now) {
      if (rec && rec.leaseUntil <= now) this.dropRoom(roomId, "lease-expired");
      return { ok: false, code: "room-unavailable" };
    }
    rec.members.set(connId, { name, owner: connId === rec.ownerConn });
    this.onMembersChanged?.(roomId);
    return { ok: true, manifest: rec.manifest, members: this.membersOf(roomId) };
  }

  leave(roomId: string, connId: string): void {
    const rec = this.rooms.get(roomId);
    if (!rec) return;
    if (rec.members.delete(connId)) this.onMembersChanged?.(roomId);
  }

  /** The member list is exactly the live connections — the source of truth. */
  membersOf(roomId: string): RoomMember[] {
    const rec = this.rooms.get(roomId);
    if (!rec) return [];
    return [...rec.members.entries()].map(([id, m]) => ({ id, name: m.name, owner: m.owner }));
  }

  memberIds(roomId: string): string[] {
    const rec = this.rooms.get(roomId);
    return rec ? [...rec.members.keys()] : [];
  }

  has(roomId: string): boolean {
    const rec = this.rooms.get(roomId);
    return !!rec && rec.leaseUntil > Date.now();
  }

  /** TCP disconnect: drop membership; if the lease holder died, the room dies too. */
  dropConnection(connId: string): string[] {
    const dropped: string[] = [];
    for (const [roomId, rec] of this.rooms) {
      if (rec.members.delete(connId)) this.onMembersChanged?.(roomId);
      if (rec.ownerConn === connId) {
        this.dropRoom(roomId, "owner-left");
        dropped.push(roomId);
      }
    }
    return dropped;
  }

  private dropRoom(roomId: string, reason: "lease-expired" | "owner-left" | "unregistered"): void {
    this.rooms.delete(roomId);
    this.onRoomOffline?.(roomId, reason);
  }

  private sweep(now = Date.now()): void {
    for (const [roomId, rec] of this.rooms) {
      if (rec.leaseUntil <= now) this.dropRoom(roomId, "lease-expired");
    }
  }

  /** /health payload — live facts only, no invented numbers. */
  stats(): { rooms: number; connectionsHeld: number } {
    let held = 0;
    for (const rec of this.rooms.values()) held += rec.members.size;
    return { rooms: this.rooms.size, connectionsHeld: held };
  }
}
