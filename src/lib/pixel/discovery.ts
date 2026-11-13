/**
 * Public room discovery via ephemeral beacons on the same zero-knowledge pub/sub
 * already used for signaling. Hosts of public rooms publish signed-off metadata
 * every BEACON_INTERVAL_MS; the Discover screen reads recent beacons only.
 *
 * Honesty rules enforced here:
 * - Member/online counts come exclusively from live host beacons.
 * - Beacons older than STALE_MS are marked "host offline / temporarily unavailable".
 * - Nothing is stored server-side beyond the pub/sub's own short cache; no database.
 * - A fake beacon can only create a listing that fails on join — joining always
 *   re-authenticates against the room's real offer + host identity commitment.
 */
import { b64url, te } from "./bytes";

export const BEACON_INTERVAL_MS = 45_000;
export const STALE_MS = 2 * BEACON_INTERVAL_MS;
const INDEX_TOPIC = "pxl_rooms_v1";

export interface RoomBeacon {
  room: string;
  name: string;
  desc: string;
  cat: string;
  region: string;
  lang: string;
  members: number; // live count reported by the host (0 if unknown)
  cap: number;
  hostName: string;
  /** Commitment of the host identity — verifiable again at join time. */
  hostId: string;
  ts: number;
  closed?: boolean;
}

export async function publishBeacon(b: RoomBeacon): Promise<boolean> {
  try {
    const res = await fetch(`https://ntfy.sh/${INDEX_TOPIC}`, {
      method: "POST",
      body: JSON.stringify(b),
      headers: { "Title": "Pixolark room beacon", "Tags": b.closed ? "skull" : b.cat },
      keepalive: true,
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface BeaconEntry extends RoomBeacon { seenAt: number }

/** Fetches recent beacons (newest first), deduped per room. never returns stale copies as live. */
export async function fetchBeacons(windowMs = 10 * 60_000): Promise<Array<BeaconEntry & { stale: boolean }>> {
  const since = `${Math.ceil(windowMs / 1000)}s`;
  let text = "";
  try {
    const res = await fetch(`https://ntfy.sh/${INDEX_TOPIC}/json?poll=1&since=${since}`);
    if (!res.ok) return [];
    text = await res.text();
  } catch {
    return [];
  }
  const byRoom = new Map<string, BeaconEntry>();
  for (const line of text.trim().split("\n")) {
    try {
      const json = JSON.parse(line);
      if (!json.message) continue;
      const b = JSON.parse(json.message) as RoomBeacon;
      if (!b || typeof b.room !== "string" || !/^[A-Z0-9-]{4,24}$/.test(b.room) || typeof b.name !== "string") continue;
      b.members = Number(b.members) || 0;
      b.cap = Number(b.cap) || 0;
      b.ts = Number(b.ts) || 0;
      const prev = byRoom.get(b.room);
      if (!prev || b.ts >= prev.ts) byRoom.set(b.room, { ...b, seenAt: json.time ? json.time * 1000 : Date.now() });
    } catch {
      // ignore malformed lines
    }
  }
  const now = Date.now();
  return Array.from(byRoom.values())
    .map((b) => ({ ...b, stale: now - b.seenAt > STALE_MS }))
    .sort((a, b) => (a.closed ? 1 : 0) - (b.closed ? 1 : 0) || b.seenAt - a.seenAt);
}

export function beaconOf(roomId: string, meta: { name: string; desc: string; cat: string; region: string; lang: string; members: number; cap: number; hostName: string; hostId: string; closed?: boolean }): RoomBeacon {
  return { room: roomId, ts: Date.now(), ...meta, desc: meta.desc.slice(0, 160), name: meta.name.slice(0, 48) };
}

/** Used by the regional/community filters. */
export const CATEGORIES = [
  "General Chat", "Technology", "Programming", "Gaming", "Anime", "Music", "Movies", "Education",
  "Memes", "Friendship", "Photography", "Travel", "Sports", "Entertainment", "Language Exchange",
] as const;

export interface RegionNode { name: string; children?: string[] }
export const REGIONS: Record<string, RegionNode> = {
  India: { name: "India", children: ["Karnataka", "Maharashtra", "Goa", "Kerala", "Tamil Nadu", "Telangana", "Andhra Pradesh", "Delhi", "Gujarat", "Rajasthan", "Uttar Pradesh", "West Bengal", "Punjab", "Other"] },
  "United States": { name: "United States", children: ["California", "New York", "Texas", "Florida", "Washington", "Other"] },
  "United Kingdom": { name: "United Kingdom", children: ["England", "Scotland", "Wales", "Northern Ireland", "Other"] },
  Canada: { name: "Canada", children: ["Ontario", "Quebec", "British Columbia", "Alberta", "Other"] },
  Australia: { name: "Australia", children: ["New South Wales", "Victoria", "Queensland", "Other"] },
  International: { name: "International" },
};

export const LANGUAGES = ["English", "Hindi", "Kannada", "Marathi", "Tamil", "Telugu", "Malayalam", "Gujarati", "Bengali", "Spanish", "French", "German", "Portuguese", "Other"] as const;

/** Short fingerprint shown next to listings so users can cross-check on join.
 *  A fast whole-string hash (FNV-1a) of host + room: differs whenever either part differs. */
export function roomFingerprint(hostId: string, room: string): string {
  let h = 0x811c9dc5;
  const s = `${hostId}|${room}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
