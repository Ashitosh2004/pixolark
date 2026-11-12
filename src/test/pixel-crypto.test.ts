import { describe, expect, it } from "vitest";
import { createIdentity, deriveSessionKeys, openFrame, packEnvelope, sealFrame, unpackEnvelope } from "@/lib/pixel/crypto";
import { decodeConnection, encodeConnection, generateRoomId, isValidRoomId } from "@/lib/pixel/codec";

async function pair() {
  const a = await createIdentity(), b = await createIdentity();
  const ka = await deriveSessionKeys(a, b.publicRaw, "host", "room|fp");
  const kb = await deriveSessionKeys(b, a.publicRaw, "guest", "room|fp");
  return { ka, kb };
}

describe("Pixolark encryption", () => {
  it("both peers derive the same safety code and can decrypt each other", async () => {
    const { ka, kb } = await pair();
    expect(ka.fingerprint).toBe(kb.fingerprint);
    const frame = await sealFrame(ka.sendKey, 1, packEnvelope({ t: "msg", text: "hi" }));
    const { plaintext } = await openFrame(kb.recvKey, frame, 0);
    expect(unpackEnvelope(plaintext).header.text).toBe("hi");
  });
  it("rejects tampered frames", async () => {
    const { ka, kb } = await pair();
    const frame = await sealFrame(ka.sendKey, 1, packEnvelope({ t: "msg", text: "hi" }));
    frame[frame.length - 1]! ^= 1;
    await expect(openFrame(kb.recvKey, frame, 0)).rejects.toThrow();
  });
  it("rejects replayed frames", async () => {
    const { ka, kb } = await pair();
    const frame = await sealFrame(ka.sendKey, 5, packEnvelope({ t: "x" }));
    await expect(openFrame(kb.recvKey, frame, 5)).rejects.toThrow();
  });
  it("different context (key mismatch) produces different safety codes", async () => {
    const a = await createIdentity(), b = await createIdentity();
    const k1 = await deriveSessionKeys(a, b.publicRaw, "host", "room|fp1");
    const k2 = await deriveSessionKeys(b, a.publicRaw, "guest", "room|fp2");
    expect(k1.fingerprint).not.toBe(k2.fingerprint);
  });
  it("expired connection codes are refused", async () => {
    const code = await encodeConnection({ v: 1, kind: "offer", room: generateRoomId(), sdp: "v=0", commit: "ab", exp: Date.now() - 1, sid: "s" });
    await expect(decodeConnection(code)).rejects.toThrow(/expired/);
  });
  it("room IDs validate", () => {
    expect(isValidRoomId(generateRoomId())).toBe(true);
    expect(isValidRoomId("PX-123")).toBe(false);
  });
});
