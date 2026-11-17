/**
 * Signed room manifests — the portable identity of a room.
 * These tests pin the trust model: a manifest is only believed when its ECDSA
 * signature verifies against the embedded owner key, it is not expired, and any
 * field modification invalidates it. Directory files are plain JSON, so the
 * manifest must survive a JSON round-trip and still verify.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalManifestBytes,
  exportSigningPublicKeyRaw,
  generateSigningKey,
  manifestIdOf,
  manifestSections,
  ownerFingerprint,
  signManifest,
  verifyManifest,
  verifyOwnerFingerprint,
  type RoomManifest,
} from "@/lib/pixel/manifest";
import { b64url } from "@/lib/pixel/bytes";

const NOW = 1_700_000_000_000;

async function owner() {
  const keys = await generateSigningKey();
  const pubRaw = await exportSigningPublicKeyRaw(keys.publicKey);
  return { keys, id: await ownerFingerprint(pubRaw), pubRaw };
}

async function sampleManifest() {
  const o = await owner();
  const base = {
    roomId: "123456",
    name: "Pixel Garden",
    desc: "A quiet pixel garden",
    type: "public" as const,
    category: "General Chat",
    region: "India",
    subRegion: "Maharashtra",
    city: "Kolhapur",
    languages: ["English", "Marathi"],
    owner: { id: o.id, signingKey: b64url(o.pubRaw) },
    host: { commitment: "a".repeat(32) },
    coordinator: { urls: ["wss://coordinator.example/coordinator"] },
    capabilities: { media: true, stickers: true, history: false, slowMode: false, approval: false },
    invitation: { method: "open" as const },
    policy: { recovery: "owner-only" as const, coOwners: [] },
    createdAt: NOW - 60_000,
    updatedAt: NOW - 30_000,
    expiresAt: NOW + 24 * 60 * 60_000,
  };
  const signed = await signManifest(base, o.keys.privateKey);
  return { o, signed };
}

describe("manifest signing", () => {
  it("round-trips sign → JSON → verify", async () => {
    const { signed } = await sampleManifest();
    // Directory files are plain JSON: serialize and parse before verifying.
    const revived = JSON.parse(JSON.stringify(signed)) as RoomManifest;
    const check = await verifyManifest(revived, NOW);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.manifest.roomId).toBe("123456");
  });

  it("rejects any field modification without re-signing", async () => {
    const { signed } = await sampleManifest();
    const tampered = JSON.parse(JSON.stringify(signed)) as RoomManifest;
    tampered.name = "Pixel Garden (free stickers)"; // attacker edits the name
    const check = await verifyManifest(tampered, NOW);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("signature");
  });

  it("rejects expiry and absurd validity windows", async () => {
    const { signed } = await sampleManifest();
    const expired = JSON.parse(JSON.stringify(signed)) as RoomManifest;
    expired.expiresAt = NOW - 1;
    // Expired manifests must fail even though the signature is intact.
    const check = await verifyManifest(expired, NOW);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("expired");
  });

  it("rejects unsigned and structurally broken candidates", async () => {
    const { signed } = await sampleManifest();
    const unsigned = { ...signed, signature: "" };
    expect((await verifyManifest(unsigned, NOW)).ok).toBe(false);
    expect((await verifyManifest(null, NOW)).ok).toBe(false);
    expect((await verifyManifest({ v: 2, alg: "ES256-P256" }, NOW)).ok).toBe(false);
  });

  it("owner fingerprint must match the embedded signing key", async () => {
    const { signed } = await sampleManifest();
    expect(await verifyOwnerFingerprint(signed)).toBe(true);
    const forged = { ...signed, owner: { ...signed.owner, id: "deadbeef0000000000" } } as RoomManifest;
    // A forged id breaks the fingerprint check even if someone re-signs nothing.
    expect(await verifyOwnerFingerprint(forged)).toBe(false);
  });

  it("canonical bytes are deterministic across key order", async () => {
    const { signed } = await sampleManifest();
    const reordered = JSON.parse(JSON.stringify(signed)) as RoomManifest;
    const clone: Record<string, unknown> = {};
    for (const k of Object.keys(signed).reverse()) clone[k] = (reordered as unknown as Record<string, unknown>)[k];
    const a = canonicalManifestBytes(signed);
    const b = canonicalManifestBytes(clone as unknown as RoomManifest);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("dedupes by content id and maps to directory sections", async () => {
    const { signed } = await sampleManifest();
    const id1 = await manifestIdOf(signed);
    const id2 = await manifestIdOf(JSON.parse(JSON.stringify(signed)));
    expect(id1).toBe(id2);
    expect(manifestSections(signed)).toEqual([
      "global/general-chat",
      "countries/india",
      "states/maharashtra",
      "cities/kolhapur",
      "languages/english",
      "languages/marathi",
    ]);
  });
});
