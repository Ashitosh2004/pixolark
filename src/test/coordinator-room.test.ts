/**
 * Coordinator-room signaling glue tests.
 *
 * Scope (honest): these tests exercise the SIGNALING ROUTING only — the
 * want→offer→answer choreography, stale-answer guards, offline handling and
 * member adoption — against the REAL coordinator server. RTCPeerConnection
 * does not exist in test environments, so the doorbell PeerSession is replaced
 * with a contract-faithful double through the reception's test seam; the REAL
 * E2EE path through these classes is verified with two real browser sessions
 * against the live coordinator (see docs/TESTING.md).
 */
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startCoordinator } from "@server/src/index";
import { CoordinatorClient } from "@/lib/pixel/coordinator";
import { CoordinatorMemberLink, CoordinatorReception, isRtcData, type MemberLinkHooks } from "@/lib/pixel/coordinator-room";
import { exportSigningPublicKeyRaw, generateSigningKey, ownerFingerprint, signManifest } from "@/lib/pixel/manifest";
import { b64url } from "@/lib/pixel/bytes";
import { registry } from "@server/src/index";

let base = "";
let stop = async () => {};
const NOW = Date.now();

beforeAll(async () => {
  const c = await startCoordinator(0);
  base = `ws://127.0.0.1:${c.port}/coordinator`;
  stop = c.close;
});
afterAll(() => stop());

/** Contract double for PeerSession (browser-only in real life): same surface
 *  the reception touches — localCode, state, acceptAnswer, close. */
class FakeDoorbell {
  localCode: string;
  state = "waiting";
  accepted: string[] = [];
  closed = false;
  constructor(public label: string) {
    this.localCode = `${label}-offer-code`;
  }
  get isSecure() {
    return this.state === "secure";
  }
  async acceptAnswer(code: string): Promise<void> {
    // Mirror the real guard: the answer must carry THIS doorbell's sid.
    if (code !== `owner-${this.localCode}`) throw new Error("sid mismatch");
    if (this.accepted.includes(code)) throw new Error("duplicate answer blocked");
    this.accepted.push(code);
    this.state = "secure";
  }
  close(): void {
    this.closed = true;
  }
}

async function ownerPack(roomId: string, name: string) {
  const keys = await generateSigningKey();
  const pubRaw = await exportSigningPublicKeyRaw(keys.publicKey);
  const manifest = await signManifest(
    {
      roomId,
      name,
      desc: "",
      type: "public",
      category: "General Chat",
      region: "India",
      subRegion: "Maharashtra",
      city: "Kolhapur",
      languages: ["English"],
      owner: { id: await ownerFingerprint(pubRaw), signingKey: b64url(pubRaw) },
      host: { commitment: "b".repeat(32) },
      coordinator: { urls: [base] },
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

describe("coordinator-room glue", () => {
  it("routes want → offer → answer → adoption between owner and member", async () => {
    const { keys, manifest } = await ownerPack("700001", "Route Room");

    const ownerClient = new CoordinatorClient({ url: base, name: "Owner", onState: () => {} });
    const memberClient = new CoordinatorClient({ url: base, name: "Meera", onState: () => {} });
    ownerClient.connect();
    memberClient.connect();

    // Owner: register the room with a real signed manifest + proof.
    await ownerClient.reown(manifest, keys.privateKey);
    expect(await ownerClient.onceRegistered(manifest.roomId)).toBe(true);

    // Member: join and discover the owner's connection id.
    const link = new CoordinatorMemberLink(memberClient, manifest.roomId, "Meera", {
      onOffer: () => {},
      onRoomOffline: () => {},
      onError: () => {},
    });
    const state = await link.connect();
    const ownerId = state?.members.find((m) => m.owner)?.id;
    expect(ownerId).toBeTruthy();

    // Owner: pre-open a doorbell through the test seam.
    const door = new FakeDoorbell("door-1");
    const adopted: string[] = [];
    const reception = new CoordinatorReception(
      ownerClient,
      manifest.roomId,
      { keyPair: null as never, publicRaw: new Uint8Array(0), commitment: "x" },
      (s) => adopted.push((s as unknown as FakeDoorbell).localCode),
      () => {},
      () => Promise.resolve(door as unknown as import("@/lib/pixel/session").PeerSession),
    );

    // Member asks for the offer; owner routes its doorbell code back.
    const offers: string[] = [];
    (link as unknown as { hooks: { onOffer: (c: string) => void } }).hooks.onOffer = (code) => offers.push(code);
    ownerClient.setRtcHandler((roomId, from, data) => {
      if (roomId === manifest.roomId && isRtcData(data)) void reception.handleRtc(from, data);
    });
    void link.handleRtc; // member rtc routing is exercised through the same signal path below
    memberClient.setRtcHandler((roomId, from, data) => {
      if (roomId === manifest.roomId && isRtcData(data)) link.handleRtc(from, data);
    });
    memberClient.signal(manifest.roomId, ownerId!, { kind: "want" });
    await new Promise((r) => setTimeout(r, 400));
    expect(offers).toEqual([door.localCode]);

    // Member's answer reaches the owner through the relay → door accepts → adoption.
    memberClient.signal(manifest.roomId, ownerId!, { kind: "answer", code: `owner-${door.localCode}` });
    await new Promise((r) => setTimeout(r, 400));
    expect(adopted).toEqual([door.localCode]);
    expect(door.accepted).toEqual([`owner-${door.localCode}`]);

    ownerClient.disconnect();
    memberClient.disconnect();
    link.stop();
    reception.stop();
  });

  it("stale answers (superseded doorbell) are refused and re-asks get the fresh offer", async () => {
    const { keys, manifest } = await ownerPack("700003", "Sid Room");
    const ownerClient = new CoordinatorClient({ url: base, name: "Owner", onState: () => {} });
    const memberClient = new CoordinatorClient({ url: base, name: "Meera", onState: () => {} });
    ownerClient.connect();
    memberClient.connect();
    await ownerClient.reown(manifest, keys.privateKey);
    await ownerClient.onceRegistered(manifest.roomId);

    const link = new CoordinatorMemberLink(memberClient, manifest.roomId, "Meera", {
      onOffer: () => {},
      onRoomOffline: () => {},
      onError: () => {},
    });
    const state = await link.connect();
    const ownerId = state?.members.find((m) => m.owner)?.id!;

    const made: FakeDoorbell[] = [];
    const adopted: string[] = [];
    // Like the real PeerSession.host, the factory hands out a FRESH doorbell
    // on every call — each one is tracked so the test can reference them.
    const reception = new CoordinatorReception(
      ownerClient,
      manifest.roomId,
      { keyPair: null as never, publicRaw: new Uint8Array(0), commitment: "x" },
      (s) => adopted.push((s as unknown as FakeDoorbell).localCode),
      () => {},
      () => {
        const d = new FakeDoorbell(`door-${made.length + 1}`);
        made.push(d);
        return Promise.resolve(d as unknown as import("@/lib/pixel/session").PeerSession);
      },
    );
    ownerClient.setRtcHandler((roomId, from, data) => {
      if (roomId === manifest.roomId && isRtcData(data)) void reception.handleRtc(from, data);
    });
    memberClient.setRtcHandler((roomId, from, data) => {
      if (roomId === manifest.roomId && isRtcData(data)) link.handleRtc(from, data);
    });

    // Joiner A gets the first doorbell's offer…
    memberClient.signal(manifest.roomId, ownerId!, { kind: "want" });
    await new Promise((r) => setTimeout(r, 300));
    expect(adopted).toEqual([]); // nothing adopted yet
    const door1 = made[0]!;

    // …but ANOTHER joiner completes door1 first — owner adopts on door1 and
    // the reception rotates to a fresh doorbell.
    ownerClient.signal(manifest.roomId, ownerId!, { kind: "answer", code: `owner-${door1.localCode}` });
    await new Promise((r) => setTimeout(r, 300));
    expect(adopted).toEqual([door1.localCode]);

    // Joiner A's now-STALE answer arrives: the live doorbell is door2, whose
    // sid guard refuses foreign codes — and the member is told honestly.
    const stales: string[] = [];
    const origHandleRtc = link.handleRtc.bind(link);
    link.handleRtc = (f, d) => {
      if (isRtcData(d) && d.kind === "stale") stales.push(f);
      origHandleRtc(f, d);
    };
    memberClient.signal(manifest.roomId, ownerId!, { kind: "answer", code: `owner-${door1.localCode}` });
    await new Promise((r) => setTimeout(r, 300));
    const door2 = made[1]!;
    expect(door2.accepted).toEqual([]); // stale answer refused (sid mismatch)
    expect(stales.length).toBe(1); // member learned its answer was refused

    // Member re-asks (past the owner's debounce) and completes on the fresh doorbell.
    await new Promise((r) => setTimeout(r, 1300));
    memberClient.signal(manifest.roomId, ownerId!, { kind: "want" });
    await new Promise((r) => setTimeout(r, 300));
    memberClient.signal(manifest.roomId, ownerId!, { kind: "answer", code: `owner-${door2.localCode}` });
    await new Promise((r) => setTimeout(r, 300));
    expect(adopted).toEqual([door1.localCode, door2.localCode]);

    ownerClient.disconnect();
    memberClient.disconnect();
    link.handleRtc = origHandleRtc;
    link.stop();
    reception.stop();
  });

  it("members learn honestly when the owner's lease dies", async () => {
    const { keys, manifest } = await ownerPack("700002", "Vanish Glue");
    const ownerClient = new CoordinatorClient({ url: base, name: "Owner", onState: () => {} });
    const memberClient = new CoordinatorClient({ url: base, name: "Watcher", onState: () => {} });
    ownerClient.connect();
    memberClient.connect();
    await ownerClient.reown(manifest, keys.privateKey);
    await ownerClient.onceRegistered(manifest.roomId);
    await memberClient.join(manifest.roomId, "Watcher");
    await memberClient.onceRoomState(manifest.roomId);
    ownerClient.disconnect(); // lease dies with the owner connection
    const offline = await memberClient.onceRoomOffline(manifest.roomId, 5000);
    expect(offline).toBe("owner-left");
    memberClient.disconnect();
  });

  it("a join() issued while the socket is still connecting is not dropped", async () => {
    // Regression: join() used to send room.join before the socket opened —
    // silently discarded (send() only delivers on OPEN) — so the member never
    // received the host's offer and fell back to the legacy doorbell. join()
    // must wait for welcome (bounded) before sending.
    const { keys, manifest } = await ownerPack("700003", "Late Bell");
    const ownerClient = new CoordinatorClient({ url: base, name: "Owner", onState: () => {} });
    ownerClient.connect();
    await ownerClient.reown(manifest, keys.privateKey);
    await ownerClient.onceRegistered(manifest.roomId);

    const memberClient = new CoordinatorClient({ url: base, name: "Late", onState: () => {} });
    memberClient.connect();
    // Armed BEFORE join, mirroring CoordinatorMemberLink.connect(): room.state
    // is the server's reply to room.join, so the waiter must exist first.
    const gotP = memberClient.onceRoomState(manifest.roomId, 6000);
    // join() issued synchronously after connect(): the socket is CONNECTING.
    await memberClient.join(manifest.roomId, "Late");
    const got = await gotP;
    expect(got).not.toBeNull();
    expect(got?.members.some((m) => m.name === "Late")).toBe(true);
    ownerClient.disconnect();
    memberClient.disconnect();
  });

  it("a probe issued while the socket is still connecting is answered (ready() wait)", async () => {
    // Regression: probe frames sent on a CONNECTING socket were dropped, so
    // the first Discover→Join on a fresh client read as "not available" and
    // fell back to the legacy doorbell. ready() must bring the socket up and
    // the probe must be genuinely delivered and answered.
    const { keys, manifest } = await ownerPack("700004", "Probe Bell");
    const ownerClient = new CoordinatorClient({ url: base, name: "Owner", onState: () => {} });
    ownerClient.connect();
    await ownerClient.reown(manifest, keys.privateKey);
    await ownerClient.onceRegistered(manifest.roomId);

    const probeClient = new CoordinatorClient({ url: base, name: "Prober", onState: () => {} });
    probeClient.connect();
    expect(await probeClient.ready(6000)).toBe(true);
    const waiter = probeClient.onceProbe(manifest.roomId, 4000);
    probeClient.probe(manifest.roomId);
    expect(await waiter).toBe(true);
    ownerClient.disconnect();
    probeClient.disconnect();
  });

  it("a member rejoining a restarted coordinator retries until the owner re-registers", { timeout: 30_000 }, async () => {
    // Regression: after a coordinator restart, a member whose re-join raced
    // the owner's re-register got room-unavailable ONCE and never retried —
    // it stayed outside the registry (bannered mid-chat) until the next join.
    const { keys, manifest } = await ownerPack("700005", "Rejoin Race");
    const membersSeen: string[] = [];
    const ownerClient = new CoordinatorClient({
      url: base,
      name: "Owner",
      onState: () => {},
      onRoomMembers: (_r, ms) => { if (ms.some((m) => m.name === "Racer")) membersSeen.push("Racer"); },
    });
    const memberClient = new CoordinatorClient({ url: base, name: "Racer", onState: () => {} });
    ownerClient.connect();
    await ownerClient.reown(manifest, keys.privateKey);
    await ownerClient.onceRegistered(manifest.roomId);
    await memberClient.join(manifest.roomId, "Racer");
    await memberClient.onceRoomState(manifest.roomId);

    // Simulate the restart's registry wipe (startCoordinator's own semantics:
    // a start is a reset — no ghosts of a previous process). Connections stay.
    registry.reset();

    // The MEMBER reconnects first — its re-join races the owner's re-register
    // and must retry rather than banner-and-give-up.
    memberClient.reconnectNow();
    await new Promise((r) => setTimeout(r, 1200));
    ownerClient.reconnectNow(); // owner re-asserts the lease
    const until = Date.now() + 25_000;
    while (Date.now() < until && membersSeen.length === 0) await new Promise((r) => setTimeout(r, 500));
    expect(membersSeen).toContain("Racer"); // membership restored by the retry
    ownerClient.disconnect();
    memberClient.disconnect();
  });
});
