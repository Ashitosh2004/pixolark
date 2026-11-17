/**
 * Ownership proofs — how a coordinator knows a registration/lease actually
 * comes from the room's owner (or an authorized co-owner) and not from someone
 * who merely copied the public manifest.
 *
 * Proof = ECDSA-P256 signature over `proofPayload(roomId, ts)` with the signing
 * key whose PUBLIC half is embedded in the manifest. Timestamps bound replay.
 * Pure WebCrypto: identical behavior in browser, Bun and Node ≥ 22.
 */
import { fromB64url, te } from "../../src/lib/pixel/bytes";
import { PROOF_TOLERANCE_MS, proofPayload, type OwnershipProof } from "../../src/lib/pixel/coordinator-protocol";
import { verifyManifest, type RoomManifest } from "../../src/lib/pixel/manifest";

async function verifySig(sigB64: string, ts: number, roomId: string, nonce: string, keyRawB64: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromB64url(keyRawB64), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(sigB64) as unknown as BufferSource, te.encode(proofPayload(roomId, ts, nonce)));
  } catch {
    return false;
  }
}

/** Who is allowed to act for this room per its manifest policy. */
export function authorizedKeys(m: RoomManifest): string[] {
  return m.policy.recovery === "co-owner" ? [m.owner.signingKey, ...m.policy.coOwners] : [m.owner.signingKey];
}

/**
 * Freshness-checked proof validation for a REGISTERED manifest.
 * `nonce` must be the per-connection nonce the coordinator issued in `welcome`.
 */
export async function verifyOwnershipProof(proof: OwnershipProof, roomId: string, allowedKeys: string[], nonce: string, now = Date.now()): Promise<boolean> {
  if (typeof proof?.ts !== "number" || Math.abs(now - proof.ts) > PROOF_TOLERANCE_MS) return false;
  if (typeof proof?.nonce !== "string" || proof.nonce !== nonce) return false; // replay guard
  for (const key of allowedKeys) {
    if (await verifySig(proof.sig, proof.ts, roomId, nonce, key)) return true;
  }
  return false;
}

export type RegisterCheck =
  | { ok: true; manifest: RoomManifest }
  | { ok: false; code: string; message: string };

/** Full registration gate: manifest integrity + fresh, connection-bound ownership proof. */
export async function checkRegistration(manifest: unknown, proof: OwnershipProof, nonce: string, now = Date.now()): Promise<RegisterCheck> {
  const m = await verifyManifest(manifest, now);
  if (!m.ok) return { ok: false, code: "manifest-invalid", message: `Room manifest rejected: ${m.reason}` };
  const proofOk = await verifyOwnershipProof(proof, m.manifest.roomId, authorizedKeys(m.manifest), nonce, now);
  if (!proofOk) return { ok: false, code: "proof-invalid", message: "Ownership proof missing, stale, replayed, or signed by an unauthorized key." };
  return { ok: true, manifest: m.manifest };
}
