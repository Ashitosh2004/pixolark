/**
 * GroupView — the group chat screen. Deliberately mirrors ChatView's layout and
 * reuses MessageBubble + Composer unchanged so 1:1 and groups behave identically.
 * Group-specific: member panel, rules, awaiting-approval and moderation banners,
 * and pin/edit/delete actions that propagate through the room's sender-key crypto.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Users, Search, LogOut, ArrowDown, X, Bell, BellOff, Pencil, AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";
import type { GroupSession } from "@/lib/pixel/group";
import type { Prefs } from "@/lib/pixel/storage";
import { isRoomMuted, setRoomMuted } from "@/lib/pixel/storage";
import { cn } from "@/lib/utils";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import { MemberPanel } from "./MemberPanel";
import type { PickerTab } from "./MediaPicker";
import type { GroupApi } from "./useGroup";
import { previewOf, type ChatMessage, type ReplyRef } from "./types";
import { Modal } from "./ui";

interface Props {
  group: GroupSession;
  api: GroupApi;
  prefs: Prefs;
  setPrefs: (fn: (p: Prefs) => Prefs) => void;
  muted: boolean;
  onLeave: () => void;
  onBack: () => void;
}

function dayLabel(ts: number) {
  const d = new Date(ts), t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() !== t.getFullYear() ? "numeric" : undefined });
}

export function GroupView(p: Props) {
  const { group, api } = p;
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const [reply, setReply] = useState<ReplyRef | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pickerTab, setPickerTab] = useState<PickerTab | null>(null);
  const [members, setMembers] = useState(false);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [editText, setEditText] = useState("");
  const [roomMutedOn, setRoomMutedOn] = useState(() => isRoomMuted(group.room));
  const lastCount = useRef(api.messages.length);
  const meta = api.snap?.meta;
  const secure = group.isSecure();

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

  // Read receipts when visible and at the bottom.
  useEffect(() => {
    const go = () => { if (atBottom && document.visibilityState === "visible" && document.hasFocus()) api.markRead(); };
    go();
    window.addEventListener("focus", go);
    document.addEventListener("visibilitychange", go);
    return () => { window.removeEventListener("focus", go); document.removeEventListener("visibilitychange", go); };
  }, [atBottom, api]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); setSearch((s) => (s === null ? "" : null)); }
      else if (e.key === "Escape") { setPickerTab(null); setReply(null); setSelectMode(false); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

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

  const pinnedMessages = useMemo(
    () => api.messages.filter((m) => api.snap?.pinned.some((pp) => pp.id === m.id)),
    [api.messages, api.snap],
  );

  const typingNames = useMemo(
    () => Object.entries(api.presence)
      .filter(([id, s]) => s.typing && s.online && id !== group.myId)
      .map(([id]) => api.snap?.roster.find((r) => r.id === id)?.name ?? "Someone"),
    [api.presence, api.snap, group.myId],
  );

  const doReply = useCallback((m: ChatMessage) => {
    setReply({ id: m.id, author: m.from === "me" ? "You" : m.senderName ?? "Member", preview: previewOf(m) });
    inputRef.current?.focus();
  }, []);
  const doCopy = useCallback(async (m: ChatMessage) => { try { await navigator.clipboard.writeText(m.text ?? previewOf(m)); toast("Copied"); } catch { toast.error("Clipboard unavailable"); } }, []);
  const doPin = useCallback((id: string) => {
    const on = !api.snap?.pinned.some((pp) => pp.id === id);
    api.pinMessage(id, on);
    toast(on ? "Pin request sent" : "Unpin request sent");
  }, [api]);
  const doDeleteLocal = useCallback((id: string) => {
    // Local-only removal from this device's view; other members keep their copy.
    api.hideMessage(id);
  }, [api]);
  const doDeleteAll = useCallback((id: string) => { void api.deleteMessage(id); }, [api]);
  const doEdit = useCallback((m: ChatMessage) => { setEditing(m); setEditText(m.text ?? ""); }, []);
  const submitEdit = useCallback(async () => {
    if (!editing) return;
    await api.editMessage(editing.id, editText);
    setEditing(null);
  }, [api, editing, editText]);
  const toggleSel = useCallback((id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const doForwardStart = useCallback((m: ChatMessage) => { setSelectMode(true); setSelected(new Set([m.id])); }, []);
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

  const statusText = api.stopReason ? "removed from this room"
    : api.phase === "awaiting" ? "waiting for approval…"
    : api.phase === "reconnecting" ? "reconnecting…"
    : api.phase === "closed" ? "room closed"
    : api.phase === "failed" ? (api.error ?? "connection stopped")
    : secure ? `${api.onlineCount} online · ${api.snap?.roster.length ?? 0} members`
    : "connecting…";

  const roomMuteToggle = () => {
    const next = !roomMutedOn;
    setRoomMutedOn(next);
    setRoomMuted(group.room, "group", meta?.name ?? "Group", next);
    toast(next ? "Notifications muted for this room" : "Notifications unmuted for this room");
  };

  let lastDay = "";
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-2 border-b-4 border-border bg-bg2 px-2 py-2 sm:px-4">
        <button className="pixel-btn pixel-icon-btn md:hidden" onClick={p.onBack} aria-label="Back to hub">←</button>
        <a href="/" className="hidden font-pixel text-[10px] text-primary md:block">PIXO<span className="text-secondary">LARK</span></a>
        <div className="pixel-surface flex h-9 w-9 shrink-0 items-center justify-center bg-primary/20"><Users size={18} className="text-primary" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{meta?.name ?? "Group"}</span>
            {roomMutedOn && <BellOff size={12} className="text-muted-foreground" />}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn("truncate", typingNames.length > 0 && "text-primary")}>{typingNames.length ? `${typingNames.join(", ")} typing…` : statusText}</span>
          </div>
        </div>
        <button className="pixel-btn pixel-btn-sm" onClick={() => setMembers(true)} title="Members & moderation"><Users size={12} /> Members</button>
        <button className="pixel-btn pixel-icon-btn" onClick={roomMuteToggle} aria-label="Mute notifications for this room">{roomMutedOn ? <BellOff size={14} /> : <Bell size={14} />}</button>
        <button className="pixel-btn pixel-icon-btn hidden sm:inline-flex" onClick={() => setSearch((s) => (s === null ? "" : null))} aria-label="Search (Ctrl+K)"><Search size={14} /></button>
        <button className="pixel-btn pixel-icon-btn pixel-btn-danger" onClick={p.onLeave} aria-label="Leave group"><LogOut size={14} /></button>
      </header>

      {/* State banners */}
      {api.stopReason && (
        <div className="flex items-center justify-center gap-2 bg-destructive px-3 py-2 text-sm text-destructive-foreground">
          <AlertTriangle size={14} /> {api.stopReason}
        </div>
      )}
      {!api.stopReason && api.phase === "awaiting" && (
        <div className="flex items-center justify-center gap-2 bg-secondary px-3 py-2 text-sm text-secondary-foreground">
          <Clock size={14} /> Waiting for the group owner or an admin to approve your join request.
        </div>
      )}
      {!api.stopReason && (api.phase === "reconnecting" || api.phase === "failed") && (
        <div className={cn("flex items-center justify-center gap-2 px-3 py-2 text-sm", api.phase === "failed" ? "bg-destructive text-destructive-foreground" : "bg-secondary text-secondary-foreground")}>
          <AlertTriangle size={14} /> {api.error ?? "Connection unstable — trying to recover…"}
        </div>
      )}

      {search !== null && (
        <div className="flex items-center gap-2 border-b-2 border-border bg-bg2 px-3 py-2">
          <Search size={14} className="text-muted-foreground" />
          <input autoFocus className="pixel-input text-sm" placeholder="Search this room…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <span className="shrink-0 text-xs text-muted-foreground">{shown.length} found</span>
          <button onClick={() => setSearch(null)} aria-label="Close search"><X size={16} /></button>
        </div>
      )}
      {pinnedMessages.length > 0 && search === null && (
        <button className="flex items-center gap-2 border-b-2 border-border bg-bg2 px-3 py-1.5 text-left text-xs" onClick={() => jump(pinnedMessages[pinnedMessages.length - 1]!.id)}>
          <span className="pixel-label shrink-0 text-secondary">📌 Pinned ({pinnedMessages.length})</span>
          <span className="truncate">{previewOf(pinnedMessages[pinnedMessages.length - 1]!)}</span>
        </button>
      )}
      {selectMode && (
        <div className="flex items-center gap-2 border-b-2 border-border bg-surface px-3 py-2 text-sm">
          <span className="flex-1">{selected.size} selected</span>
          <button className="pixel-btn pixel-btn-sm pixel-btn-primary" disabled={!selected.size || !secure} onClick={forwardSelected}>Forward</button>
          <button className="pixel-btn pixel-btn-sm" disabled={!selected.size} onClick={() => { setSelectMode(false); setSelected(new Set()); }}><X size={12} /></button>
        </div>
      )}

      {/* Messages */}
      <div className="relative min-h-0 flex-1">
        <div ref={listRef} onScroll={onScroll} className="pixel-scroll h-full overflow-y-auto px-3 py-4 sm:px-6" onClick={() => setPickerTab(null)}>
          {api.messages.length === 0 && (
            <div className="mx-auto mt-10 max-w-sm text-center">
              <div className="font-pixel text-[10px] text-primary">🔒 Encrypted room</div>
              <p className="mt-3 text-sm text-muted-foreground">
                Say hi! Everything here is end-to-end encrypted with rotating group keys.
                {meta?.isPublic ? " This room is listed in Discover." : " This room is private — invite people with its join code."}
              </p>
            </div>
          )}
          {shown.map((m) => {
            const d = dayLabel(m.ts);
            const sep = d !== lastDay; lastDay = d;
            return (
              <div key={m.id}>
                {sep && <div className="my-4 flex items-center gap-3"><div className="h-1 flex-1 bg-surface" /><span className="pixel-label">{d}</span><div className="h-1 flex-1 bg-surface" /></div>}
                <MessageBubble
                  m={m} peerName={meta?.name ?? "Group"} selectMode={selectMode} selected={selected.has(m.id)} highlight={search ?? undefined}
                  onSelect={toggleSel} onReply={doReply} onReact={api.react} onCopy={doCopy} onPin={doPin}
                  onDelete={doDeleteLocal} onDeleteAll={doDeleteAll} onEdit={doEdit}
                  onForward={doForwardStart}
                  onCancel={api.cancelTransfer} onJump={jump}
                />
              </div>
            );
          })}
          {typingNames.length > 0 && (
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
        disabled={!secure}
        prefs={p.prefs} setPrefs={p.setPrefs}
        reply={reply} clearReply={() => setReply(null)}
        inputRef={inputRef}
        pickerTab={pickerTab} setPickerTab={setPickerTab}
        onTyping={api.setTyping}
        onSend={(text) => { void api.sendMsg({ kind: "text", text, replyTo: reply ?? undefined }); setReply(null); }}
        onSticker={(id, url) => { void api.sendMsg({ kind: "sticker", sticker: id ?? undefined, stickerUrl: url, replyTo: reply ?? undefined }); setReply(null); }}
        onFile={(f, name, kind) => { void api.sendFile(f, name, kind, reply ?? undefined); setReply(null); }}
      />

      <MemberPanel open={members} onClose={() => setMembers(false)} group={group} api={api} />

      <Modal open={!!editing} onClose={() => setEditing(null)} title="Edit message">
        <div className="flex flex-col gap-3">
          <textarea
            autoFocus className="pixel-input min-h-24" value={editText} maxLength={4000}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submitEdit(); }}
          />
          <div className="flex justify-end gap-2">
            <button className="pixel-btn" onClick={() => setEditing(null)}>Cancel</button>
            <button className="pixel-btn pixel-btn-primary" disabled={!editText.trim() || editText === editing?.text} onClick={() => void submitEdit()}>
              <Pencil size={12} /> Save edit
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
