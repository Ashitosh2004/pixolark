/** Validation shared by the asset pipeline, tests and the library stats screen. */
type Grid = (string | null)[][];
export function framesHash(frames: Grid[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = frames.map((f) => f.map((r) => r.map((c) => c ?? ".").join(",")).join("|")).join("#");
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822507); }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + ":" + s.length;
}
export function validateFrames(frames: Grid[]): { ok: true } | { ok: false; reason: string } {
  if (frames.length < 2) return { ok: false, reason: "not animated" };
  const keys = new Set(frames.map((f) => f.map((r) => r.join(",")).join("|")));
  if (keys.size < 2) return { ok: false, reason: "frames identical (no motion)" };
  for (const f of frames) {
    let filled = 0, total = 0;
    for (const r of f) for (const c of r) { total++; if (c) filled++; }
    if (filled / total > 0.8) return { ok: false, reason: "background not transparent" };
    if (filled / total < 0.06) return { ok: false, reason: "frame nearly empty" };
    if (f[0]![0] && f[0]![f.length - 1] && f[f.length - 1]![0] && f[f.length - 1]![f.length - 1]) return { ok: false, reason: "opaque corners" };
  }
  return { ok: true };
}
