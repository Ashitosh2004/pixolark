/** Local-only storage. Only preferences by default; chat history only when the user opts in.
 *  Encryption keys are NEVER written to storage (group identity keys live in IndexedDB,
 *  non-extractable, and are excluded from backups). */
import { b64url, fromB64url } from "./bytes";
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

// ---------- drafts (unsent text survives reloads/crashes) ----------

const DRAFT = "pxc.draft.";

export function saveDraft(room: string, text: string) {
  try {
    if (text) localStorage.setItem(DRAFT + room, text);
    else localStorage.removeItem(DRAFT + room);
  } catch { /* quota */ }
}

export function loadDraft(room: string): string {
  try { return localStorage.getItem(DRAFT + room) ?? ""; } catch { return ""; }
}

// ---------- last-read anchor (scroll restore) ----------

const SCROLL = "pxc.scroll.";

export function saveScrollAnchor(room: string, messageId: string) {
  try { localStorage.setItem(SCROLL + room, messageId); } catch { /* quota */ }
}

export function loadScrollAnchor(room: string): string | null {
  try { return localStorage.getItem(SCROLL + room); } catch { return null; }
}

// ---------- room bookmarks ("favourite rooms") + per-room mute ----------

const BOOKMARKS = "pxc.bookmarks.v1";

export interface RoomBookmark { room: string; kind: "group" | "peer"; name: string; at: number; muted?: boolean | undefined }

export function loadBookmarks(): RoomBookmark[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS);
    const list = raw ? (JSON.parse(raw) as RoomBookmark[]) : [];
    return list.filter((b) => b && b.room && (b.kind === "group" || b.kind === "peer"));
  } catch { return []; }
}

export function saveBookmark(b: RoomBookmark) {
  try {
    const list = loadBookmarks().filter((x) => x.room !== b.room);
    list.unshift({ ...b, at: Date.now() });
    localStorage.setItem(BOOKMARKS, JSON.stringify(list.slice(0, 50)));
  } catch { /* quota */ }
}

export function removeBookmark(room: string) {
  try { localStorage.setItem(BOOKMARKS, JSON.stringify(loadBookmarks().filter((x) => x.room !== room))); } catch { /* quota */ }
}

export function isRoomMuted(room: string): boolean {
  return loadBookmarks().some((b) => b.room === room && b.muted);
}

export function setRoomMuted(room: string, kind: "group" | "peer", name: string, muted: boolean) {
  const list = loadBookmarks();
  const existing = list.find((b) => b.room === room);
  if (existing) { existing.muted = muted || undefined; try { localStorage.setItem(BOOKMARKS, JSON.stringify(list)); } catch { /* */ } return; }
  if (muted) saveBookmark({ room, kind, name, at: Date.now(), muted: true });
}

// ---------- recent rooms (manual rejoin lists) ----------

const RECENTS = "pxc.recentRooms.v1";

export interface RecentRoom { room: string; kind: "group" | "peer"; name: string; at: number; role?: "host" | "member" | undefined }

export function loadRecentRooms(): RecentRoom[] {
  try {
    const raw = localStorage.getItem(RECENTS);
    return raw ? (JSON.parse(raw) as RecentRoom[]).filter((r) => r && r.room) : [];
  } catch { return []; }
}

export function pushRecentRoom(room: string, kind: "group" | "peer", name: string, role?: "host" | "member") {
  try {
    const list = loadRecentRooms().filter((r) => r.room !== room);
    list.unshift({ room, kind, name, at: Date.now(), role });
    localStorage.setItem(RECENTS, JSON.stringify(list.slice(0, 12)));
  } catch { /* quota */ }
}

// ---------- host snapshot persistence (ownership recovery across host restarts) ----------

const GSNAP = "pxc.gsnap.";

export function saveGroupSnapshot(room: string, snap: unknown) {
  try { localStorage.setItem(GSNAP + room, JSON.stringify({ savedAt: Date.now(), snap })); } catch { /* quota */ }
}

export function loadGroupSnapshot(room: string): { savedAt: number; snap: any } | null {
  try {
    const raw = localStorage.getItem(GSNAP + room);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.snap ? parsed : null;
  } catch { return null; }
}

export function clearGroupSnapshot(room: string) {
  try { localStorage.removeItem(GSNAP + room); } catch { /* ignore */ }
}

// ---------- encrypted cross-device backup (passphrase → PBKDF2 → AES-GCM) ----------
// Contents: prefs, opt-in 1:1 history, drafts, bookmarks, recents, host room snapshots.
// NEVER included: identity keys (IndexedDB, non-extractable), group chain generations
// (a restored stale counter could confuse replay checks - fresh devices re-derive them).

const BACKUP_ITER = 210_000;

export interface BackupFile {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iter: number;
  salt: string;
  iv: string;
  ct: string;
  createdAt: number;
}

function collectBackupEntries(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(localStorage)) {
    const include = k === KEY || k.startsWith(HIST) || k.startsWith(DRAFT) || k === BOOKMARKS || k === RECENTS || k.startsWith(GSNAP);
    if (include) out[k] = localStorage.getItem(k) ?? "";
  }
  return out;
}

async function backupKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: BACKUP_ITER }, ikm, 256));
  const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["encrypt", "decrypt"]);
  bits.fill(0);
  return key;
}

/** Serializes the backup; the UI writes it to a file. Throws on empty passphrase. */
export async function exportBackup(passphrase: string): Promise<string> {
  if (!passphrase) throw new Error("Choose a passphrase to protect the backup file.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await backupKey(passphrase, salt);
  const pt = new TextEncoder().encode(JSON.stringify({ createdAt: Date.now(), entries: collectBackupEntries() }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  const file: BackupFile = { v: 1, kdf: "PBKDF2-SHA256", iter: BACKUP_ITER, salt: b64url(salt), iv: b64url(iv), ct: b64url(ct), createdAt: Date.now() };
  return JSON.stringify(file);
}

/** Restores entries from a backup file. Returns how many entries were written. */
export async function importBackup(payload: string, passphrase: string): Promise<number> {
  let file: BackupFile;
  try { file = JSON.parse(payload) as BackupFile; } catch { throw new Error("That file is not a Pixolark backup."); }
  if (!file || file.v !== 1 || file.kdf !== "PBKDF2-SHA256" || !file.salt || !file.iv || !file.ct) throw new Error("That file is not a Pixolark backup.");
  const key = await backupKey(passphrase, fromB64url(file.salt));
  let pt: Uint8Array;
  try {
    pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(file.iv) }, key, fromB64url(file.ct)));
  } catch {
    throw new Error("Wrong passphrase, or the backup file is corrupted.");
  }
  const data = JSON.parse(new TextDecoder().decode(pt)) as { entries?: Record<string, string> };
  const entries = data.entries ?? {};
  let n = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (k === KEY) {
      try { savePrefs({ ...defaultPrefs(), ...JSON.parse(v) }); n++; } catch { /* skip bad entry */ }
      continue;
    }
    try { localStorage.setItem(k, v); n++; } catch { /* skip bad entry */ }
  }
  return n;
}

export function clearAllLocalData() {
  for (const k of Object.keys(localStorage)) if (k.startsWith("pxc.") || k.startsWith("epr_")) localStorage.removeItem(k);
  try { sessionStorage.clear(); } catch { /* */ }
}
