// Pure pixel-drawing code: indexed grid access is bounds-checked at runtime.
// @ts-nocheck
/** Tiny pixel-art renderer: color grids -> crisp SVG. All art here is original. */
export type Grid = (string | null)[][];

export function emptyGrid(w: number, h: number): Grid {
  return Array.from({ length: h }, () => Array<string | null>(w).fill(null));
}

export function gridToSvg(grid: Grid, opts: { anim?: "bob" | "wiggle" | "pulse" | "spin" | null; bg?: string } = {}): string {
  const h = grid.length, w = grid[0].length;
  let rects = "";
  for (let y = 0; y < h; y++) {
    let x = 0;
    while (x < w) {
      const c = grid[y][x];
      if (!c) { x++; continue; }
      let run = 1;
      while (x + run < w && grid[y][x + run] === c) run++;
      rects += `<rect x="${x}" y="${y}" width="${run}" height="1.02" fill="${c}"/>`;
      x += run;
    }
  }
  const cx = w / 2, cy = h / 2;
  const anim =
    opts.anim === "bob" ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -1;0 0" dur="0.8s" calcMode="discrete" repeatCount="indefinite"/>`
    : opts.anim === "wiggle" ? `<animateTransform attributeName="transform" type="rotate" values="-6 ${cx} ${cy};6 ${cx} ${cy};-6 ${cx} ${cy}" dur="0.6s" calcMode="discrete" repeatCount="indefinite"/>`
    : opts.anim === "pulse" ? `<animateTransform attributeName="transform" type="scale" values="1;1.06;1" dur="0.7s" calcMode="discrete" repeatCount="indefinite" additive="sum"/>`
    : opts.anim === "spin" ? `<animateTransform attributeName="transform" type="rotate" values="0 ${cx} ${cy};90 ${cx} ${cy};180 ${cx} ${cy};270 ${cx} ${cy}" dur="0.8s" calcMode="discrete" repeatCount="indefinite"/>`
    : "";
  const bg = opts.bg ? `<rect width="${w}" height="${h}" fill="${opts.bg}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${bg}<g>${rects}${anim}</g></svg>`;
}

export const svgUri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

export function outline(grid: Grid, color: string): Grid {
  const h = grid.length, w = grid[0].length;
  const out = grid.map((r) => r.slice());
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (grid[y][x]) continue;
    const n = [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => grid[y + dy]?.[x + dx]);
    if (n) out[y][x] = color;
  }
  return out;
}

/* ---------- Avatars ---------- */
export interface PixelAvatar { kind: "pixel"; cells: string; fg: string; bg: string; accent: string }
export interface ImageAvatar { kind: "image"; url: string }
export type Avatar = PixelAvatar | ImageAvatar;

const AV_COLORS = ["#8FE388", "#FFD166", "#FF8C61", "#6EC5FF", "#F28DC2", "#B8E986", "#F5F5F5", "#7FD6C2"];
const AV_BGS = ["#242936", "#1B1E27", "#2E3445", "#3A2F2A", "#22332B"];

export function randomAvatar(): PixelAvatar {
  const r = crypto.getRandomValues(new Uint8Array(40));
  let cells = "";
  for (let y = 0; y < 8; y++) {
    const half: string[] = [];
    for (let x = 0; x < 4; x++) {
      const v = r[y * 4 + x] % 10;
      half.push(v < 4 ? "0" : v < 8 ? "1" : "2");
    }
    cells += half.join("") + half.slice().reverse().join("");
  }
  return { kind: "pixel", cells, fg: AV_COLORS[r[32] % AV_COLORS.length], accent: AV_COLORS[r[33] % AV_COLORS.length], bg: AV_BGS[r[34] % AV_BGS.length] };
}

export function avatarSrc(a: Avatar): string {
  if (a.kind === "image") return a.url;
  const g = emptyGrid(10, 10);
  for (let i = 0; i < 64; i++) {
    const c = a.cells[i];
    if (c === "1") g[1 + Math.floor(i / 8)][1 + (i % 8)] = a.fg;
    if (c === "2") g[1 + Math.floor(i / 8)][1 + (i % 8)] = a.accent;
  }
  return svgUri(gridToSvg(g, { bg: a.bg }));
}

export const AVATAR_COLORS = AV_COLORS;
export const AVATAR_BGS = AV_BGS;

/* ---------- Mascot ---------- */
const MASCOT = [
  "....KKKKKK....",
  "...KGGGGGGK...",
  "..KGGGGGGGGK..",
  "..KGWKGGWKGK..",
  "..KGKKGGKKGK..",
  "..KGGGGGGGGK..",
  "..KGGPGGPGGK..",
  "..KGGGKKGGGK..",
  "...KGGGGGGK...",
  "..KYKGGGGKYK..",
  "..KYYKKKKYYK..",
  "...KKK..KKK...",
];
export function mascotSvg(anim: "bob" | null = "bob") {
  const map: Record<string, string> = { K: "#111318", G: "#8FE388", W: "#F5F5F5", P: "#F28DC2", Y: "#FFD166" };
  const g: Grid = MASCOT.map((row) => row.split("").map((c) => map[c] ?? null));
  return gridToSvg(g, { anim });
}
