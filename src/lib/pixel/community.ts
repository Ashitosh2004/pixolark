/**
 * Community-room glue — ties the stable user identity (recovery registry) to
 * the coordinator and the signed-manifest world.
 *
 * Responsibilities:
 * - ensureUserIdentity(): the user's PERSISTENT identity — an extractable ECDH
 *   key pair (the WebRTC host anchor whose commitment lives inside room
 *   manifests) plus an ECDSA manifest-signing subkey. Stored ONLY in this
 *   device's encrypted recovery registry; never sent anywhere automatically.
 * - registerCommunityRoom(): sign + register a room manifest with the live
 *   coordinator (leases it while this device hosts).
 * - verifyOfferAgainstManifest(): joiners refuse offers whose host commitment
 *   doesn't match the room's signed manifest — a stranger can't impersonate
 *   the host of a listed community room.
 * - exportManifest(): download the signed manifest for manual directory
 *   submission (the static directory is built by the owner CLI; there is no
 *   backend to auto-publish to).
 */
import { b64url, fromB64url } from "./bytes";
import { commitmentOf, type Identity } from "./crypto";
import { decodeConnection } from "./codec";
import {
  exportSigningPrivateKeyPkcs8,
  generateSigningKey,
  importSigningPrivateKeyPkcs8,
  ownerFingerprint,
  type RoomManifest,
} from "./manifest";
import { loadRecovery, saveRecovery, type RecoveryPayload } from "./recovery";
import type { CoordinatorClient } from "./coordinator";

export interface UserIdentity {
  identity: Identity;
  /** Manifest signing subkey (private). PROOF of room ownership. */
  signPriv: CryptoKey;
  signPubRaw: Uint8Array<ArrayBuffer>;
  /** Public fingerprint of the signing key — embedded in manifests. */
  ownerId: string;
  /** The user's stable Pixolark ID (hex commitment of the ECDH identity). */
  pixolarkId: string;
}

/** ECDSA/ECDH public raw point (04||x||y) recovered from a PKCS8 private key. */
async function publicRawFromPrivate(priv: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  const dec = (s: string) => fromB64url(s);
  const x = dec(jwk.x!), y = dec(jwk.y!);
  const out = new Uint8Array(1 + x.length + y.length);
  out[0] = 0x04;
  out.set(x, 1);
  out.set(y, 1 + x.length);
  return out;
}

async function identityFromPkcs8(pkcs8: Uint8Array<ArrayBuffer>): Promise<Identity> {
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  const pub = await crypto.subtle.importKey("jwk", { kty: jwk.kty!, crv: jwk.crv!, x: jwk.x!, y: jwk.y! } as JsonWebKey, { name: "ECDH", namedCurve: "P-256" }, true, []);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pub));
  return { keyPair: { privateKey: priv, publicKey: pub }, publicRaw, commitment: await commitmentOf(publicRaw) };
}

/**
 * The user's stable identity — loaded from the encrypted recovery registry or
 * created once and stored. The SAME identity signs nothing; it is the ECDH
 * anchor manifests point at. The signing subkey is what proves ownership.
 */
export async function ensureUserIdentity(): Promise<UserIdentity> {
  const payload = await loadRecovery();
  if (payload.identity) {
    const identity = await identityFromPkcs8(fromB64url(payload.identity.ecdhPkcs8));
    const signPriv = await importSigningPrivateKeyPkcs8(fromB64url(payload.identity.signPkcs8));
    const signPubRaw = await publicRawFromPrivate(signPriv);
    return {
      identity,
      signPriv,
      signPubRaw,
      ownerId: await ownerFingerprint(signPubRaw),
      pixolarkId: payload.identity.pixolarkId || identity.commitment,
    };
  }

  // Fresh identity — extractable by design so the encrypted backup can carry it.
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const identity: Identity = {
    keyPair: pair,
    publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    commitment: "",
  };
  identity.commitment = await commitmentOf(identity.publicRaw);
  const sign = await generateSigningKey();
  const signPubRaw = await publicRawFromPrivate(sign.privateKey);
  const user: UserIdentity = {
    identity,
    signPriv: sign.privateKey,
    signPubRaw,
    ownerId: await ownerFingerprint(signPubRaw),
    pixolarkId: identity.commitment,
  };
  await saveRecovery({
    identity: {
      name: "",
      pixolarkId: identity.commitment,
      ecdhPkcs8: b64url(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      signPkcs8: b64url(await exportSigningPrivateKeyPkcs8(sign.privateKey)),
    },
  });
  return user;
}

/** Persist a display name next to the stable identity (recovery registry). */
export async function saveUserName(name: string): Promise<void> {
  const payload = await loadRecovery();
  if (!payload.identity) return;
  const identity: NonNullable<RecoveryPayload["identity"]> = { ...payload.identity, name };
  await saveRecovery({ identity });
}

export interface CommunityRoomMeta {
  name: string;
  desc?: string;
  type: "public" | "private";
  category: string;
  region?: string;
  subRegion?: string;
  city?: string;
  languages: string[];
}

/**
 * Create + register a manifest for a room THIS device hosts. The manifest's
 * host commitment is the STABLE user identity's commitment, so joiners verify
 * the live WebRTC peer against the manifest across restarts. The signed
 * manifest is also stored in the local recovery registry for restart recovery.
 */
export async function registerCommunityRoom(client: CoordinatorClient, roomId: string, meta: CommunityRoomMeta, user: UserIdentity, existingManifest?: RoomManifest): Promise<RoomManifest> {
  const manifest = await client.createRoom({
    roomId,
    name: meta.name,
    ...(meta.desc ? { desc: meta.desc } : {}),
    type: meta.type,
    category: meta.category,
    ...(meta.region ? { region: meta.region } : {}),
    ...(meta.subRegion ? { subRegion: meta.subRegion } : {}),
    ...(meta.city ? { city: meta.city } : {}),
    languages: meta.languages,
    hostCommitment: user.identity.commitment,
    signPriv: user.signPriv,
    signPubRaw: user.signPubRaw,
    ownerId: user.ownerId,
  });
  // Local memory for restart recovery: owned room → manifest (+ which ones we own).
  const payload = await loadRecovery();
  const manifests = { ...payload.manifests, [manifest.roomId]: existingManifest ?? manifest };
  const owned = [...new Set([...payload.ownedRoomIds, manifest.roomId])];
  await saveRecovery({ manifests, ownedRoomIds: owned });
  return manifest;
}

/**
 * Re-register an EXISTING manifest after a restart (owner recovery). Uses the
 * manifest stored in the recovery registry; the stable identity means the host
 * commitment still matches the live doorbell.
 */
export async function reownCommunityRoom(client: CoordinatorClient, roomId: string, user: UserIdentity): Promise<RoomManifest | null> {
  const payload = await loadRecovery();
  const manifest = payload.manifests[roomId];
  if (!manifest) return null;
  const ok = await client.reown(manifest, user.signPriv);
  return ok ? manifest : null;
}

/**
 * Joiner-side trust check: the offer's host commitment must equal the signed
 * manifest's — otherwise this "room" is not hosted by its registered owner.
 * Throws with an honest message; callers refuse the join.
 */
export async function verifyOfferAgainstManifest(offerCode: string, manifest: RoomManifest): Promise<void> {
  const p = await decodeConnection(offerCode);
  if (p.commit !== manifest.host.commitment) {
    throw new Error("The host's identity does not match this room's signed manifest. The room listing may be stale — do not connect.");
  }
}

/** Download the signed manifest — the owner's artifact for directory submission. */
export function exportManifest(manifest: RoomManifest): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `pixolark-room-${manifest.roomId}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Honest availability probe for a directory room. `null` means "couldn't ask"
 * (coordinator down / no route) — callers must treat that as UNAVAILABLE, not
 * as an optimistic yes.
 */
export async function probeCommunityRoom(client: CoordinatorClient, roomId: string): Promise<boolean | null> {
  if (!(await client.ready(6000))) return null; // couldn't ask — honest
  const waiter = client.onceProbe(roomId, 6000); // waiter registers BEFORE the ask
  client.probe(roomId);
  return waiter;
}
