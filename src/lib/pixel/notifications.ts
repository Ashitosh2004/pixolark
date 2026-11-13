/**
 * Central notification router for every chat surface (1:1, groups).
 *
 * One place decides whether an incoming message may interrupt the user:
 * - DND window (`pxc.dnd.until`): suppresses sounds AND desktop notifications;
 * - per-room mute (storage.ts bookmarks): suppresses sound + notification for that room;
 * - transient global mute (the in-app mute toggle): same as per-room mute, everywhere;
 * - mentions (`@name`): URGENT - a desktop notification is shown even when the tab is
 *   visible (the message may be buried in a busy group), but DND still wins. Deliberately
 *   no "@all" keyword: it would let any member force-notify the whole group.
 *
 * Sound goes through sound.ts `play()`; the global sounds preference is applied there via
 * `setSoundEnabled` (play() has no internal prefs gating), so this module does not need to
 * re-check it.
 *
 * A small in-memory log of delivered notifications feeds the Notifications screen; it is
 * intentionally NOT persisted (session-scoped only, nothing leaves the device).
 */
import { isRoomMuted } from "./storage";
import { play } from "./sound";

const DND_KEY = "pxc.dnd.until";

// ---------- Do Not Disturb ----------

export function setDndUntil(until: number): void {
  try {
    if (until > Date.now()) localStorage.setItem(DND_KEY, String(until));
    else localStorage.removeItem(DND_KEY);
  } catch { /* quota */ }
}

export function dndActive(): boolean {
  try {
    const v = Number(localStorage.getItem(DND_KEY)) || 0;
    return v > Date.now();
  } catch { return false; }
}

export function dndUntil(): number {
  try { return Number(localStorage.getItem(DND_KEY)) || 0; } catch { return 0; }
}

/** Presets in minutes; 0 clears. */
export const DND_PRESETS: { label: string; minutes: number }[] = [
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 240 },
  { label: "Off", minutes: 0 },
];

// ---------- browser permission ----------

export function notificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return notificationSupported() ? Notification.permission : "unsupported";
}

/** Requests permission if needed. Resolves true only when notifications can be shown. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!notificationSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try { return (await Notification.requestPermission()) === "granted"; } catch { return false; }
}

// ---------- mention detection ----------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` mentions `name` with an @-reply (case-insensitive, word-bounded). */
export function mentionsMe(text: string | undefined | null, name: string): boolean {
  if (!text || !name) return false;
  const nick = name.trim();
  if (!nick) return false;
  return new RegExp(`@${escapeRe(nick)}(?=\\s|$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

// ---------- the router ----------

export interface Delivery {
  room: string; // stable room id (PeerSession.roomId / GroupSession.room)
  roomName: string;
  senderName: string;
  body: string; // short preview already built by the caller
  mention?: boolean | undefined; // caller-detected mention (we re-check against text too)
  text?: string | undefined; // raw text for our own mention re-check
}

export interface DeliveryOpts {
  muted: boolean; // transient in-app mute (message bell toggle)
  sounds: boolean; // prefs.sounds - matches the global switch set via setSoundEnabled
  notifications: boolean; // prefs.notifications - user opted into desktop notifications
  /** Extra names that count as "me" (e.g. previous usernames are not tracked; groups pass the current one). */
  myName: string;
}

export interface DeliveryLog {
  ts: number;
  room: string;
  roomName: string;
  senderName: string;
  body: string;
  mention: boolean;
  sound: boolean;
  notified: boolean;
}

const LOG_MAX = 60;
const log: DeliveryLog[] = [];
const logListeners = new Set<() => void>();

export function recentNotifications(): DeliveryLog[] {
  return log;
}

export function onNotificationsChanged(fn: () => void): () => void {
  logListeners.add(fn);
  return () => { logListeners.delete(fn); };
}

function record(e: DeliveryLog): void {
  log.unshift(e);
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  for (const fn of logListeners) fn();
}

/**
 * Route one incoming message. Returns what was delivered ("sound", "notify",
 * "sound+notify", "none") plus why when nothing was ("dnd", "muted").
 */
export function deliver(d: Delivery, opts: DeliveryOpts): { out: string; reason?: string } {
  const mention = !!d.mention || mentionsMe(d.text, opts.myName);

  if (dndActive()) return finish({ out: "none", reason: "dnd" }, d, mention);
  if (opts.muted || isRoomMuted(d.room)) return finish({ out: "none", reason: "muted" }, d, mention);

  // Sound: play() applies the global sounds preference itself.
  let sound = false;
  if (opts.sounds) { play("receive"); sound = true; }

  // Desktop notification: normally only when the tab is hidden; mentions are urgent and
  // shown even in the foreground so a busy group can't bury them.
  let notified = false;
  if (opts.notifications && notificationSupported() && Notification.permission === "granted") {
    const hidden = document.visibilityState !== "visible";
    if (hidden || mention) {
      try {
        new Notification(`${d.senderName} · ${d.roomName}`, { body: d.body, icon: "/favicon.ico", tag: `pxl-${d.room}` });
        notified = true;
      } catch { /* some browsers restrict constructors; ignore */ }
    }
  }
  return finish({ out: notified ? (sound ? "sound+notify" : "notify") : sound ? "sound" : "none" }, d, mention, sound, notified);
}

function finish(
  r: { out: string; reason?: string },
  d: Delivery,
  mention: boolean,
  sound = false,
  notified = false,
): { out: string; reason?: string } {
  // The activity log shows what was actually delivered; suppressed deliveries stay silent.
  if (r.out !== "none") {
    record({ ts: Date.now(), room: d.room, roomName: d.roomName, senderName: d.senderName, body: d.body, mention, sound, notified });
  }
  return r;
}
