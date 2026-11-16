/**
 * Regression test for the "member stuck on connecting…" group-join bug.
 *
 * Root cause: joinAsMember passed the raw GroupIdentity.keyPair (a bare
 * CryptoKeyPair) as a PeerSession Identity via `as unknown as Identity`. The
 * Identity interface also carries `commitment`, so PeerSession.join embedded
 * `commit: undefined` into the answer code, the host's hello commitment check
 * rejected every join (KEY MISMATCH), and members looped on "connecting…".
 *
 * The adapter asSessionIdentity (idb.ts) must hand PeerSession a *complete*
 * Identity whose commitment equals commitmentOf(publicRaw) — the same value
 * stored under the memberId name. It must never use createGroupIdentity here:
 * jsdom has no IndexedDB, and the storage path is not what this pins.
 */
import { describe, expect, it } from "vitest";
import { asSessionIdentity, type GroupIdentity } from "@/lib/pixel/idb";
import { commitmentOf } from "@/lib/pixel/crypto";

async function fakeGroupIdentity(): Promise<GroupIdentity> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return { keyPair, publicRaw, memberId: await commitmentOf(publicRaw) };
}

describe("group identity → session identity adapter", () => {
  it("exposes a complete Identity: same key material and commitment === commitmentOf(publicRaw)", async () => {
    const gid = await fakeGroupIdentity();
    const id = asSessionIdentity(gid);

    expect(id.keyPair).toBe(gid.keyPair);
    expect(id.publicRaw).toBe(gid.publicRaw);
    expect(id.commitment).toBe(gid.memberId);
    // The heart of the regression: the commitment the 1:1 handshake embeds in
    // the answer code must be a real hash of the public key — never undefined.
    expect(id.commitment).toBe(await commitmentOf(gid.publicRaw));
    expect(id.commitment.length).toBeGreaterThan(0);
  });

  it("adapts identities loaded from storage identically (same value shape both sides of the join)", async () => {
    const gid = await fakeGroupIdentity();
    // Simulate a reloaded identity: fresh adapter call, same underlying object.
    const first = asSessionIdentity(gid);
    const second = asSessionIdentity(gid);
    expect(second.commitment).toBe(first.commitment);
    expect(second.keyPair).toBe(first.keyPair);
  });

  it("different devices derive different commitments (the host must be able to tell members apart)", async () => {
    const a = asSessionIdentity(await fakeGroupIdentity());
    const b = asSessionIdentity(await fakeGroupIdentity());
    expect(a.commitment).not.toBe(b.commitment);
  });
});
