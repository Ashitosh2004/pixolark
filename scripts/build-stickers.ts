/** Sticker asset pipeline. Run: bun scripts/build-stickers.ts
 *  Renders every catalog sticker frame-by-frame, exports transparent animated PNG (APNG)
 *  + static thumbnail, validates each asset, removes duplicates, and writes per-category
 *  manifests, a library index, a report and the bundled library version. */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { buildCatalog, CATEGORIES, PACKS } from "../src/lib/pixel/stickercatalog";
import { renderFrames, ACTION_FPS, FRAMES, SIZE } from "../src/lib/pixel/stickerart";
import { validateFrames, framesHash } from "../src/lib/pixel/stickervalidate";

const SCALE = 2;
const OUT = "public/stickers";
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length); out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length))); return out;
}
const u32 = (...v: number[]) => { const b = new Uint8Array(v.length * 4); const d = new DataView(b.buffer); v.forEach((x, i) => d.setUint32(i * 4, x)); return b; };
function rgba(grid: (string | null)[][]) {
  const w = SIZE * SCALE, raw = new Uint8Array((w * 4 + 1) * w);
  for (let y = 0; y < w; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const c = grid[Math.floor(y / SCALE)]![Math.floor(x / SCALE)]; const o = y * (w * 4 + 1) + 1 + x * 4; if (c) { raw[o] = parseInt(c.slice(1, 3), 16); raw[o + 1] = parseInt(c.slice(3, 5), 16); raw[o + 2] = parseInt(c.slice(5, 7), 16); raw[o + 3] = 255; } } }
  return deflateSync(raw, { level: 9 });
}
function encodePng(frames: (string | null)[][][], fps: number): Uint8Array {
  const w = SIZE * SCALE;
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const ihdr = new Uint8Array(13); const d = new DataView(ihdr.buffer); d.setUint32(0, w); d.setUint32(4, w); ihdr.set([8, 6, 0, 0, 0], 8);
  parts.push(chunk("IHDR", ihdr));
  const anim = frames.length > 1; let seq = 0;
  if (anim) parts.push(chunk("acTL", u32(frames.length, 0)));
  frames.forEach((f, i) => {
    if (anim) { const fc = new Uint8Array(26); const v = new DataView(fc.buffer); v.setUint32(0, seq++); v.setUint32(4, w); v.setUint32(8, w); v.setUint16(20, 1); v.setUint16(22, fps); fc[24] = 1; fc[25] = 0; parts.push(chunk("fcTL", fc)); }
    const data = rgba(f);
    if (i === 0) parts.push(chunk("IDAT", data));
    else { const fd = new Uint8Array(4 + data.length); new DataView(fd.buffer).setUint32(0, seq++); fd.set(data, 4); parts.push(chunk("fdAT", fd)); }
  });
  parts.push(chunk("IEND", new Uint8Array()));
  const total = parts.reduce((a, p) => a + p.length, 0); const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
function checkPng(b: Uint8Array): boolean {
  let o = 8; const dv = new DataView(b.buffer, b.byteOffset);
  while (o < b.length) { const len = dv.getUint32(o); if (crc32(b.subarray(o + 4, o + 8 + len)) !== dv.getUint32(o + 8 + len)) return false; o += 12 + len; }
  return o === b.length;
}

rmSync(OUT, { recursive: true, force: true });
const catalog = buildCatalog();
const seen = new Map<string, string>();
const report = { generatedAt: new Date().toISOString(), total: 0, verified: 0, animated: 0, missing: 0, invalid: 0, duplicates: 0, bytes: 0, byCategory: {} as Record<string, { verified: number; invalid: number; duplicates: number }>, problems: [] as string[] };
const manifests: Record<string, unknown[]> = {};
const verHash = createHash("sha256");
for (const m of catalog) {
  report.total++;
  const bc = (report.byCategory[m.cat] ??= { verified: 0, invalid: 0, duplicates: 0 });
  const frames = renderFrames({ species: m.species, expr: m.expr, action: m.action, fx: m.fx, ...(m.text ? { text: m.text } : {}), ...(m.pair ? { pair: true } : {}) });
  const v = validateFrames(frames);
  if (!v.ok) { report.invalid++; bc.invalid++; report.problems.push(`${m.id}: ${v.reason}`); continue; }
  const h = framesHash(frames);
  if (seen.has(h)) { report.duplicates++; bc.duplicates++; report.problems.push(`${m.id}: duplicate of ${seen.get(h)}`); continue; }
  seen.set(h, m.id);
  const fps = ACTION_FPS(m.action);
  const png = encodePng(frames, fps), thumb = encodePng([frames[0]!], fps);
  if (!checkPng(png) || !checkPng(thumb)) { report.invalid++; bc.invalid++; report.problems.push(`${m.id}: corrupt file`); continue; }
  const [cat, num] = m.id.split(".");
  mkdirSync(`${OUT}/${cat}`, { recursive: true });
  writeFileSync(`${OUT}/${cat}/${num}.png`, png); writeFileSync(`${OUT}/${cat}/${num}.thumb.png`, thumb);
  const sha = createHash("sha256").update(png).digest("hex").slice(0, 16);
  verHash.update(m.id + sha);
  report.verified++; report.animated++; bc.verified++; report.bytes += png.length + thumb.length;
  (manifests[cat!] ??= []).push({ id: m.id, name: m.name, category: m.cat, keywords: m.keywords, characters: m.species, emotion: m.expr, action: m.action, packs: m.packs, asset: `/stickers/${cat}/${num}.png`, thumb: `/stickers/${cat}/${num}.thumb.png`, format: "apng", frames: FRAMES, fps, durationMs: Math.round((FRAMES / fps) * 1000), loop: true, sha256: sha, bytes: png.length, version: 1 });
}
const version = `pxs1-${verHash.digest("hex").slice(0, 12)}`;
for (const c of CATEGORIES) writeFileSync(`${OUT}/${c.id}/manifest.json`, JSON.stringify({ version, category: c.id, label: c.label, stickers: manifests[c.id] ?? [] }));
writeFileSync(`${OUT}/index.json`, JSON.stringify({ version, categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label, icon: c.icon, count: (manifests[c.id] ?? []).length, manifest: `/stickers/${c.id}/manifest.json` })), packs: PACKS.map((p) => ({ id: p.id, name: p.name, desc: p.desc })) }));
writeFileSync(`${OUT}/report.json`, JSON.stringify({ version, ...report }, null, 1));
writeFileSync("src/lib/pixel/sticker-version.ts", `// Generated by scripts/build-stickers.ts — do not edit.\nexport const STICKER_LIB_VERSION = ${JSON.stringify(version)};\nexport const STICKER_LIB_COUNT = ${report.verified};\n`);
console.log(JSON.stringify({ version, total: report.total, verified: report.verified, invalid: report.invalid, duplicates: report.duplicates, kb: Math.round(report.bytes / 1024), byCategory: report.byCategory }));
if (report.problems.length) console.log(report.problems.slice(0, 30).join("\n"));
