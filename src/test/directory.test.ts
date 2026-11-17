/**
 * Static directory client tests — discovery with NO database.
 * Uses a fake fetch serving a real directory tree built from owner-signed
 * manifests. Pins the honesty rules: tampered/expired manifests are dropped
 * (never shown), filters work, and stale caches still refuse bad manifests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterRooms, loadDirectory, type DirectoryRoom } from "@/lib/pixel/directory";
import { signManifest, exportSigningPublicKeyRaw, generateSigningKey, ownerFingerprint, type RoomManifest } from "@/lib/pixel/manifest";
import { b64url } from "@/lib/pixel/bytes";

const NOW = Date.now();

async function makeRooms(): Promise<RoomManifest[]> {
  const keys = await generateSigningKey();
  const pubRaw = await exportSigningPublicKeyRaw(keys.publicKey);
  const owner = { id: await ownerFingerprint(pubRaw), signingKey: b64url(pubRaw) };
  const base = {
    desc: "",
    type: "public" as const,
    expiresAt: NOW + 24 * 60 * 60_000,
    coordinator: { urls: [] },
    capabilities: { media: true, stickers: true, history: false, slowMode: false, approval: false },
    invitation: { method: "open" as const },
    policy: { recovery: "owner-only" as const, coOwners: [] },
    createdAt: NOW - 1000,
    updatedAt: NOW,
  };
  const mk = async (o: Partial<RoomManifest> & { roomId: string; name: string; category: string }) =>
    await signManifest({ ...base, region: "", subRegion: "", city: "", languages: ["English"], owner, host: { commitment: "a".repeat(32) }, ...o } as Parameters<typeof signManifest>[0], keys.privateKey);

  return [
    await mk({ roomId: "111111", name: "Global Lounge", category: "General Chat" }),
    await mk({ roomId: "222222", name: "Kolhapur Pixels", category: "General Chat", region: "India", subRegion: "Maharashtra", city: "Kolhapur", languages: ["Marathi", "English"] }),
    await mk({ roomId: "333333", name: "Bengaluru Tech", category: "Technology", region: "India", subRegion: "Karnataka", city: "Bengaluru", languages: ["Kannada"] }),
    await mk({ roomId: "444444", name: "Expired Room", category: "General Chat", expiresAt: NOW - 1 }), // expired
  ];
}

let rooms: RoomManifest[];

beforeEach(async () => {
  rooms = await makeRooms();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Fake a static-host directory tree served over fetch. */
function serveTree(sections: Record<string, unknown>): void {
  vi.stubGlobal("fetch", (url: string) => {
    const path = url.replace(/^.*?\/room-directory/, "").replace(/^\//, "").split("?")[0]!;
    const body = path === "index.json" ? sections["index.json"] : sections[path];
    if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  });
}

describe("directory client", () => {
  it("loads and verifies listings; expired manifests never appear", async () => {
    const file = { v: 1, section: "global/general-chat", generatedAt: NOW, rooms };
    serveTree({
      "index.json": { v: 1, generatedAt: NOW, mirrors: [], sections: ["global/general-chat.json"] },
      "global/general-chat.json": file,
    });
    const list = await loadDirectory();
    const ids = list.map((r) => r.manifest.roomId).sort();
    expect(ids).toEqual(["111111", "222222", "333333"]); // 444444 expired → dropped
  });

  it("drops tampered manifests even if a mirror serves them", async () => {
    const tampered = JSON.parse(JSON.stringify(rooms[0])) as RoomManifest;
    tampered.name = "Evil Edited Name";
    const file = { v: 1, section: "global/general-chat", generatedAt: NOW, rooms: [tampered, rooms[1]!] };
    serveTree({
      "index.json": { v: 1, generatedAt: NOW, mirrors: [], sections: ["global/general-chat.json"] },
      "global/general-chat.json": file,
    });
    const list = await loadDirectory();
    expect(list.map((r) => r.manifest.roomId)).toEqual(["222222"]);
  });

  it("survives a down mirror via cache, still verifying", async () => {
    serveTree({
      "index.json": { v: 1, generatedAt: NOW, mirrors: [], sections: ["global/general-chat.json"] },
      "global/general-chat.json": { v: 1, section: "global/general-chat", generatedAt: NOW, rooms },
    });
    const first = await loadDirectory();
    expect(first.length).toBeGreaterThan(0);

    // Mirror goes down; cache serves within TTL.
    serveTree({});
    const second = await loadDirectory();
    expect(second.map((r) => r.manifest.roomId).sort()).toEqual(first.map((r) => r.manifest.roomId).sort());
  });

  it("filters by country/state/city, category, language and text", async () => {
    serveTree({
      "index.json": { v: 1, generatedAt: NOW, mirrors: [], sections: ["global/general-chat.json"] },
      "global/general-chat.json": { v: 1, section: "global/general-chat", generatedAt: NOW, rooms },
    });
    const all = (await loadDirectory()) as DirectoryRoom[];

    expect(filterRooms(all, { country: "India", state: "Maharashtra", city: "Kolhapur" }).map((r) => r.manifest.roomId)).toEqual(["222222"]);
    expect(filterRooms(all, { category: "Technology" }).map((r) => r.manifest.roomId)).toEqual(["333333"]);
    expect(filterRooms(all, { language: "Marathi" }).map((r) => r.manifest.roomId)).toEqual(["222222"]);
    expect(filterRooms(all, { text: "kolhapur" }).map((r) => r.manifest.roomId)).toEqual(["222222"]);
    expect(filterRooms(all, { country: "India" }).length).toBe(2);
  });

  it("handles total mirror outage with an honest empty list", async () => {
    serveTree({});
    const list = await loadDirectory();
    expect(list).toEqual([]);
  });
});
