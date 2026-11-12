// Pure pixel-drawing code for the animated sticker library. Bounds-checked at runtime.
// @ts-nocheck
/** Frame-by-frame procedural pixel art (32x32). Original characters only. Used by the
 *  asset pipeline (scripts/build-stickers.ts) and by validation tests — not at runtime. */
import { emptyGrid, outline, type Grid } from "./pixelart";

export const SIZE = 32;
export const K = "#111318";
const W = "#F5F5F5", PINK = "#F28DC2", BLUE = "#6EC5FF", Y = "#FFD166", R = "#FF6464", OR = "#FF8C61",
  G = "#8FE388", BR = "#8B5A3C", GRAY = "#A1A8B5", PURP = "#C9B6E4", DG = "#3E8E5A";

export interface Species { id: string; name: string; who: string; color: string; accent: string; belly: string; ears: string; mark?: string; shape?: string }
export const SPECIES: Species[] = [
  { id: "cat", name: "cat", who: "Mochi", color: "#FF8C61", accent: "#E06A45", belly: "#FFE3C8", ears: "cat", mark: "stripes" },
  { id: "dog", name: "dog", who: "Biscuit", color: "#E2B07A", accent: "#9C6B43", belly: "#FFF1DD", ears: "floppy", mark: "muzzle" },
  { id: "panda", name: "panda", who: "Bao", color: "#F5F5F5", accent: "#2A2D36", belly: "#F5F5F5", ears: "round", mark: "panda" },
  { id: "fox", name: "fox", who: "Ember", color: "#FF7A3D", accent: "#FFFFFF", belly: "#FFFFFF", ears: "fox", mark: "muzzle" },
  { id: "bear", name: "bear", who: "Cocoa", color: "#B07A4F", accent: "#7A4F31", belly: "#E8C9A5", ears: "round", mark: "muzzle" },
  { id: "bunny", name: "bunny", who: "Momo", color: "#F7F2F2", accent: "#F28DC2", belly: "#FFFFFF", ears: "long" },
  { id: "penguin", name: "penguin", who: "Pip", color: "#3B4252", accent: "#FFB347", belly: "#F5F5F5", ears: "none", mark: "face", shape: "beak" },
  { id: "duck", name: "duck", who: "Quackers", color: "#FFE066", accent: "#FF9F43", belly: "#FFF3B0", ears: "tuft", shape: "beak" },
  { id: "frog", name: "frog", who: "Lilypad", color: "#7BD86B", accent: "#4FA84A", belly: "#D7F5C2", ears: "frog" },
  { id: "hamster", name: "hamster", who: "Nibbles", color: "#F2C27B", accent: "#D99A4E", belly: "#FFF4E0", ears: "round", mark: "cheeks" },
  { id: "bird", name: "bird", who: "Chirp", color: "#6EC5FF", accent: "#FFD166", belly: "#DFF3FF", ears: "tuft", shape: "beak" },
  { id: "tiger", name: "tiger", who: "Stripe", color: "#FFA53D", accent: "#3A2A20", belly: "#FFF1DD", ears: "round", mark: "tiger" },
  { id: "lion", name: "lion", who: "Sunny", color: "#F6C453", accent: "#C0702F", belly: "#FFE9B5", ears: "round", mark: "mane" },
  { id: "monkey", name: "monkey", who: "Bongo", color: "#9C6B43", accent: "#F2D3B1", belly: "#F2D3B1", ears: "side", mark: "face" },
  { id: "capy", name: "capybara", who: "Capy", color: "#B98A5E", accent: "#8A6141", belly: "#D9B48C", ears: "tiny", mark: "snout" },
  { id: "pixo", name: "pixo", who: "Pixo", color: "#8FE388", accent: "#FFD166", belly: "#C9F5C2", ears: "antenna" },
  { id: "ghost", name: "ghost", who: "Boo", color: "#F5F5F5", accent: "#C9B6E4", belly: "#F5F5F5", ears: "none", shape: "ghost" },
  { id: "slime", name: "slime", who: "Gloop", color: "#7FD6C2", accent: "#4FB3A0", belly: "#B8F0E2", ears: "drip", shape: "slime" },
  { id: "robot", name: "robot", who: "Bolt", color: "#A1A8B5", accent: "#6EC5FF", belly: "#D5DAE3", ears: "bolt", shape: "box" },
  { id: "kai", name: "boy", who: "Kai", color: "#F5D0B0", accent: "#3A2A20", belly: "#6EC5FF", ears: "hair" },
  { id: "mei", name: "girl", who: "Mei", color: "#F5D0B0", accent: "#B0413E", belly: "#F28DC2", ears: "hairlong" },
  { id: "heart", name: "heart", who: "Lovey", color: "#FF6B8A", accent: "#FFB3C6", belly: "#FF6B8A", ears: "none", shape: "heart" },
  { id: "star", name: "star", who: "Twinkle", color: "#FFD166", accent: "#FFF0B3", belly: "#FFD166", ears: "none", shape: "star" },
  { id: "dino", name: "dino", who: "Rexy", color: "#8FD3A0", accent: "#4FA86A", belly: "#E2F7C8", ears: "spikes" },
];
export const speciesById = (id: string) => SPECIES.find((s) => s.id === id);

const set = (g: Grid, x: number, y: number, c: string | null) => { x = Math.round(x); y = Math.round(y); if (x >= 0 && x < SIZE && y >= 0 && y < SIZE) g[y][x] = c; };
const get = (g: Grid, x: number, y: number) => g[Math.round(y)]?.[Math.round(x)] ?? null;
function ell(g: Grid, cx: number, cy: number, rx: number, ry: number, c: string) {
  for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++)
    if (((x - cx) / (rx + 0.3)) ** 2 + ((y - cy) / (ry + 0.3)) ** 2 <= 1) set(g, x, y, c);
}
function rect(g: Grid, x: number, y: number, w: number, h: number, c: string) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(g, x + i, y + j, c); }
function sprite(g: Grid, x: number, y: number, rows: string[], pal: Record<string, string>) {
  rows.forEach((r, j) => r.split("").forEach((ch, i) => { if (pal[ch]) set(g, x + i, y + j, pal[ch]); }));
}
function heart(g: Grid, x: number, y: number, c = R, big = false) {
  sprite(g, x, y, big ? [".HH.HH.", "HHHHHHH", "HHHHHHH", ".HHHHH.", "..HHH..", "...H..."] : ["H.H", "HHH", ".H."], { H: c });
}

/* ---------- character ---------- */
export interface Pose { cx: number; cy: number; s: number; expr: string; blink?: boolean; alt?: boolean; armL?: number; armR?: number; squash?: number; step?: number; flip?: boolean }

export function drawChar(g: Grid, sp: Species, p: Pose) {
  const s = p.s, cx = p.cx, sq = p.squash ?? 0;
  let rx = Math.round(8 * s) + sq, ry = Math.round(7 * s) - sq;
  const cy = p.cy + sq;
  const shape = sp.shape;
  // behind-head features
  if (sp.mark === "mane") ell(g, cx, cy, rx + 2.5 * s, ry + 2.5 * s, sp.accent);
  if (sp.ears === "hairlong") rect(g, cx - rx - 1, cy - 1, rx * 2 + 3, Math.round(ry + 3 * s), sp.accent);
  // body
  const by = cy + ry + Math.round(2.5 * s);
  const brx = Math.max(2, 5.5 * s), bry = Math.max(2, 3.5 * s);
  if (!["ghost", "heart", "star", "slime"].includes(shape)) {
    ell(g, cx, by, brx, bry, sp.ears === "hair" || sp.ears === "hairlong" ? sp.belly : sp.color);
    if (sp.belly && sp.ears !== "hair" && sp.ears !== "hairlong") ell(g, cx, by + 0.5, brx - 2 * s, bry - 1.2 * s, sp.belly);
    const st = p.step ?? 0;
    const fy = Math.round(by + bry);
    rect(g, cx - Math.round(3 * s) - (st === 1 ? 1 : 0), fy - (st === 1 ? 1 : 0), Math.max(1, Math.round(2 * s)), 1, sp.ears === "hair" || sp.ears === "hairlong" ? "#3B4252" : sp.accent === "#FFFFFF" ? sp.color : sp.accent);
    rect(g, cx + Math.round(1.5 * s) + (st === 2 ? 1 : 0), fy - (st === 2 ? 1 : 0), Math.max(1, Math.round(2 * s)), 1, sp.ears === "hair" || sp.ears === "hairlong" ? "#3B4252" : sp.accent === "#FFFFFF" ? sp.color : sp.accent);
    // arms
    const armC = sp.color;
    const ax = Math.round(brx) + 1;
    const arm = (side: number, up: number) => {
      const x = cx + side * ax;
      if (up >= 2) { rect(g, x, by - Math.round(3 * s) - 3, 1, 3, armC); }
      else if (up === 1) { set(g, x, by - 1, armC); set(g, x + side, by - 2, armC); }
      else { set(g, x, by, armC); set(g, x, by + 1, armC); }
    };
    arm(-1, p.armL ?? 0); arm(1, p.armR ?? 0);
  }
  // head
  if (shape === "box") { rect(g, cx - rx, cy - ry + 1, rx * 2 + 1, ry * 2, sp.color); rect(g, cx - rx + 2, cy - ry + 3, rx * 2 - 3, ry * 2 - 5, sp.belly); }
  else if (shape === "heart") { for (let y = -ry - 2; y <= ry + 3; y++) for (let x = -rx - 2; x <= rx + 2; x++) { const X = x / (rx + 1), Yv = -(y - 1) / (ry + 1); if ((X * X + Yv * Yv - 1) ** 3 - X * X * Yv ** 3 <= 0) set(g, cx + x, cy + y, sp.color); } }
  else if (shape === "star") { for (let y = -ry - 3; y <= ry + 3; y++) for (let x = -rx - 3; x <= rx + 3; x++) { const a = Math.atan2(y, x), d = Math.hypot(x, y); const r = (rx * 0.55) + rx * 0.5 * Math.abs(Math.cos(2.5 * (a + Math.PI / 2))); if (d <= r) set(g, cx + x, cy + y + 1, sp.color); } }
  else if (shape === "ghost") { ell(g, cx, cy, rx, ry, sp.color); rect(g, cx - rx, cy, rx * 2 + 1, Math.round(ry + 4 * s), sp.color); const bot = Math.round(cy + ry + 4 * s); for (let x = -rx; x <= rx; x += 3) set(g, cx + x + ((p.step ?? 0) % 2), bot, null); }
  else if (shape === "slime") { ell(g, cx, cy + 2 * s, rx + 1, ry, sp.color); set(g, cx - 1, cy - ry + 2 * s - 1, sp.color); set(g, cx, cy - ry + 2 * s - 2, sp.color); }
  else ell(g, cx, cy, rx, ry, sp.color);
  // ears / top features
  const top = cy - ry;
  const e = sp.ears, ex = Math.round(5 * s);
  if (e === "cat" || e === "fox") for (const sd of [-1, 1]) { const x0 = cx + sd * ex; for (let i = 0; i < 3; i++) { set(g, x0, top - i, sp.color); if (i < 2) { set(g, x0 - sd, top - i, sp.color); } if (i === 0) set(g, x0 + sd, top, sp.color); } if (e === "fox") set(g, x0, top - 2, "#3A2A20"); else set(g, x0, top - 1, PINK); }
  if (e === "round") for (const sd of [-1, 1]) { ell(g, cx + sd * (ex + 1), top + 1, 1.7 * s + 0.3, 1.7 * s + 0.3, sp.mark === "panda" ? sp.accent : sp.color); }
  if (e === "side") for (const sd of [-1, 1]) ell(g, cx + sd * (rx + 1), cy, 1.5, 2, sp.accent);
  if (e === "tiny") for (const sd of [-1, 1]) { set(g, cx + sd * ex, top, sp.accent); set(g, cx + sd * ex, top - 1, sp.accent); }
  if (e === "long") for (const sd of [-1, 1]) { const x0 = cx + sd * Math.round(3 * s); const h = Math.round(7 * s); rect(g, x0 - (sd < 0 ? 1 : 0), top - h, 2, h + 1, sp.color); rect(g, x0 - (sd < 0 ? 1 : 0) + (sd < 0 ? 1 : 0), top - h + 1, 1, h - 1, sp.accent); }
  if (e === "floppy") for (const sd of [-1, 1]) ell(g, cx + sd * rx, cy - 1, 1.6 * s + 0.2, 3.5 * s, sp.accent);
  if (e === "tuft") { set(g, cx, top - 1, sp.accent); set(g, cx + 1, top - 2, sp.accent); set(g, cx - 1, top - 2, sp.accent); }
  if (e === "frog") for (const sd of [-1, 1]) ell(g, cx + sd * Math.round(4 * s), top + 1, 2.4 * s, 2.2 * s, sp.color);
  if (e === "antenna") { set(g, cx, top - 1, K); set(g, cx, top - 2, K); set(g, cx, top - 3, sp.accent); set(g, cx + 1, top - 3, sp.accent); }
  if (e === "bolt") { set(g, cx, top, K); set(g, cx, top - 1, K); set(g, cx, top - 2, sp.accent); for (const sd of [-1, 1]) rect(g, cx + sd * (rx + 1), cy - 1, 1, 3, sp.accent); }
  if (e === "drip") { set(g, cx - rx, cy + ry + 1, sp.accent); set(g, cx + rx - 1, cy + ry + 2, sp.accent); }
  if (e === "spikes") for (let i = -1; i <= 1; i++) { set(g, cx + i * 3, top - 1, sp.accent); set(g, cx + i * 3, top - 2 + Math.abs(i), sp.accent); }
  if (e === "hair" || e === "hairlong") { for (let x = -rx; x <= rx; x++) for (let y = top; y < top + Math.round(3.5 * s); y++) if (get(g, cx + x, y) === sp.color) set(g, cx + x, y, sp.accent); set(g, cx + 2, top + Math.round(3.5 * s), sp.accent); set(g, cx - 3, top + Math.round(3.5 * s), sp.accent); if (e === "hairlong") { set(g, cx + rx, top + 2, R); set(g, cx + rx + 1, top + 1, R); set(g, cx + rx + 1, top + 3, R); } }
  // markings
  const eyX = Math.round(3.5 * s), eyY = cy - (e === "frog" ? Math.round(4 * s) : 0);
  if (sp.mark === "panda") for (const sd of [-1, 1]) ell(g, cx + sd * eyX, eyY + 0.5, 1.6 * s, 1.6 * s, sp.accent);
  if (sp.mark === "tiger" || sp.mark === "stripes") { set(g, cx, top + 1, sp.accent); set(g, cx, top + 2, sp.accent); set(g, cx - 2, top + 1, sp.accent); set(g, cx + 2, top + 1, sp.accent); if (sp.mark === "tiger") { set(g, cx - rx, cy, sp.accent); set(g, cx + rx, cy, sp.accent); set(g, cx - rx + 1, cy - 2, sp.accent); set(g, cx + rx - 1, cy - 2, sp.accent); } }
  if (sp.mark === "muzzle" || sp.mark === "snout") ell(g, cx, cy + Math.round(3 * s), (sp.mark === "snout" ? 3.5 : 2.6) * s, 1.6 * s, sp.belly);
  if (sp.mark === "face") ell(g, cx, cy + 1, rx - 2, ry - 2, sp.belly);
  if (sp.mark === "cheeks") for (const sd of [-1, 1]) ell(g, cx + sd * (rx - 1), cy + 2, 1.5, 1.2, sp.belly);
  // face
  drawEyes(g, cx, eyY, eyX, p.blink ? "closed" : p.expr, sp);
  drawMouth(g, cx, cy + Math.round(3 * s), p, sp);
  if (["shy", "love", "blush", "kiss", "cute"].includes(p.expr)) for (const sd of [-1, 1]) { set(g, cx + sd * (eyX + 2), eyY + 2, PINK); set(g, cx + sd * (eyX + 1), eyY + 2, PINK); }
}

function drawEyes(g: Grid, cx: number, ey: number, dx: number, expr: string, sp: Species) {
  const map: Record<string, string> = { happy: "happy", laugh: "happy", love: "heart", shy: "closed", sleep: "closed", sad: "sad", cry: "sad", angry: "angry", shock: "wide", wide: "wide", dizzy: "x", dead: "x", star: "star", wink: "wink", meh: "meh", sus: "meh", cool: "shades", kiss: "wink", blush: "dot", cute: "sparkle", smile: "sparkle", neutral: "dot", closed: "closed", teary: "teary" };
  const k = map[expr] ?? "dot";
  const ink = sp.mark === "panda" ? W : K;
  if (k === "shades") { rect(g, cx - dx - 2, ey, dx * 2 + 5, 2, K); set(g, cx - dx - 1, ey, W); set(g, cx + dx, ey, W); return; }
  for (const sd of [-1, 1]) {
    const x = cx + sd * dx;
    switch (k) {
      case "dot": set(g, x, ey, ink); set(g, x, ey + 1, ink); break;
      case "sparkle": set(g, x, ey, ink); set(g, x + 1, ey, ink); set(g, x, ey + 1, ink); set(g, x + 1, ey + 1, ink); set(g, x, ey, W); break;
      case "teary": set(g, x, ey, ink); set(g, x + 1, ey, ink); set(g, x, ey + 1, BLUE); set(g, x + 1, ey + 1, ink); set(g, x, ey, W); break;
      case "wide": set(g, x, ey, W); set(g, x + 1, ey, W); set(g, x, ey + 1, W); set(g, x + 1, ey + 1, ink); break;
      case "happy": set(g, x - 1, ey + 1, ink); set(g, x, ey, ink); set(g, x + 1, ey + 1, ink); break;
      case "closed": set(g, x - 1, ey + 1, ink); set(g, x, ey + 1, ink); set(g, x + 1, ey + 1, ink); break;
      case "meh": set(g, x - 1, ey, ink); set(g, x, ey, ink); set(g, x + 1, ey, ink); set(g, x, ey + 1, ink); break;
      case "heart": set(g, x - 1, ey, R); set(g, x + 1, ey, R); set(g, x - 1, ey + 1, R); set(g, x, ey + 1, R); set(g, x + 1, ey + 1, R); set(g, x, ey + 2, R); break;
      case "x": set(g, x - 1, ey - 1, ink); set(g, x + 1, ey - 1, ink); set(g, x, ey, ink); set(g, x - 1, ey + 1, ink); set(g, x + 1, ey + 1, ink); break;
      case "star": set(g, x, ey - 1, Y); set(g, x - 1, ey, Y); set(g, x, ey, Y); set(g, x + 1, ey, Y); set(g, x, ey + 1, Y); break;
      case "sad": set(g, x, ey + 1, ink); set(g, x - sd, ey - 1, ink); set(g, x, ey, ink); break;
      case "angry": set(g, x, ey + 1, ink); set(g, x, ey, ink); set(g, x + sd, ey - 1, ink); set(g, x - sd * 0, ey - 1, null); set(g, x - sd, ey - 1, ink); break;
      case "wink": if (sd > 0) { set(g, x - 1, ey + 1, ink); set(g, x, ey, ink); set(g, x + 1, ey + 1, ink); } else { set(g, x, ey, ink); set(g, x, ey + 1, ink); } break;
    }
  }
}

function drawMouth(g: Grid, cx: number, my: number, p: Pose, sp: Species) {
  if (sp.shape === "beak") { rect(g, cx - 1, my - 1, 3, 1, sp.accent); rect(g, cx - (p.alt ? 1 : 0), my, p.alt ? 3 : 1, 1, p.alt ? R : sp.accent); return; }
  const m: Record<string, string> = { happy: "smile", smile: "smile", cute: "cat", laugh: "grin", love: "smile", shy: "small", sleep: "small", sad: "frown", cry: "open", angry: "frown", shock: "o", wide: "o", dizzy: "wavy", dead: "flat", star: "grin", wink: "tongue", meh: "flat", sus: "smirk", cool: "smirk", kiss: "kiss", blush: "small", neutral: "flat", closed: "smile", teary: "wavy" };
  let k = m[p.expr] ?? "smile";
  if (p.alt) k = k === "grin" || k === "smile" ? "open" : k === "o" ? "small" : k === "open" ? "o" : k === "kiss" ? "small" : k;
  const ink = K;
  switch (k) {
    case "smile": set(g, cx - 2, my, ink); set(g, cx - 1, my + 1, ink); set(g, cx, my + 1, ink); set(g, cx + 1, my, ink); break;
    case "grin": rect(g, cx - 2, my, 4, 1, ink); rect(g, cx - 1, my + 1, 2, 1, R); set(g, cx - 2, my + 1, ink); set(g, cx + 1, my + 1, ink); break;
    case "open": rect(g, cx - 1, my, 2, 1, ink); rect(g, cx - 1, my + 1, 2, 1, R); set(g, cx - 2, my + 1, ink); set(g, cx + 1, my + 1, ink); rect(g, cx - 1, my + 2, 2, 1, ink); break;
    case "o": rect(g, cx - 1, my, 2, 2, ink); break;
    case "small": set(g, cx - 1, my, ink); set(g, cx, my, ink); break;
    case "flat": rect(g, cx - 2, my, 4, 1, ink); break;
    case "frown": set(g, cx - 2, my + 1, ink); set(g, cx - 1, my, ink); set(g, cx, my, ink); set(g, cx + 1, my + 1, ink); break;
    case "cat": set(g, cx - 2, my, ink); set(g, cx - 1, my + 1, ink); set(g, cx, my, ink); set(g, cx + 1, my + 1, ink); set(g, cx + 2, my, ink); break;
    case "wavy": set(g, cx - 2, my + 1, ink); set(g, cx - 1, my, ink); set(g, cx, my + 1, ink); set(g, cx + 1, my, ink); break;
    case "tongue": rect(g, cx - 2, my, 4, 1, ink); set(g, cx, my + 1, PINK); break;
    case "smirk": set(g, cx - 1, my, ink); set(g, cx, my, ink); set(g, cx + 1, my - 1, ink); break;
    case "kiss": set(g, cx, my, R); set(g, cx - 1, my, R); set(g, cx, my + 1, R); break;
  }
}

/* ---------- props & effects (drawn per frame) ---------- */
export type Fx = string;
const FONT: Record<string, string> = {
  A: "010101111101101", B: "110101110101110", C: "011100100100011", D: "110101101101110", E: "111100110100111", F: "111100110100100",
  G: "011100101101011", H: "101101111101101", I: "111010010010111", J: "001001001101010", K: "101101110101101", L: "100100100100111",
  M: "101111111101101", N: "110101101101101", O: "010101101101010", P: "110101110100100", Q: "010101101110011", R: "110101110101101",
  S: "011100010001110", T: "111010010010010", U: "101101101101111", V: "101101101101010", W: "101101111111101", X: "101101010101101",
  Y: "101101010010010", Z: "111001010100111", "0": "111101101101111", "1": "010110010010111", "2": "110001010100111", "3": "110001010001110",
  "4": "101101111001001", "5": "111100110001110", "6": "011100111101111", "7": "111001010010010", "8": "111101111101111", "9": "111101111001110",
  "!": "010010010000010", "?": "110001010000010", ".": "000000000000010", "<": "000101111111010", "'": "010010000000000", "-": "000000111000000", " ": "000000000000000",
};
export function drawText(g: Grid, text: string, y: number, color = Y) {
  const t = text.toUpperCase();
  const w = t.length * 4 - 1;
  let x = Math.round((SIZE - w) / 2);
  const layer = emptyGrid(SIZE, SIZE);
  for (const ch of t) {
    const f = FONT[ch] ?? FONT[" "];
    for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (f[j * 3 + i] === "1") set(layer, x + i, y + j, ch === "<" ? R : color);
    x += 4;
  }
  const o = outline(layer, K);
  for (let yy = 0; yy < SIZE; yy++) for (let xx = 0; xx < SIZE; xx++) if (o[yy][xx]) g[yy][xx] = o[yy][xx];
}

export function drawFx(g: Grid, fx: Fx, f: number, n: number, c: { cx: number; cy: number; s: number }) {
  const t = f / n, px = c.cx + Math.round(9 * c.s) + 1, py = c.cy + Math.round(4 * c.s);
  switch (fx) {
    case "hearts": for (let i = 0; i < 3; i++) { const ph = (t + i / 3) % 1; heart(g, [3, 26, 14][i] + (i === 2 ? (f % 2) : 0), Math.round(24 - ph * 22), [R, PINK, R][i]); } break;
    case "bigheart": { const b = f % 4 < 2; heart(g, px - (b ? 3 : 2), py - (b ? 1 : 0), R, b); if (!b) heart(g, px - 1, py, R); break; }
    case "heartburst": for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, r = 3 + t * 12; heart(g, c.cx + Math.cos(a) * r - 1, c.cy + Math.sin(a) * r - 1, i % 2 ? PINK : R); } break;
    case "orbithearts": for (let i = 0; i < 3; i++) { const a = t * Math.PI * 2 + i * 2.1; heart(g, c.cx + Math.cos(a) * 11 - 1, c.cy - 9 + Math.sin(a) * 3, R); } break;
    case "tears": for (const sd of [-1, 1]) { const y = c.cy + 2 + (f % 4) * 2; set(g, c.cx + sd * Math.round(3.5 * c.s), y, BLUE); set(g, c.cx + sd * Math.round(3.5 * c.s), y + 1, BLUE); } break;
    case "cryflood": for (const sd of [-1, 1]) for (let y = c.cy + 2; y < 30; y++) if ((y + f) % 3) set(g, c.cx + sd * (Math.round(3.5 * c.s) + 2 + ((y + f) % 2)), y, BLUE); break;
    case "zzz": for (let i = 0; i < 2; i++) { const ph = (t + i / 2) % 1; const x = 24 + Math.round(ph * 4), y = Math.round(12 - ph * 10); sprite(g, x, y, ["ZZZ", "..Z", ".Z.", "Z..", "ZZZ"].slice(0, 5).map((r, j) => (j === 0 || j === 4 ? r : r)).filter((_, j) => j !== 1), { Z: i ? BLUE : W }); } break;
    case "sparkle": for (const [x, y, k] of [[3, 4, 0], [27, 7, 1], [5, 22, 2], [26, 22, 3]]) if ((f + k) % 4 < 2) { set(g, x, y, Y); set(g, x - 1, y, Y); set(g, x + 1, y, Y); set(g, x, y - 1, Y); set(g, x, y + 1, Y); } else set(g, x, y, W); break;
    case "sweat": { const y = c.cy - 6 + (f % 4); set(g, c.cx + Math.round(8 * c.s), y, BLUE); set(g, c.cx + Math.round(8 * c.s), y + 1, BLUE); set(g, c.cx + Math.round(8 * c.s) - 1, y + 1, BLUE); break; }
    case "vein": if (f % 4 < 3) sprite(g, c.cx + Math.round(6 * c.s), c.cy - Math.round(8 * c.s), ["R.R", ".R.", "R.R"], { R }); break;
    case "question": sprite(g, 25, 2 + (f % 4 < 2 ? 0 : 1), ["QQQ.", "...Q", "..Q.", ".Q..", "....", ".Q.."], { Q: Y }); break;
    case "exclaim": sprite(g, 26, 2 + (f % 2), ["E", "E", "E", "E", ".", "E"], { E: R }); sprite(g, 28, 3 - (f % 2), ["E", "E", "E", ".", "E"], { E: R }); break;
    case "music": for (let i = 0; i < 2; i++) { const ph = (t + i / 2) % 1; sprite(g, i ? 25 : 3, Math.round(20 - ph * 16), [".NN", ".N.", ".N.", "NN."], { N: i ? Y : G }); } break;
    case "confetti": for (let i = 0; i < 14; i++) { const x = (i * 7 + 3) % 31, y = (i * 5 + Math.round(t * 32)) % 32; set(g, x, y, [R, Y, G, BLUE, PINK][i % 5]); } break;
    case "fireworks": for (const [ox, oy, col, off] of [[7, 7, Y, 0], [25, 6, PINK, 3], [16, 3, BLUE, 5]]) { const ph = ((f + off) % n) / n; const r = Math.round(ph * 6); if (r === 0) { set(g, ox, oy + 3, col); continue; } for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; set(g, ox + Math.cos(a) * r, oy + Math.sin(a) * r, ph > 0.8 ? GRAY : col); } } break;
    case "explode": for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2, r = 4 + t * 12; set(g, c.cx + Math.cos(a) * r, c.cy - 4 + Math.sin(a) * r, [OR, Y, R][i % 3]); set(g, c.cx + Math.cos(a) * (r - 1), c.cy - 4 + Math.sin(a) * (r - 1), Y); } break;
    case "dizzy": for (let i = 0; i < 3; i++) { const a = t * Math.PI * 2 + i * 2.1; const x = c.cx + Math.cos(a) * 9, y = c.cy - 9 + Math.sin(a) * 2; set(g, x, y, Y); set(g, x + 1, y, Y); set(g, x, y - 1, Y); } break;
    case "kiss": { const ph = t; heart(g, c.cx + 6 + Math.round(ph * 8), c.cy - 2 - Math.round(ph * 8), R); break; }
    case "rose": sprite(g, px, py - 4, [".RR.", "RRRR", ".RR.", "..G.", ".GG.", "..G.", "..G."], { R, G: DG }); break;
    case "flower": sprite(g, px, py - 4 - (f % 4 < 2 ? 0 : 1), [".P.", "PYP", ".P.", ".G.", "GG.", ".G."], { P: PINK, Y, G: DG }); break;
    case "letter": sprite(g, px - 1, py - 2 - (f % 4 < 2 ? 0 : 1), ["WWWWW", "WR.RW", "WWRWW", "WWWWW"], { W, R }); break;
    case "ring": sprite(g, px - 1, py - 3, [".YY.", "Y..Y", "Y..Y", ".YY."], { Y }); if (f % 4 < 2) set(g, px + 1, py - 4, W); else set(g, px + 3, py - 5, W); break;
    case "food": sprite(g, px - 1, py - 2, [".BBB.", "BCBCB", "BBBBB", ".BBB."], { B: "#D99A4E", C: BR }); if (f % 4 === 1) set(g, px + 3, py - 1, null); break;
    case "pizza": sprite(g, px - 1, py - 3, ["YYYY", "YRYY", ".YRY", ".YY.", "..Y."], { Y: "#F6C453", R }); break;
    case "coffee": sprite(g, px - 1, py - 2, ["WWWW.", "WBBWW", "WWWW.", ".WW.."], { W, B: BR }); for (let i = 0; i < 2; i++) set(g, px + i * 2, py - 4 - ((f + i) % 3), GRAY); break;
    case "book": sprite(g, px - 2, py - 1, ["BBB.BBB", "BWWBWWB", "BBBBBBB"], { B: BLUE, W }); break;
    case "laptop": sprite(g, px - 2, py - 3, ["GGGGG", "GBBBG", "GBBBG", "GGGGGG"], { G: GRAY, B: f % 2 ? BLUE : "#3B4252" }); break;
    case "dumbbell": { const y = py - 2 - (f % 4 < 2 ? 0 : 3); sprite(g, px - 2, y, ["K...K", "KGGGK", "K...K"], { K: "#3B4252", G: GRAY }); break; }
    case "suitcase": sprite(g, px - 1, py - 3, [".KK.", "OOOO", "OYOO", "OOOO"], { K, O: OR, Y }); break;
    case "bag": sprite(g, px - 1, py - 3, [".KK.", "K..K", "PPPP", "PWPP", "PPPP"], { K, P: PINK, W }); break;
    case "cake": sprite(g, px - 2, py - 5, ["..F..", "..W..", "PPPPP", "WWWWW", "PPPPP"], { F: f % 2 ? Y : OR, W, P: PINK }); break;
    case "gift": sprite(g, px - 1, py - 3, ["Y.Y.", ".YY.", "RYRR", "RYRR", "RYRR"], { Y, R }); break;
    case "balloon": { const b = f % 4 < 2 ? 0 : 1; sprite(g, px, 2 + b, [".RR.", "RRRR", "RRRR", ".RR.", "..G.", "..G.", ".G..", ".G..", "..G."], { R: f % 8 < 4 ? R : R, G: GRAY }); break; }
    case "diya": sprite(g, px - 2, py - 3, ["..F..", ".FYF.", "OOOOO", ".OOO."], { F: f % 2 ? Y : OR, Y: W, O: "#C0702F" }); break;
    case "holi": for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2 + t, r = 8 + ((f + i) % 3) * 2; set(g, c.cx + Math.cos(a) * r, c.cy + Math.sin(a) * r * 0.8, [PINK, Y, G, BLUE, OR, PURP][i % 6]); set(g, c.cx + Math.cos(a) * r + 1, c.cy + Math.sin(a) * r * 0.8, [PINK, Y, G, BLUE, OR, PURP][(i + f) % 6]); } break;
    case "tree": { sprite(g, px - 2, py - 7, ["..Y..", "..G..", ".GGG.", "GGGGG", ".GGG.", "GGGGG", "..B.."], { Y, G: DG, B: BR }); set(g, px - 1, py - 4, f % 2 ? R : Y); set(g, px + 1, py - 2, f % 2 ? BLUE : R); break; }
    case "lantern": sprite(g, px - 1, py - 6 + (f % 4 < 2 ? 0 : 1), [".K.", "RRR", "RYR", "RYR", "RRR", ".Y."], { K, R, Y: f % 2 ? Y : OR }); break;
    case "sun": { sprite(g, 2, 2, [".YY.", "YYYY", "YYYY", ".YY."], { Y }); const rays = f % 2 ? [[0, 3], [7, 3], [3, 0], [3, 7]] : [[1, 1], [6, 1], [1, 6], [6, 6]]; rays.forEach(([x, y]) => set(g, x, y, Y)); break; }
    case "moon": { sprite(g, 25, 2, [".YYY", "YY..", "YY..", ".YYY"], { Y }); if (f % 4 < 2) set(g, 22, 6, W); else set(g, 29, 9, W); break; }
    case "controller": sprite(g, px - 2, py - 2, [".GGGG.", "GKGGRG", "KKKGGG", ".GKGG.".replace("K", "G")], { G: GRAY, K: "#3B4252", R: f % 2 ? R : Y }); break;
    case "sword": sprite(g, px, py - 7, ["..W", ".W.", "W..", "Y..", "B.."].map((r) => r), { W, Y, B: BR }); if (f % 4 === 0) set(g, px + 3, py - 8, Y); break;
    case "coin": { const w = [3, 2, 1, 2][f % 4]; const yy = 3 + (f % 8 < 4 ? f % 4 : 3 - (f % 4)); rect(g, 26 - Math.floor(w / 2), yy, w, 4, Y); set(g, 26, yy + 1, OR); break; }
    case "trophy": sprite(g, px - 2, py - 4, ["YYYYY", "YYYYY", ".YYY.", "..Y..", ".BBB."], { Y, B: BR }); if (f % 4 < 2) set(g, px - 3, py - 5, W); else set(g, px + 3, py - 5, W); break;
    case "medal": sprite(g, px - 1, py - 5, ["B.B", ".B.", "YYY", "YWY", "YYY"], { B: BLUE, Y, W: f % 2 ? W : Y }); break;
    case "skull": sprite(g, 24, 2 + (f % 4 < 2 ? 0 : 1), [".WWW.", "WKWKW", "WWWWW", ".W.W."], { W, K }); break;
    case "fire": for (const x of [3, 27]) sprite(g, x - 1, 22 - (f % 2), [".R.", "ROR", "OYO", ".O."], { R, O: OR, Y }); break;
    case "lightbulb": sprite(g, 25, 1, [".YY.", "YYYY", "YYYY", ".GG."], { Y: f % 2 ? Y : W, G: GRAY }); break;
    case "bubble": { const r = 1 + (f % 4); ell(g, c.cx + 6, c.cy + 2, r * 0.6, r * 0.6, BLUE); break; }
    case "clap": if (f % 2) { sprite(g, c.cx - 1, c.cy - 12, ["Y.Y", ".Y.", "Y.Y"], { Y }); } break;
    case "drinks": for (const sd of [-1, 1]) sprite(g, c.cx + sd * 4 - 1, c.cy - 11 + (f % 4 < 2 ? 0 : 1), ["WWW", "YYY", "YYY", ".Y."], { W, Y: OR }); break;
    case "handhold": rect(g, c.cx - 2, c.cy + 6, 5, 1, PINK); break;
    case "wand": sprite(g, px, py - 5, ["Y.", ".B", ".B", ".B"], { Y: f % 2 ? Y : W, B: BR }); break;
    case "clock": sprite(g, 24, 3, [".WWW.", "WWKWW", "WWKKW", "WWWWW", ".WWW."], { W, K }); if (f % 2) set(g, 26, 5, R); break;
    case "dots": for (let i = 0; i < 3; i++) if (f % 4 > i) set(g, 24 + i * 2, 4, W); break;
  }
}

/* ---------- animation ---------- */
export interface FrameParams { ox: number; oy: number; blink?: boolean; alt?: boolean; armL?: number; armR?: number; squash?: number; step?: number; flip?: boolean }
export const ACTIONS: Record<string, { fps: number; words: string[]; f: (i: number) => FrameParams }> = {
  idle: { fps: 5, words: ["blink", "idle"], f: (i) => ({ ox: 0, oy: 0, blink: i === 5 }) },
  bounce: { fps: 10, words: ["bounce", "hop", "happy"], f: (i) => ({ ox: 0, oy: [0, -1, -2, -3, -3, -2, -1, 0][i], squash: i === 0 ? 1 : 0, armL: i > 2 && i < 6 ? 1 : 0, armR: i > 2 && i < 6 ? 1 : 0 }) },
  jump: { fps: 10, words: ["jump", "yay", "excited"], f: (i) => ({ ox: 0, oy: [1, 0, -2, -4, -4, -2, 0, 1][i], squash: i === 0 || i === 7 ? 1 : 0, armL: i > 1 && i < 6 ? 2 : 0, armR: i > 1 && i < 6 ? 2 : 0 }) },
  wave: { fps: 6, words: ["wave", "hello", "hi", "bye"], f: (i) => ({ ox: 0, oy: 0, armR: i % 2 ? 2 : 1, blink: i === 6 }) },
  shake: { fps: 12, words: ["shake", "tremble"], f: (i) => ({ ox: i % 2 ? 1 : -1, oy: 0 }) },
  tremble: { fps: 14, words: ["tremble", "nervous", "shiver"], f: (i) => ({ ox: [0, 1, 0, -1][i % 4] * (i % 2), oy: 0 }) },
  dance: { fps: 8, words: ["dance", "groove", "party"], f: (i) => ({ ox: [-1, 0, 1, 0][i % 4], oy: i % 2 ? -1 : 0, armL: i % 4 < 2 ? 2 : 0, armR: i % 4 < 2 ? 0 : 2, step: i % 4 < 2 ? 1 : 2 }) },
  laugh: { fps: 10, words: ["laugh", "haha", "lol"], f: (i) => ({ ox: 0, oy: i % 2 ? -1 : 0, alt: i % 2 === 1 }) },
  sway: { fps: 4, words: ["sway", "calm"], f: (i) => ({ ox: [-1, -1, 0, 1, 1, 1, 0, -1][i], oy: 0, blink: i === 4 }) },
  pulse: { fps: 6, words: ["pulse", "breathe"], f: (i) => ({ ox: 0, oy: 0, squash: i % 4 < 2 ? 0 : -1 }) },
  turn: { fps: 5, words: ["look", "turn", "suspicious"], f: (i) => ({ ox: i < 4 ? -1 : 1, oy: 0, flip: i >= 4 }) },
  fall: { fps: 8, words: ["fall", "faint", "collapse"], f: (i) => ({ ox: 0, oy: [0, 0, 1, 2, 3, 3, 3, 3][i], squash: i > 3 ? 2 : 0, blink: i > 3 }) },
  sleep: { fps: 3, words: ["sleep", "nap", "tired"], f: (i) => ({ ox: 0, oy: i % 4 < 2 ? 0 : 1, squash: i % 4 < 2 ? 0 : 1 }) },
  float: { fps: 7, words: ["fly", "float"], f: (i) => ({ ox: 0, oy: [0, -1, -2, -2, -1, 0, 1, 1][i], armL: i % 2 ? 1 : 0, armR: i % 2 ? 1 : 0 }) },
  walk: { fps: 8, words: ["walk", "go"], f: (i) => ({ ox: [-2, -1, 0, 1, 2, 1, 0, -1][i], oy: i % 2 ? -1 : 0, step: i % 2 ? 1 : 2 }) },
  run: { fps: 14, words: ["run", "escape", "flee"], f: (i) => ({ ox: [-3, -1, 1, 3, 1, -1, -3, -2][i], oy: i % 2 ? -1 : 0, step: i % 2 ? 1 : 2, armL: i % 2 ? 1 : 0, armR: i % 2 ? 0 : 1 }) },
  nod: { fps: 6, words: ["nod", "yes", "agree"], f: (i) => ({ ox: 0, oy: i % 2, blink: i % 4 === 1 }) },
  no: { fps: 7, words: ["no", "nope", "refuse"], f: (i) => ({ ox: [0, -1, 0, 1][i % 4], oy: 0, flip: i % 4 === 3 }) },
  hug: { fps: 6, words: ["hug", "cuddle"], f: (i) => ({ ox: 0, oy: 0, armL: i % 4 < 2 ? 2 : 1, armR: i % 4 < 2 ? 2 : 1, squash: i % 4 < 2 ? 0 : 1 }) },
  chew: { fps: 8, words: ["eat", "chew", "munch"], f: (i) => ({ ox: 0, oy: 0, alt: i % 2 === 1, armR: 1 }) },
};

export interface StickerSpec { species: string[]; expr: string; action: string; fx: string[]; text?: string; pair?: boolean }
export const FRAMES = 8;

function mirror(g: Grid): Grid { return g.map((r) => r.slice().reverse()); }

/** Render all frames of a sticker as colour grids (null = transparent). */
export function renderFrames(spec: StickerSpec): Grid[] {
  const act = ACTIONS[spec.action];
  const frames: Grid[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const fp = act.f(i);
    const chars = emptyGrid(SIZE, SIZE);
    const hasText = !!spec.text;
    const hasProp = spec.fx.some((x) => PROPS.has(x));
    const anchors: { cx: number; cy: number; s: number }[] = [];
    if (spec.pair) {
      const close = spec.action === "hug" ? (i % 4 < 2 ? 1 : 0) : 0;
      const s = 0.6, cy = hasText ? 11 : 14;
      spec.species.slice(0, 2).forEach((id, k) => {
        const sp = speciesById(id)!;
        const cx = (k === 0 ? 9 + close : 23 - close) + fp.ox;
        const layer = emptyGrid(SIZE, SIZE);
        drawChar(layer, sp, { cx, cy: cy + (k === 0 ? fp.oy : (i % 2 && spec.action !== "sleep" ? fp.oy : fp.oy)), s, expr: spec.expr, blink: fp.blink && k === 0, alt: fp.alt, armL: k === 1 ? fp.armL : 0, armR: k === 0 ? fp.armR : fp.armR, squash: fp.squash ? Math.min(1, fp.squash) : 0, step: fp.step });
        const o = outline(layer, K);
        for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (o[y][x]) chars[y][x] = o[y][x];
      });
      anchors.push({ cx: 16 + fp.ox, cy, s: 1 });
    } else {
      const sp = speciesById(spec.species[0])!;
      const s = hasText ? 0.8 : 1;
      const cx = (hasProp ? 13 : 16) + fp.ox, cy = (hasText ? 9 : 13) + fp.oy;
      const layer = emptyGrid(SIZE, SIZE);
      drawChar(layer, sp, { cx, cy, s, expr: spec.expr, blink: fp.blink, alt: fp.alt, armL: fp.armL, armR: fp.armR, squash: fp.squash, step: fp.step });
      let o = outline(layer, K);
      if (fp.flip) { o = mirror(o); }
      for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (o[y][x]) chars[y][x] = o[y][x];
      anchors.push({ cx, cy, s });
    }
    const fxl = emptyGrid(SIZE, SIZE);
    for (const fx of spec.fx) drawFx(fxl, fx, i, FRAMES, anchors[0]);
    const fo = outline(fxl, K);
    const out = chars;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (fxl[y][x]) out[y][x] = fxl[y][x]; else if (fo[y][x] && !out[y][x] && PROP_OUTLINE.has(spec.fx.find((f) => PROPS.has(f)) ?? "")) out[y][x] = fo[y][x];
    if (spec.text) drawText(out, spec.text, 26, spec.text.includes("<") ? W : Y);
    frames.push(out);
  }
  return frames;
}
export const PROPS = new Set(["rose", "flower", "letter", "ring", "food", "pizza", "coffee", "book", "laptop", "dumbbell", "suitcase", "bag", "cake", "gift", "diya", "tree", "lantern", "controller", "sword", "trophy", "medal", "wand", "bigheart"]);
const PROP_OUTLINE = PROPS;
export const ACTION_FPS = (a: string) => ACTIONS[a]?.fps ?? 6;
