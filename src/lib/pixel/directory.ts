/**
 * Static room-directory client — database-free discovery over plain HTTPS.
 *
 * - Downloads the signed manifest tree from one or more mirrors (ordinary
 *   static hosting; see tools/directory-publisher/README.md).
 * - VERIFIES every manifest signature + owner fingerprint + expiry before a
 *   listing is shown: a mirror can only serve stale data, never forge rooms.
 * - Caches locally (public data only) so Discover works offline; expired
 *   entries are dropped even from cache.
 * - Presence in a directory ≠ availability: joining always probes a live
 *   coordinator lease first, and the UI says "Room temporarily unavailable"
 *   when there is none. Never faked.
 */
import { CATEGORIES, REGIONS, LANGUAGES } from "./discovery";
import { manifestIdOf, verifyManifest, verifyOwnerFingerprint, type DirectoryIndex, type RoomManifest } from "./manifest";

/** Env: comma-separated mirror base URLs (e.g. https://dir1.example/room-directory,https://dir2...). */
export function directoryMirrors(): string[] {
  const env = (import.meta.env["VITE_DIRECTORY_URL"] as string | undefined) ?? "";
  const list = env.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  return list.length ? list : ["/room-directory"]; // dev default: served from public/room-directory
}

const CACHE_KEY = "pixolark-directory-cache";
const CACHE_TTL_MS = 5 * 60_000;

export interface DirectoryRoom {
  manifest: RoomManifest;
  /** Content id of the manifest — dedupe + stable keys for the UI. */
  id: string;
  /** Which mirror it came from (informational). */
  mirror: string;
}

interface CacheShape {
  fetchedAt: number;
  /** roomId → { manifest, mirror } — public data only, no secrets. */
  rooms: Record<string, { manifest: RoomManifest; mirror: string }>;
}

export interface DirectoryFilters {
  text?: string | undefined;
  category?: string | undefined;
  country?: string | undefined;
  state?: string | undefined;
  city?: string | undefined;
  language?: string | undefined;
}

/** Loads (cache-first) + verifies the directory. Never throws; honest empties. */
export async function loadDirectory(): Promise<DirectoryRoom[]> {
  const cache = readCache();
  const fresh = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS ? cache : null;
  if (fresh) return verifiedEntries(fresh);

  const merged = new Map<string, { manifest: RoomManifest; mirror: string }>();
  for (const mirror of directoryMirrors()) {
    try {
      const rooms = await fetchMirror(mirror);
      for (const m of rooms) merged.set(m.roomId, { manifest: m, mirror });
    } catch {
      // mirror down — try the next one; if all fail, cache still serves (below)
    }
  }

  if (merged.size > 0) {
    const next: CacheShape = { fetchedAt: Date.now(), rooms: Object.fromEntries(merged) };
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(next));
    } catch {
      // storage full/private mode — cache is best-effort only
    }
    return verifiedEntries(next);
  }

  // All mirrors failed: serve the (possibly stale) cache, but expiry still applies.
  if (cache) return verifiedEntries(cache);
  return [];
}

function readCache(): CacheShape | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CacheShape) : null;
  } catch {
    return null;
  }
}

/** Verify + expiry-check every cached manifest; drop anything failing. */
async function verifiedEntries(cache: CacheShape): Promise<DirectoryRoom[]> {
  const now = Date.now();
  const out: DirectoryRoom[] = [];
  for (const { manifest, mirror } of Object.values(cache.rooms)) {
    const check = await verifyManifest(manifest, now);
    if (!check.ok) continue; // expired/tampered — never shown, never trusted
    if (!(await verifyOwnerFingerprint(manifest))) continue;
    out.push({ manifest, mirror, id: await manifestIdOf(manifest) });
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

async function fetchMirror(base: string): Promise<RoomManifest[]> {
  const res = await fetch(`${base}/index.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`directory index unavailable (${res.status})`);
  const index = (await res.json()) as DirectoryIndex;
  if (index.v !== 1 || !Array.isArray(index.sections)) throw new Error("unsupported directory index");

  const byRoom = new Map<string, RoomManifest>();
  for (const section of index.sections) {
    try {
      const r = await fetch(`${base}/${section}`, { cache: "no-cache" });
      if (!r.ok) continue;
      const file = (await r.json()) as { v?: number; rooms?: unknown };
      if (file.v !== 1 || !Array.isArray(file.rooms)) continue;
      for (const candidate of file.rooms) {
        const check = await verifyManifest(candidate);
        if (check.ok && (await verifyOwnerFingerprint(check.manifest))) {
          byRoom.set(check.manifest.roomId, check.manifest); // signature-verified only
        }
      }
    } catch {
      // a broken section file never takes down discovery
    }
  }
  return [...byRoom.values()];
}

/** Client-side filtering (country/state/city hierarchy + category + language + text). */
export function filterRooms(rooms: DirectoryRoom[], f: DirectoryFilters): DirectoryRoom[] {
  const text = f.text?.trim().toLowerCase();
  return rooms.filter(({ manifest: m }) => {
    if (f.category && m.category !== f.category) return false;
    if (f.language && !m.languages.includes(f.language)) return false;
    if (f.country) {
      if (m.region !== f.country) return false;
      if (f.state) {
        if (m.subRegion !== f.state) return false;
        if (f.city && m.city !== f.city) return false;
      }
    }
    if (text) {
      const hay = `${m.name} ${m.desc} ${m.category} ${m.region} ${m.subRegion} ${m.city} ${m.languages.join(" ")}`.toLowerCase();
      if (!hay.includes(text)) return false;
    }
    return true;
  });
}

/** Directory faces for the Discover UI — same catalogs the app already uses. */
export { CATEGORIES, REGIONS, LANGUAGES };
