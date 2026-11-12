import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCatalog, CATEGORIES } from "@/lib/pixel/stickercatalog";
import { renderFrames } from "@/lib/pixel/stickerart";
import { framesHash, validateFrames } from "@/lib/pixel/stickervalidate";
import { resolveIncomingSticker, searchStickers } from "@/lib/pixel/stickerlib";
import { STICKER_LIB_VERSION } from "@/lib/pixel/sticker-version";

const catalog = buildCatalog();
const TARGETS: Record<string, number> = { love: 100, cute: 120, memes: 120, animals: 120, couple: 100, friends: 100, reactions: 100, daily: 80, gaming: 80, festivals: 80 };

describe("sticker library", () => {
  it("has at least 1,000 stickers across 10 categories meeting each target", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(1000);
    expect(CATEGORIES.length).toBe(10);
    for (const [cat, n] of Object.entries(TARGETS)) expect(catalog.filter((s) => s.cat === cat).length).toBeGreaterThanOrEqual(n);
  });
  it("every sticker is animated, transparent and unique", () => {
    const seen = new Set<string>();
    for (const m of catalog) {
      const f = renderFrames({ species: m.species, expr: m.expr, action: m.action, fx: m.fx, ...(m.text ? { text: m.text } : {}), ...(m.pair ? { pair: true } : {}) });
      expect(validateFrames(f), m.id).toEqual({ ok: true });
      const h = framesHash(f); expect(seen.has(h), m.id).toBe(false); seen.add(h);
    }
  }, 60_000);
  it("exported assets and manifests match the catalog and bundled version", () => {
    const idx = JSON.parse(readFileSync("public/stickers/index.json", "utf8"));
    expect(idx.version).toBe(STICKER_LIB_VERSION);
    let n = 0;
    for (const c of CATEGORIES) {
      const man = JSON.parse(readFileSync(`public/stickers/${c.id}/manifest.json`, "utf8"));
      for (const s of man.stickers) { expect(existsSync("public" + s.asset), s.id).toBe(true); expect(existsSync("public" + s.thumb), s.id).toBe(true); n++; }
    }
    expect(n).toBe(catalog.length);
  });
  it("search finds by keyword, character and multi-word phrases", () => {
    const lib = { stickers: catalog.map((m) => ({ ...m, category: m.cat })) as never };
    expect(searchStickers(lib, "birthday").length).toBeGreaterThan(0);
    expect(searchStickers(lib, "cute cat").every((s: { keywords: string[] }) => s.keywords.some((k) => k.startsWith("cat")))).toBe(true);
    expect(searchStickers(lib, "zzqqxx")).toEqual([]);
  });
});

describe("incoming sticker rules", () => {
  const url = "data:image/png;base64,AAAA";
  it("uses the local asset only when the library version matches", () => {
    expect(resolveIncomingSticker({ sticker: "love.001", stickerLib: STICKER_LIB_VERSION, stickerUrl: url })).toEqual({ sticker: "love.001" });
  });
  it("falls back to the encrypted inline file when versions differ", () => {
    expect(resolveIncomingSticker({ sticker: "love.001", stickerLib: "pxs1-other", stickerUrl: url })).toEqual({ stickerUrl: url });
  });
  it("never trusts an unverified ID without a file", () => {
    expect(resolveIncomingSticker({ sticker: "love.001" })).toEqual({});
    expect(resolveIncomingSticker({ stickerUrl: "javascript:alert(1)" })).toEqual({});
  });
});
