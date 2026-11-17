/**
 * Coordinator wire protocol — the ONLY server-visible surface of Pixolark.
 *
 * The coordinator is a stateless in-memory process: it relays signed room
 * manifests, presence, and WebRTC signaling (offer/answer SDP — public data by
 * design, identical in nature to the ntfy topics used for backend-less play).
 * It NEVER carries message plaintext and NEVER persists anything.
 *
 * Framing: plain JSON text frames over a single WebSocket per client.
 */
import type { RoomManifest } from "./manifest";
import { b64url, te } from "./bytes";

/** Fresh proof that the sender controls the owner (or authorized co-owner) signing key. */
export interface OwnershipProof {
  /** Epoch ms — must be within PROOF_TOLERANCE_MS of server time. */
  ts: number;
  /** Per-connection nonce issued in `welcome` — binds the proof to THIS socket
   *  so a captured register/lease frame can never be replayed from elsewhere. */
  nonce: string;
  /** b64url ECDSA-P256 signature over proofPayload(roomId, ts, nonce). */
  sig: string;
}

export function proofPayload(roomId: string, ts: number, nonce: string): string {
  return `pixolark-proof|${roomId}|${ts}|${nonce}`;
}

export const PROOF_TOLERANCE_MS = 60_000;

/**
 * Sign an ownership proof with the room's signing key. The `nonce` comes from
 * the coordinator's `welcome` frame — proofs are connection-bound, so a captured
 * frame replayed on another socket (or by another person) never verifies.
 * Pure WebCrypto: identical in browser, Bun and Node ≥ 22.
 */
export async function createOwnershipProof(roomId: string, priv: CryptoKey, nonce: string): Promise<OwnershipProof> {
  const ts = Date.now();
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, te.encode(proofPayload(roomId, ts, nonce)));
  return { ts, nonce, sig: b64url(new Uint8Array(sig)) };
}

// ---------- client → coordinator ----------

export type ClientToServer =
  | { t: "hello"; client: string; name?: string }
  | { t: "room.register"; manifest: RoomManifest; proof: OwnershipProof }
  | { t: "room.unregister"; roomId: string; proof: OwnershipProof }
  | { t: "room.lease"; roomId: string; proof: OwnershipProof }
  | { t: "room.probe"; roomId: string }
  | { t: "room.join"; roomId: string; name: string }
  | { t: "room.leave"; roomId: string }
  | { t: "rtc"; roomId: string; to: string; data: unknown } // offer/answer SDP relay (public data)
  | { t: "ping" };

// ---------- coordinator → client ----------

export interface RoomMember {
  id: string; // connection id
  name: string;
  /** Role hint derived from registration: the owner is marked as such. */
  owner: boolean;
}

export type ServerToClient =
  | { t: "welcome"; clientId: string; serverTime: number; nonce: string }
  | { t: "room.registered"; roomId: string; leaseMs: number }
  | { t: "room.state"; roomId: string; manifest: RoomManifest; members: RoomMember[] }
  | { t: "room.members"; roomId: string; members: RoomMember[] }
  | { t: "room.probe"; roomId: string; available: boolean }
  | { t: "room.offline"; roomId: string; reason: "lease-expired" | "owner-left" | "unregistered" }
  | { t: "rtc"; roomId: string; from: string; data: unknown }
  | { t: "error"; code: string; message: string; roomId?: string }
  | { t: "pong" };
