import { afterEach, describe, expect, it, vi } from "vitest";
import { beaconOf, CATEGORIES, fetchBeacons, LANGUAGES, REGIONS, regionMatches, regionPath, roomFingerprint } from "@/lib/pixel/discovery";

function good(room = "PXROOM-AAAA") {
  return beaconOf(room, { name: "Test Room", desc: "A test room", cat: "Gaming", region: "", lang: "English", members: 3, cap: 12, hostName: "Host", hostId: "abcdef12" });
}

function res(text: string) {
  return { ok: true, text: async () => text } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe("room discovery beacons", () => {
  it("dedupes per room keeping the newest and skips malformed lines", async () => {
    const now = Math.floor(Date.now() / 1000);
    const newest = good();
    const older = { ...newest, members: 99 };
    const raw = [
      "not json at all",
      JSON.stringify({ message: "{ broken", time: now }),
      JSON.stringify({ message: JSON.stringify(older), time: now - 300 }),
      JSON.stringify({ message: JSON.stringify(newest), time: now - 10 }),
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => res(raw)));
    const list = await fetchBeacons();
    expect(list).toHaveLength(1);
    expect(list[0]!.members).toBe(3);
    expect(list[0]!.stale).toBe(false);
  });

  it("marks beacons older than the freshness window as stale (host offline)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const raw = JSON.stringify({ message: JSON.stringify(good()), time: now - 600 });
    vi.stubGlobal("fetch", vi.fn(async () => res(raw)));
    const list = await fetchBeacons();
    expect(list[0]!.stale).toBe(true);
  });

  it("lists closed rooms last", async () => {
    const now = Math.floor(Date.now() / 1000);
    const open = good("PXROOM-OPEN");
    const closed = { ...good("PXROOM-SHUT"), closed: true };
    const raw = [
      JSON.stringify({ message: JSON.stringify(closed), time: now }),
      JSON.stringify({ message: JSON.stringify(open), time: now }),
    ].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => res(raw)));
    const list = await fetchBeacons();
    expect(list.map((b) => b.room)).toEqual(["PXROOM-OPEN", "PXROOM-SHUT"]);
  });

  it("never returns anything on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(fetchBeacons()).resolves.toEqual([]);
  });

  it("trims long metadata and produces stable fingerprints", () => {
    const b = beaconOf("PXROOM-BBBB", { name: "x".repeat(80), desc: "y".repeat(400), cat: "General Chat", region: "India", lang: "Hindi", members: 1, cap: 5, hostName: "h", hostId: "zz" });
    expect(b.name.length).toBe(48);
    expect(b.desc.length).toBe(160);
    const f1 = roomFingerprint("hostid", "PXROOM-BBBB");
    expect(roomFingerprint("hostid", "PXROOM-BBBB")).toBe(f1);
    expect(roomFingerprint("hostid", "PXROOM-CCCC")).not.toBe(f1);
    expect(roomFingerprint("other", "PXROOM-BBBB")).not.toBe(f1);
  });

  it("ships the full category/region/language catalogs", () => {
    expect(CATEGORIES).toContain("Programming");
    expect(REGIONS["India"]!.children).toContain("Karnataka");
    expect(LANGUAGES).toContain("Kannada");
  });

  it("ships a three-level region catalog (country → state → city)", () => {
    expect(REGIONS["India"]!.cities!["Karnataka"]).toContain("Bengaluru");
    expect(REGIONS["India"]!.cities!["Maharashtra"]).toContain("Kolhapur");
    expect(REGIONS["United States"]!.cities!["California"]).toContain("San Francisco");
    // every listed city belongs to a listed state of its country
    for (const node of Object.values(REGIONS)) {
      for (const [state, cities] of Object.entries(node.cities ?? {})) {
        expect(node.children, `${node.name}/${state}`).toContain(state);
        expect(cities.length).toBeGreaterThan(0);
      }
    }
    // International has no subdivisions
    expect(REGIONS["International"]!.children).toBeUndefined();
    expect(REGIONS["International"]!.cities).toBeUndefined();
  });

  it("builds region paths and matches beacons at country/state/city granularity", () => {
    expect(regionPath({ region: "India", subRegion: "Karnataka", city: "Bengaluru" })).toBe("India · Karnataka · Bengaluru");
    expect(regionPath({ region: "India", subRegion: "Karnataka" })).toBe("India · Karnataka");
    expect(regionPath({ region: "India" })).toBe("India");
    expect(regionPath({ region: "" })).toBe("");
    // country selection matches everything below it
    expect(regionMatches("India · Karnataka · Bengaluru", "India")).toBe(true);
    expect(regionMatches("India · Karnataka", "India")).toBe(true);
    expect(regionMatches("India", "India")).toBe(true);
    // state selection matches its cities but not other states or shallower tags
    expect(regionMatches("India · Karnataka · Bengaluru", "India · Karnataka")).toBe(true);
    expect(regionMatches("India · Maharashtra", "India · Karnataka")).toBe(false);
    expect(regionMatches("India", "India · Karnataka")).toBe(false);
    // city selection is exact
    expect(regionMatches("India · Karnataka · Bengaluru", "India · Karnataka · Bengaluru")).toBe(true);
    expect(regionMatches("India · Karnataka · Mysuru", "India · Karnataka · Bengaluru")).toBe(false);
    // legacy "/" separators and empty selection (no filter)
    expect(regionMatches("India/Karnataka", "India")).toBe(true);
    expect(regionMatches("anything", "")).toBe(true);
  });
});
