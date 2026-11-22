/**
 * Coordinator hardening tests — the abuse/robustness surface: malformed and
 * oversized frames, message floods, room-id validation, presence-name
 * sanitization, per-connection/registry/member caps, the connection cap, the
 * WS origin allowlist, and the heartbeat reaper for silent connections.
 * Same harness as coordinator.test.ts: a real coordinator on an ephemeral
 * port, real WS clients, memory-only state, no database anywhere.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import type { ClientToServer, ServerToClient } from "@/lib/pixel/coordinator-protocol";
import { createOwnershipProof } from "@/lib/pixel/coordinator-protocol";
import { b64url } from "@/lib/pixel/bytes";
import { generateSigningKey, exportSigningPublicKeyRaw, ownerFingerprint, signManifest } from "@/lib/pixel/manifest";

// Caps and heartbeat cadence are read when the server module is imported, so
// they are set here — BEFORE the dynamic import below — and unset in afterAll
// so they can never leak into another test file's module instance.
process.env["COORD_MAX_CONNECTIONS"] = "4";
process.env["COORD_MAX_ROOMS"] = "3";
process.env["COORD_MAX_ROOMS_PER_CONN"] = "2";
process.env["COORD_MAX_MEMBERS"] = "3";
process.env["COORD_PING_MS"] = "150";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let startCoordinator: (port?: number) => Promise<{ port: number; close: () => Promise<void> }>;
let base = "";
let stop = async () => {};

const NOW = Date.now();

async function makeOwner(name = "Hardening Room", roomId = "123456") {
  const keys = await generateSigningKey();
  const pubRaw = await exportSigningPublicKeyRaw(keys.publicKey);
  const manifest = await signManifest(
    {
      roomId,
      name,
      desc: "hardening test room",
      type: "public",
      category: "General Chat",
      region: "India",
      subRegion: "Maharashtra",
      city: "Kolhapur",
      languages: ["English"],
      owner: { id: await ownerFingerprint(pubRaw), signingKey: b64url(pubRaw) },
      host: { commitment: "a".repeat(32) },
      coordinator: { urls: [] },
      capabilities: { media: true, stickers: true, history: false, slowMode: false, approval: false },
      invitation: { method: "open" },
      policy: { recovery: "owner-only", coOwners: [] },
      createdAt: NOW - 1000,
      updatedAt: NOW,
      expiresAt: NOW + 24 * 60 * 60_000,
    },
    keys.privateKey,
  );
  return { keys, manifest };
}

class Client {
  ws: WebSocket;
  inbox: ServerToClient[] = [];
  private pending: { pred: (m: ServerToClient) => boolean; resolve: (m: ServerToClient) => void }[] = [];
  id = "";
  nonce = "";
  closeCode: number | undefined;
  ready: Promise<void>;

  constructor(opts: { origin?: string } = {}) {
    this.ws = new WebSocket(base, opts.origin ? { headers: { origin: opts.origin } } : undefined);
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as ServerToClient;
      if (m.t === "welcome") {
        this.id = m.clientId;
        this.nonce = m.nonce;
      }
      this.inbox.push(m);
      const idx = this.pending.findIndex((p) => p.pred(m));
      if (idx >= 0) {
        const p = this.pending[idx];
        if (p) {
          this.pending.splice(idx, 1);
          p.resolve(m);
        }
      }
    });
    this.ws.on("close", (code) => {
      this.closeCode = code;
    });
    this.ready = new Promise<void>((res) => this.ws.on("open", () => res())).then(
      () => this.next((m) => m.t === "welcome"),
    ).then(() => undefined);
    this.ws.on("error", () => {});
  }

  send(m: ClientToServer): void {
    this.ws.send(JSON.stringify(m));
  }

  /** Send a raw string frame — for malformed/oversized traffic. */
  raw(s: string): void {
    this.ws.send(s);
  }

  /** Waits for the next message matching a predicate (checks the inbox first). */
  next(pred: (m: ServerToClient) => boolean, timeoutMs = 4000): Promise<ServerToClient> {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.resolve === resolve);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error("timeout waiting for coordinator message"));
      }, timeoutMs);
      const waiter = (m: ServerToClient) => {
        clearTimeout(timer);
        resolve(m);
      };
      this.pending.push({ pred, resolve: waiter });
    });
  }

  /** Waits until at least `n` matching messages have arrived (for bursts). */
  async collect(pred: (m: ServerToClient) => boolean, n: number): Promise<ServerToClient[]> {
    for (let i = 0; i < 100 && this.inbox.filter(pred).length < n; i++) await sleep(50);
    return this.inbox.filter(pred);
  }

  error(code: string): Promise<Extract<ServerToClient, { t: "error" }>> {
    return this.next((m): m is Extract<ServerToClient, { t: "error" }> => m.t === "error" && m.code === code) as Promise<Extract<ServerToClient, { t: "error" }>>;
  }

  closed(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((res) => this.ws.on("close", () => res()));
  }

  close(): Promise<void> {
    return new Promise((res) => {
      if (this.ws.readyState === WebSocket.CLOSED) return res();
      this.ws.on("close", () => res());
      this.ws.close();
    });
  }
}

beforeAll(async () => {
  ({ startCoordinator } = await import("@server/src/index"));
  const c = await startCoordinator(0);
  base = `ws://127.0.0.1:${c.port}/coordinator`;
  stop = c.close;
});
afterAll(async () => {
  await stop();
  for (const k of ["COORD_MAX_CONNECTIONS", "COORD_MAX_ROOMS", "COORD_MAX_ROOMS_PER_CONN", "COORD_MAX_MEMBERS", "COORD_PING_MS", "ALLOWED_ORIGINS"]) delete process.env[k];
});

describe("coordinator hardening", () => {
  it("rejects malformed, non-object and unknown frames without killing the connection", async () => {
    const c = new Client();
    await c.ready;
    c.raw("{not json at all"); // invalid JSON
    c.raw("[1,2,3]"); // JSON but not an object
    c.raw('{"nope":1}'); // object without `t`
    c.raw('{"t":123}'); // non-string `t`
    c.raw('{"t":"definitely-not-a-type"}'); // unknown message type
    const errors = await c.collect((m) => m.t === "error" && m.code === "bad-frame", 5);
    expect(errors.length).toBe(5);
    // The connection is still alive and serviceable afterwards.
    c.send({ t: "ping" });
    await c.next((m) => m.t === "pong");
    await c.close();
  });

  it("closes connections that send oversized frames (1009)", async () => {
    const c = new Client();
    await c.ready;
    c.raw(JSON.stringify({ t: "ping", pad: "x".repeat(100_000) }));
    await c.closed();
    expect(c.closeCode).toBe(1009);
  });

  it("rate-limits message floods instead of crashing or queueing them", async () => {
    const c = new Client();
    await c.ready;
    for (let i = 0; i < 250; i++) c.raw(JSON.stringify({ t: "ping" }));
    await c.collect((m) => m.t === "error" && m.code === "rate-limited", 1);
    expect(c.inbox.some((m) => m.t === "error" && m.code === "rate-limited")).toBe(true);
    await c.close();
  });

  it("validates room ids on the wire before any registry lookup", async () => {
    const c = new Client();
    await c.ready;
    c.send({ t: "room.join", roomId: "abc", name: "X" });
    c.send({ t: "room.probe", roomId: 123456 } as unknown as ClientToServer);
    c.send({ t: "room.leave" } as unknown as ClientToServer);
    c.send({ t: "rtc", roomId: "12ab", to: "c1", data: {} } as unknown as ClientToServer);
    const errors = await c.collect((m) => m.t === "error" && m.code === "bad-frame", 4);
    expect(errors.length).toBe(4);
    await c.close();
  });

  it("sanitizes presence names: control characters stripped, length capped", async () => {
    const { keys, manifest } = await makeOwner("Names Room", "555555");
    const owner = new Client();
    await owner.ready;
    owner.send({ t: "room.register", manifest, proof: await createOwnershipProof(manifest.roomId, keys.privateKey, owner.nonce) });
    await owner.next((m) => m.t === "room.registered");
    const member = new Client();
    await member.ready;
    member.send({ t: "room.join", roomId: manifest.roomId, name: "\u202E reversed \u0001\u0002 " + "x".repeat(40) });
    const state = await member.next((m) => m.t === "room.state" && m.roomId === manifest.roomId);
    if (state.t !== "room.state") throw new Error("unreachable");
    const joined = state.members.find((m) => m.id === member.id)!.name;
    expect(joined.length).toBeLessThanOrEqual(32);
    for (const ch of ["\u202E", "\u0001", "\u0002"]) expect(joined.includes(ch)).toBe(false);
    expect(joined).toContain("reversed");
    await member.close();
    await owner.close();
  });

  it("caps live members per room with an honest room-full answer", async () => {
    const { keys, manifest } = await makeOwner("Full Room", "666666");
    const owner = new Client();
    await owner.ready;
    owner.send({ t: "room.register", manifest, proof: await createOwnershipProof(manifest.roomId, keys.privateKey, owner.nonce) });
    await owner.next((m) => m.t === "room.registered");
    const members: Client[] = [];
    for (let i = 0; i < 2; i++) {
      const m = new Client();
      await m.ready;
      m.send({ t: "room.join", roomId: manifest.roomId, name: `M${i}` });
      await m.next((x) => x.t === "room.state");
      members.push(m);
    }
    const extra = new Client();
    await extra.ready;
    extra.send({ t: "room.join", roomId: manifest.roomId, name: "Too late" });
    await extra.error("room-full");
    await extra.close();
    for (const m of members) await m.close();
    await owner.close();
  });

  it("reaps silent connections via the heartbeat", async () => {
    const port = Number(new URL(base.replace("ws://", "http://")).port);
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((res) => sock.once("connect", () => res()));
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
    sock.write(`GET /coordinator HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await new Promise<void>((res) => {
      const onData = (d: Buffer) => {
        if (String(d).includes("101")) {
          sock.off("data", onData);
          res();
        }
      };
      sock.on("data", onData);
    });
    const start = Date.now();
    await new Promise<void>((res) => sock.once("close", () => res()));
    // PING_MS=150: two heartbeat rounds at most — never a lingering zombie.
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("caps rooms per connection and total registry size with honest refusals", async () => {
    // Fresh registry so room counts are exact regardless of earlier tests.
    await stop();
    const c2 = await startCoordinator(0);
    base = `ws://127.0.0.1:${c2.port}/coordinator`;
    stop = c2.close;

    const o1 = await makeOwner("A1", "111111");
    const o2 = await makeOwner("A2", "222222");
    const o3 = await makeOwner("A3", "777777");
    const b1 = await makeOwner("B1", "333333");
    const b2 = await makeOwner("B2", "444444");
    const connA = new Client();
    await connA.ready;
    for (const o of [o1, o2]) {
      connA.send({ t: "room.register", manifest: o.manifest, proof: await createOwnershipProof(o.manifest.roomId, o.keys.privateKey, connA.nonce) });
      await connA.next((m) => m.t === "room.registered" && m.roomId === o.manifest.roomId);
    }
    // Third room on the same connection → refused.
    connA.send({ t: "room.register", manifest: o3.manifest, proof: await createOwnershipProof(o3.manifest.roomId, o3.keys.privateKey, connA.nonce) });
    await connA.error("too-many-rooms");

    // A second connection fills the registry (3 rooms); the next is refused.
    const connB = new Client();
    await connB.ready;
    connB.send({ t: "room.register", manifest: b1.manifest, proof: await createOwnershipProof(b1.manifest.roomId, b1.keys.privateKey, connB.nonce) });
    await connB.next((m) => m.t === "room.registered" && m.roomId === b1.manifest.roomId);
    connB.send({ t: "room.register", manifest: b2.manifest, proof: await createOwnershipProof(b2.manifest.roomId, b2.keys.privateKey, connB.nonce) });
    await connB.error("registry-full");
    await connA.close();
    await connB.close();
  });

  it("refuses connections beyond the cap with close code 1013", async () => {
    const cs: Client[] = [];
    for (let i = 0; i < 4; i++) {
      const c = new Client();
      await c.ready;
      cs.push(c);
    }
    const extra = new Client();
    await extra.closed();
    expect(extra.closeCode).toBe(1013);
    for (const c of cs) await c.close();
  });

  it("enforces the origin allowlist when configured (unset stays public)", async () => {
    await stop();
    process.env["ALLOWED_ORIGINS"] = "https://pixolark.example";
    const c2 = await startCoordinator(0);
    base = `ws://127.0.0.1:${c2.port}/coordinator`;
    stop = c2.close;

    const allowed = new Client({ origin: "https://pixolark.example" });
    await allowed.ready; // handshake + welcome succeed
    await allowed.close();

    const foreign = new Client({ origin: "https://evil.example" });
    await foreign.closed();
    expect(foreign.id).toBe(""); // never got a welcome

    const bare = new Client(); // browsers always send Origin; absence is rejected too
    await bare.closed();
    expect(bare.id).toBe("");

    delete process.env["ALLOWED_ORIGINS"];
  });
});
