/**
 * Ephemeral signaling helper using public zero-knowledge pub/sub.
 * Allows peers to exchange offer and answer using just the 6-digit room code.
 * No user accounts, database, or chat data are ever stored here.
 * Only the encrypted WebRTC connection tokens are temporarily relayed for 2 minutes.
 */

const NTFY_PREFIX = "pxl_";

/** Tombstone body the room creator publishes when they leave, so joiners stop retrying a dead room. */
export const ROOM_CLOSED = "PXROOM-CLOSED";

function topicFor(roomId: string, kind: "offer" | "answer") {
  const cleanRoom = roomId.replace(/\D/g, "") || roomId;
  return `${NTFY_PREFIX}${cleanRoom}_${kind}`;
}

export async function publishSignal(roomId: string, kind: "offer" | "answer", code: string): Promise<boolean> {
  try {
    const res = await fetch(`https://ntfy.sh/${topicFor(roomId, kind)}`, {
      method: "POST",
      body: code,
      headers: { "Title": `Pixolark ${kind}` },
      keepalive: true, // lets the room-closed tombstone survive the pagehide that follows it
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Newest-first: the latest code on the topic, or closed=true when the creator's tombstone is the newest message. */
export async function fetchSignal(roomId: string, kind: "offer" | "answer"): Promise<{ code: string | null; closed: boolean }> {
  try {
    const res = await fetch(`https://ntfy.sh/${topicFor(roomId, kind)}/json?poll=1`);
    if (!res.ok) return { code: null, closed: false };
    const text = await res.text();
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const json = JSON.parse(lines[i]!);
        if (json.message?.includes(ROOM_CLOSED)) return { code: null, closed: true };
        if (json.message && json.message.includes("PXC1.")) {
          const match = json.message.match(/PXC1\.[A-Za-z0-9_-]+/);
          if (match) return { code: match[0], closed: false };
        }
      } catch {
        // ignore malformed line
      }
    }
    return { code: null, closed: false };
  } catch {
    return { code: null, closed: false };
  }
}

export function subscribeSignal(roomId: string, kind: "offer" | "answer", onSignal: (code: string) => void): () => void {
  const topic = topicFor(roomId, kind);
  let stopped = false;
  let es: EventSource | null = null;

  try {
    if (typeof EventSource !== "undefined") {
      es = new EventSource(`https://ntfy.sh/${topic}/sse`);
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.message && data.message.includes("PXC1.")) {
            const match = data.message.match(/PXC1\.[A-Za-z0-9_-]+/);
            if (match) onSignal(match[0]);
          }
        } catch {
          // ignore
        }
      };
    }
  } catch {
    // fallback to poll
  }

  // Backup poll every 2.5 seconds
  const interval = setInterval(async () => {
    if (stopped) return;
    const { code } = await fetchSignal(roomId, kind);
    if (code) onSignal(code);
  }, 2500);

  return () => {
    stopped = true;
    clearInterval(interval);
    es?.close();
  };
}
