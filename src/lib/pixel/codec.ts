/** Connection codes: compressed, URL-safe descriptions of a WebRTC offer/answer.
 *  They contain ONLY public data (SDP, room ID, public-key commitment, expiry). */
import { b64url, fromB64url, te, td } from "./bytes";

const PREFIX = "PXC1.";
export const OFFER_TTL_MS = 15 * 60 * 1000;

export interface ConnectionPayload {
  v: 1;
  kind: "offer" | "answer";
  room: string;
  sdp: string;
  commit: string; // hash of sender's ECDH public key
  exp: number;
  sid: string; // session id, prevents duplicate/mismatched answers
}

/** Generates a simple 6-digit room code (e.g. "582914"). */
export function generateRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  const num = (bytes[0] % 900000) + 100000;
  return `${num}`;
}

export function normalizeRoomId(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidRoomId(s: string): boolean {
  const n = normalizeRoomId(s);
  // Validates 6-digit code (e.g. 123456), PX-6digits, or legacy PX-XXXXX-XXXXX format
  return /^\d{6}$/.test(n) || /^PX-\d{6}$/.test(n) || /^PX-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(n);
}

/** Strip unnecessary SDP lines to minimize payload size for QR codes and fast copy/paste. */
export function compactSdp(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("a=extmap-allow-mixed")) continue;
    if (trimmed.startsWith("a=msid-semantic")) continue;
    if (trimmed.startsWith("a=ice-options:trickle")) continue;
    if (trimmed.startsWith("a=candidate:")) {
      if (trimmed.includes(" typ relay ")) continue;
      if (trimmed.includes(" tcptype ")) continue;
      if (trimmed.includes("fe80:")) continue;
    }
    kept.push(trimmed);
  }
  return kept.join("\r\n") + "\r\n";
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
  const payload: ConnectionPayload = {
    ...p,
    sdp: compactSdp(p.sdp),
  };
  return PREFIX + b64url(await compress(te.encode(JSON.stringify(payload))));
}

export class CodeError extends Error {}

export async function decodeConnection(code: string): Promise<ConnectionPayload> {
  // Extract PXC1 token even if user pasted extra text, URL, or spaces
  const match = code.match(/PXC1\.[A-Za-z0-9_-]+/);
  const c = match ? match[0] : code.trim().replace(/\s+/g, "");
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
