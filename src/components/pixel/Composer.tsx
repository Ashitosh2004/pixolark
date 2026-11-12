import { useEffect, useRef, useState } from "react";
import { Send, Smile, Sticker, Paperclip, Mic, Square, X, Image as ImageIcon, FileUp, Camera } from "lucide-react";
import { toast } from "sonner";
import type { Prefs } from "@/lib/pixel/storage";
import { MediaPicker, type PickerTab } from "./MediaPicker";
import { MAX_TEXT, type ReplyRef } from "./types";

type EmojiEntry = { e: string; n: string; t: string[] };
let emojiIndex: EmojiEntry[] | null = null;
async function loadEmojiIndex() {
  if (emojiIndex) return emojiIndex;
  const mod: any = await import("emojibase-data/en/compact.json");
  const data: any[] = mod.default ?? mod;
  emojiIndex = data.filter((d) => d.unicode && d.group !== 2).map((d) => ({ e: d.unicode, n: d.label ?? d.annotation ?? "", t: d.tags ?? [] }));
  return emojiIndex;
}

interface Props {
  disabled: boolean;
  prefs: Prefs;
  setPrefs: (fn: (p: Prefs) => Prefs) => void;
  reply: ReplyRef | null;
  clearReply: () => void;
  onSend: (text: string) => void;
  onSticker: (id: string | null, url?: string) => void;
  onFile: (f: Blob, name: string, kind: "file" | "voice" | "gif") => void;
  onTyping: (on: boolean) => void;
  pickerTab: PickerTab | null;
  setPickerTab: (t: PickerTab | null) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function Composer(p: Props) {
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const [rec, setRec] = useState<{ mr: MediaRecorder; start: number } | null>(null);
  const [recTime, setRecTime] = useState(0);
  const [suggest, setSuggest] = useState<EmojiEntry[]>([]);
  const [sIdx, setSIdx] = useState(0);
  const typingRef = useRef(false);
  const typingTimer = useRef<number>(0);
  const imgRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = p.inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [text, p.inputRef]);

  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => setRecTime(Math.floor((Date.now() - rec.start) / 1000)), 250);
    return () => clearInterval(t);
  }, [rec]);

  const updateSuggest = async (v: string, caret: number) => {
    const m = v.slice(0, caret).match(/:([a-z0-9_+-]{2,})$/i);
    if (!m) { setSuggest([]); return; }
    const q = (m[1] ?? "").toLowerCase();
    const idx = await loadEmojiIndex();
    const res = idx.filter((x) => x.n.toLowerCase().includes(q) || x.t.some((t) => t.startsWith(q))).slice(0, 8);
    setSuggest(res); setSIdx(0);
  };

  const applySuggest = (e: string) => {
    const el = p.inputRef.current!;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/:([a-z0-9_+-]{2,})$/i, e);
    setText(before + text.slice(caret));
    setSuggest([]);
    setTimeout(() => { el.focus(); el.setSelectionRange(before.length, before.length); });
  };

  const insert = (s: string) => {
    const el = p.inputRef.current;
    const pos = el?.selectionStart ?? text.length;
    const next = (text.slice(0, pos) + s + text.slice(pos)).slice(0, MAX_TEXT);
    setText(next);
    setTimeout(() => { el?.focus(); el?.setSelectionRange(pos + s.length, pos + s.length); });
  };

  const typing = (on: boolean) => {
    if (typingRef.current !== on) { typingRef.current = on; p.onTyping(on); }
    window.clearTimeout(typingTimer.current);
    if (on) typingTimer.current = window.setTimeout(() => typing(false), 3000);
  };

  const send = () => {
    const t = text.trim();
    if (!t || p.disabled) return;
    p.onSend(t);
    setText(""); setSuggest([]); typing(false);
  };

  const startRec = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if ((mr as any)._discard) return;
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
        if (blob.size) p.onFile(blob, `voice-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${ext}`, "voice");
      };
      mr.start(250);
      setRec({ mr, start: Date.now() }); setRecTime(0);
    } catch (e: any) {
      toast.error(e?.name === "NotAllowedError" ? "Microphone permission denied. Allow it in your browser settings to record voice messages." : "Couldn't start recording on this device.");
    }
  };
  const stopRec = (discard = false) => { if (!rec) return; (rec.mr as any)._discard = discard; rec.mr.stop(); setRec(null); };

  const pickFiles = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) p.onFile(f, f.name, f.type === "image/gif" ? "gif" : "file");
    setAttach(false);
  };

  return (
    <div className="relative border-t-4 border-border bg-bg2 p-2 sm:p-3" style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}>
      {p.pickerTab && (
        <div className="absolute bottom-full left-0 right-0 z-30 mb-2 px-2 sm:left-3 sm:right-auto">
          <MediaPicker
            tab={p.pickerTab} setTab={(t) => p.setPickerTab(t)} prefs={p.prefs} setPrefs={p.setPrefs}
            onEmoji={insert}
            onSticker={(id, url) => { p.onSticker(id, url); p.setPickerTab(null); }}
            onGif={(b, n) => { p.onFile(b, n, "gif"); p.setPickerTab(null); }}
            onClose={() => p.setPickerTab(null)}
          />
        </div>
      )}
      {attach && (
        <div className="pixel-box animate-pop absolute bottom-full left-2 z-30 mb-2 flex flex-col p-2">
          <button className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface" onClick={() => imgRef.current?.click()}><ImageIcon size={16} /> Photo / video</button>
          <button className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface" onClick={() => camRef.current?.click()}><Camera size={16} /> Take photo</button>
          <button className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-surface" onClick={() => fileRef.current?.click()}><FileUp size={16} /> Document / file</button>
          <span className="px-3 pt-1 text-[10px] text-muted-foreground">Max 250 MB · sent directly, encrypted</span>
        </div>
      )}
      <input ref={imgRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4" multiple className="hidden" onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />
      <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.zip,.mp3,.mp4,image/*,application/pdf,text/plain,application/zip,audio/mpeg,video/mp4" multiple className="hidden" onChange={(e) => { pickFiles(e.target.files); e.target.value = ""; }} />

      {p.reply && (
        <div className="mb-2 flex items-center gap-2 border-l-4 border-secondary bg-surface px-3 py-1.5 text-xs">
          <div className="min-w-0 flex-1"><b>Replying to {p.reply.author}</b><div className="truncate text-muted-foreground">{p.reply.preview}</div></div>
          <button onClick={p.clearReply} aria-label="Cancel reply"><X size={14} /></button>
        </div>
      )}
      {suggest.length > 0 && (
        <div className="pixel-box absolute bottom-full left-14 z-30 mb-2 flex flex-col p-1">
          {suggest.map((s, i) => (
            <button key={s.e + i} className={`flex items-center gap-2 px-2 py-1 text-left text-sm ${i === sIdx ? "bg-surface" : ""}`} onMouseDown={(e) => { e.preventDefault(); applySuggest(s.e); }}>
              <span className="text-lg">{s.e}</span> <span className="text-muted-foreground">:{s.n}</span>
            </button>
          ))}
        </div>
      )}

      {rec ? (
        <div className="flex items-center gap-3">
          <span className="h-3 w-3 animate-blink bg-destructive" />
          <span className="font-pixel text-[10px]">REC {Math.floor(recTime / 60)}:{String(recTime % 60).padStart(2, "0")}</span>
          <div className="flex-1" />
          <button className="pixel-btn pixel-btn-sm" onClick={() => stopRec(true)}><X size={12} /> Discard</button>
          <button className="pixel-btn pixel-btn-sm pixel-btn-primary" onClick={() => stopRec(false)}><Square size={12} /> Send</button>
        </div>
      ) : (
        <div className="flex items-end gap-2 sm:gap-3">
          <div className="flex gap-1.5 sm:gap-2">
            <button className="pixel-btn pixel-icon-btn" aria-label="Emoji (Ctrl+E)" disabled={p.disabled} onClick={() => p.setPickerTab(p.pickerTab === "emoji" ? null : "emoji")}><Smile size={16} /></button>
            <button className="pixel-btn pixel-icon-btn hidden sm:inline-flex" aria-label="Stickers" disabled={p.disabled} onClick={() => p.setPickerTab(p.pickerTab === "sticker" ? null : "sticker")}><Sticker size={16} /></button>
            <button className="pixel-btn pixel-icon-btn hidden font-pixel !text-[8px] sm:inline-flex" aria-label="GIFs" disabled={p.disabled} onClick={() => p.setPickerTab(p.pickerTab === "gif" ? null : "gif")}>GIF</button>
            <button className="pixel-btn pixel-icon-btn" aria-label="Attach" disabled={p.disabled} onClick={() => setAttach((v) => !v)}><Paperclip size={16} /></button>
          </div>
          <div className="relative min-w-0 flex-1">
            <textarea
              ref={p.inputRef}
              rows={1}
              className="pixel-input pixel-scroll block max-h-40 resize-none text-[15px]"
              placeholder={p.disabled ? "Not connected" : "Type a message… (:smile for emoji)"}
              value={text}
              disabled={p.disabled}
              maxLength={MAX_TEXT}
              onChange={(e) => { setText(e.target.value); typing(e.target.value.length > 0); void updateSuggest(e.target.value, e.target.selectionStart); }}
              onKeyDown={(e) => {
                if (suggest.length) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setSIdx((i) => (i + 1) % suggest.length); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setSIdx((i) => (i - 1 + suggest.length) % suggest.length); return; }
                  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applySuggest(suggest[sIdx]!.e); return; }
                  if (e.key === "Escape") { setSuggest([]); return; }
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
              }}
              onFocus={() => setAttach(false)}
            />
            {text.length > MAX_TEXT * 0.8 && <span className="absolute -top-5 right-1 text-[10px] text-muted-foreground">{text.length}/{MAX_TEXT}</span>}
          </div>
          {text.trim() ? (
            <button className="pixel-btn pixel-btn-primary pixel-icon-btn" aria-label="Send" onClick={send} disabled={p.disabled}><Send size={16} /></button>
          ) : (
            <button className="pixel-btn pixel-btn-gold pixel-icon-btn" aria-label="Record voice message" onClick={startRec} disabled={p.disabled}><Mic size={16} /></button>
          )}
        </div>
      )}
      <div className="mt-1 hidden justify-between text-[10px] text-muted-foreground sm:flex">
        <span>Enter to send · Shift+Enter new line</span>
        <span>{text.length}/{MAX_TEXT}</span>
      </div>
    </div>
  );
}
