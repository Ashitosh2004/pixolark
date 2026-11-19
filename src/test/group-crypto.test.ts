import { describe, expect, it } from "vitest";
import { createIdentity } from "@/lib/pixel/crypto";
import {
  MAX_SKIPPED_KEPT,
  derivePairwiseBits,
  memberIdOf,
  newSenderChain,
  openFromMember,
  openGroupMessage,
  openRecoveredMessage,
  peerChainFromDistribute,
  sealGroupMessage,
  sealToMember,
  type GroupWire,
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

  it("opens a long run of consecutive messages without key drift (regression: 3rd message)", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    let chain = newSenderChain(1);
    const ck0 = chain.chainKey;
    const wires: GroupWire[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await sealGroupMessage(chain, ROOM, aid, { t: "msg", n: i });
      wires.push(r.wire);
      chain = r.next;
    }
    let peer = peerChainFromDistribute(1, 0, ck0, 0);
    for (const [i, w] of wires.entries()) {
      const opened = await openGroupMessage(w, ROOM, peer);
      peer = opened.next;
      expect(opened.header.n).toBe(i);
    }
  });

  it("retains skipped keys over a gap and recovers the missed frames verbatim", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    let chain = newSenderChain(1);
    const ck0 = chain.chainKey;
    const wires: GroupWire[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await sealGroupMessage(chain, ROOM, aid, { t: "msg", n: i });
      wires.push(r.wire);
      chain = r.next;
    }
    const peer = peerChainFromDistribute(1, 0, ck0, 0);
    // Only the LAST of four frames arrives: the receiver skips 0..2 and ratchets forward.
    const late = await openGroupMessage(wires[3]!, ROOM, peer);
    expect(late.next.skipped?.map((k) => k.seq)).toEqual([0, 1, 2]);
    // The original sender replays the missed frames verbatim; they open with the
    // retained keys and touch no chain state.
    for (const w of wires.slice(0, 3)) {
      const rec = await openRecoveredMessage(w, ROOM, late.next);
      expect(rec.header.n).toBe(w.seq);
    }
    // The ratchet is untouched by recovery: the NEXT ordinary frame still opens.
    const later = await sealGroupMessage(chain, ROOM, aid, { t: "msg", n: 4 });
    const next = await openGroupMessage(later.wire, ROOM, late.next);
    expect(next.header.n).toBe(4);
  });

  it("recovered frames are authenticated, sender-bound and key-bound", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    let chain = newSenderChain(1);
    const ck0 = chain.chainKey;
    const s0 = await sealGroupMessage(chain, ROOM, aid, { t: "msg", n: 0 });
    const s1 = await sealGroupMessage(s0.next, ROOM, aid, { t: "msg", n: 1 });
    const s2 = await sealGroupMessage(s1.next, ROOM, aid, { t: "msg", n: 2 });
    const peer = peerChainFromDistribute(1, 0, ck0, 0);
    const late = await openGroupMessage(s2.wire, ROOM, peer); // skips 0..1
    // Tampered ciphertext: rejected.
    const tampered = { ...s0.wire, sealed: s0.wire.sealed.slice(0, -4) + (s0.wire.sealed.endsWith("A") ? "BBBB" : "AAAA") };
    await expect(openRecoveredMessage(tampered, ROOM, late.next)).rejects.toThrow();
    // A frame claimed from another sender: rejected (AAD binds the sender).
    const other = await createIdentity();
    const forged = { ...s0.wire, from: await memberIdOf(other.publicRaw) };
    await expect(openRecoveredMessage(forged, ROOM, late.next)).rejects.toThrow();
    // A fresh distribute holds no skipped keys: recovery refused.
    await expect(openRecoveredMessage(s0.wire, ROOM, peerChainFromDistribute(1, 0, ck0, 0))).rejects.toThrow(/No retained key/);
    // Retained keys are epoch/gen-bound: a gen-1 re-announce of the same seq doesn't match.
    const gen1 = newSenderChain(1, 1);
    const g1 = (await sealGroupMessage(gen1, ROOM, aid, { t: "msg", n: 0 })).wire;
    await expect(openRecoveredMessage(g1, ROOM, late.next)).rejects.toThrow(/No retained key/);
  });

  it("caps retained skipped keys, keeping the newest chain positions", async () => {
    const a = await createIdentity();
    const aid = await memberIdOf(a.publicRaw);
    let chain = newSenderChain(1);
    const ck0 = chain.chainKey;
    const wires: GroupWire[] = [];
    for (let i = 0; i <= 40; i++) {
      const r = await sealGroupMessage(chain, ROOM, aid, { t: "msg", n: i });
      wires.push(r.wire);
      chain = r.next;
    }
    const peer = peerChainFromDistribute(1, 0, ck0, 0);
    // Frames 0..39 are skipped; only the newest MAX_SKIPPED_KEPT positions are retained.
    const late = await openGroupMessage(wires[40]!, ROOM, peer);
    expect(late.next.skipped?.length).toBe(MAX_SKIPPED_KEPT);
    expect(late.next.skipped?.[0]?.seq).toBe(40 - MAX_SKIPPED_KEPT);
    expect(late.next.skipped?.at(-1)?.seq).toBe(39);
    // The retained range recovers; anything older is honestly unrecoverable.
    expect((await openRecoveredMessage(wires[8]!, ROOM, late.next)).header.n).toBe(8);
    expect((await openRecoveredMessage(wires[39]!, ROOM, late.next)).header.n).toBe(39);
    await expect(openRecoveredMessage(wires[7]!, ROOM, late.next)).rejects.toThrow(/No retained key/);
  });
});
