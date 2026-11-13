/**
 * useGroup — maps a GroupSession (host or member role) onto React state for the group UI.
 * Message/file/reaction/edit/delete/read handling mirrors useChat 1:1 so MessageBubble,
 * Composer and media pickers are reused unchanged, with group additions:
 * - sender attribution (senderId/senderName) preserved for MessageBubble and moderation;
 * - real dedupe by message id across relay, replay rejection and rejoin;
 * - encrypted local history persistence (IndexedDB, opt-in) with restore on mount and a
 *   history source registered on the session for newcomer sharing;
 * - read receipts applied via the host-relayed `read` event;
 * - local stop on kick/ban notices so reconnect loops don't fight moderation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { randomId } from "@/lib/pixel/bytes";
import { play } from "@/lib/pixel/sound";
import { deliver } from "@/lib/pixel/notifications";
import type { Prefs } from "@/lib/pixel/storage";
import { isLibStickerId, resolveIncomingSticker, STICKER_LIB_VERSION, stickerDataUrl } from "@/lib/pixel/stickerlib";
import { appendHistoryLog, decryptStored, ensureHistoryKey, loadHistoryLog } from "@/lib/pixel/idb";
import { saveGroupSnapshot } from "@/lib/pixel/storage";
import {
  GROUP_MAX_FILE_BYTES,
  type AuditEntry,
  type GroupMessage,
  type GroupMeta,
  type GroupPhase,
  type GroupRole,
  type GroupRules,
  type GroupSession,
  type GroupSnapshot,
  type HistoryItem,
  type PresenceState,
} from "@/lib/pixel/group";
import { CHUNK, previewOf, type ChatMessage, type MsgKind, type ReplyRef } from "./types";

interface Incoming { chunks: Uint8Array[]; received: number; size: number; mime: string; lastUi: number }

interface UseGroupOpts {
  prefs: Prefs;
  muted: boolean;
  /** Opt-in encrypted local history for this room (idb.ts). */
  history: boolean;
}

/** Notices that mean "you are no longer welcome/able to be here" - stop reconnecting. */
const STOP_KINDS = new Set(["kicked", "banned", "full"]);

export function useGroup(session: GroupSession | null, opts: UseGroupOpts) {
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [snap, setSnap] = useState<GroupSnapshot | null>(session?.snap ?? null);
  const [presence, setPresence] = useState<Record<string, PresenceState>>({});
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [phase, setPhase] = useState<GroupPhase>(session?.phase ?? "joining");
  const [error, setError] = useState<string | null>(session?.error ?? null);
  const [stopped, setStopped] = useState<string | null>(null); // kicked/banned/full → local stop

  const incoming = useRef(new Map<string, Incoming>());
  const cancelled = useRef(new Set<string>());
  const readSent = useRef(new Set<string>());
  const typingTimer = useRef<number>(0);
  const histKey = useRef<CryptoKey | null>(null);
  const sessionRef = useRef<GroupSession | null>(session); sessionRef.current = session;
  const messagesRef = useRef<GroupMessage[]>([]); messagesRef.current = messages;
  const snapRef = useRef<GroupSnapshot | null>(snap); snapRef.current = snap;
  const optsRef = useRef(opts); optsRef.current = opts;

  const patch = useCallback((id: string, fn: (m: GroupMessage) => GroupMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);
  const append = useCallback((m: GroupMessage) => {
    setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
  }, []);
  const addSystem = useCallback((text: string) => {
    setMessages((ms) => [...ms, { id: randomId(), from: "system", senderId: "", kind: "system", text, ts: Date.now(), reactions: {} }]);
  }, []);
  /** Local-only removal from THIS device's view (groups: others keep their copy). */
  const hideMessage = useCallback((id: string) => {
    setMessages((ms) => ms.filter((m) => m.id !== id));
  }, []);

  // ---- encrypted local history (opt-in) ----

  const persist = useCallback((m: GroupMessage) => {
    const o = optsRef.current;
    if (!o.history || !histKey.current || !sessionRef.current) return;
    if (m.kind === "system" || m.kind === "file" || m.kind === "voice" || m.kind === "gif") return;
    if (m.deleted) return;
    const { id, senderId, senderName, kind, ts, text, sticker, stickerUrl, from } = m;
    void appendHistoryLog(sessionRef.current.room, histKey.current, {
      id, senderId, senderName, kind, ts,
      plain: JSON.stringify({ id, senderId, senderName, kind, ts, text, sticker, stickerUrl, from }),
    });
  }, []);

  useEffect(() => {
    if (!session || !opts.history) return;
    let alive = true;
    const room = session.room;
    (async () => {
      try {
        const key = await ensureHistoryKey(room);
        if (!alive) return;
        histKey.current = key;
        const stored = await loadHistoryLog(room);
        if (!alive) return;
        const cutoff = optsRef.current.prefs.autoDelete24h ? Date.now() - 24 * 3600_000 : 0;
        const items: GroupMessage[] = [];
        for (const s of stored) {
          try {
            const plain = JSON.parse(await decryptStored(key, s)) as HistoryItem & { from?: string };
            if (cutoff && plain.ts < cutoff) continue; // auto-delete honored at restore time
            items.push({
              id: plain.id, from: plain.from === "me" ? "me" : "peer", senderId: plain.senderId,
              senderName: plain.senderName, kind: plain.kind as GroupMessage["kind"],
              text: plain.text, sticker: plain.sticker, stickerUrl: plain.stickerUrl,
              ts: plain.ts, reactions: {},
            });
          } catch { /* corrupt entries are skipped, never fabricated */ }
        }
        if (items.length) {
          setMessages((ms) => {
            const have = new Set(ms.map((m) => m.id));
            const add = items.filter((m) => !have.has(m.id));
            return add.length ? [...add, ...ms] : ms;
          });
        }
      } catch { /* history is optional; failures never break chat */ }
    })();
    return () => { alive = false; };
  }, [session, opts.history]);

  /** Provides OUR recent items to the session for newcomer history sharing (opt-in). */
  useEffect(() => {
    if (!session || !opts.history) return;
    session.setHistorySource(async (from, limit) => {
      const mine = messagesRef.current
        .filter((m) => m.kind !== "system" && !m.deleted && m.senderId !== from && (!m.file || m.file.status === "done"))
        .slice(-limit);
      return mine.map((m) => ({ id: m.id, senderId: m.senderId, senderName: m.senderName, kind: m.kind, ts: m.ts, text: m.text, sticker: m.sticker, stickerUrl: m.stickerUrl }));
    });
  }, [session, opts.history]);

  const notify = useCallback((m: GroupMessage) => {
    const o = optsRef.current;
    if (m.from !== "peer" || m.recovered) return;
    const chat: ChatMessage = {
      id: m.id, from: "peer", kind: m.kind, text: m.text, sticker: m.sticker, stickerUrl: m.stickerUrl,
      file: m.file ? { name: m.file.name, size: m.file.size, mime: m.file.mime, progress: 0, status: "done" } : undefined,
      ts: m.ts, reactions: {},
    };
    deliver(
      {
        room: sessionRef.current?.room ?? "group",
        roomName: snapRef.current?.meta.name ?? "Group",
        senderName: m.senderName ?? "Member",
        body: previewOf(chat),
        text: m.text,
      },
      { muted: o.muted, sounds: o.prefs.sounds, notifications: o.prefs.notifications, myName: o.prefs.username },
    );
  }, []);

  // ---- session binding ----

  useEffect(() => {
    if (!session) return;
    setPhase(session.phase);
    setError(session.error);
    if (session.role === "host") setSnap(session.snap);
    const offs = [
      session.on("phase", (p) => { setPhase(p); if (p === "failed") setError(session.error); if (p === "ready") setStopped(null); }),
      session.on("snapshot", (s) => {
        setSnap(s);
        // Host: persist the roster/roles/bans/pins so an ownership restart can re-host
        // the same room with continuity (storage.ts ownership recovery).
        if (session.role === "host") saveGroupSnapshot(session.room, s);
      }),
      session.on("presence", (p) => setPresence(p)),
      session.on("audit", (a) => setAudit([...a])),
      session.on("notice", (n) => {
        if (STOP_KINDS.has(n.kind)) { setStopped(n.text); toast.error(n.text); return; }
        if (n.kind === "denied" || n.kind === "slow" || n.kind === "muted" || n.kind === "pending" || n.kind === "keys") toast.info(n.text);
        else if (n.kind === "approved" || n.kind === "epoch" || n.kind === "history") toast.success(n.text);
        else toast(n.text);
      }),
      session.on("read", ({ ids }) => {
        const set = new Set(ids);
        setMessages((ms) => ms.map((m) => (set.has(m.id) && m.from === "me" && m.status !== "read" ? { ...m, status: "read" } : m)));
      }),
      session.on("message", (m) => {
        const x = m as any;
        if (x.__react) {
          patch(m.id, (t) => {
            const r = { ...t.reactions };
            const list = (r[x.__react.emoji] ?? []).filter((w) => w !== "peer");
            const next = x.__react.on ? [...list, "peer" as const] : list;
            if (next.length) r[x.__react.emoji] = next; else delete r[x.__react.emoji];
            return { ...t, reactions: r };
          });
          return;
        }
        if (x.__edit) {
          // Authorship was enforced host-side; receivers re-check (defense in depth).
          const target = messagesRef.current.find((t) => t.id === m.id);
          if (target && target.senderId !== m.senderId) return;
          patch(m.id, (t) => ({ ...t, text: m.text, edited: true }));
          return;
        }
        if (x.__del) {
          const target = messagesRef.current.find((t) => t.id === m.id);
          if (target && target.senderId !== m.senderId) return;
          patch(m.id, (t) => ({ ...t, deleted: true, text: undefined, sticker: undefined, stickerUrl: undefined }));
          return;
        }
        if (x.__fileFrame) {
          const frame = x.__fileFrame as { t: string; body?: Uint8Array };
          if (frame.t === "file-start") {
            if (m.file && m.file.size > GROUP_MAX_FILE_BYTES) { addSystem(`Rejected "${m.file.name}": larger than the 25 MB group limit.`); return; }
            incoming.current.set(m.id, { chunks: [], received: 0, size: m.file?.size ?? 0, mime: m.file?.mime ?? "application/octet-stream", lastUi: 0 });
            append(m);
            notify(m);
            return;
          }
          if (frame.t === "file-chunk") {
            const inc = incoming.current.get(m.id);
            if (!inc || !frame.body) return;
            inc.chunks.push(frame.body);
            inc.received += frame.body.length;
            if (inc.received > inc.size) { incoming.current.delete(m.id); patch(m.id, (t) => ({ ...t, file: t.file ? { ...t.file, status: "failed" } : t.file })); return; }
            const now = performance.now();
            if (now - inc.lastUi > 120) { inc.lastUi = now; const p = inc.size ? inc.received / inc.size : 0; patch(m.id, (t) => ({ ...t, file: t.file ? { ...t.file, progress: p } : t.file })); }
            return;
          }
          if (frame.t === "file-end") {
            const inc = incoming.current.get(m.id);
            if (!inc) return;
            incoming.current.delete(m.id);
            const url = URL.createObjectURL(new Blob(inc.chunks as BlobPart[], { type: inc.mime }));
            patch(m.id, (t) => ({ ...t, file: t.file ? { ...t.file, url, progress: 1, status: "done" } : t.file }));
            return;
          }
          if (frame.t === "file-cancel") {
            incoming.current.delete(m.id);
            patch(m.id, (t) => ({ ...t, file: t.file ? { ...t.file, status: "cancelled" } : t.file }));
            return;
          }
          return;
        }
        // regular content / system / recovered-history message
        let msg = m;
        if (m.kind !== "system" && (m.sticker || m.stickerUrl)) {
          const r = resolveIncomingSticker({ sticker: m.sticker, stickerUrl: m.stickerUrl, stickerLib: x.stickerLib });
          msg = { ...m, ...r };
        }
        append(msg);
        persist(msg);
        notify(msg);
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [session, patch, append, addSystem, persist, notify]);

  // Viewing state drives presence ("currently viewing room") + read receipt timing.
  useEffect(() => {
    if (!session) return;
    const onVis = () => session.setViewing(document.visibilityState === "visible");
    session.setViewing(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [session]);

  // ---- outgoing content ----

  const sendMsg = useCallback(async (m: Omit<GroupMessage, "id" | "from" | "ts" | "reactions" | "status" | "senderId">) => {
    const s = sessionRef.current;
    if (!s) { toast.error("The room is not open."); return; }
    const id = randomId();
    const msg: GroupMessage = { ...m, id, from: "me", senderId: s.myId, senderName: optsRef.current.prefs.username, ts: Date.now(), reactions: {}, status: "sending" };
    append(msg);
    persist(msg);
    try {
      let stickerUrl = m.stickerUrl;
      // Groups: receivers' sticker-library versions are unknown to the sender, so a
      // built-in sticker is ALWAYS also sent inline (still inside the E2EE frame);
      // receivers with the same verified library render the local asset instead.
      if (m.kind === "sticker" && isLibStickerId(m.sticker)) stickerUrl = await stickerDataUrl(m.sticker);
      const queued = s.role === "member" && s.phase !== "ready";
      await s.sendContent({ t: "msg", id, kind: m.kind, text: m.text, sticker: m.sticker, stickerLib: isLibStickerId(m.sticker) ? STICKER_LIB_VERSION : undefined, stickerUrl, replyTo: m.replyTo, forwarded: m.forwarded });
      if (!queued) { patch(id, (x) => (x.status === "sending" ? { ...x, status: "sent" } : x)); play(m.kind === "sticker" ? "sticker" : "send"); }
      else toast.info("Queued - connecting to the room's host…");
    } catch {
      patch(id, (x) => ({ ...x, status: "failed" }));
      toast.error("Not sent - you're not securely connected to the room.");
    }
  }, [append, patch, persist]);

  const sendFile = useCallback(async (file: Blob, name: string, kind: MsgKind, replyTo?: ReplyRef, forwarded?: boolean) => {
    const s = sessionRef.current;
    if (!s) { toast.error("The room is not open."); return; }
    if (file.size > GROUP_MAX_FILE_BYTES) { toast.error("Group files are limited to 25 MB."); return; }
    const id = randomId();
    const mime = file.type || "application/octet-stream";
    const url = URL.createObjectURL(file);
    const msg: GroupMessage = { id, from: "me", senderId: s.myId, senderName: optsRef.current.prefs.username, kind: kind === "voice" ? "voice" : "file", ts: Date.now(), reactions: {}, status: "sending", replyTo, forwarded, file: { name, size: file.size, mime, url, progress: 0, status: "sending" } };
    append(msg);
    persist(msg);
    try {
      await s.sendContent({ t: "file-start", id, name, size: file.size, mime, kind, replyTo, forwarded });
      let sent = 0, lastUi = 0;
      while (sent < file.size) {
        if (cancelled.current.has(id)) { await s.sendContent({ t: "file-cancel", id }).catch(() => {}); return; }
        const chunk = new Uint8Array(await file.slice(sent, sent + CHUNK).arrayBuffer());
        await s.sendContent({ t: "file-chunk", id }, chunk);
        sent += chunk.length;
        const now = performance.now();
        if (now - lastUi > 120) { lastUi = now; const p = sent / file.size; patch(id, (m) => ({ ...m, file: m.file ? { ...m.file, progress: p } : m.file })); }
      }
      await s.sendContent({ t: "file-end", id });
      patch(id, (m) => ({ ...m, status: m.status === "sending" ? "sent" : m.status, file: m.file ? { ...m.file, progress: 1, status: "done" } : m.file }));
      play("send");
    } catch {
      patch(id, (m) => ({ ...m, status: "failed", file: m.file ? { ...m.file, status: m.file.status === "cancelled" ? "cancelled" : "failed" } : m.file }));
      toast.error("Transfer failed - the connection to the room was interrupted.");
    }
  }, [append, patch, persist]);

  const cancelTransfer = useCallback((id: string) => {
    cancelled.current.add(id);
    incoming.current.delete(id);
    patch(id, (m) => (m.file ? { ...m, file: { ...m.file, status: "cancelled" } } : m));
    void sessionRef.current?.sendContent({ t: "file-cancel", id }).catch(() => {});
  }, [patch]);

  const react = useCallback((id: string, emoji: string) => {
    let on = false;
    patch(id, (m) => {
      const r = { ...m.reactions };
      const list = r[emoji] ?? [];
      on = !list.includes("me");
      const next = on ? [...list, "me" as const] : list.filter((x) => x !== "me");
      if (next.length) r[emoji] = next; else delete r[emoji];
      return { ...m, reactions: r };
    });
    setTimeout(() => void sessionRef.current?.react(id, emoji, on).catch(() => {}), 0);
  }, [patch]);

  const editMessage = useCallback(async (id: string, text: string) => {
    const m = messagesRef.current.find((x) => x.id === id);
    if (!m || m.senderId !== sessionRef.current?.myId) return;
    patch(id, (x) => ({ ...x, text, edited: true }));
    try { await sessionRef.current?.editMessage(id, text); } catch { toast.error("Edit not delivered - connection interrupted."); }
  }, [patch]);

  const deleteMessage = useCallback(async (id: string) => {
    const m = messagesRef.current.find((x) => x.id === id);
    if (!m || m.senderId !== sessionRef.current?.myId) return;
    patch(id, (x) => ({ ...x, deleted: true, text: undefined, sticker: undefined, stickerUrl: undefined }));
    try { await sessionRef.current?.deleteMessage(id); } catch { /* best-effort */ }
  }, [patch]);

  const pinMessage = useCallback((id: string, on: boolean) => {
    void sessionRef.current?.pinMessage(id, on);
  }, []);

  const setTyping = useCallback((on: boolean) => {
    if (optsRef.current.prefs.typingIndicator) void sessionRef.current?.setTyping(on);
    if (on) {
      window.clearTimeout(typingTimer.current);
      typingTimer.current = window.setTimeout(() => void sessionRef.current?.setTyping(false), 4000);
    }
  }, []);

  const markRead = useCallback(() => {
    const s = sessionRef.current;
    if (!s?.isSecure() || !optsRef.current.prefs.readReceipts) return;
    const ids = messagesRef.current
      .filter((m) => m.from === "peer" && !readSent.current.has(m.id) && m.kind !== "system" && (!m.file || m.file.status === "done"))
      .map((m) => m.id);
    if (!ids.length) return;
    ids.forEach((i) => readSent.current.add(i));
    void s.markRead(ids);
  }, []);

  // ---- moderation / room management (host enforces; members request via g-req) ----

  const mod = useMemo(() => ({
    approve: (id: string) => void sessionRef.current?.approve(id),
    reject: (id: string) => void sessionRef.current?.reject(id),
    kick: (id: string) => void sessionRef.current?.kick(id),
    ban: (id: string) => void sessionRef.current?.ban(id),
    mute: (id: string, ms?: number) => void sessionRef.current?.mute(id, ms),
    unmute: (id: string) => void sessionRef.current?.unmute(id),
    setRole: (id: string, role: GroupRole) => void sessionRef.current?.setRole(id, role),
    setRules: (rules: Partial<GroupRules>) => void sessionRef.current?.setRules(rules),
    setGroupMeta: (m: Partial<Pick<GroupMeta, "name" | "desc" | "rules">>) => void sessionRef.current?.setGroupMeta(m),
    transferOwnership: (id: string) => sessionRef.current?.transferOwnership(id) ?? false,
    requestHistory: (limit?: number) => void sessionRef.current?.requestHistory(limit),
  }), []);

  // ---- derived ----

  const chat: ChatMessage[] = useMemo(() => messages.map((m) => ({
    id: m.id,
    from: m.from,
    kind: m.kind,
    text: m.deleted ? undefined : m.text,
    sticker: m.sticker,
    stickerUrl: m.stickerUrl,
    file: m.deleted ? undefined : (m.file ? { name: m.file.name, size: m.file.size, mime: m.file.mime, url: m.file.url, progress: m.file.progress ?? 0, status: m.file.status ?? "sending" } : undefined),
    ts: m.ts,
    status: m.status,
    replyTo: m.replyTo,
    reactions: m.reactions,
    pinned: (snap?.pinned ?? []).some((pp) => pp.id === m.id),
    forwarded: m.forwarded,
    senderName: m.from === "peer" ? m.senderName : undefined,
    senderId: m.senderId,
    edited: m.edited,
    deleted: m.deleted,
  })), [messages, snap]);

  const roleOf = useCallback((id: string): GroupRole => snapRef.current?.roster.find((r) => r.id === id)?.role ?? "member", []);
  const myRole: GroupRole = snap?.roster.find((r) => r.id === session?.myId)?.role ?? "member";
  const pending = useMemo(() => (snap?.roster ?? []).filter((r) => r.pending), [snap]);
  const onlineCount = useMemo(() => Object.values(presence).filter((p) => p.online).length, [presence]);

  return {
    messages: chat,
    snap,
    presence,
    audit,
    phase: stopped ? ("failed" as GroupPhase) : phase,
    error: stopped ?? error,
    stopReason: stopped,
    myRole,
    roleOf,
    pending,
    onlineCount,
    sendMsg, sendFile, cancelTransfer, react, editMessage, deleteMessage, pinMessage,
    setTyping, markRead, addSystem, hideMessage, mod,
  };
}
export type GroupApi = ReturnType<typeof useGroup>;
