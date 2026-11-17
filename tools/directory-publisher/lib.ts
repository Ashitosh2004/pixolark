/**
 * Static room-directory builder — turns a folder of owner-signed room
 * manifests into the database-free discovery tree:
 *
 *   room-directory/
 *   ├── index.json
 *   ├── global/<category>.json
 *   ├── countries/<country>.json
 *   ├── states/<state>.json
 *   ├── cities/<city>.json
 *   └── languages/<language>.json
 *
 * Honesty rules enforced here:
 * - every manifest must pass full signature + expiry + fingerprint checks or
 *   the build FAILS LOUDLY — invalid rooms are never quietly published;
 * - two different manifests claiming the same roomId fail the build (owner
 *   conflict must be resolved by the owners, not silently overwritten);
 * - directory presence does NOT mean availability — rooms are joinable only
 *   while an authorized coordinator holds a live lease.
 */
import path from "node:path";
import {
  manifestIdOf,
  manifestSections,
  verifyManifest,
  verifyOwnerFingerprint,
  type DirectoryFile,
  type DirectoryIndex,
  type RoomManifest,
} from "../../src/lib/pixel/manifest";
import { exists, readJson } from "../lib/cli";

export interface BuildReport {
  index: DirectoryIndex;
  files: { section: string; data: DirectoryFile }[];
  rooms: RoomManifest[];
  rejected: { file: string; reason: string }[];
}

export async function buildDirectory(fromDir: string, mirrors: string[] = []): Promise<BuildReport> {
  const fs = await import("node:fs/promises");
  if (!(await exists(fromDir))) throw new Error(`manifest source folder not found: ${fromDir}`);
  const names = (await fs.readdir(fromDir)).filter((n) => n.endsWith(".json")).sort();

  if (names.length === 0) throw new Error(`no signed room manifests (*.json) in ${fromDir} — generate some with the room-manifest-generator`);

  // 1) verify every manifest. NO invalid manifest is ever published.
  const rooms = new Map<string, RoomManifest>(); // roomId → manifest
  const rejected: { file: string; reason: string }[] = [];
  for (const n of names) {
    const file = path.join(fromDir, n);
    const candidate = await readJson<unknown>(file);
    const check = await verifyManifest(candidate);
    if (!check.ok) {
      rejected.push({ file, reason: check.reason });
      continue;
    }
    const m = check.manifest;
    if (!(await verifyOwnerFingerprint(m))) {
      rejected.push({ file, reason: "owner fingerprint does not match the embedded signing key" });
      continue;
    }
    const prev = rooms.get(m.roomId);
    if (prev && (await manifestIdOf(prev)) !== (await manifestIdOf(m))) {
      throw new Error(`roomId conflict: ${prev.roomId} is claimed by two different manifests (${n}) — owners must resolve this, the directory never picks a winner silently.`);
    }
    rooms.set(m.roomId, m);
  }
  if (rejected.length > 0) {
    const lines = rejected.map((r) => `  ✗ ${path.basename(r.file)}: ${r.reason}`).join("\n");
    throw new Error(`refusing to publish — ${rejected.length} manifest(s) failed verification:\n${lines}\nFix or remove these files; invalid rooms must never enter a directory.`);
  }

  // 2) group into sections, deterministically ordered.
  const bySection = new Map<string, RoomManifest[]>();
  for (const m of rooms.values()) {
    for (const s of manifestSections(m)) {
      const list = bySection.get(s) ?? [];
      list.push(m);
      bySection.set(s, list);
    }
  }

  const generatedAt = Date.now();
  const files = [...bySection.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([section, list]) => ({
      section,
      data: {
        v: 1,
        section,
        generatedAt,
        rooms: [...list].sort((a, b) => a.roomId.localeCompare(b.roomId) || a.name.localeCompare(b.name)),
      } satisfies DirectoryFile,
    }));

  const index: DirectoryIndex = {
    v: 1,
    generatedAt,
    mirrors,
    sections: files.map((f) => `${f.section}.json`),
  };
  return { index, files, rooms: [...rooms.values()], rejected: [] };
}
