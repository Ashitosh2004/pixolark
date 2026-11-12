/** Runtime sticker library: loads the bundled manifests (static files, no backend),
 *  provides search, asset URLs and the P2P compatibility rules. */
import { STICKER_LIB_VERSION } from "./sticker-version";

export { STICKER_LIB_VERSION };
export interface LibSticker { id: string; name: string; category: string; keywords: string[]; characters: string[]; emotion: string; action: string; packs: string[]; asset: string; thumb: string; format: string; frames: number; fps: number; durationMs: number; loop: boolean; sha256: string; bytes: number; version: number }
export interface LibCategory { id: string; label: string; icon: string; count: number; manifest: string }
export interface LibPack { id: string; name: string; desc: string }
export interface Library { version: string; categories: LibCategory[]; packs: LibPack[]; stickers: LibSticker[]; byId: Map<string, LibSticker>; vocab: string[] }

const LIB_ID = /^([a-z]+)\.(\d{3})$/;
export const isLibStickerId = (id: string | undefined): id is string => !!id && LIB_ID.test(id);
export function stickerAsset(id: string, thumb = false): string | null {
  const m = LIB_ID.exec(id);
  return m ? `/stickers/${m[1]}/${m[2]}${thumb ? ".thumb" : ""}.png` : null;
}

let libPromise: Promise<Library> | null = null;
export function loadLibrary(): Promise<Library> {
  libPromise ??= (async () => {
    const idx = await (await fetch("/stickers/index.json")).json();
    const parts = await Promise.all((idx.categories as LibCategory[]).map(async (c) => (await (await fetch(c.manifest)).json()).stickers as LibSticker[]));
    const stickers = parts.flat();
    const freq = new Map<string, number>();
    for (const s of stickers) for (const k of s.keywords) freq.set(k, (freq.get(k) ?? 0) + 1);
    const vocab = [...freq.entries()].filter(([k]) => k.length > 1).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    return { version: idx.version, categories: idx.categories, packs: idx.packs, stickers, byId: new Map(stickers.map((s) => [s.id, s])), vocab };
  })().catch((e) => { libPromise = null; throw e; });
  return libPromise;
}

/** Multi-term search over names, keywords, categories, characters, emotions and actions. */
export function searchStickers(lib: Pick<Library, "stickers">, q: string, usage: Record<string, number> = {}): LibSticker[] {
  const terms = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: [LibSticker, number][] = [];
  for (const s of lib.stickers) {
    const name = s.name.toLowerCase();
    let score = 0, ok = true;
    for (const t of terms) {
      let best = 0;
      for (const k of s.keywords) { if (k === t) { best = 3; break; } if (k.startsWith(t)) best = Math.max(best, 2); }
      if (!best && name.includes(t)) best = 1;
      if (!best) { ok = false; break; }
      score += best;
    }
    if (ok) scored.push([s, score + Math.min(2, (usage[s.id] ?? 0) / 5)]);
  }
  return scored.sort((a, b) => b[1] - a[1]).map(([s]) => s);
}
export function autocomplete(vocab: string[], q: string, n = 6): string[] {
  const last = q.toLowerCase().trim().split(/\s+/).pop() ?? "";
  if (!last) return [];
  return vocab.filter((v) => v.startsWith(last) && v !== last).slice(0, n);
}

/** Decide how an incoming sticker message is rendered. A built-in ID is only trusted when the
 *  sender declares the exact same verified library version; otherwise the encrypted inline file
 *  (an image data URL carried inside the E2EE frame) is used. */
export function resolveIncomingSticker(h: { sticker?: unknown; stickerLib?: unknown; stickerUrl?: unknown }, ourVersion = STICKER_LIB_VERSION): { sticker?: string; stickerUrl?: string } {
  const url = typeof h.stickerUrl === "string" && h.stickerUrl.startsWith("data:image/") && h.stickerUrl.length < 600_000 ? h.stickerUrl : undefined;
  const id = typeof h.sticker === "string" ? h.sticker : undefined;
  if (isLibStickerId(id)) {
    if (h.stickerLib === ourVersion) return { sticker: id };
    return url ? { stickerUrl: url } : {};
  }
  if (id && /^px\d{1,3}$/.test(id)) return { sticker: id, ...(url ? { stickerUrl: url } : {}) };
  return url ? { stickerUrl: url } : {};
}

const dataCache = new Map<string, string>();
export async function stickerDataUrl(id: string): Promise<string> {
  const hit = dataCache.get(id); if (hit) return hit;
  const url = stickerAsset(id); if (!url) throw new Error("unknown sticker");
  const blob = await (await fetch(url)).blob();
  const out = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(blob); });
  if (dataCache.size > 50) dataCache.clear();
  dataCache.set(id, out);
  return out;
}
