/**
 * Ephemeral signaling helper using public zero-knowledge pub/sub.
 * Allows peers to exchange offer and answer using just the room code.
 * No user accounts, database, or chat data are ever stored here.
 * Only the encrypted WebRTC connection tokens are temporarily relayed.
 *
 * Rate-limit discipline (ntfy.sh free tier: ~60 requests / 5 min and
 * ~250 messages / day per visitor IP) is part of the design:
 * - SSE is the primary transport; the HTTP poll is a slow fallback, never a treadmill.
 * - Publishes back off instead of failing silently into a dead topic.
 */
import { b64url } from "./bytes";

const NTFY_PREFIX = "pxl_";

/** Tombstone body the room creator publishes when they leave, so joiners stop retrying a dead room. */
export const ROOM_CLOSED = "PXROOM-CLOSED";

const PXC1_RE = /PXC1\.[A-Za-z0-9_-]+/;

function topicFor(roomId: string, kind: "offer" | "answer") {
  const cleanRoom = roomId.replace(/\D/g, "") || roomId;
  return `${NTFY_PREFIX}${cleanRoom}_${kind}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Publishes a signaling code. Retries transient failures with backoff so a
 * momentary rate limit or hiccup can't leave a stale/empty topic behind.
 * The room-closed tombstone must stay single-shot: it rides a pagehide
 * (keepalive), and a retry would never fire after unload.
 */
export async function publishSignal(roomId: string, kind: "offer" | "answer", code: string, retries = 2): Promise<boolean> {
  // Tombstones self-protect regardless of the requested retries: they are
  // published during pagehide, where timers never fire again — a retry would
  // silently never happen and keepalive must carry the request instead.
  const isTombstone = code === ROOM_CLOSED;
  const maxRetries = isTombstone ? 0 : retries;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`https://ntfy.sh/${topicFor(roomId, kind)}`, {
        method: "POST",
        body: code,
        headers: { "Title": `Pixolark ${kind}` },
        keepalive: isTombstone, // must survive the unload that follows it
      });
      if (res.ok) return true;
      if (attempt >= maxRetries) return false;
    } catch {
      if (attempt >= maxRetries) return false;
    }
    await sleep(3000 * (attempt + 1));
  }
}

/** Newest-first: the latest code on the topic, or closed=true when the creator's tombstone is the newest message. */
export async function fetchSignal(roomId: string, kind: "offer" | "answer"): Promise<{ code: string | null; closed: boolean; limited: boolean }> {
  try {
    const res = await fetch(`https://ntfy.sh/${topicFor(roomId, kind)}/json?poll=1`);
    if (!res.ok) return { code: null, closed: false, limited: res.status === 429 };
    const text = await res.text();
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const json = JSON.parse(lines[i]!);
        if (json.message?.includes(ROOM_CLOSED)) return { code: null, closed: true, limited: false };
        if (json.message && json.message.includes("PXC1.")) {
          const match = json.message.match(PXC1_RE);
          if (match) return { code: match[0], closed: false, limited: false };
        }
      } catch {
        // ignore malformed line
      }
    }
    return { code: null, closed: false, limited: false };
  } catch {
    return { code: null, closed: false, limited: false };
  }
}

const POLL_MIN_MS = 15_000; // healthy fallback cadence — never a 2.5s treadmill
const POLL_MAX_MS = 60_000; // back off hard while the pub/sub says "too many requests"
/** Trust the SSE stream only while it demonstrably flows: a connection can sit
 *  "open" forever without delivering a single event (proxies, hung sockets). */
const STREAM_TRUST_MS = 5 * 60_000;

/**
 * Live subscription for incoming codes. SSE is primary; a slow HTTP poll exists
 * only as a fallback (SSE silent/down) and as one catch-up sweep for anything
 * published before the stream opened. Backs off when the pub/sub rate-limits us.
 */
export function subscribeSignal(roomId: string, kind: "offer" | "answer", onSignal: (code: string) => void): () => void {
  const topic = topicFor(roomId, kind);
  let stopped = false;
  let timer = 0;
  let delay = POLL_MIN_MS; // current fallback cadence; doubles while rate-limited
  let lastSseAt = 0; // when the stream last delivered ANY event (proof of flow)
  let es: EventSource | null = null;

  const handle = (text: string) => {
    try {
      if (!text.includes("PXC1.")) return;
      const match = text.match(PXC1_RE);
      if (match) onSignal(match[0]);
    } catch {
      // ignore
    }
  };

  try {
    if (typeof EventSource !== "undefined") {
      es = new EventSource(`https://ntfy.sh/${topic}/sse`);
      es.onmessage = (e) => { lastSseAt = Date.now(); handle(String(e.data ?? "")); };
    }
  } catch {
    es = null; // fall back to polling
  }

  const poll = async () => {
    if (stopped) return;
    // The stream gets the benefit of the doubt only while it has recently
    // delivered SOMETHING; a hung socket stays readyState OPEN but silent.
    const sseAlive = !!es && es.readyState === 1 && Date.now() - lastSseAt < STREAM_TRUST_MS;
    if (sseAlive) {
      timer = window.setTimeout(poll, POLL_MIN_MS);
      return;
    }
    const { code, limited } = await fetchSignal(roomId, kind);
    if (stopped) return;
    if (code) onSignal(code);
    // 429 (or a dead network): back off exponentially, capped.
    delay = limited ? Math.min(POLL_MAX_MS, delay * 2) : POLL_MIN_MS;
    timer = window.setTimeout(poll, delay);
  };

  // One catch-up sweep shortly after subscribing: covers signals published in the
  // gap before the SSE stream opened (e.g. while the host session was still assembling).
  timer = window.setTimeout(poll, 3000);

  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    es?.close();
  };
}
