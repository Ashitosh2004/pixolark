/**
 * Directory publisher CLI — writes the verified static room-directory tree.
 *
 *   bun tools/directory-publisher/build.ts [--from rooms] [--out room-directory] \
 *     [--mirror https://mirror1.example/room-directory --mirror https://mirror2.../]
 *
 * The output is plain JSON on ordinary static hosting — no database, no
 * server-side state. See tools/directory-publisher/README.md for upload
 * adapters (GitHub Pages / Netlify / Cloudflare Pages / self-host).
 */
import path from "node:path";
import { die, exists, flag, flags, parseArgs, splitList, writeJson } from "../lib/cli";
import { buildDirectory } from "./lib";

const args = parseArgs(process.argv.slice(2));
const from = flag(args, "from") ?? "rooms";
const out = flag(args, "out") ?? "room-directory";
const mirrors = [...flags(args, "mirror").flatMap(splitList)];

const report = await buildDirectory(from, mirrors).catch((e: Error) => die(e.message));

for (const f of report.files) {
  await writeJson(path.join(out, `${f.section}.json`), f.data);
}
await writeJson(path.join(out, "index.json"), report.index);

console.log(`[directory] ${report.rooms.length} verified room(s) → ${report.files.length} section file(s) under ${out}`);
for (const f of report.files) {
  console.log(`  ${f.section}.json — ${f.data.rooms.length} room(s)`);
}
console.log(`[directory] presence in a directory ≠ availability: rooms are joinable only while an authorized coordinator holds a live lease.`);
