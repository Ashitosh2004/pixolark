import { memo, useState } from "react";
import { Reply, Copy, Pin, Trash2, Forward, Download, X, SmilePlus, Check, CheckCheck, Clock, AlertTriangle, FileText, Pencil } from "lucide-react";
import { formatBytes } from "@/lib/pixel/bytes";
import { stickerSrc } from "@/lib/pixel/stickers";
import { isLibStickerId } from "@/lib/pixel/stickerlib";
import { StickerImg } from "./StickerImg";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "./types";

const QUICK = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

interface Props {
  m: ChatMessage;
  peerName: string;
  selectMode: boolean;
  selected: boolean;
  highlight?: string | undefined;
  onSelect: (id: string) => void;
  onReply: (m: ChatMessage) => void;
  onReact: (id: string, e: string) => void;
  onCopy: (m: ChatMessage) => void;
  onPin: (id: string) => void;
  onDelete: (id: string) => void;
  onForward: (m: ChatMessage) => void;
  onCancel: (id: string) => void;
  onJump: (id: string) => void;
  /** Groups only: edit/delete propagate to everyone via the room's encryption. */
  onEdit?: (m: ChatMessage) => void;
  onDeleteAll?: (id: string) => void;
}

function Hl({ text, q }: { text: string; q?: string | undefined }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark className="bg-secondary text-secondary-foreground">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

function Linkify({ text, q }: { text: string; q?: string | undefined }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return <>{parts.map((p, i) => /^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" className="underline">{p}</a> : <Hl key={i} text={p} q={q} />)}</>;
}

function Status({ s }: { s?: ChatMessage["status"] }) {
  if (s === "sending") return <Clock size={11} aria-label="sending" />;
  if (s === "sent") return <Check size={12} aria-label="sent" />;
  if (s === "delivered") return <CheckCheck size={12} aria-label="delivered" />;
  if (s === "read") return <CheckCheck size={12} className="text-secondary" aria-label="read" />;
  if (s === "failed") return <AlertTriangle size={12} className="text-destructive" aria-label="failed" />;
  return null;
}

function FileBody({ m, onCancel }: { m: ChatMessage; onCancel: (id: string) => void }) {
  const f = m.file!;
  const active = f.status === "sending" || f.status === "receiving";
  const isImg = f.mime.startsWith("image/");
  const isVid = f.mime.startsWith("video/");
  const isAud = f.mime.startsWith("audio/") || m.kind === "voice";
  return (
    <div className="flex min-w-[200px] max-w-[300px] flex-col gap-2">
      {f.url && f.status !== "failed" && f.status !== "cancelled" && (f.status === "done" || m.from === "me") && (
        isImg ? <a href={f.url} target="_blank" rel="noreferrer"><img src={f.url} alt={f.name} className="max-h-64 w-full object-contain" loading="lazy" /></a>
        : isVid ? <video src={f.url} controls className="max-h-64 w-full" />
        : isAud ? <audio src={f.url} controls className="w-full" />
        : null
      )}
      {!(isImg && f.status === "done") && m.kind !== "voice" && (
        <div className="flex items-center gap-2">
          <FileText size={18} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{f.name}</div>
            <div className="text-xs opacity-75">{formatBytes(f.size)}</div>
          </div>
        </div>
      )}
      {active && (
        <div className="flex items-center gap-2">
          <div className="h-2 flex-1 bg-pixel-dark/40"><div className="h-full bg-secondary" style={{ width: `${Math.round(f.progress * 100)}%` }} /></div>
          <span className="text-[10px]">{Math.round(f.progress * 100)}%</span>
          <button className="pixel-btn pixel-btn-sm pixel-icon-btn !min-h-6 !min-w-6 !p-1" onClick={() => onCancel(m.id)} aria-label="Cancel transfer"><X size={10} /></button>
        </div>
      )}
      {f.status === "cancelled" && <span className="text-xs opacity-75">Transfer cancelled</span>}
      {f.status === "failed" && <span className="text-xs opacity-75">Transfer interrupted</span>}
      {f.status === "done" && f.url && (
        <a href={f.url} download={f.name} className="inline-flex items-center gap-1 text-xs underline"><Download size={12} /> Download</a>
      )}
      {!f.url && f.status === "done" && <span className="text-xs opacity-75">File not kept in saved history</span>}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble(p: Props) {
  const { m } = p;
  const [menu, setMenu] = useState(false);
  if (m.kind === "system") {
    return <div className="my-2 text-center"><span className="pixel-label bg-bg2 px-2 py-1">{m.text}</span></div>;
  }
  const mine = m.from === "me";
  const time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const isSticker = m.kind === "sticker";
  return (
    <div id={`msg-${m.id}`} className={cn("group flex items-end gap-2 py-1", mine ? "flex-row-reverse" : "flex-row")} onClick={() => p.selectMode && p.onSelect(m.id)}>
      {p.selectMode && <input type="checkbox" checked={p.selected} readOnly className="h-4 w-4 accent-primary" aria-label="Select message" />}
      <div className={cn("flex max-w-[85%] flex-col sm:max-w-[70%]", mine ? "items-end" : "items-start")}>
        {!mine && m.senderName && <div className="mb-0.5 pl-1 text-[10px] font-semibold text-muted-foreground">{m.senderName}</div>}
        <div className={cn(isSticker ? "" : "bubble px-3 py-2", !isSticker && (mine ? "bubble-me" : "bubble-peer"), m.pinned && "outline-2 outline-secondary outline-offset-4")}>
          {m.deleted ? (
            <p className="text-[13px] italic opacity-70">Message deleted</p>
          ) : (
            <>
              {m.forwarded && <div className="mb-1 flex items-center gap-1 text-[10px] opacity-70"><Forward size={10} /> Forwarded</div>}
              {m.replyTo && (
                <button className="mb-2 block w-full border-l-4 border-secondary bg-pixel-dark/20 px-2 py-1 text-left text-xs" onClick={(e) => { e.stopPropagation(); p.onJump(m.replyTo!.id); }}>
                  <div className="font-semibold">{m.replyTo.author}</div>
                  <div className="truncate opacity-80">{m.replyTo.preview}</div>
                </button>
              )}
              {m.kind === "text" && <p className="whitespace-pre-wrap break-words text-[15px] leading-snug"><Linkify text={m.text ?? ""} q={p.highlight} />{m.edited && <span className="ml-1 align-middle text-[10px] opacity-60">(edited)</span>}</p>}
              {isSticker && isLibStickerId(m.sticker) && <StickerImg id={m.sticker} alt="Animated sticker" size={120} />}
              {isSticker && !isLibStickerId(m.sticker) && <img src={m.stickerUrl ?? stickerSrc(m.sticker ?? "") ?? ""} alt="sticker" width={120} height={120} className="pixelated h-[120px] w-[120px] object-contain" />}
              {m.file && <FileBody m={m} onCancel={p.onCancel} />}
            </>
          )}
        </div>
        {Object.keys(m.reactions).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {Object.entries(m.reactions).map(([e, who]) => (
              <button key={e} onClick={() => p.onReact(m.id, e)} className={cn("pixel-surface px-1.5 text-sm", who.includes("me") && "bg-primary/30")}>{e}{who.length > 1 ? ` ${who.length}` : ""}</button>
            ))}
          </div>
        )}
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
          {m.pinned && <Pin size={10} className="text-secondary" />}
          <span>{time}</span>
          {mine && <Status s={m.status} />}
        </div>
      </div>
      {!p.selectMode && (
        <div className="relative self-center">
          <button className="pixel-btn pixel-btn-sm pixel-icon-btn !min-h-7 !min-w-7 !p-1 opacity-60 transition-opacity group-hover:opacity-100 sm:opacity-0" onClick={() => setMenu((v) => !v)} aria-label="Message actions">
            <SmilePlus size={12} />
          </button>
          {menu && (
            <div className={cn("pixel-box animate-pop absolute bottom-10 z-20 flex w-52 flex-col p-2", mine ? "right-0" : "left-0")} onMouseLeave={() => setMenu(false)}>
              <div className="mb-2 flex justify-between">
                {QUICK.map((e) => <button key={e} className="p-1 text-lg hover:scale-125" onClick={() => { p.onReact(m.id, e); setMenu(false); }}>{e}</button>)}
              </div>
              {[
                { i: Reply, l: "Reply", f: () => p.onReply(m) },
                { i: Copy, l: "Copy", f: () => p.onCopy(m) },
                ...(p.onEdit && mine && m.kind === "text" && !m.deleted ? [{ i: Pencil, l: "Edit", f: () => p.onEdit!(m) }] : []),
                { i: Pin, l: m.pinned ? "Unpin (local)" : "Pin (local)", f: () => p.onPin(m.id) },
                { i: Forward, l: "Forward / select", f: () => p.onForward(m) },
                ...(p.onDeleteAll && mine && !m.deleted ? [{ i: Trash2, l: "Delete for everyone", f: () => p.onDeleteAll!(m.id) }] : []),
                { i: Trash2, l: "Delete for me", f: () => p.onDelete(m.id) },
              ].map((a) => (
                <button key={a.l} className="flex items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-surface" onClick={() => { a.f(); setMenu(false); }}>
                  <a.i size={14} /> {a.l}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
