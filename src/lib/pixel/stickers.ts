// Pure pixel-drawing code: indexed grid access is bounds-checked at runtime.
// @ts-nocheck
/** Procedurally drawn, original pixel stickers (16x16). Sent by ID; both peers render identically. */
import { emptyGrid, gridToSvg, outline, svgUri, type Grid } from "./pixelart";

type Body = "blob" | "cat" | "bunny" | "frog" | "ghost" | "heart" | "pad" | "star" | "slime" | "bear";
type Eyes = "dot" | "happy" | "heart" | "x" | "closed" | "star" | "wide" | "sad" | "wink" | "angry";
type Mouth = "smile" | "open" | "flat" | "frown" | "cat" | "tongue" | "o" | "grin";
type Extra = "blush" | "sweat" | "tears" | "hearts" | "hat" | "sparkle" | "zzz" | "fire" | "crown" | "cry" | null;

export interface StickerDef { id: string; name: string; cat: string; body: Body; color: string; eyes: Eyes; mouth: Mouth; extra: Extra; anim?: "bob" | "wiggle" | "pulse" | "spin" }

const K = "#111318", W = "#F5F5F5", PINK = "#F28DC2", BLUE = "#6EC5FF", Y = "#FFD166", R = "#FF6464", OR = "#FF8C61";

function mask(body: Body): Grid {
  const g = emptyGrid(16, 16);
  const set = (x: number, y: number, c: string) => { if (x >= 0 && x < 16 && y >= 0 && y < 16) g[y][x] = c; };
  const circle = (cx: number, cy: number, rx: number, ry: number) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) set(x, y, "B");
  };
  switch (body) {
    case "blob": circle(7.5, 8.5, 6.3, 6); break;
    case "cat": circle(7.5, 9, 6.3, 5.6); [[3,2],[3,3],[4,3],[2,3],[12,2],[12,3],[11,3],[13,3]].forEach(([x,y]) => set(x,y,"B")); break;
    case "bear": circle(7.5, 9, 6.3, 5.6); circle(3, 3.5, 1.6, 1.6); circle(12, 3.5, 1.6, 1.6); break;
    case "bunny": circle(7.5, 10, 6, 5); for (let y = 0; y < 6; y++) { set(4,y,"B"); set(5,y,"B"); set(10,y,"B"); set(11,y,"B"); } break;
    case "frog": circle(7.5, 9.5, 7, 5); circle(4, 4.5, 2, 2); circle(11, 4.5, 2, 2); break;
    case "ghost": circle(7.5, 7, 6, 6); for (let y = 7; y < 15; y++) for (let x = 2; x < 14; x++) set(x, y, "B"); [3,7,11].forEach((x) => { set(x,14,null as any); set(x+1,14,null as any); }); break;
    case "heart": for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const X = (x - 7.5) / 7, Yv = -(y - 7) / 7; if ((X*X + Yv*Yv - 1) ** 3 - X*X * Yv**3 <= 0) set(x, y, "B"); } break;
    case "pad": for (let y = 5; y < 13; y++) for (let x = 1; x < 15; x++) set(x, y, "B"); [[1,5],[14,5],[1,12],[14,12]].forEach(([x,y]) => set(x,y,null as any)); for (let x=3;x<6;x++) set(x,13,"B"); for (let x=10;x<13;x++) set(x,13,"B"); break;
    case "star": for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const a = Math.atan2(y - 8.5, x - 7.5), d = Math.hypot(x - 7.5, y - 8.5); const r = 4 + 3.6 * Math.abs(Math.cos(2.5 * (a + Math.PI / 2))); if (d <= r) set(x, y, "B"); } break;
    case "slime": circle(7.5, 11, 7, 4.6); circle(7.5, 6, 3, 3); break;
  }
  return g;
}

function draw(def: StickerDef): string {
  const m = mask(def.body);
  const g: Grid = m.map((r) => r.map((c) => (c ? def.color : null)));
  const p = (x: number, y: number, c: string) => { if (g[y]?.[x] !== undefined) g[y][x] = c; };
  const ey = def.body === "bunny" ? 9 : def.body === "pad" ? 7 : 8;
  const lx = 5, rx = 10;
  const eye = (x: number, kind: Eyes, right: boolean) => {
    switch (kind) {
      case "dot": p(x, ey, K); p(x, ey + 1, K); break;
      case "wide": p(x, ey, W); p(x, ey + 1, K); p(x - 1, ey, K); p(x - 1, ey + 1, K); break;
      case "happy": p(x - 1, ey + 1, K); p(x, ey, K); p(x + 1, ey + 1, K); break;
      case "closed": p(x - 1, ey + 1, K); p(x, ey + 1, K); p(x + 1, ey + 1, K); break;
      case "heart": p(x - 1, ey, R); p(x + 1, ey, R); p(x - 1, ey + 1, R); p(x, ey + 1, R); p(x + 1, ey + 1, R); p(x, ey + 2, R); break;
      case "x": p(x - 1, ey, K); p(x + 1, ey, K); p(x, ey + 1, K); p(x - 1, ey + 2, K); p(x + 1, ey + 2, K); break;
      case "star": p(x, ey, Y); p(x - 1, ey + 1, Y); p(x, ey + 1, Y); p(x + 1, ey + 1, Y); p(x, ey + 2, Y); break;
      case "sad": p(x, ey + 1, K); p(right ? x - 1 : x + 1, ey, K); break;
      case "wink": if (right) { p(x - 1, ey + 1, K); p(x, ey + 1, K); p(x + 1, ey + 1, K); } else { p(x, ey, K); p(x, ey + 1, K); } break;
      case "angry": p(x, ey + 1, K); p(right ? x - 1 : x + 1, ey - 1, K); p(x, ey, K); break;
    }
  };
  eye(lx, def.eyes, false); eye(rx, def.eyes, true);
  const my = ey + 3;
  switch (def.mouth) {
    case "smile": p(6, my, K); p(7, my + 1, K); p(8, my + 1, K); p(9, my, K); break;
    case "grin": for (let x = 6; x < 10; x++) { p(x, my, K); p(x, my + 1, W); } p(6, my + 1, K); p(9, my + 1, K); break;
    case "open": p(7, my, K); p(8, my, K); p(7, my + 1, R); p(8, my + 1, R); break;
    case "flat": for (let x = 6; x < 10; x++) p(x, my, K); break;
    case "frown": p(6, my + 1, K); p(7, my, K); p(8, my, K); p(9, my + 1, K); break;
    case "cat": p(6, my, K); p(7, my + 1, K); p(8, my, K); p(9, my + 1, K); p(10, my, K); break;
    case "tongue": p(6, my, K); p(7, my, K); p(8, my, K); p(9, my, K); p(8, my + 1, PINK); break;
    case "o": p(7, my, K); p(8, my, K); p(7, my + 1, K); p(8, my + 1, K); break;
  }
  switch (def.extra) {
    case "blush": p(3, ey + 2, PINK); p(4, ey + 2, PINK); p(11, ey + 2, PINK); p(12, ey + 2, PINK); break;
    case "sweat": p(13, 4, BLUE); p(13, 5, BLUE); p(12, 5, BLUE); break;
    case "tears": p(lx, ey + 2, BLUE); p(lx, ey + 3, BLUE); p(rx, ey + 2, BLUE); p(rx, ey + 3, BLUE); break;
    case "cry": for (let y = ey + 2; y < 15; y++) { p(lx - 1, y, BLUE); p(rx + 1, y, BLUE); } break;
    case "hearts": p(13, 1, R); p(15, 1, R); p(13, 2, R); p(14, 2, R); p(15, 2, R); p(14, 3, R); p(1, 3, PINK); p(1, 4, PINK); break;
    case "hat": p(7, 0, Y); p(6, 1, BLUE); p(7, 1, Y); p(8, 1, BLUE); for (let x = 5; x < 10; x++) p(x, 2, x % 2 ? R : Y); break;
    case "crown": for (let x = 5; x < 11; x++) p(x, 2, Y); p(5, 1, Y); p(7, 1, Y); p(8, 1, Y); p(10, 1, Y); p(5, 0, Y); p(10, 0, Y); p(7, 2, R); break;
    case "sparkle": p(1, 1, Y); p(0, 2, Y); p(2, 2, Y); p(1, 3, Y); p(14, 12, W); p(13, 13, W); p(15, 13, W); p(14, 14, W); break;
    case "zzz": p(12, 0, W); p(13, 0, W); p(13, 1, W); p(12, 2, W); p(13, 2, W); p(14, 3, BLUE); p(15, 3, BLUE); p(15, 4, BLUE); p(14, 5, BLUE); p(15, 5, BLUE); break;
    case "fire": p(13, 2, OR); p(13, 3, R); p(14, 3, OR); p(12, 3, OR); p(13, 1, Y); p(2, 2, OR); p(2, 3, R); break;
  }
  return gridToSvg(outline(g, K), { anim: def.anim ?? null });
}

const G = "#8FE388", MINT = "#7FD6C2", CREAM = "#F5E6C8", BROWN = "#C08552", LAV = "#C9B6E4", GRAY = "#A1A8B5", ORG = OR;

const RAW: [string, string, Body, string, Eyes, Mouth, Extra, StickerDef["anim"]?][] = [
  // Cute characters
  ["cute", "Hello blob", "blob", G, "dot", "smile", "blush", "bob"],
  ["cute", "Sparkly", "blob", Y, "star", "grin", "sparkle", "pulse"],
  ["cute", "Shy slime", "slime", MINT, "happy", "o", "blush"],
  ["cute", "Ghostie", "ghost", W, "wide", "o", null, "bob"],
  ["cute", "Star pal", "star", Y, "dot", "smile", null, "spin"],
  // Pixel animals
  ["animals", "Cat", "cat", ORG, "dot", "cat", "blush"],
  ["animals", "Bunny", "bunny", W, "dot", "cat", "blush", "bob"],
  ["animals", "Frog", "frog", G, "wide", "smile", null],
  ["animals", "Bear", "bear", BROWN, "dot", "smile", null],
  ["animals", "Sleepy cat", "cat", GRAY, "closed", "flat", "zzz"],
  // Love
  ["love", "Big heart", "heart", R, "happy", "smile", "sparkle", "pulse"],
  ["love", "Love eyes", "blob", Y, "heart", "grin", "hearts", "bob"],
  ["love", "Kissy cat", "cat", PINK, "wink", "o", "hearts"],
  ["love", "Hug bear", "bear", CREAM, "happy", "smile", "blush"],
  // Funny reactions
  ["funny", "Silly", "blob", ORG, "wink", "tongue", null, "wiggle"],
  ["funny", "LOL", "blob", Y, "closed", "grin", "tears", "wiggle"],
  ["funny", "Oops", "slime", BLUE, "wide", "flat", "sweat"],
  ["funny", "Derp frog", "frog", G, "x", "tongue", null],
  // Gaming
  ["gaming", "Controller", "pad", GRAY, "dot", "smile", null, "bob"],
  ["gaming", "GG", "pad", G, "happy", "grin", "sparkle"],
  ["gaming", "Game over", "ghost", LAV, "x", "o", null],
  ["gaming", "Power up", "star", Y, "wide", "grin", "fire", "pulse"],
  // Expressions
  ["expressions", "Shocked", "blob", W, "wide", "o", null],
  ["expressions", "Angry", "blob", R, "angry", "frown", "fire", "wiggle"],
  ["expressions", "Meh", "blob", GRAY, "closed", "flat", null],
  ["expressions", "Cool", "bear", MINT, "wink", "smile", "sparkle"],
  // Celebration
  ["celebration", "Party", "blob", PINK, "happy", "grin", "hat", "wiggle"],
  ["celebration", "Winner", "bear", Y, "star", "grin", "crown", "bob"],
  ["celebration", "Yay frog", "frog", G, "happy", "open", "hat", "bob"],
  ["celebration", "Hooray", "star", ORG, "happy", "grin", "sparkle", "spin"],
  // Sad & emotional
  ["sad", "Teary", "blob", BLUE, "sad", "frown", "tears"],
  ["sad", "Crying", "cat", LAV, "closed", "frown", "cry", "bob"],
  ["sad", "Broken", "heart", GRAY, "sad", "frown", "tears"],
  ["sad", "Lonely ghost", "ghost", LAV, "sad", "flat", null],
];

export const STICKER_CATEGORIES: { id: string; label: string }[] = [
  { id: "favorites", label: "★ Favs" },
  { id: "cute", label: "Cute" },
  { id: "animals", label: "Animals" },
  { id: "love", label: "Love" },
  { id: "funny", label: "Funny" },
  { id: "gaming", label: "Gaming" },
  { id: "expressions", label: "Faces" },
  { id: "celebration", label: "Party" },
  { id: "sad", label: "Sad" },
  { id: "custom", label: "Custom" },
];

export const STICKERS: StickerDef[] = RAW.map(([cat, name, body, color, eyes, mouth, extra, anim], i) => ({
  id: `px${i}`, cat, name, body, color, eyes, mouth, extra, anim,
}));

const cache = new Map<string, string>();
export function stickerSrc(id: string): string | null {
  if (cache.has(id)) return cache.get(id)!;
  const def = STICKERS.find((s) => s.id === id);
  if (!def) return null;
  const uri = svgUri(draw(def));
  cache.set(id, uri);
  return uri;
}
