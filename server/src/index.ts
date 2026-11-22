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
import http, { type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { RoomRegistry, LEASE_MS, RENEW_MS } from "./registry";
import { checkRegistration, verifyOwnershipProof, authorizedKeys } from "./proof";
import { isValidRoomId } from "../../src/lib/pixel/codec";
import type { ClientToServer, ServerToClient } from "../../src/lib/pixel/coordinator-protocol";

const PORT = Number(process.env["PORT"] ?? 8787);
/** Per-connection message budget: generous for humans, hostile to floods. */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 200;
/** Wire-size caps — a coordinator is not a file host. */
const MAX_FRAME_BYTES = 64 * 1024;
/** Resource caps (env-overridable so tests can exercise them cheaply): protect
 *  small hosts from memory exhaustion while staying generous for humans. */
const MAX_CONNECTIONS = Number(process.env["COORD_MAX_CONNECTIONS"] ?? 512);
const MAX_CONNS_PER_IP = Number(process.env["COORD_MAX_CONNS_PER_IP"] ?? 8);
const MAX_ROOMS_PER_CONN = Number(process.env["COORD_MAX_ROOMS_PER_CONN"] ?? 8);
/** WS liveness: silent connections (dropped mobile links) are reaped so
 *  presence stays honest and memory stays bounded. */
const PING_MS = Number(process.env["COORD_PING_MS"] ?? 30_000);
/** Optional WS origin allowlist (comma-separated). Unset = public coordinator:
 *  any origin may connect, matching the beacon/ntfy semantics. Set it in
 *  production (e.g. ALLOWED_ORIGINS=https://pixolark.vercel.app) so only your
 *  frontend can use this coordinator. Read per (re)start, not at import. */
const allowedOrigins = (): string[] =>
  (process.env["ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

interface ConnState {
  id: string;
  name: string;
  nonce: string; // per-connection replay guard for ownership proofs
  heldRooms: Set<string>;
  rate: number[]; // timestamps of recent messages
  isAlive: boolean; // pong liveness for the heartbeat sweeper
}

const started = Date.now();
/** Memory-only room registry. Exported for tests that simulate a restart's
 *  registry wipe (startCoordinator is a singleton per process by design). */
export const registry = new RoomRegistry();
const conns = new Map<WebSocket, ConnState>();
const connsPerIp = new Map<string, number>();
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

/** Best-effort client IP for the per-connection cap. Behind a proxy (Render),
 *  the platform overwrites X-Forwarded-For with the real client, so the first
 *  entry is trusted there; direct/local connections fall back to the socket
 *  address (header-less, so nothing is spoofable in that mode). */
function clientIpOf(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function rateLimited(st: ConnState, now = Date.now()): boolean {
  st.rate = st.rate.filter((t) => now - t < RATE_WINDOW_MS);
  // Once over budget, refuse WITHOUT pushing another timestamp: a flood can no
  // longer grow this array inside the window (memory stays bounded).
  if (st.rate.length >= RATE_MAX) return true;
  st.rate.push(now);
  return false;
}

/** Presence names are public room metadata: cap length and strip control
 *  characters (C0/C1, bidi overrides & isolates, BOM) so names can't carry
 *  invisible spoofing tricks. ZWJ/ZWNJ survive — emoji and Indic conjuncts
 *  still render. Empty result falls back to the honest default name. */
function cleanName(s: string): string {
  const cleaned = s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .slice(0, 32)
    .trim();
  return cleaned || "Member";
}

/** Room ids on the wire must be canonical before any registry lookup — this
 *  rejects type-confused or junk ids with the same rule the manifest uses. */
function isRoomId(x: unknown): x is string {
  return typeof x === "string" && isValidRoomId(x);
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
      if (typeof msg.name === "string") st.name = cleanName(msg.name);
      return;
    }
    case "ping": {
      send(ws, { t: "pong" });
      return;
    }
    case "room.register": {
      const check = await checkRegistration(msg.manifest, msg.proof, st.nonce);
      if (!check.ok) return errorOf(ws, check.code, check.message);
      if (st.heldRooms.size >= MAX_ROOMS_PER_CONN && !st.heldRooms.has(check.manifest.roomId)) {
        return errorOf(ws, "too-many-rooms", `A connection may hold at most ${MAX_ROOMS_PER_CONN} rooms.`, check.manifest.roomId);
      }
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
      if (!isRoomId(msg.roomId)) return errorOf(ws, "bad-frame", "Invalid room id.");
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
      if (!isRoomId(msg.roomId)) return errorOf(ws, "bad-frame", "Invalid room id.");
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
      if (!isRoomId(msg.roomId)) return errorOf(ws, "bad-frame", "Invalid room id.");
      // Availability = a live lease + live owner connection. Facts only.
      send(ws, { t: "room.probe", roomId: msg.roomId, available: registry.has(msg.roomId) });
      return;
    }
    case "room.join": {
      if (!isRoomId(msg.roomId)) return errorOf(ws, "bad-frame", "Invalid room id.");
      const res = registry.join(msg.roomId, st.id, cleanName(typeof msg.name === "string" ? msg.name : ""));
      if (!res.ok || !res.manifest) {
        return errorOf(ws, res.code ?? "room-unavailable", "Room temporarily unavailable — its coordinator lease is not live right now.", msg.roomId);
      }
      st.heldRooms.add(msg.roomId);
      send(ws, { t: "room.state", roomId: msg.roomId, manifest: res.manifest, members: res.members ?? [] });
      broadcastRoom(msg.roomId, { t: "room.members", roomId: msg.roomId, members: registry.membersOf(msg.roomId) });
      return;
    }
    case "room.leave": {
      if (!isRoomId(msg.roomId)) return errorOf(ws, "bad-frame", "Invalid room id.");
      registry.leave(msg.roomId, st.id);
      st.heldRooms.delete(msg.roomId);
      broadcastRoom(msg.roomId, { t: "room.members", roomId: msg.roomId, members: registry.membersOf(msg.roomId) });
      return;
    }
    case "rtc": {
      // WebRTC signaling relay: offer/answer SDP is public data (contains ICE
      // candidates and key commitments, never message content).
      if (!isRoomId(msg.roomId)) return errorOf(ws, "bad-frame", "Invalid room id.");
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
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method-not-allowed" }));
      return;
    }
    const s = registry.stats();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
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
  const origins = allowedOrigins();
  const w = new WebSocketServer({
    server,
    path: "/coordinator",
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: (info, cb) => {
      if (origins.length === 0) return cb(true); // public coordinator (default)
      const origin = typeof info.origin === "string" ? info.origin : "";
      cb(origin !== "" && origins.includes(origin), 403, "Origin not allowed by this coordinator.");
    },
  });
  w.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const ip = clientIpOf(req);
    if (conns.size >= MAX_CONNECTIONS || (connsPerIp.get(ip) ?? 0) >= MAX_CONNS_PER_IP) {
      ws.close(1013, "coordinator-full"); // try-again-later; the client's backoff reconnects
      return;
    }
    const st: ConnState = {
      id: `c${++connSeq}`,
      name: "Member",
      nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url"),
      heldRooms: new Set(),
      rate: [],
      isAlive: true,
    };
    conns.set(ws, st);
    connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1);
    // close and error can both fire; release exactly once by checking conns.
    const release = (): void => {
      if (!conns.delete(ws)) return;
      const n = connsPerIp.get(ip) ?? 1;
      if (n <= 1) connsPerIp.delete(ip);
      else connsPerIp.set(ip, n - 1);
    };
    send(ws, { t: "welcome", clientId: st.id, serverTime: Date.now(), nonce: st.nonce });

    ws.on("pong", () => {
      st.isAlive = true;
    });
    ws.on("message", (data) => {
      void handle(ws, st, String(data)).catch(() => errorOf(ws, "internal", "Coordinator failed to handle that message."));
    });
    ws.on("close", () => {
      release();
      for (const roomId of registry.dropConnection(st.id)) st.heldRooms.delete(roomId);
    });
    ws.on("error", () => {
      release();
      registry.dropConnection(st.id);
    });
  });
  return w;
}

/** Heartbeat sweeper: pings every connection and terminates the ones that
 *  failed to pong since the last round. Dead silent links (elevator, tunnel)
 *  otherwise linger for hours holding registry state — presence must reflect
 *  live connections only. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    for (const [ws, st] of conns) {
      if (!st.isAlive) {
        ws.terminate();
        continue;
      }
      st.isAlive = false;
      ws.ping();
    }
  }, PING_MS);
  heartbeatTimer.unref?.();
}
startHeartbeat();

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
