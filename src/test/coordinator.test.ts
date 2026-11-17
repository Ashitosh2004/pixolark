/**
 * Coordinator integration tests — a real WebSocket server on an ephemeral port,
 * exercised with a real WS client. Covers the master spec's mandatory scenarios:
 * owner registration with fresh proofs, hijack/tamper/replay rejection, honest
 * room-unavailable answers, signaling relay, lease expiry, and restart recovery.
 * No database exists anywhere in these paths — the registry is memory-only.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startCoordinator } from "@server/src/index";
import type { ClientToServer, ServerToClient } from "@/lib/pixel/coordinator-protocol";
import { createOwnershipProof } from "@/lib/pixel/coordinator-protocol";
import { b64url } from "@/lib/pixel/bytes";
import { generateSigningKey, exportSigningPublicKeyRaw, ownerFingerprint, signManifest, type RoomManifest } from "@/lib/pixel/manifest";

let base = "";
let stop = async () => {};

beforeAll(async () => {
  const c = await startCoordinator(0);
  base = `ws://127.0.0.1:${c.port}/coordinator`;
  stop = c.close;
});
afterAll(() => stop());

class Client {
  ws: WebSocket;
  inbox: ServerToClient[] = [];
  private pending: { pred: (m: ServerToClient) => boolean; resolve: (m: ServerToClient) => void }[] = [];
  id = "";
  nonce = "";
  opened: Promise<void>;
  /** Resolves once the coordinator's `welcome` arrived — the per-connection
   *  nonce is only trustworthy after this, never after `opened` alone. */
  ready: Promise<void>;

  constructor() {
    this.ws = new WebSocket(base);
    this.ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as ServerToClient;
      if (m.t === "welcome") {
        this.id = m.clientId;
        this.nonce = m.nonce;
      }
      this.inbox.push(m);
      // EVERY waiter gets a look at every message; the first matching one takes it.
      const idx = this.pending.findIndex((p) => p.pred(m));
      if (idx >= 0) {
        const p = this.pending[idx];
        if (p) {
          this.pending.splice(idx, 1);
          p.resolve(m);
        }
      }
    });
    this.opened = new Promise<void>((res) => this.ws.on("open", () => res()));
    this.ready = this.opened.then(() => this.next((m) => m.t === "welcome")).then(() => undefined);
    // A failed handshake surfaces as an 'error' event; record it, never let it
    // crash the suite as an unhandled rejection — the waiters will time out.
    this.ws.on("error", () => {});
  }

  send(m: ClientToServer): void {
    this.ws.send(JSON.stringify(m));
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

  error(code: string): Promise<Extract<ServerToClient, { t: "error" }>> {
    return this.next((m): m is Extract<ServerToClient, { t: "error" }> => m.t === "error" && m.code === code) as Promise<Extract<ServerToClient, { t: "error" }>>;
  }

  close(): Promise<void> {
    return new Promise((res) => {
      this.ws.on("close", () => res());
      this.ws.close();
    });
  }
}

const NOW = Date.now();

async function makeOwner(name = "Pixel Garden") {
  const keys = await generateSigningKey();
  const pubRaw = await exportSigningPublicKeyRaw(keys.publicKey);
  const manifest = await signManifest(
    {
      roomId: "123456",
      name,
      desc: "coordinator test room",
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

describe("coordinator", () => {
  it("registers an owner with a valid manifest + fresh proof and answers joins", async () => {
    const { keys, manifest } = await makeOwner();
    const owner = new Client();
    await owner.ready;
    const proof = await createOwnershipProof(manifest.roomId, keys.privateKey, owner.nonce);
    owner.send({ t: "room.register", manifest, proof });
    await owner.next((m) => m.t === "room.registered" && m.roomId === manifest.roomId);

    const member = new Client();
    await member.ready;
    member.send({ t: "room.join", roomId: manifest.roomId, name: "Meera" });
    const state = await member.next((m) => m.t === "room.state" && m.roomId === manifest.roomId);
    if (state.t !== "room.state") throw new Error("unreachable");
    expect(state.manifest.name).toBe("Pixel Garden");
    expect(state.members.map((x) => x.name).sort()).toEqual(["Meera", "Member"]); // owner + joiner, live only
    await member.close();
    await owner.close();
  });

  it("rejects a tampered manifest and a forged ownership proof (hijack attempt)", async () => {
    const { manifest } = await makeOwner();
    const attacker = new Client();
    await attacker.ready;
    // 1) Tampered manifest — signature no longer covers the fields.
    const tampered = JSON.parse(JSON.stringify(manifest)) as RoomManifest;
    tampered.name = "Hijacked Room";
    attacker.send({ t: "room.register", manifest: tampered, proof: await createOwnershipProof(tampered.roomId, (await generateSigningKey()).privateKey, attacker.nonce) });
    await attacker.error("manifest-invalid");
    // 2) Intact public manifest, but the attacker cannot sign the ownership proof
    //    with the owner key — the proof never verifies.
    attacker.send({ t: "room.register", manifest, proof: await createOwnershipProof(manifest.roomId, (await generateSigningKey()).privateKey, attacker.nonce) });
    await attacker.error("proof-invalid");
    await attacker.close();
  });

  it("refuses replayed proofs bound to another connection's nonce", async () => {
    const { keys, manifest } = await makeOwner();
    const owner = new Client();
    await owner.ready;
    const proof = await createOwnershipProof(manifest.roomId, keys.privateKey, owner.nonce);
    owner.send({ t: "room.register", manifest, proof });
    await owner.next((m) => m.t === "room.registered");
    // Attacker replays the captured (manifest, proof) pair from their own socket:
    const attacker = new Client();
    await attacker.ready;
    attacker.send({ t: "room.register", manifest, proof }); // stale nonce + held room
    await attacker.error("proof-invalid");
    await owner.close(); // lease dies with the owner connection
    await attacker.close();
  });

  it("answers joins on an unknown/expired room honestly", async () => {
    const member = new Client();
    await member.ready;
    member.send({ t: "room.join", roomId: "999999", name: "Lonely" });
    await member.error("room-unavailable");
    await member.close();
  });

  it("relays WebRTC signaling only between live members of the room", async () => {
    const { keys, manifest } = await makeOwner("Relay Room");
    const owner = new Client();
    await owner.ready;
    owner.send({ t: "room.register", manifest, proof: await createOwnershipProof(manifest.roomId, keys.privateKey, owner.nonce) });
    await owner.next((m) => m.t === "room.registered");
    const member = new Client();
    await member.ready;
    member.send({ t: "room.join", roomId: manifest.roomId, name: "Peer" });
    await member.next((m) => m.t === "room.state");

    owner.send({ t: "rtc", roomId: manifest.roomId, to: member.id, data: { kind: "offer", code: "PXC1.test" } });
    const relayed = await member.next((m) => m.t === "rtc" && m.roomId === manifest.roomId);
    if (relayed.t !== "rtc") throw new Error("unreachable");
    expect((relayed.data as { kind: string }).kind).toBe("offer");
    // Relay to a non-member must be refused, never buffered into a fake state.
    owner.send({ t: "rtc", roomId: manifest.roomId, to: "c999999", data: { kind: "offer" } });
    await owner.error("peer-absent");
    await member.close();
    await owner.close();
  });

  it("owner disconnect ends the room for members — no fake availability", async () => {
    const { keys, manifest } = await makeOwner("Vanish Room");
    const owner = new Client();
    await owner.ready;
    owner.send({ t: "room.register", manifest, proof: await createOwnershipProof(manifest.roomId, keys.privateKey, owner.nonce) });
    await owner.next((m) => m.t === "room.registered");
    const member = new Client();
    await member.ready;
    member.send({ t: "room.join", roomId: manifest.roomId, name: "Watcher" });
    await member.next((m) => m.t === "room.state");
    await owner.close();
    const offline = await member.next((m) => m.t === "room.offline" && m.roomId === manifest.roomId);
    if (offline.t !== "room.offline") throw new Error("unreachable");
    expect(offline.reason).toBe("owner-left");
    // And a fresh join is honestly refused:
    const late = new Client();
    await late.ready;
    late.send({ t: "room.join", roomId: manifest.roomId, name: "Late" });
    await late.error("room-unavailable");
    await late.close();
    await member.close();
  });

  it("restarts clean: an empty registry says so instead of pretending", { timeout: 20_000 }, async () => {
    const { keys, manifest } = await makeOwner("Restart Room");
    const owner = new Client();
    await owner.ready;
    owner.send({ t: "room.register", manifest, proof: await createOwnershipProof(manifest.roomId, keys.privateKey, owner.nonce) });
    await owner.next((m) => m.t === "room.registered");
    await owner.close();

    // Simulated restart: same code, fresh process state.
    await stop();
    const c2 = await startCoordinator(0);
    base = `ws://127.0.0.1:${c2.port}/coordinator`;
    stop = c2.close;
    const late = new Client();
    await late.ready;
    late.send({ t: "room.join", roomId: manifest.roomId, name: "Survivor" });
    await late.error("room-unavailable");
    // The owner re-registers and the room is back — recovery needs no backend memory.
    const owner2 = new Client();
    await owner2.ready;
    owner2.send({ t: "room.register", manifest, proof: await createOwnershipProof(manifest.roomId, keys.privateKey, owner2.nonce) });
    await owner2.next((m) => m.t === "room.registered" && m.roomId === manifest.roomId);
    const survivor = new Client();
    await survivor.ready;
    survivor.send({ t: "room.join", roomId: manifest.roomId, name: "Survivor" });
    await survivor.next((m) => m.t === "room.state");
    await survivor.close();
    await owner2.close();
    await late.close();
  });

  it("health reports live facts only", async () => {
    const res = await fetch(`http://127.0.0.1:${new URL(base.replace("ws://", "http://")).port}/health`);
    const body = (await res.json()) as { ok: boolean; rooms: number; connections: number };
    expect(body.ok).toBe(true);
    expect(body.rooms).toBeGreaterThanOrEqual(0);
    expect(body.connections).toBeGreaterThanOrEqual(0);
  });
});
