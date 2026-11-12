import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Phone, Video, Search, Settings as Cog, LogOut, Lock, ShieldCheck, ArrowDown, X, Pin, RefreshCw, Copy, Forward, Trash2, AlertTriangle, BellOff } from "lucide-react";
import { toast } from "sonner";
import type { PeerSession, SessionState } from "@/lib/pixel/session";
import type { Prefs } from "@/lib/pixel/storage";
import { randomAvatar } from "@/lib/pixel/pixelart";
import { cn } from "@/lib/utils";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import type { PickerTab } from "./MediaPicker";
import type { ChatApi } from "./useChat";
import { previewOf, type ChatMessage, type ReplyRef } from "./types";
import { AvatarImg } from "./ui";

interface Props {
  api: ChatApi;
  session: PeerSession | null;
  sessState: SessionState;
  prefs: Prefs;
  setPrefs: (fn: (p: Prefs) => Prefs) => void;
  roomId: string;
  verified: boolean;
  muted: boolean;
  blocked: boolean;
  onSettings: (tab?: "security" | "profile") => void;
  onLeave: () => void;
  onReconnect: () => void;
}

function dayLabel(ts: number) {
  const d = new Date(ts), t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() !== t.getFullYear() ? "numeric" : undefined });
}

export function ChatView(p: Props) {
  const { api } = p;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const [reply, setReply] = useState<ReplyRef | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerTab, setPickerTab] = useState<PickerTab | null>(null);
  const [vh, setVh] = useState<number | null>(null);
  const [fallbackAvatar] = useState(randomAvatar);
  const lastCount = useRef(api.messages.length);
  const peerName = api.peer?.name ?? "Friend";
  const secure = p.sessState === "secure" || p.sessState === "reconnecting";

  // Keep composer above the mobile virtual keyboard
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => setVh(vv.height);
    on();
    vv.addEventListener("resize", on);
    return () => vv.removeEventListener("resize", on);
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  useLayoutEffect(() => {
    const added = api.messages.slice(lastCount.current);
    lastCount.current = api.messages.length;
    if (!added.length) return;
    const mine = added.some((m) => m.from === "me");
    if (atBottom || mine) requestAnimationFrame(() => scrollToBottom(!mine));
    else setUnread((u) => u + added.filter((m) => m.from === "peer").length);
  }, [api.messages, atBottom, scrollToBottom]);

  useEffect(() => { requestAnimationFrame(() => scrollToBottom(false)); }, [scrollToBottom]);

  // Read receipts: when visible and scrolled to bottom
  useEffect(() => {
    const go = () => { if (atBottom && document.visibilityState === "visible" && document.hasFocus()) api.markRead(); };
    go();
    window.addEventListener("focus", go);
    document.addEventListener("visibilitychange", go);
    return () => { window.removeEventListener("focus", go); document.removeEventListener("visibilitychange", go); };
  }, [atBottom, api]);

  // Keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch((s) => (s === null ? "" : null)); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === "s") { e.preventDefault(); setPickerTab((t) => (t === "sticker" ? null : "sticker")); }
      else if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); setPickerTab((t) => (t === "emoji" ? null : "emoji")); }
      else if (mod && e.key === ",") { e.preventDefault(); p.onSettings(); }
      else if (e.key === "Escape") { setPickerTab(null); setReply(null); setSelectMode(false); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [p]);

  const onScroll = () => {
    const el = listRef.current!;
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(b);
    if (b) setUnread(0);
  };

  const shown = useMemo(() => {
    if (!search) return api.messages;
    const q = search.toLowerCase();
    return api.messages.filter((m) => previewOf(m).toLowerCase().includes(q));
  }, [api.messages, search]);

  const pinned = api.messages.filter((m) => m.pinned);

  const doReply = useCallback((m: ChatMessage) => { setReply({ id: m.id, author: m.from === "me" ? "You" : peerName, preview: previewOf(m) }); inputRef.current?.focus(); }, [peerName]);
  const doCopy = useCallback(async (m: ChatMessage) => { try { await navigator.clipboard.writeText(m.text ?? previewOf(m)); toast("Copied"); } catch { toast.error("Clipboard unavailable"); } }, []);
  const doPin = useCallback((id: string) => api.setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, pinned: !m.pinned } : m))), [api]);
  const doDelete = useCallback((id: string) => api.setMessages((ms) => ms.filter((m) => m.id !== id)), [api]);
  const doForwardStart = useCallback((m: ChatMessage) => { setSelectMode(true); setSelected(new Set([m.id])); }, []);
  const toggleSel = useCallback((id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const jump = useCallback((id: string) => { setSearch(null); setTimeout(() => document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }, []);

  const forwardSelected = async () => {
    const list = api.messages.filter((m) => selected.has(m.id) && m.kind !== "system");
    for (const m of list) {
      if (m.kind === "text") await api.sendMsg({ kind: "text", text: m.text, forwarded: true });
      else if (m.kind === "sticker") await api.sendMsg({ kind: "sticker", sticker: m.sticker, stickerUrl: m.stickerUrl, forwarded: true });
      else if (m.file?.url && m.file.status === "done") {
        const b = await (await fetch(m.file.url)).blob();
        void api.sendFile(b, m.file.name, m.kind, undefined, true);
      }
    }
    setSelectMode(false); setSelected(new Set());
    toast(`Forwarded ${list.length} item${list.length === 1 ? "" : "s"}`);
  };

  const statusText =
    p.sessState === "secure" ? (api.online ? (api.peerTyping ? "typing…" : api.peer?.status || "online") : "offline")
    : p.sessState === "reconnecting" ? "reconnecting…"
    : p.sessState === "closed" ? "disconnected" : p.sessState === "failed" ? "connection stopped" : p.sessState;

  let lastDay = "";
  return (
    <div className="flex flex-col overflow-hidden" style={{ height: vh ? `${vh}px` : "100dvh" }}>
      {/* Header */}
      <header className="flex items-center gap-2 border-b-4 border-border bg-bg2 px-2 py-2 sm:gap-3 sm:px-4">
        <a href="/" className="hidden font-pixel text-[10px] text-primary md:block">PIXO<span className="text-secondary">LARK</span></a>
        <AvatarImg avatar={api.peer?.avatar ?? fallbackAvatar} size={38} online={secure ? api.online : false} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{peerName}</span>
            {p.muted && <BellOff size={12} className="text-muted-foreground" />}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn("truncate", api.peerTyping && "text-primary")}>{statusText}</span>
            <button className="hidden items-center gap-1 font-mono sm:flex" onClick={() => { void navigator.clipboard?.writeText(p.roomId); toast("Room ID copied"); }} title="Copy Room ID">· {p.roomId} <Copy size={10} /></button>
          </div>
        </div>
        <button
          className={cn("pixel-btn pixel-btn-sm hidden sm:inline-flex", secure ? (p.verified ? "pixel-btn-primary" : "") : "pixel-btn-danger")}
          onClick={() => p.onSettings("security")}
          title="Encryption status"
        >
          {secure ? (p.verified ? <ShieldCheck size={12} /> : <Lock size={12} />) : <AlertTriangle size={12} />}
          {secure ? (p.verified ? "Verified" : "E2EE · verify") : "Not secure"}
        </button>
        <button className="pixel-btn pixel-icon-btn sm:hidden" onClick={() => p.onSettings("security")} aria-label="Encryption status">{secure ? <Lock size={14} className={p.verified ? "text-primary" : ""} /> : <AlertTriangle size={14} />}</button>
        <button className="pixel-btn pixel-icon-btn" disabled={!secure} onClick={() => api.startCall(false)} aria-label="Voice call"><Phone size={14} /></button>
        <button className="pixel-btn pixel-icon-btn" disabled={!secure} onClick={() => api.startCall(true)} aria-label="Video call"><Video size={14} /></button>
        <button className="pixel-btn pixel-icon-btn hidden sm:inline-flex" onClick={() => setSearch((s) => (s === null ? "" : null))} aria-label="Search (Ctrl+K)"><Search size={14} /></button>
        <button className="pixel-btn pixel-icon-btn" onClick={() => p.onSettings()} aria-label="Settings"><Cog size={14} /></button>
        <button className="pixel-btn pixel-icon-btn pixel-btn-danger" onClick={p.onLeave} aria-label="Leave room"><LogOut size={14} /></button>
      </header>

      {secure && !p.verified && (
        <button className="flex items-center justify-center gap-2 bg-surface px-3 py-1.5 text-xs text-muted-foreground" onClick={() => p.onSettings("security")}>
          <Lock size={12} className="text-primary" /> Encryption active · connection not yet verified — tap to compare safety codes
        </button>
      )}
      {(p.sessState === "closed" || p.sessState === "failed" || p.sessState === "reconnecting") && (
        <div className={cn("flex flex-wrap items-center justify-center gap-3 px-3 py-2 text-sm", p.sessState === "failed" ? "bg-destructive text-destructive-foreground" : "bg-secondary text-secondary-foreground")}>
          <AlertTriangle size={14} />
          <span>{p.sessState === "reconnecting" ? "Connection unstable — trying to recover…" : p.session?.error ?? "Disconnected."}</span>
          {p.sessState !== "reconnecting" && <button className="pixel-btn pixel-btn-sm" onClick={p.onReconnect}><RefreshCw size={12} /> Reconnect</button>}
        </div>
      )}

      {search !== null && (
        <div className="flex items-center gap-2 border-b-2 border-border bg-bg2 px-3 py-2">
          <Search size={14} className="text-muted-foreground" />
          <input autoFocus className="pixel-input text-sm" placeholder="Search this session…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="shrink-0 text-xs text-muted-foreground">{shown.length} found</span>
          <button onClick={() => setSearch(null)} aria-label="Close search"><X size={16} /></button>
        </div>
      )}
      {pinned.length > 0 && search === null && (
        <button className="flex items-center gap-2 border-b-2 border-border bg-bg2 px-3 py-1.5 text-left text-xs" onClick={() => jump(pinned[pinned.length - 1]!.id)}>
          <Pin size={12} className="text-secondary" /> <span className="pixel-label">Pinned ({pinned.length})</span>
          <span className="truncate">{previewOf(pinned[pinned.length - 1]!)}</span>
        </button>
      )}
      {selectMode && (
        <div className="flex items-center gap-2 border-b-2 border-border bg-surface px-3 py-2 text-sm">
          <span className="flex-1">{selected.size} selected</span>
          <button className="pixel-btn pixel-btn-sm pixel-btn-primary" disabled={!selected.size || !secure} onClick={forwardSelected}><Forward size={12} /> Forward</button>
          <button className="pixel-btn pixel-btn-sm" disabled={!selected.size} onClick={async () => { const t = api.messages.filter((m) => selected.has(m.id)).map(previewOf).join("\n"); try { await navigator.clipboard.writeText(t); toast("Copied"); } catch { /* */ } }}><Copy size={12} /></button>
          <button className="pixel-btn pixel-btn-sm" disabled={!selected.size} onClick={() => { api.setMessages((ms) => ms.filter((m) => !selected.has(m.id))); setSelected(new Set()); setSelectMode(false); }}><Trash2 size={12} /></button>
          <button className="pixel-btn pixel-btn-sm" onClick={() => { setSelectMode(false); setSelected(new Set()); }}><X size={12} /></button>
        </div>
      )}

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onScroll} className="pixel-scroll h-full overflow-y-auto px-3 py-4 sm:px-6" onClick={() => setPickerTab(null)}>
          {api.messages.length === 0 && (
            <div className="mx-auto mt-10 max-w-sm text-center">
              <div className="font-pixel text-[10px] text-primary">🔒 Secure channel open</div>
              <p className="mt-3 text-sm text-muted-foreground">Say hi! Messages are encrypted on your device and go straight to {peerName}. Nothing is stored on any server.</p>
            </div>
          )}
          {shown.map((m) => {
            const d = dayLabel(m.ts);
            const sep = d !== lastDay; lastDay = d;
            return (
              <div key={m.id}>
                {sep && <div className="my-4 flex items-center gap-3"><div className="h-1 flex-1 bg-surface" /><span className="pixel-label">{d}</span><div className="h-1 flex-1 bg-surface" /></div>}
                <MessageBubble
                  m={m} peerName={peerName} selectMode={selectMode} selected={selected.has(m.id)} highlight={search ?? undefined}
                  onSelect={toggleSel} onReply={doReply} onReact={api.react} onCopy={doCopy} onPin={doPin} onDelete={doDelete}
                  onForward={doForwardStart} onCancel={api.cancelTransfer} onJump={jump}
                />
              </div>
            );
          })}
          {api.peerTyping && (
            <div className="flex items-center gap-2 py-2">
              <div className="bubble bubble-peer flex gap-1 px-3 py-3">
                {[0, 1, 2].map((i) => <span key={i} className="animate-bob h-2 w-2 bg-foreground" style={{ animationDelay: `${i * 0.15}s` }} />)}
              </div>
            </div>
          )}
        </div>
        {!atBottom && (
          <button className="pixel-btn pixel-btn-gold pixel-icon-btn absolute bottom-4 right-4" onClick={() => { scrollToBottom(); setUnread(0); }} aria-label="Scroll to bottom">
            <ArrowDown size={16} />
            {unread > 0 && <span className="absolute -right-3 -top-3 bg-destructive px-1.5 font-pixel text-[8px] text-destructive-foreground">{unread}</span>}
          </button>
        )}
      </div>

      <Composer
        disabled={!secure || p.sessState === "reconnecting" && !p.session?.isSecure}
        prefs={p.prefs} setPrefs={p.setPrefs}
        reply={reply} clearReply={() => setReply(null)}
        inputRef={inputRef}
        pickerTab={pickerTab} setPickerTab={setPickerTab}
        onTyping={api.setTyping}
        onSend={(text) => { void api.sendMsg({ kind: "text", text, replyTo: reply ?? undefined }); setReply(null); }}
        onSticker={(id, url) => { void api.sendMsg({ kind: "sticker", sticker: id ?? undefined, stickerUrl: url, replyTo: reply ?? undefined }); setReply(null); }}
        onFile={(f, name, kind) => { void api.sendFile(f, name, kind, reply ?? undefined); setReply(null); }}
      />
    </div>
  );
}
