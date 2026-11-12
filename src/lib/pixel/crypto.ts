/**
 * End-to-end encryption layer (Web Crypto only).
 * - ECDH P-256 ephemeral key pair per session (private key is non-extractable, memory only)
 * - HKDF-SHA-256 derives two AES-GCM-256 keys (one per direction)
 * - Every frame: fresh random 96-bit IV + monotonically increasing sequence number in AAD
 */
import { concat, hex, te } from "./bytes";

export interface Identity {
  keyPair: CryptoKeyPair;
  publicRaw: Uint8Array<ArrayBuffer>;
  commitment: string; // short hash of public key, safe to share in connection codes
}

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export async function createIdentity(): Promise<Identity> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { keyPair, publicRaw, commitment: await commitmentOf(publicRaw) };
}

export async function commitmentOf(publicRaw: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex((await sha256(publicRaw)).subarray(0, 16));
}

function cmp(a: Uint8Array, b: Uint8Array) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

export interface SessionKeys {
  sendKey: CryptoKey;
  recvKey: CryptoKey;
  fingerprint: string; // human-comparable safety code (same on both sides)
}

/**
 * @param role "host" or "guest" — determines direction of the derived keys
 * @param context binds keys to room ID and DTLS fingerprints of both peers
 */
export async function deriveSessionKeys(
  me: Identity,
  peerPublicRaw: Uint8Array<ArrayBuffer>,
  role: "host" | "guest",
  context: string,
): Promise<SessionKeys> {
  const peerKey = await crypto.subtle.importKey("raw", peerPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, me.keyPair.privateKey, 256);
  const [a, b] = cmp(me.publicRaw, peerPublicRaw) < 0 ? [me.publicRaw, peerPublicRaw] : [peerPublicRaw, me.publicRaw];
  const transcript = concat(te.encode("PIXELCHAT/v1|" + context + "|"), a, b);
  const salt = await sha256(transcript);
  const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("pixelchat keys") }, hkdfKey, 512),
  );
  const hostToGuest = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
  const guestToHost = await crypto.subtle.importKey("raw", bits.slice(32, 64), "AES-GCM", false, ["encrypt", "decrypt"]);
  bits.fill(0);
  const fpHash = await sha256(transcript);
  const fp = hex(fpHash.subarray(0, 15)).toUpperCase().match(/.{5}/g)!.join(" ");
  return {
    sendKey: role === "host" ? hostToGuest : guestToHost,
    recvKey: role === "host" ? guestToHost : hostToGuest,
    fingerprint: fp,
  };
}

function seqBytes(seq: number) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(seq));
  return b;
}

/** Frame layout: [8 bytes seq][12 bytes IV][ciphertext+tag] */
export async function sealFrame(key: CryptoKey, seq: number, plaintext: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sb = seqBytes(seq);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: sb }, key, plaintext));
  return concat(sb, iv, ct);
}

export async function openFrame(key: CryptoKey, frame: Uint8Array<ArrayBuffer>, lastSeq: number): Promise<{ seq: number; plaintext: Uint8Array<ArrayBuffer> }> {
  if (frame.length < 8 + 12 + 16) throw new Error("Frame too short");
  const sb = frame.slice(0, 8);
  const seq = Number(new DataView(sb.buffer).getBigUint64(0));
  if (seq <= lastSeq) throw new Error("Replayed or out-of-order frame");
  const iv = frame.slice(8, 20);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: sb }, key, frame.slice(20));
  return { seq, plaintext: new Uint8Array(pt) };
}

/** Plaintext envelope: [4 byte header length][JSON header][binary body] */
export function packEnvelope(header: unknown, body?: Uint8Array): Uint8Array<ArrayBuffer> {
  const h = te.encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, h.length);
  return concat(len, h, body ?? new Uint8Array(0));
}

export function unpackEnvelope(data: Uint8Array<ArrayBuffer>): { header: any; body: Uint8Array<ArrayBuffer> } {
  const n = new DataView(data.buffer, data.byteOffset).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + n)));
  return { header, body: data.slice(4 + n) };
}
