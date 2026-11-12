import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { randomId } from "@/lib/pixel/bytes";
import type { PeerSession } from "@/lib/pixel/session";
import { play } from "@/lib/pixel/sound";
import type { Prefs } from "@/lib/pixel/storage";
import { isLibStickerId, resolveIncomingSticker, STICKER_LIB_VERSION, stickerDataUrl } from "@/lib/pixel/stickerlib";
import { CHUNK, MAX_FILE_BYTES, previewOf, type CallState, type ChatMessage, type MsgKind, type PeerProfile, type ReplyRef } from "./types";

interface Incoming { chunks: Uint8Array[]; received: number; size: number; mime: string; lastUi: number }

export function mediaErrorText(e: any, video: boolean): string {
  const what = video ? "camera and microphone" : "microphone";
  if (e?.name === "NotAllowedError") return `Permission to use your ${what} was denied. Allow it in your browser's site settings and try again.`;
  if (e?.name === "NotFoundError") return `No ${what} was found on this device.`;
  if (e?.name === "NotReadableError") return `Your ${what} is being used by another app.`;
  if (!navigator.mediaDevices) return "Calls need a secure (HTTPS) page and a modern browser.";
  return `Could not access your ${what}.`;
}

export function useChat(session: PeerSession | null, prefs: Prefs, opts: { muted: boolean; blocked: boolean; initial: ChatMessage[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(opts.initial);
  const [peer, setPeer] = useState<PeerProfile | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const [online, setOnline] = useState(false);
  const [call, setCall] = useState<CallState>({ phase: "idle", video: false, startedAt: null, micOn: true, camOn: true });
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const incoming = useRef(new Map<string, Incoming>());
  const cancelled = useRef(new Set<string>());
  const readSent = useRef(new Set<string>());
  const typingTimer = useRef<number>(0);
  const pendingStream = useRef<MediaStream | null>(null);
  const callRef = useRef(call); callRef.current = call;
  const optsRef = useRef(opts); optsRef.current = opts;
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const peerRef = useRef(peer); peerRef.current = peer;

  const patch = useCallback((id: string, fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));
  }, []);
  const addSystem = useCallback((text: string) => {
    setMessages((ms) => [...ms, { id: randomId(), from: "system", kind: "system", text, ts: Date.now(), reactions: {} }]);
  }, []);

  const notify = useCallback((title: string, body: string) => {
    if (optsRef.current.muted) return;
    play("receive");
    if (prefsRef.current.notifications && document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
      try { new Notification(title, { body, icon: "/favicon.ico", tag: "pixelchat" }); } catch { /* */ }
    }
  }, []);

  const sendProfile = useCallback(() => {
    if (!session?.isSecure) return;
    const p = prefsRef.current;
    void session.send({ t: "profile", name: p.username.slice(0, 32), avatar: p.avatar, status: p.status.slice(0, 60), stickerLib: STICKER_LIB_VERSION }).catch(() => {});
  }, [session]);

  // Resend profile when it changes
  useEffect(() => { sendProfile(); }, [prefs.username, prefs.avatar, prefs.status, sendProfile]);

  const stopCallMedia = useCallback(() => {
    pendingStream.current?.getTracks().forEach((t) => t.stop());
    pendingStream.current = null;
    session?.stopLocalMedia();
    setLocalStream(null);
    setRemoteStream(null);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const offs = [
      session.on("presence", (v) => setOnline(v)),
      session.on("track", (s) => setRemoteStream(s.getTracks().length ? new MediaStream(s.getTracks()) : null)),
      session.on("state", (s) => {
        if (s === "secure") { setOnline(true); sendProfile(); }
        if (s === "closed" || s === "failed") {
          setOnline(false); setPeerTyping(false);
          if (callRef.current.phase !== "idle") { stopCallMedia(); setCall((c) => ({ ...c, phase: "idle", startedAt: null })); }
          // fail in-flight transfers
          setMessages((ms) => ms.map((m) => m.file && (m.file.status === "sending" || m.file.status === "receiving") ? { ...m, file: { ...m.file, status: "failed" } } : m));
          incoming.current.clear();
        }
      }),
      session.on("message", ({ header: h, body }) => {
        const blocked = optsRef.current.blocked;
        switch (h.t) {
          case "profile":
            setPeer({ name: String(h.name ?? "Friend").slice(0, 32), avatar: h.avatar, status: String(h.status ?? "").slice(0, 60), stickerLib: typeof h.stickerLib === "string" ? h.stickerLib.slice(0, 40) : undefined });
            break;
          case "msg": {
            if (blocked) return;
            const m: ChatMessage = {
              id: h.id, from: "peer", kind: h.kind as MsgKind, text: typeof h.text === "string" ? h.text.slice(0, 4000) : undefined,
              ...resolveIncomingSticker(h),
              ts: Date.now(), replyTo: h.replyTo, reactions: {}, forwarded: !!h.forwarded,
            };
            setMessages((ms) => (ms.some((x) => x.id === m.id) ? ms : [...ms, m]));
            void session.send({ t: "ack", id: h.id }).catch(() => {});
            setPeerTyping(false);
            notify(peerRef.current?.name ?? "Pixolark", previewOf(m));
            break;
          }
          case "ack": patch(h.id, (m) => (m.status === "read" ? m : { ...m, status: "delivered" })); break;
          case "read": { const ids = new Set<string>(h.ids ?? []); setMessages((ms) => ms.map((m) => (ids.has(m.id) && m.from === "me" ? { ...m, status: "read" } : m))); break; }
          case "typing":
            if (blocked) return;
            setPeerTyping(!!h.on);
            window.clearTimeout(typingTimer.current);
            if (h.on) typingTimer.current = window.setTimeout(() => setPeerTyping(false), 6000);
            break;
          case "react":
            patch(h.id, (m) => {
              const r = { ...m.reactions };
              const list: ("me" | "peer")[] = (r[h.emoji] ?? []).filter((x) => x !== "peer");
              if (h.on) list.push("peer");
              if (list.length) r[h.emoji] = list; else delete r[h.emoji];
              return { ...m, reactions: r };
            });
            break;
          case "file-start": {
            if (blocked) { void session.send({ t: "file-cancel", id: h.id }).catch(() => {}); return; }
            if (h.size > MAX_FILE_BYTES) { void session.send({ t: "file-cancel", id: h.id }).catch(() => {}); addSystem(`Rejected "${h.name}": larger than the 250 MB limit.`); return; }
            incoming.current.set(h.id, { chunks: [], received: 0, size: h.size, mime: h.mime, lastUi: 0 });
            setMessages((ms) => [...ms, {
              id: h.id, from: "peer", kind: h.kind, ts: Date.now(), reactions: {}, replyTo: h.replyTo, forwarded: !!h.forwarded,
              file: { name: String(h.name).slice(0, 200), size: h.size, mime: h.mime, progress: 0, status: "receiving" },
            }]);
            break;
          }
          case "file-chunk": {
            const inc = incoming.current.get(h.id);
            if (!inc) return;
            inc.chunks.push(body);
            inc.received += body.length;
            if (inc.received > inc.size) { incoming.current.delete(h.id); patch(h.id, (m) => ({ ...m, file: { ...m.file!, status: "failed" } })); return; }
            const now = performance.now();
            if (now - inc.lastUi > 120) { inc.lastUi = now; const p = inc.received / inc.size; patch(h.id, (m) => ({ ...m, file: { ...m.file!, progress: p } })); }
            break;
          }
          case "file-end": {
            const inc = incoming.current.get(h.id);
            if (!inc) return;
            incoming.current.delete(h.id);
            const url = URL.createObjectURL(new Blob(inc.chunks as BlobPart[], { type: inc.mime }));
            let preview = "";
            patch(h.id, (m) => { preview = previewOf(m); return { ...m, file: { ...m.file!, url, progress: 1, status: "done" } }; });
            void session.send({ t: "ack", id: h.id }).catch(() => {});
            notify(peerRef.current?.name ?? "Pixolark", preview || "sent a file");
            break;
          }
          case "file-cancel":
            incoming.current.delete(h.id);
            cancelled.current.add(h.id);
            patch(h.id, (m) => (m.file ? { ...m, file: { ...m.file, status: "cancelled" } } : m));
            break;
          case "call-invite":
            if (blocked) { void session.send({ t: "call-reject" }).catch(() => {}); return; }
            if (callRef.current.phase !== "idle") { void session.send({ t: "call-busy" }).catch(() => {}); return; }
            setCall({ phase: "incoming", video: !!h.video, incomingVideo: !!h.video, startedAt: null, micOn: true, camOn: true });
            if (!optsRef.current.muted) play("ring");
            break;
          case "call-accept":
            if (callRef.current.phase === "outgoing" && pendingStream.current) {
              void session.addLocalMedia(pendingStream.current);
              pendingStream.current = null;
              setCall((c) => ({ ...c, phase: "active", startedAt: Date.now() }));
            }
            break;
          case "call-reject": case "call-busy":
            if (callRef.current.phase === "outgoing") { stopCallMedia(); setCall((c) => ({ ...c, phase: "idle" })); toast(h.t === "call-busy" ? "Your friend is already in a call." : "Call declined."); }
            break;
          case "call-end":
            if (callRef.current.phase !== "idle") { stopCallMedia(); setCall((c) => ({ ...c, phase: "idle", startedAt: null })); addSystem("Call ended."); }
            break;
          case "bye":
            addSystem(`${peerRef.current?.name ?? "Your friend"} left the room.`);
            if (!optsRef.current.muted) play("leave");
            break;
        }
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [session, patch, addSystem, notify, sendProfile, stopCallMedia]);

  const sendMsg = useCallback(async (m: Omit<ChatMessage, "id" | "from" | "ts" | "reactions" | "status">) => {
    const id = randomId();
    const msg: ChatMessage = { ...m, id, from: "me", ts: Date.now(), reactions: {}, status: "sending" };
    setMessages((ms) => [...ms, msg]);
    try {
      if (!session?.isSecure) throw new Error("offline");
      let stickerUrl = m.stickerUrl;
      // Built-in sticker: send only its ID when the peer has the identical verified library;
      // otherwise embed the animated file itself (still inside the encrypted frame).
      if (m.kind === "sticker" && isLibStickerId(m.sticker) && peerRef.current?.stickerLib !== STICKER_LIB_VERSION) stickerUrl = await stickerDataUrl(m.sticker);
      await session.send({ t: "msg", id, kind: m.kind, text: m.text, sticker: m.sticker, stickerLib: isLibStickerId(m.sticker) ? STICKER_LIB_VERSION : undefined, stickerUrl, replyTo: m.replyTo, forwarded: m.forwarded });
      patch(id, (x) => (x.status === "sending" ? { ...x, status: "sent" } : x));
      play(m.kind === "sticker" ? "sticker" : "send");
    } catch {
      patch(id, (x) => ({ ...x, status: "failed" }));
      toast.error("Not sent — you're not securely connected.");
    }
  }, [session, patch]);

  const sendFile = useCallback(async (file: Blob, name: string, kind: MsgKind, replyTo?: ReplyRef, forwarded?: boolean) => {
    if (file.size > MAX_FILE_BYTES) { toast.error("Files are limited to 250 MB."); return; }
    if (!session?.isSecure) { toast.error("Connect to a peer first."); return; }
    const id = randomId();
    const mime = file.type || "application/octet-stream";
    const url = URL.createObjectURL(file);
    setMessages((ms) => [...ms, { id, from: "me", kind, ts: Date.now(), reactions: {}, status: "sending", replyTo, forwarded, file: { name, size: file.size, mime, url, progress: 0, status: "sending" } }]);
    try {
      await session.send({ t: "file-start", id, name, size: file.size, mime, kind, replyTo, forwarded });
      let sent = 0, lastUi = 0;
      while (sent < file.size) {
        if (cancelled.current.has(id)) return;
        const chunk = new Uint8Array(await file.slice(sent, sent + CHUNK).arrayBuffer());
        await session.send({ t: "file-chunk", id }, chunk);
        sent += chunk.length;
        const now = performance.now();
        if (now - lastUi > 120) { lastUi = now; const p = sent / file.size; patch(id, (m) => ({ ...m, file: { ...m.file!, progress: p } })); }
      }
      await session.send({ t: "file-end", id });
      patch(id, (m) => ({ ...m, status: m.status === "sending" ? "sent" : m.status, file: { ...m.file!, progress: 1, status: "done" } }));
      play("send");
    } catch {
      patch(id, (m) => ({ ...m, status: "failed", file: { ...m.file!, status: m.file!.status === "cancelled" ? "cancelled" : "failed" } }));
    }
  }, [session, patch]);

  const cancelTransfer = useCallback((id: string) => {
    cancelled.current.add(id);
    incoming.current.delete(id);
    patch(id, (m) => (m.file ? { ...m, file: { ...m.file, status: "cancelled" } } : m));
    void session?.send({ t: "file-cancel", id }).catch(() => {});
  }, [session, patch]);

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
    setTimeout(() => void session?.send({ t: "react", id, emoji, on }).catch(() => {}), 0);
  }, [session, patch]);

  const setTyping = useCallback((on: boolean) => {
    if (prefsRef.current.typingIndicator && session?.isSecure) void session.send({ t: "typing", on }).catch(() => {});
  }, [session]);

  const markRead = useCallback(() => {
    if (!session?.isSecure || !prefsRef.current.readReceipts) return;
    const ids = messages.filter((m) => m.from === "peer" && !readSent.current.has(m.id) && (m.kind !== "file" && m.kind !== "voice" && m.kind !== "gif" || m.file?.status === "done")).map((m) => m.id);
    if (!ids.length) return;
    ids.forEach((i) => readSent.current.add(i));
    void session.send({ t: "read", ids }).catch(() => {});
  }, [session, messages]);

  // ---- calls ----
  const startCall = useCallback(async (video: boolean) => {
    if (!session?.isSecure) { toast.error("Connect to a peer first."); return; }
    if (callRef.current.phase !== "idle") return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { facingMode: "user" } : false });
      pendingStream.current = s;
      setLocalStream(s);
      setCall({ phase: "outgoing", video, startedAt: null, micOn: true, camOn: video });
      await session.send({ t: "call-invite", video });
      setTimeout(() => {
        if (callRef.current.phase === "outgoing") { void session.send({ t: "call-end" }).catch(() => {}); stopCallMedia(); setCall((c) => ({ ...c, phase: "idle" })); toast("No answer."); }
      }, 40_000);
    } catch (e) {
      toast.error(mediaErrorText(e, video));
    }
  }, [session, stopCallMedia]);

  const acceptCall = useCallback(async (withVideo: boolean) => {
    if (!session) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: withVideo ? { facingMode: "user" } : false });
      setLocalStream(s);
      await session.addLocalMedia(s);
      await session.send({ t: "call-accept" });
      setCall((c) => ({ ...c, phase: "active", video: withVideo || !!c.incomingVideo, camOn: withVideo, startedAt: Date.now() }));
    } catch (e) {
      toast.error(mediaErrorText(e, withVideo));
      void session.send({ t: "call-reject" }).catch(() => {});
      setCall((c) => ({ ...c, phase: "idle" }));
    }
  }, [session]);

  const rejectCall = useCallback(() => {
    void session?.send({ t: "call-reject" }).catch(() => {});
    setCall((c) => ({ ...c, phase: "idle" }));
  }, [session]);

  const endCall = useCallback(() => {
    void session?.send({ t: "call-end" }).catch(() => {});
    stopCallMedia();
    const dur = callRef.current.startedAt ? Math.round((Date.now() - callRef.current.startedAt) / 1000) : 0;
    setCall((c) => ({ ...c, phase: "idle", startedAt: null }));
    if (dur) addSystem(`Call ended · ${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`);
  }, [session, stopCallMedia, addSystem]);

  const toggleMic = useCallback(() => {
    const s = session?.localStream ?? localStream;
    const on = !callRef.current.micOn;
    s?.getAudioTracks().forEach((t) => (t.enabled = on));
    setCall((c) => ({ ...c, micOn: on }));
  }, [session, localStream]);

  const toggleCam = useCallback(() => {
    const s = session?.localStream ?? localStream;
    const on = !callRef.current.camOn;
    s?.getVideoTracks().forEach((t) => (t.enabled = on));
    setCall((c) => ({ ...c, camOn: on }));
  }, [session, localStream]);

  const facing = useRef<"user" | "environment">("user");
  const switchCamera = useCallback(async () => {
    const s = session?.localStream;
    if (!s || !session) return;
    try {
      facing.current = facing.current === "user" ? "environment" : "user";
      const ns = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing.current } });
      const nt = ns.getVideoTracks()[0];
      if (!nt) return;
      const old = s.getVideoTracks()[0];
      await session.replaceVideoTrack(nt);
      if (old) { s.removeTrack(old); old.stop(); }
      s.addTrack(nt);
      setLocalStream(new MediaStream(s.getTracks()));
    } catch (e) { toast.error("Couldn't switch camera: " + mediaErrorText(e, true)); }
  }, [session]);

  return {
    messages, setMessages, peer, peerTyping, online, call, remoteStream, localStream,
    sendMsg, sendFile, cancelTransfer, react, setTyping, markRead, addSystem,
    startCall, acceptCall, rejectCall, endCall, toggleMic, toggleCam, switchCamera,
  };
}
export type ChatApi = ReturnType<typeof useChat>;
