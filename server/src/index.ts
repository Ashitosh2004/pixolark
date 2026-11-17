/**
 * Pixolark coordinator — zero-database signaling & room coordination server.
 *
 * Responsibilities (all in-memory, all rebuildable):
 * - verify signed room manifests + fresh ownership proofs;
 * - hold short-lived room leases so discovery/availability is truthful;
 * - presence for live members;
 * - relay WebRTC offer/answer SDP between members of the same room (public
 *   data by design — the same class of data ntfy topics carried before).
 *
 * Hard guarantees:
 * - NO database, NO persistence, NO message content ever (E2EE DataChannels
 *   carry all chat traffic — the coordinator never sees plaintext);
 * - after a restart the registry is empty: owners re-register, members
 *   re-join, and clients show honest "coordinator offline" states meanwhile;
 * - no room can be taken over while its lease is live.
 *
 * Run: bun server/src/index.ts   (or node with a TS loader; PORT env respected)
 */
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { RoomRegistry, LEASE_MS, RENEW_MS } from "./registry";
import { checkRegistration, verifyOwnershipProof, authorizedKeys } from "./proof";
import type { ClientToServer, ServerToClient } from "../../src/lib/pixel/coordinator-protocol";

const PORT = Number(process.env["PORT"] ?? 8787);
/** Per-connection message budget: generous for humans, hostile to floods. */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 200;
/** Wire-size caps — a coordinator is not a file host. */
const MAX_FRAME_BYTES = 64 * 1024;

interface ConnState {
  id: string;
  name: string;
  nonce: string; // per-connection replay guard for ownership proofs
  heldRooms: Set<string>;
  rate: number[]; // timestamps of recent messages
}

const started = Date.now();
/** Memory-only room registry. Exported for tests that simulate a restart's
 *  registry wipe (startCoordinator is a singleton per process by design). */
export const registry = new RoomRegistry();
const conns = new Map<WebSocket, ConnState>();
let connSeq = 0;

function send(ws: WebSocket, msg: ServerToClient): void {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  } catch {
    // never crash the coordinator on a dying socket
  }
}

function broadcastRoom(roomId: string, msg: ServerToClient, except?: WebSocket): void {
  // Membership is tracked via heldRooms (set on register/join, cleared on
  // leave/disconnect). We deliberately do NOT re-check the registry here:
  // post-drop notifications (room.offline) must still reach former members.
  for (const [ws, st] of conns) {
    if (ws === except || !st.heldRooms.has(roomId)) continue;
    send(ws, msg);
  }
}

function errorOf(ws: WebSocket, code: string, message: string, roomId?: string): void {
  send(ws, roomId ? { t: "error", code, message, roomId } : { t: "error", code, message });
}

function rateLimited(st: ConnState, now = Date.now()): boolean {
  st.rate = st.rate.filter((t) => now - t < RATE_WINDOW_MS);
  st.rate.push(now);
  return st.rate.length > RATE_MAX;
}

async function handle(ws: WebSocket, st: ConnState, raw: string): Promise<void> {
  if (raw.length > MAX_FRAME_BYTES) return errorOf(ws, "frame-too-large", "Coordinator frames are capped at 64 KB.");
  let msg: ClientToServer;
  try {
    msg = JSON.parse(raw) as ClientToServer;
  } catch {
    return errorOf(ws, "bad-frame", "Coordinator frames must be JSON objects.");
  }
  if (!msg || typeof msg !== "object" || typeof (msg as { t?: unknown }).t !== "string") {
    return errorOf(ws, "bad-frame", "Coordinator frames need a `t` field.");
  }
  if (rateLimited(st)) return errorOf(ws, "rate-limited", "Too many coordinator messages — slow down.");

  switch (msg.t) {
    case "hello": {
      st.name = typeof msg.name === "string" ? msg.name.slice(0, 32) : st.name;
      return;
    }
    case "ping": {
      send(ws, { t: "pong" });
      return;
    }
    case "room.register": {
      const check = await checkRegistration(msg.manifest, msg.proof, st.nonce);
      if (!check.ok) return errorOf(ws, check.code, check.message);
      const res = registry.register(check.manifest, st.id);
      if (!res.ok) return errorOf(ws, res.code!, res.message!, check.manifest.roomId);
      st.heldRooms.add(check.manifest.roomId);
      // The owner is its room's first member (presence is real, never invented).
      registry.join(check.manifest.roomId, st.id, st.name);
      send(ws, { t: "room.registered", roomId: check.manifest.roomId, leaseMs: res.leaseMs ?? LEASE_MS });
      broadcastRoom(check.manifest.roomId, { t: "room.state", roomId: check.manifest.roomId, manifest: check.manifest, members: registry.membersOf(check.manifest.roomId) });
      return;
    }
    case "room.lease": {
      const rec = registry.manifestOf(msg.roomId);
      if (!rec) return errorOf(ws, "room-unavailable", "This room is not registered on this coordinator.", msg.roomId);
      if (!(await verifyOwnershipProof(msg.proof, msg.roomId, authorizedKeys(rec), st.nonce))) {
        return errorOf(ws, "proof-invalid", "Lease renewal needs a fresh ownership proof.", msg.roomId);
      }
      const res = registry.renew(msg.roomId, st.id);
      if (!res.ok) return errorOf(ws, res.code!, res.message!, msg.roomId);
      send(ws, { t: "room.registered", roomId: msg.roomId, leaseMs: res.leaseMs ?? RENEW_MS });
      return;
    }
    case "room.unregister": {
      const rec = registry.manifestOf(msg.roomId);
      if (!rec) return;
      if (!(await verifyOwnershipProof(msg.proof, msg.roomId, authorizedKeys(rec), st.nonce))) {
        return errorOf(ws, "proof-invalid", "Unregister needs a fresh ownership proof.", msg.roomId);
      }
      registry.unregister(msg.roomId, st.id);
      st.heldRooms.delete(msg.roomId);
      return;
    }
    case "room.probe": {
      // Availability = a live lease + live owner connection. Facts only.
      send(ws, { t: "room.probe", roomId: msg.roomId, available: registry.has(msg.roomId) });
      return;
    }
    case "room.join": {
      const res = registry.join(msg.roomId, st.id, typeof msg.name === "string" ? msg.name.slice(0, 32) : "Member");
      if (!res.ok || !res.manifest) {
        return errorOf(ws, res.code ?? "room-unavailable", "Room temporarily unavailable — its coordinator lease is not live right now.", msg.roomId);
      }
      st.heldRooms.add(msg.roomId);
      send(ws, { t: "room.state", roomId: msg.roomId, manifest: res.manifest, members: res.members ?? [] });
      broadcastRoom(msg.roomId, { t: "room.members", roomId: msg.roomId, members: registry.membersOf(msg.roomId) });
      return;
    }
    case "room.leave": {
      registry.leave(msg.roomId, st.id);
      st.heldRooms.delete(msg.roomId);
      broadcastRoom(msg.roomId, { t: "room.members", roomId: msg.roomId, members: registry.membersOf(msg.roomId) });
      return;
    }
    case "rtc": {
      // WebRTC signaling relay: offer/answer SDP is public data (contains ICE
      // candidates and key commitments, never message content).
      if (typeof msg.to !== "string" || msg.data === undefined) return errorOf(ws, "bad-frame", "rtc relay needs `to` and `data`.");
      if (!registry.memberIds(msg.roomId).includes(st.id)) return errorOf(ws, "not-a-member", "Join the room before signaling.", msg.roomId);
      let target: WebSocket | null = null;
      for (const [peer, peerState] of conns) {
        if (peerState.id === msg.to && peerState.heldRooms.has(msg.roomId)) {
          target = peer;
          break;
        }
      }
      if (!target) return errorOf(ws, "peer-absent", "That member is not on this coordinator right now.", msg.roomId);
      send(target, { t: "rtc", roomId: msg.roomId, from: st.id, data: msg.data });
      return;
    }
    default: {
      errorOf(ws, "bad-frame", `Unknown message type.`);
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") {
    const s = registry.stats();
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify({ ok: true, uptimeMs: Date.now() - started, rooms: s.rooms, connections: s.connectionsHeld }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not-found" }));
});

let wss = createWss();

/** (Re)create the WebSocket server for the (re)started coordinator. A restart
 *  tears the old one down; a fresh instance must re-attach its upgrade handler
 *  or every /coordinator handshake answers 404. */
function createWss(): WebSocketServer {
  const w = new WebSocketServer({ server, path: "/coordinator", maxPayload: MAX_FRAME_BYTES });
  w.on("connection", (ws: WebSocket) => {
    const st: ConnState = {
      id: `c${++connSeq}`,
      name: "Member",
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
      heldRooms: new Set(),
      rate: [],
    };
    conns.set(ws, st);
    send(ws, { t: "welcome", clientId: st.id, serverTime: Date.now(), nonce: st.nonce });

    ws.on("message", (data) => {
      void handle(ws, st, String(data)).catch(() => errorOf(ws, "internal", "Coordinator failed to handle that message."));
    });
    ws.on("close", () => {
      conns.delete(ws);
      for (const roomId of registry.dropConnection(st.id)) st.heldRooms.delete(roomId);
    });
    ws.on("error", () => {
      conns.delete(ws);
      registry.dropConnection(st.id);
    });
  });
  return w;
}

// Registry events → live updates for members.
registry.onRoomOffline = (roomId, reason) => {
  broadcastRoom(roomId, { t: "room.offline", roomId, reason });
};
registry.onMembersChanged = (roomId) => {
  broadcastRoom(roomId, { t: "room.members", roomId, members: registry.membersOf(roomId) });
};
registry.start();

const shutdown = (): void => {
  registry.stop();
  for (const ws of conns.keys()) ws.close();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref?.();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "")) {
  server.listen(PORT, () => {
    console.log(`[pixolark-coordinator] listening on :${PORT} (ws: /coordinator, health: /health) — in-memory only`);
  });
}

/** Test/embedding entry: start the coordinator on any port (0 = ephemeral).
 *  A start is a restart: the registry begins empty and stays honest — rooms
 *  reappear only when their owners re-register with fresh ownership proofs. */
export function startCoordinator(port: number | 0 = PORT): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    // Restart semantics: no ghosts of a previous process are allowed.
    registry.reset();
    for (const ws of conns.keys()) ws.close();
    conns.clear();
    wss.close();
    wss = createWss();
    const s = server.listen(port, () => {
      const p = (s.address() as { port: number }).port;
      resolve({
        port: p,
        close: () =>
          new Promise<void>((done) => {
            registry.stop();
            registry.reset();
            for (const ws of conns.keys()) ws.close();
            conns.clear();
            wss.close();
            s.close(() => done());
          }),
      });
    });
  });
}
