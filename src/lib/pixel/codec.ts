/** Connection codes: compressed, URL-safe descriptions of a WebRTC offer/answer.
 *  They contain ONLY public data (SDP, room ID, public-key commitment, expiry). */
import { b64url, fromB64url, te, td } from "./bytes";

const PREFIX = "PXC1.";
export const OFFER_TTL_MS = 15 * 60 * 1000;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface ConnectionPayload {
  v: 1;
  kind: "offer" | "answer";
  room: string;
  sdp: string;
  commit: string; // hash of sender's ECDH public key
  exp: number;
  sid: string; // session id, prevents duplicate/mismatched answers
}

export function generateRoomId(): string {
  const r = crypto.getRandomValues(new Uint8Array(10));
  const chars = Array.from(r, (x) => ALPHA[x % 32]).join("");
  return `PX-${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export function normalizeRoomId(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidRoomId(s: string): boolean {
  return /^PX-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(normalizeRoomId(s));
}

async function compress(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof CompressionStream === "undefined") return data;
  const cs = new Response(data).body!.pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(cs).arrayBuffer());
}
async function decompress(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const ds = new Response(data).body!.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

export async function encodeConnection(p: ConnectionPayload): Promise<string> {
  return PREFIX + b64url(await compress(te.encode(JSON.stringify(p))));
}

export class CodeError extends Error {}

export async function decodeConnection(code: string): Promise<ConnectionPayload> {
  const c = code.trim().replace(/\s+/g, "");
  if (!c.startsWith(PREFIX)) throw new CodeError("This doesn't look like a Pixolark connection code.");
  let p: ConnectionPayload;
  try {
    p = JSON.parse(td.decode(await decompress(fromB64url(c.slice(PREFIX.length)))));
  } catch {
    throw new CodeError("The connection code is damaged or incomplete. Copy it again.");
  }
  if (p.v !== 1 || !p.sdp || !p.room || !p.commit || !p.sid) throw new CodeError("Unsupported or invalid connection code.");
  if (Date.now() > p.exp) throw new CodeError("This connection code has expired. Ask your friend for a new one.");
  return p;
}

export function dtlsFingerprints(sdp: string): string {
  return Array.from(sdp.matchAll(/a=fingerprint:(\S+ \S+)/g), (m) => m[1]).sort().join(",");
}
