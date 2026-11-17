/**
 * Recovery registry tests — the local encrypted memory of Pixolark.
 * These pin the trust model of the ZERO-DATABASE persistence layer:
 * everything is encrypted at rest with a device-local key, exports are
 * password-protected (PBKDF2 600k), wrong passwords fail, and clearing
 * storage genuinely wipes everything.
 *
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearEverything,
  exportRecovery,
  importRecovery,
  loadRecovery,
  saveRecovery,
  type RecoveryPayload,
} from "@/lib/pixel/recovery";
import { exportSigningPrivateKeyPkcs8, generateSigningKey, signManifest, ownerFingerprint, exportSigningPublicKeyRaw } from "@/lib/pixel/manifest";
import { b64url } from "@/lib/pixel/bytes";

const NOW = Date.now();

async function samplePayload(): Promise<RecoveryPayload> {
  const sign = await generateSigningKey();
  const signPkcs8 = b64url(await exportSigningPrivateKeyPkcs8(sign.privateKey));
  const pubRaw = await exportSigningPublicKeyRaw(sign.publicKey);
  const manifest = await signManifest(
    {
      roomId: "555111",
      name: "Recovered Room",
      desc: "",
      type: "public",
      category: "General Chat",
      region: "India",
      subRegion: "Maharashtra",
      city: "Kolhapur",
      languages: ["Marathi"],
      owner: { id: await ownerFingerprint(pubRaw), signingKey: b64url(pubRaw) },
      host: { commitment: "c".repeat(32) },
      coordinator: { urls: ["ws://localhost:8787/coordinator"] },
      capabilities: { media: true, stickers: true, history: false, slowMode: false, approval: false },
      invitation: { method: "open" },
      policy: { recovery: "owner-only", coOwners: [] },
      createdAt: NOW - 1000,
      updatedAt: NOW,
      expiresAt: NOW + 24 * 60 * 60_000,
    },
    sign.privateKey,
  );
  return {
    v: 1,
    identity: { name: "Pixel", pixolarkId: "abcd1234", ecdhPkcs8: "AA", signPkcs8 },
    manifests: { "555111": manifest },
    ownedRoomIds: ["555111"],
    joinedRoomIds: ["555111"],
    lastCoordinator: "ws://localhost:8787/coordinator",
    lastSelectedRoom: { discover: "555111" },
    drafts: { "555111": "draft text" },
    pinned: {},
    prefs: { sound: true },
    savedAt: NOW,
  };
}

beforeEach(async () => {
  await clearEverything();
});

describe("recovery registry", () => {
  it("persists and loads the encrypted payload (round-trip)", async () => {
    const payload = await samplePayload();
    await saveRecovery(payload);
    const loaded = await loadRecovery();
    expect(loaded.identity?.name).toBe("Pixel");
    expect(loaded.manifests["555111"]?.name).toBe("Recovered Room");
    expect(loaded.ownedRoomIds).toEqual(["555111"]);
    expect(loaded.drafts["555111"]).toBe("draft text");
  });

  it("merges patches instead of clobbering", async () => {
    await saveRecovery({ lastCoordinator: "ws://a/coordinator" });
    await saveRecovery({ drafts: { "123": "hi" } });
    const loaded = await loadRecovery();
    expect(loaded.lastCoordinator).toBe("ws://a/coordinator");
    expect(loaded.drafts["123"]).toBe("hi");
  });

  it("exports a password-protected backup and restores it on a cleared device", async () => {
    const payload = await samplePayload();
    await saveRecovery(payload);
    const backup = await exportRecovery("correct horse battery staple");

    // Simulate a wiped device / cleared browser storage:
    await clearEverything();
    expect((await loadRecovery()).identity).toBeNull();

    const restored = await importRecovery(backup, "correct horse battery staple");
    expect(restored.identity?.name).toBe("Pixel");
    expect((await loadRecovery()).manifests["555111"]?.roomId).toBe("555111");
    expect((await loadRecovery()).joinedRoomIds).toEqual(["555111"]);
  });

  it("rejects wrong passwords and foreign files", async () => {
    const payload = await samplePayload();
    await saveRecovery(payload);
    const backup = await exportRecovery("correct horse battery staple");
    await clearEverything();

    await expect(importRecovery(backup, "wrong password")).rejects.toThrow(/Wrong password/i);
    await expect(importRecovery({ hello: 1 }, "whatever")).rejects.toThrow(/Not a Pixolark backup/i);
  });

  it("refuses short backup passwords", async () => {
    await expect(exportRecovery("short")).rejects.toThrow(/8 characters/);
  });

  it("clearEverything leaves an honest empty registry", async () => {
    await saveRecovery(await samplePayload());
    await clearEverything();
    const loaded = await loadRecovery();
    expect(loaded.identity).toBeNull();
    expect(Object.keys(loaded.manifests)).toEqual([]);
    expect(loaded.joinedRoomIds).toEqual([]);
  });
});
