/**
 * Group cryptography — Signal-style sender keys with a forward hash ratchet, built on
 * the existing identity primitives (ECDH P-256 + HKDF-SHA-256 + AES-GCM-256, Web Crypto).
 * This is NOT MLS: it is the established sender-key design used by Signal for small groups.
 *
 * Design:
 * - Every member has a long-term ECDH identity (already used for 1:1 sessions).
 * - Each member sends group content under a per-epoch SENDER CHAIN: message key for seq s
 *   is HKDF(chainKey_s, "msg"), and chainKey_{s+1} = HKDF(chainKey_s, "chain"). The chain
 *   is one-way, so a member who joins mid-conversation receives the CURRENT chain key and
 *   can only decrypt FUTURE messages — never older ones (no explicit history grant).
 * - Chain keys are distributed pairwise-sealed: the envelope key is static-static
 *   ECDH(sender identity, target identity) + HKDF bound to the room id, so only the target
 *   can open it and possession of the sender identity is authenticated (the target derives
 *   with the sender's roster public key — a forged envelope can't be made without the
 *   sender's private identity key).
 * - Membership change (leave/removal) => host bumps the epoch; every remaining member mints
 *   a fresh chain and redistributes it. Removed members never receive it and the relay
 *   drops their traffic, so they cannot read future messages.
 * - Replay protection: receivers track the highest seq per (sender, epoch); the frame's
 *   seq is in the AAD, and seq <= lastSeq is rejected. A bounded gap window limits
 *   ratcheting work.
 *
 * Honest limits (docs/ARCHITECTURE.md): no TreeKEM/post-compromise security, O(N)
 * distribution per membership change (fine for small groups), member authentication chains
 * through the host's introduction — members can compare identity commitments in the member
 * panel to harden against a malicious host.
 */
import { b64url, concat, fromB64url, te } from "./bytes";
import { commitmentOf, packEnvelope, sha256, unpackEnvelope, type Identity } from "./crypto";

export type { Identity };

export async function memberIdOf(publicRaw: Uint8Array<ArrayBuffer>): Promise<string> {
  return commitmentOf(publicRaw);
}

function cmp(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Static-static ECDH + HKDF. Both sides derive the same 32 bytes. */
export async function derivePairwiseBits(me: Identity, peerPublicRaw: Uint8Array<ArrayBuffer>, context: string): Promise<Uint8Array<ArrayBuffer>> {
  const peerKey = await crypto.subtle.importKey("raw", peerPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, me.keyPair.privateKey, 256);
  const [a, b] = cmp(me.publicRaw, peerPublicRaw) < 0 ? [me.publicRaw, peerPublicRaw] : [peerPublicRaw, me.publicRaw];
  const transcript = concat(te.encode("PIXOLARK-GROUP/v1|" + context + "|"), a, b);
  const salt = await sha256(transcript);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("pixolark group envelope") }, hkdf, 256));
  return bits;
}

/** My sending state for the current epoch: one-way chain, seq = next message number.
 *  gen increments each time the chain is re-announced (rejoin) so receivers can discard stale frames. */
export interface SenderChain { epoch: number; gen: number; chainKey: string; seq: number }

export function newSenderChain(epoch: number, gen = 0): SenderChain {
  return { epoch, gen, chainKey: b64url(crypto.getRandomValues(new Uint8Array(32))), seq: 0 };
}

async function hkdfBits(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const hkdf = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode(info) }, hkdf, 256));
}

async function aesKey(bits: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
  bits.fill(0);
  return key;
}

async function roomSalt(roomId: string): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(te.encode(`pixolark|${roomId}`));
}

/**
 * Seals one group message and advances the chain. Returns the wire frame plus the
 * UPDATED chain state (callers must persist it in place).
 */
export async function sealGroupMessage(
  chain: SenderChain, roomId: string, from: string, header: unknown, body?: Uint8Array,
): Promise<{ wire: GroupWire; next: SenderChain }> {
  const salt = await roomSalt(roomId);
  const mk = await aesKey(await hkdfBits(fromB64url(chain.chainKey), salt, `msg|${chain.epoch}|${from}|${chain.seq}`));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = te.encode(`g|${roomId}|${from}|${chain.epoch}|${chain.gen}|${chain.seq}`);
  const pt = packEnvelope(header, body);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, mk, pt));
  const wire: GroupWire = { from, epoch: chain.epoch, gen: chain.gen, seq: chain.seq, sealed: b64url(concat(iv, ct)) };
  const nk = await hkdfBits(fromB64url(chain.chainKey), salt, `chain|${chain.epoch}`);
  return { wire, next: { epoch: chain.epoch, gen: chain.gen, chainKey: b64url(nk), seq: chain.seq + 1 } };
}

/** Receiver's view of one sender's chain: where we entered + how far we've read. */
export interface PeerChain { epoch: number; gen: number; chainKey: string; baseSeq: number; lastSeq: number }

export function peerChainFromDistribute(epoch: number, gen: number, chainKey: string, baseSeq: number): PeerChain {
  return { epoch, gen, chainKey, baseSeq, lastSeq: baseSeq - 1 };
}

/** Wire form of a group content frame (relayed verbatim by the host). */
export interface GroupWire { from: string; epoch: number; gen: number; seq: number; sealed: string }

const MAX_RATCHET_STEPS = 2000;

/** Opens a group frame with the sender's distributed chain state; returns the advanced state. */
export async function openGroupMessage(
  w: GroupWire, roomId: string, peer: PeerChain,
): Promise<{ header: any; body: Uint8Array<ArrayBuffer>; next: PeerChain }> {
  if (w.epoch !== peer.epoch || w.gen !== peer.gen || w.seq <= peer.lastSeq) throw new Error("Replayed, stale or out-of-order group message");
  const steps = w.seq - peer.baseSeq;
  if (steps < 0 || steps > MAX_RATCHET_STEPS) throw new Error("Group message too far ahead of our chain position");
  const salt = await roomSalt(roomId);
  let ck = fromB64url(peer.chainKey);
  for (let i = 0; i < steps; i++) ck = await hkdfBits(ck, salt, `chain|${w.epoch}`);
  const mk = await aesKey(await hkdfBits(ck, salt, `msg|${w.epoch}|${w.from}|${w.seq}`));
  const raw = fromB64url(w.sealed);
  if (raw.length < 12 + 16) throw new Error("Group frame too short");
  const aad = te.encode(`g|${roomId}|${w.from}|${w.epoch}|${w.gen}|${w.seq}`);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: aad }, mk, raw.slice(12));
  const { header, body } = unpackEnvelope(new Uint8Array(pt));
  const next: PeerChain = { epoch: w.epoch, gen: w.gen, chainKey: b64url(ck), baseSeq: peer.baseSeq, lastSeq: w.seq };
  return { header, body, next };
}

/** Seals an arbitrary payload so ONLY the holder of targetPublicRaw can open it. */
export async function sealToMember(me: Identity, targetPublicRaw: Uint8Array<ArrayBuffer>, roomId: string, payload: unknown): Promise<string> {
  const bits = await derivePairwiseBits(me, targetPublicRaw, roomId);
  const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(payload))));
  bits.fill(0);
  return b64url(concat(iv, ct));
}

/** Opens a payload sealed by the member whose publicRaw is given. */
export async function openFromMember(me: Identity, senderPublicRaw: Uint8Array<ArrayBuffer>, roomId: string, sealed: string): Promise<any> {
  const bits = await derivePairwiseBits(me, senderPublicRaw, roomId);
  const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
  const raw = fromB64url(sealed);
  if (raw.length < 12 + 16) throw new Error("Envelope too short");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
  bits.fill(0);
  return JSON.parse(new TextDecoder().decode(pt));
}
