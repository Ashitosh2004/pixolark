import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Settings as Cog } from "lucide-react";
import { generateRoomId, normalizeRoomId } from "@/lib/pixel/codec";
import { PeerSession, type SessionState } from "@/lib/pixel/session";
import { play, setSoundEnabled } from "@/lib/pixel/sound";
import { clearAllLocalData, clearHistory, loadHistory, loadPrefs, purgeOldHistory, saveHistory, savePrefs, defaultPrefs, type Prefs } from "@/lib/pixel/storage";
import { CallOverlay } from "./CallOverlay";
import { ChatView } from "./ChatView";
import { GuestJoin, HostWait } from "./Handshake";
import { SettingsPanel } from "./Settings";
import { useChat } from "./useChat";
import { AvatarImg, Loader, Mascot, PixelBackground } from "./ui";
import { randomAvatar } from "@/lib/pixel/pixelart";

type Stage = "lobby" | "host" | "join" | "chat";

export default function PixelApp({
  mode,
  initialCode,
  initialRoom,
}: {
  mode?: "create" | "join" | undefined;
  initialCode?: string | undefined;
  initialRoom?: string | undefined;
}) {
  const [prefs, setPrefsState] = useState<Prefs>(() => loadPrefs());
  const [stage, setStage] = useState<Stage>("lobby");
  const [session, setSession] = useState<PeerSession | null>(null);
  const [sessState, setSessState] = useState<SessionState>("preparing");
  const [roomId, setRoomId] = useState(initialRoom ?? "");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<{ open: boolean; tab?: "security" | "profile" | undefined }>({ open: false });
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [verified, setVerified] = useState(false);
  const autoRan = useRef(false);

  const setPrefs = useCallback((fn: (p: Prefs) => Prefs) => setPrefsState((p) => { const n = fn(p); savePrefs(n); return n; }), []);
  const api = useChat(session, prefs, { muted, blocked, initial: [] });

  useEffect(() => { setSoundEnabled(prefs.sounds); }, [prefs.sounds]);
  useEffect(() => { document.documentElement.classList.toggle("light", prefs.theme === "light"); }, [prefs.theme]);
  useEffect(() => { purgeOldHistory(); }, []);

  // Session lifecycle
  useEffect(() => {
    if (!session) return;
    setSessState(session.state);
    return session.on("state", (s) => {
      setSessState(s);
      if (s === "secure") {
        setStage("chat");
        play("connect");
        api.addSystem(session.role === "host" ? "Friend joined. Keys verified — end-to-end encryption active." : "Connected. Keys verified — end-to-end encryption active.");
      }
      if (s === "failed") { play("error"); if (session.error) toast.error(session.error, { duration: 8000 }); }
      if (s === "closed") play("leave");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Auto-disconnect on session expiry
  useEffect(() => {
    if (!session || sessState !== "secure") return;
    const t = setTimeout(() => {
      api.addSystem("Session expired — disconnected automatically. Keys deleted.");
      session.close();
    }, prefs.sessionHours * 3600 * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, sessState === "secure", prefs.sessionHours]);

  // Optional local history
  useEffect(() => {
    if (!roomId || !prefs.saveHistory) return;
    saveHistory(roomId, api.messages.filter((m) => m.kind !== "system").map((m) => (m.file ? { ...m, file: { ...m.file, url: undefined, status: m.file.status === "done" ? "done" : "failed" } } : m)));
  }, [api.messages, roomId, prefs.saveHistory]);
  useEffect(() => { if (!prefs.saveHistory && roomId) clearHistory(roomId); }, [prefs.saveHistory, roomId]);

  const loadRoomHistory = (room: string) => {
    if (prefs.saveHistory) { const h = loadHistory(room, prefs.autoDelete24h); if (h.length) api.setMessages(h); }
  };

  const createRoom = useCallback(async (existingRoom?: string) => {
    setBusy(true);
    try {
      session?.close(false);
      const r = existingRoom ?? generateRoomId();
      setRoomId(r);
      if (!existingRoom) { api.setMessages([]); loadRoomHistory(r); }
      setVerified(false);
      const s = await PeerSession.host(r);
      setSession(s);
      setStage("host");
    } catch (e: any) {
      toast.error(typeof RTCPeerConnection === "undefined" ? "Your browser doesn't support WebRTC." : `Couldn't create room: ${e?.message ?? e}`);
    } finally { setBusy(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, prefs.saveHistory]);

  const joinRoom = useCallback(async (room: string, code: string) => {
    session?.close(false);
    const s = await PeerSession.join(room, code);
    if (room !== roomId) { api.setMessages([]); loadRoomHistory(room); }
    setRoomId(room);
    setVerified(false);
    setSession(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, roomId, prefs.saveHistory]);

  // Room creator: re-host an existing room under its 6-digit code (after leaving/reload).
  // HostWait re-publishes the offer, so the friend's Reconnect picks the fresh one up.
  const rejoinRoom = useCallback(async (room: string) => {
    setBusy(true);
    try {
      session?.close(false);
      const r = normalizeRoomId(room);
      setRoomId(r);
      api.setMessages([]);
      loadRoomHistory(r);
      setVerified(false);
      const s = await PeerSession.host(r);
      setSession(s);
      setStage("host");
      toast(`Room ${r} is live again — waiting for your friend.`);
    } catch (e: any) {
      toast.error(typeof RTCPeerConnection === "undefined" ? "Your browser doesn't support WebRTC." : `Couldn't rejoin room: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    if (mode === "create") void createRoom();
    else if (mode === "join" || initialCode) setStage("join");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const leave = useCallback(() => {
    session?.close(true);
    setSession(null);
    setVerified(false);
    setBlocked(false);
    setStage("lobby");
    setSettings({ open: false });
    if (!prefs.saveHistory) api.setMessages([]);
    toast("You left the room. Session keys deleted.");
  }, [session, prefs.saveHistory, api]);

  const reconnect = useCallback(() => {
    setSettings({ open: false });
    if (session?.role === "guest") { session.close(false); setSession(null); setStage("join"); toast("Connection lost. Enter the 6-digit room code to reconnect."); }
    else void createRoom(roomId || undefined);
  }, [session, roomId, createRoom]);

  const exportChat = () => {
    const data = { app: "Pixolark", room: roomId, exportedAt: new Date().toISOString(), messages: api.messages.map((m) => ({ ...m, file: m.file ? { name: m.file.name, size: m.file.size, mime: m.file.mime } : undefined })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `pixolark-${roomId || "chat"}-${Date.now()}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const clearChat = () => {
    api.messages.forEach((m) => m.file?.url && URL.revokeObjectURL(m.file.url));
    api.setMessages([]);
    if (roomId) clearHistory(roomId);
    toast("Chat cleared on this device.");
  };

  const clearAll = () => {
    clearAllLocalData();
    clearChat();
    session?.close(true);
    setSession(null);
    setStage("lobby");
    const fresh = defaultPrefs();
    setPrefsState(fresh); savePrefs(fresh);
    setSettings({ open: false });
    toast("All local data cleared.");
  };

  // Clean up blob URLs + session on unmount / tab close
  useEffect(() => {
    const h = () => session?.close(true);
    window.addEventListener("pagehide", h);
    return () => window.removeEventListener("pagehide", h);
  }, [session]);

  return (
    <div className="min-h-dvh">
      {stage !== "chat" && <PixelBackground />}
      {stage !== "chat" && (
        <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <a href="/" className="font-pixel text-xs text-primary">PIXO<span className="text-secondary">LARK</span></a>
          <button className="pixel-btn pixel-btn-sm" onClick={() => setSettings({ open: true, tab: "profile" })}><Cog size={12} /> Settings</button>
        </header>
      )}

      {stage === "lobby" && (
        <div className="mx-auto flex max-w-md flex-col items-center gap-6 p-4">
          <Mascot size={72} className="animate-bob" />
          <div className="pixel-box flex w-full flex-col gap-4 p-6">
            <span className="pixel-label">Your player</span>
            <div className="flex items-center gap-4">
              <AvatarImg avatar={prefs.avatar} size={56} />
              <div className="flex flex-1 flex-col gap-2">
                <input className="pixel-input" value={prefs.username} maxLength={32} onChange={(e) => setPrefs((p) => ({ ...p, username: e.target.value }))} aria-label="Username" />
                <div className="flex gap-2">
                  <button className="pixel-btn pixel-btn-sm" onClick={() => setPrefs((p) => ({ ...p, avatar: randomAvatar() }))}>🎲 Random</button>
                  <button className="pixel-btn pixel-btn-sm" onClick={() => setSettings({ open: true, tab: "profile" })}>Edit</button>
                </div>
              </div>
            </div>
            <div className="mt-2 grid gap-5 sm:grid-cols-2">
              <button className="pixel-btn pixel-btn-primary" disabled={busy} onClick={() => createRoom()}>▶ Create room</button>
              <button className="pixel-btn pixel-btn-gold" onClick={() => setStage("join")}>Join room</button>
            </div>
            {busy && <Loader label="Generating keys" />}
          </div>
        </div>
      )}

      {stage === "host" && session && session.role === "host" && <HostWait session={session} onBack={leave} />}
      {stage === "host" && busy && <div className="py-20"><Loader label="Generating room" /></div>}
      {stage === "join" && (
        <GuestJoin
          session={session?.role === "guest" ? session : null}
          onJoin={joinRoom}
          onRejoin={rejoinRoom}
          onBack={leave}
          initialRoom={initialRoom || roomId}
          initialCode={initialCode}
        />
      )}
      {stage === "chat" && (
        <ChatView
          api={api} session={session} sessState={sessState} prefs={prefs} setPrefs={setPrefs} roomId={roomId}
          verified={verified} muted={muted} blocked={blocked}
          onSettings={(tab) => setSettings({ open: true, tab })} onLeave={leave} onReconnect={reconnect}
        />
      )}

      <CallOverlay api={api} session={session} peer={api.peer} />
      <SettingsPanel
        open={settings.open} initialTab={settings.tab} onClose={() => setSettings({ open: false })}
        prefs={prefs} setPrefs={setPrefs} session={session?.isSecure ? session : stage === "chat" ? session : null}
        muted={muted} setMuted={setMuted} blocked={blocked} setBlocked={setBlocked}
        verified={verified} setVerified={(v) => { setVerified(v); if (v) api.addSystem("You marked this connection as verified."); }}
        onClearChat={clearChat} onExport={exportChat} onClearAll={clearAll} onReconnect={reconnect} onLeave={leave}
      />
    </div>
  );
}
