import { describe, expect, it } from "vitest";
import { createIdentity } from "@/lib/pixel/crypto";
import {
  derivePairwiseBits,
  memberIdOf,
  newSenderChain,
  openFromMember,
  openGroupMessage,
  peerChainFromDistribute,
  sealGroupMessage,
  sealToMember,
} from "@/lib/pixel/groupcrypto";

const ROOM = "PXROOM-TEST";
const ROOM2 = "PXROOM-OTHER";

describe("Group sender-key crypto", () => {
  it("member ids are stable per identity and distinct between devices", async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    expect(await memberIdOf(a.publicRaw)).toBe(await memberIdOf(a.publicRaw));
    expect(await memberIdOf(a.publicRaw)).not.toBe(await memberIdOf(b.publicRaw));
  });

  it("roundtrips a message and advances both chains in lockstep", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    let chain = newSenderChain(1);
    const first = await sealGroupMessage(chain, ROOM, aid, { t: "msg", text: "hello" });
    const second = await sealGroupMessage(first.next, ROOM, aid, { t: "msg", text: "again" });
    expect(first.wire.seq).toBe(0);
    expect(second.wire.seq).toBe(1);

    const peer = peerChainFromDistribute(1, 0, chain.chainKey, 0);
    const open1 = await openGroupMessage(first.wire, ROOM, peer);
    expect(open1.header.text).toBe("hello");
    const open2 = await openGroupMessage(second.wire, ROOM, open1.next);
    expect(open2.header.text).toBe("again");
  });

  it("rejects replayed frames once the receiver has advanced", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    const chain = newSenderChain(1);
    const { wire } = await sealGroupMessage(chain, ROOM, aid, { t: "msg", text: "once" });
    const peer = peerChainFromDistribute(1, 0, chain.chainKey, 0);
    const open = await openGroupMessage(wire, ROOM, peer);
    await expect(openGroupMessage(wire, ROOM, open.next)).rejects.toThrow(/Replayed/);
  });

  it("late joiners cannot decrypt messages sent before they received the chain", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    const chain = newSenderChain(1);
    const m0 = await sealGroupMessage(chain, ROOM, aid, { t: "msg", text: "before you" });
    const m1 = await sealGroupMessage(m0.next, ROOM, aid, { t: "msg" });
    // The newcomer receives the CURRENT chain position (baseSeq 2), never older keys.
    const late = peerChainFromDistribute(1, 0, m1.next.chainKey, 2);
    await expect(openGroupMessage(m0.wire, ROOM, late)).rejects.toThrow();
  });

  it("rejects frames from a different room, epoch or generation", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    const chain = newSenderChain(2, 0);
    const { wire } = await sealGroupMessage(chain, ROOM, aid, { t: "msg", text: "x" });
    const peer = peerChainFromDistribute(2, 0, chain.chainKey, 0);
    await expect(openGroupMessage(wire, ROOM2, peer)).rejects.toThrow();
    const wrongEpoch = peerChainFromDistribute(3, 0, chain.chainKey, 0);
    await expect(openGroupMessage(wire, ROOM, wrongEpoch)).rejects.toThrow();
    const wrongGen = peerChainFromDistribute(2, 7, chain.chainKey, 0);
    await expect(openGroupMessage(wire, ROOM, wrongGen)).rejects.toThrow();
  });

  it("rejects tampered group frames", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    const chain = newSenderChain(1);
    const { wire } = await sealGroupMessage(chain, ROOM, aid, { t: "msg", text: "intact" });
    const tampered = { ...wire, sealed: wire.sealed.slice(0, -4) + (wire.sealed.endsWith("A") ? "BBBB" : "AAAA") };
    const peer = peerChainFromDistribute(1, 0, chain.chainKey, 0);
    await expect(openGroupMessage(tampered, ROOM, peer)).rejects.toThrow();
  });

  it("tolerates out-of-order delivery, then rejects the skipped older frame", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    const chain = newSenderChain(1);
    const first = await sealGroupMessage(chain, ROOM, aid, { t: "msg" });
    const second = await sealGroupMessage(first.next, ROOM, aid, { t: "msg" });
    const peer = peerChainFromDistribute(1, 0, chain.chainKey, 0);
    // Second arrives first: the receiver ratchets forward over the gap.
    const open2 = await openGroupMessage(second.wire, ROOM, peer);
    expect(open2.next.lastSeq).toBe(second.wire.seq);
    // The skipped first message can no longer be accepted.
    await expect(openGroupMessage(first.wire, ROOM, open2.next)).rejects.toThrow(/Replayed/);
  });

  it("pairwise envelopes only open for the intended member", async () => {
    const host = await createIdentity();
    const alice = await createIdentity();
    const bob = await createIdentity();
    const sealedForAlice = await sealToMember(host, alice.publicRaw, ROOM, { kind: "senderkey", chainKey: "secret" });
    expect(await openFromMember(alice, host.publicRaw, ROOM, sealedForAlice)).toMatchObject({ kind: "senderkey", chainKey: "secret" });
    await expect(openFromMember(bob, host.publicRaw, ROOM, sealedForAlice)).rejects.toThrow();
    // Sender identity is authenticated: a forged "host" envelope can't be opened with
    // the host's public key unless it was sealed by the host's private key.
    const forged = await sealToMember(bob, alice.publicRaw, ROOM, { kind: "senderkey", chainKey: "evil" });
    await expect(openFromMember(alice, host.publicRaw, ROOM, forged)).rejects.toThrow();
  });

  it("derives identical pairwise bits both ways, different per context", async () => {
    const a = await createIdentity();
    const b = await createIdentity();
    const ab = await derivePairwiseBits(a, b.publicRaw, ROOM);
    const ba = await derivePairwiseBits(b, a.publicRaw, ROOM);
    expect(ab).toEqual(ba);
    const other = await derivePairwiseBits(a, b.publicRaw, ROOM2);
    expect(other).not.toEqual(ab);
  });
});
