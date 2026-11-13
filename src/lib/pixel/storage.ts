/** Local-only storage. Only preferences by default; chat history only when the user opts in.
 *  Encryption keys are NEVER written to storage. */
import { randomAvatar, type Avatar } from "./pixelart";
import { isValidRoomId, normalizeRoomId } from "./codec";

export interface Prefs {
  username: string;
  avatar: Avatar;
  status: string;
  theme: "dark" | "light";
  sounds: boolean;
  notifications: boolean;
  saveHistory: boolean;
  autoDelete24h: boolean;
  sessionHours: number;
  favStickers: string[];
  customStickers: { id: string; url: string }[];
  readReceipts: boolean;
  typingIndicator: boolean;
  recentStickers: string[];
  stickerUsage: Record<string, number>;
  installedPacks: string[];
  favPacks: string[];
  stickerSearches: string[];
  userPacks: { id: string; name: string; ids: string[] }[];
  reduceMotion: boolean;
}

const KEY = "pxc.prefs.v1";
const HIST = "pxc.history.";

export function defaultPrefs(): Prefs {
  const n = crypto.getRandomValues(new Uint16Array(1))[0]! % 1000;
  return {
    username: `Player${n}`, avatar: randomAvatar(), status: "Ready to chat", theme: "dark", sounds: true,
    notifications: false, saveHistory: false, autoDelete24h: true,
    sessionHours: 4, favStickers: [], customStickers: [], readReceipts: true, typingIndicator: true,
    recentStickers: [], stickerUsage: {}, installedPacks: ["pixel-love", "funny-reactions", "gaming-legends"], favPacks: [],
    stickerSearches: [], userPacks: [], reduceMotion: false,
  };
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultPrefs(), ...JSON.parse(raw) };
  } catch { /* ignore */ }
  const p = defaultPrefs();
  savePrefs(p);
  return p;
}

export function savePrefs(p: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* quota */ }
}

export function saveHistory(room: string, messages: unknown[]) {
  try { localStorage.setItem(HIST + room, JSON.stringify({ savedAt: Date.now(), messages })); } catch { /* quota */ }
}

export function loadHistory(room: string, autoDelete24h: boolean): any[] {
  try {
    const raw = localStorage.getItem(HIST + room);
    if (!raw) return [];
    const h = JSON.parse(raw);
    if (autoDelete24h && Date.now() - h.savedAt > 24 * 3600 * 1000) { localStorage.removeItem(HIST + room); return []; }
    return h.messages ?? [];
  } catch { return []; }
}

export function purgeOldHistory() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(HIST)) continue;
      const h = JSON.parse(localStorage.getItem(k) || "{}");
      if (!h.savedAt || Date.now() - h.savedAt > 24 * 3600 * 1000) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

export function clearHistory(room: string) { localStorage.removeItem(HIST + room); }

const LASTROOM = "pxc.lastRoom.v1";

export interface LastRoom { roomId: string; role: "host" | "guest"; at: number }

/** Remembers the last room this device was in, so a reload or return can offer a one-click rejoin. */
export function saveLastRoom(room: string, role: "host" | "guest") {
  try { localStorage.setItem(LASTROOM, JSON.stringify({ roomId: normalizeRoomId(room), role, at: Date.now() } satisfies LastRoom)); } catch { /* quota */ }
}

export function loadLastRoom(): LastRoom | null {
  try {
    const raw = localStorage.getItem(LASTROOM);
    if (!raw) return null;
    const l = JSON.parse(raw) as Partial<LastRoom>;
    if ((l.role !== "host" && l.role !== "guest") || !l.roomId || !isValidRoomId(l.roomId)) return null;
    return { roomId: l.roomId, role: l.role, at: l.at ?? 0 };
  } catch { return null; }
}

export function clearLastRoom() { try { localStorage.removeItem(LASTROOM); } catch { /* ignore */ } }

export function clearAllLocalData() {
  for (const k of Object.keys(localStorage)) if (k.startsWith("pxc.") || k.startsWith("epr_")) localStorage.removeItem(k);
  try { sessionStorage.clear(); } catch { /* */ }
}
