/**
 * Ephemeral signaling helper using public zero-knowledge pub/sub.
 * Allows peers to exchange offer and answer using just the 6-digit room code.
 * No user accounts, database, or chat data are ever stored here.
 * Only the encrypted WebRTC connection tokens are temporarily relayed for 2 minutes.
 */

const NTFY_PREFIX = "pxl_";

export async function publishSignal(roomId: string, kind: "offer" | "answer", code: string): Promise<boolean> {
  try {
    const cleanRoom = roomId.replace(/\D/g, "") || roomId;
    const topic = `${NTFY_PREFIX}${cleanRoom}_${kind}`;
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      body: code,
      headers: { "Title": `Pixolark ${kind}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchSignal(roomId: string, kind: "offer" | "answer"): Promise<string | null> {
  try {
    const cleanRoom = roomId.replace(/\D/g, "") || roomId;
    const topic = `${NTFY_PREFIX}${cleanRoom}_${kind}`;
    const res = await fetch(`https://ntfy.sh/${topic}/json?poll=1`);
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const json = JSON.parse(lines[i]!);
        if (json.message && json.message.includes("PXC1.")) {
          const match = json.message.match(/PXC1\.[A-Za-z0-9_-]+/);
          if (match) return match[0];
        }
      } catch {
        // ignore malformed line
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function subscribeSignal(roomId: string, kind: "offer" | "answer", onSignal: (code: string) => void): () => void {
  const cleanRoom = roomId.replace(/\D/g, "") || roomId;
  const topic = `${NTFY_PREFIX}${cleanRoom}_${kind}`;
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
    const code = await fetchSignal(roomId, kind);
    if (code) onSignal(code);
  }, 2500);

  return () => {
    stopped = true;
    clearInterval(interval);
    es?.close();
  };
}

