import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Star, Upload, Trash2, Search } from "lucide-react";
import { toast } from "sonner";
import { STICKERS, STICKER_CATEGORIES, stickerSrc } from "@/lib/pixel/stickers";
import { randomId } from "@/lib/pixel/bytes";
import type { Prefs } from "@/lib/pixel/storage";
import { GIPHY_API_KEY } from "@/lib/pixel/env";
import { cn } from "@/lib/utils";
import { Loader } from "./ui";
import { StickerPicker } from "./StickerPicker";

const EmojiPicker = lazy(() => import("emoji-picker-react"));

export type PickerTab = "emoji" | "sticker" | "gif";

export async function resizeImage(file: Blob, max = 160): Promise<string> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

interface Props {
  tab: PickerTab;
  setTab: (t: PickerTab) => void;
  prefs: Prefs;
  setPrefs: (fn: (p: Prefs) => Prefs) => void;
  onEmoji: (e: string) => void;
  onSticker: (id: string | null, url?: string) => void;
  onGif: (blob: Blob, name: string) => void;
  onClose: () => void;
}

export function MediaPicker(p: Props) {
  return (
    <div className={cn("pixel-box animate-pop flex w-full flex-col", p.tab === "sticker" ? "h-[520px] max-h-[70dvh] sm:w-[460px]" : "h-[420px] max-h-[60dvh] sm:w-[380px]")}>
      <div className="flex border-b-4 border-border">
        {(["emoji", "sticker", "gif"] as const).map((t) => (
          <button key={t} data-active={p.tab === t} className="pixel-tab flex-1 py-2 font-pixel text-[9px] uppercase" onClick={() => p.setTab(t)}>{t === "sticker" ? "Stickers" : t === "gif" ? "GIF" : "Emoji"}</button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {p.tab === "emoji" && (
          <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader label="Loading emoji" /></div>}>
            <EmojiPickerWrap onEmoji={p.onEmoji} theme={p.prefs.theme} />
          </Suspense>
        )}
        {p.tab === "sticker" && <StickerPicker prefs={p.prefs} setPrefs={p.setPrefs} onSend={(id) => p.onSticker(id)} classic={<StickerTab {...p} />} />}
        {p.tab === "gif" && <GifTab {...p} />}
      </div>
    </div>
  );
}

function EmojiPickerWrap({ onEmoji, theme }: { onEmoji: (e: string) => void; theme: string }) {
  return (
    <EmojiPicker
      onEmojiClick={(d: any) => onEmoji(d.emoji)}
      // Native emoji glyphs: no images fetched from a CDN.
      emojiStyle={"native" as any}
      theme={(theme === "light" ? "light" : "dark") as any}
      width="100%"
      height="100%"
      lazyLoadEmojis
      previewConfig={{ showPreview: false }}
      skinTonesDisabled={false}
      style={{ borderRadius: 0, border: "none", ["--epr-bg-color" as any]: "var(--bg2)", ["--epr-category-label-bg-color" as any]: "var(--bg2)" }}
    />
  );
}

function StickerTab({ prefs, setPrefs, onSticker }: Props) {
  const [cat, setCat] = useState("cute");
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fav = new Set(prefs.favStickers);
  const toggleFav = (id: string) => setPrefs((p) => ({ ...p, favStickers: fav.has(id) ? p.favStickers.filter((x) => x !== id) : [...p.favStickers, id] }));

  const items: { id: string; src: string; custom?: boolean }[] =
    cat === "custom" ? prefs.customStickers.map((c) => ({ id: c.id, src: c.url, custom: true }))
    : cat === "favorites" ? prefs.favStickers.map((id) => {
        const c = prefs.customStickers.find((x) => x.id === id);
        return c ? { id, src: c.url, custom: true } : { id, src: stickerSrc(id) ?? "" };
      }).filter((x) => x.src)
    : STICKERS.filter((s) => s.cat === cat).map((s) => ({ id: s.id, src: stickerSrc(s.id)! }));

  const upload = async (f: File) => {
    if (!f.type.startsWith("image/")) { toast.error("Choose an image file."); return; }
    try {
      const url = f.type === "image/gif" && f.size < 400_000 ? await blobToDataUrl(f) : await resizeImage(f, 160);
      setPrefs((p) => ({ ...p, customStickers: [...p.customStickers, { id: "c_" + randomId(6), url }] }));
      setCat("custom");
    } catch { toast.error("Couldn't read that image."); }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="pixel-scroll flex gap-1 overflow-x-auto border-b-2 border-border p-2">
        {STICKER_CATEGORIES.map((c) => (
          <button key={c.id} data-active={cat === c.id} className="pixel-tab shrink-0 px-2 py-1 text-xs" onClick={() => setCat(c.id)}>{c.label}</button>
        ))}
      </div>
      <div className="flex h-20 items-center justify-center border-b-2 border-border bg-background/50">
        {preview ? <img src={preview} alt="Sticker preview" className="pixelated h-16 w-16 object-contain" /> : <span className="pixel-label">Hover to preview</span>}
      </div>
      <div className="pixel-scroll grid flex-1 auto-rows-min grid-cols-4 gap-2 overflow-y-auto p-2">
        {cat === "custom" && (
          <button className="pixel-surface flex aspect-square flex-col items-center justify-center gap-1 text-xs text-muted-foreground" onClick={() => fileRef.current?.click()}>
            <Upload size={16} /> Upload
          </button>
        )}
        {items.map((s) => (
          <div key={s.id} className="group relative" onMouseEnter={() => setPreview(s.src)} onFocus={() => setPreview(s.src)}>
            <button className="pixel-surface aspect-square w-full p-1 hover:bg-bg2" onClick={() => s.custom ? onSticker(null, s.src) : onSticker(s.id)} aria-label="Send sticker">
              <img src={s.src} alt="" className="pixelated h-full w-full object-contain" loading="lazy" />
            </button>
            <button className="absolute -right-1 -top-1 bg-background p-0.5" onClick={() => toggleFav(s.id)} aria-label={fav.has(s.id) ? "Remove favourite" : "Add favourite"}>
              <Star size={12} className={cn(fav.has(s.id) ? "fill-secondary text-secondary" : "text-muted-foreground")} />
            </button>
            {s.custom && cat === "custom" && (
              <button className="absolute -left-1 -top-1 bg-background p-0.5 text-destructive" onClick={() => setPrefs((p) => ({ ...p, customStickers: p.customStickers.filter((c) => c.id !== s.id), favStickers: p.favStickers.filter((x) => x !== s.id) }))} aria-label="Delete custom sticker">
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
        {!items.length && cat !== "custom" && <p className="col-span-4 p-4 text-center text-sm text-muted-foreground">No favourites yet — tap ★ on a sticker.</p>}
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
    </div>
  );
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(b); });
}

interface GifResult { id: string; preview: string; full: string; title: string }

function GifTab({ onGif }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GifResult[]>([]);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!GIPHY_API_KEY) return undefined;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const base = q.trim() ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&` : "https://api.giphy.com/v1/gifs/trending?";
        const r = await fetch(`${base}api_key=${encodeURIComponent(GIPHY_API_KEY)}&limit=24&rating=pg-13`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        setResults(j.data.map((g: any) => ({ id: g.id, title: g.title, preview: g.images.fixed_width_small?.url ?? g.images.fixed_width.url, full: g.images.downsized?.url ?? g.images.original.url })));
      } catch { toast.error("GIF search failed."); setResults([]); }
      finally { setLoading(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const sendRemote = async (g: GifResult) => {
    try {
      const b = await (await fetch(g.full)).blob();
      onGif(b, `${g.title || "gif"}.gif`);
    } catch { toast.error("Couldn't download that GIF."); }
  };

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <button className="pixel-btn pixel-btn-sm" onClick={() => fileRef.current?.click()}><Upload size={12} /> Send a GIF from your device</button>
      <input ref={fileRef} type="file" accept="image/gif" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onGif(f, f.name); e.target.value = ""; }} />
      {!GIPHY_API_KEY ? (
        <p className="m-auto text-center text-xs text-muted-foreground">GIF search is currently unavailable.</p>
      ) : (
        <>
          <label className="relative">
            <Search size={14} className="absolute left-3 top-3 text-muted-foreground" />
            <input className="pixel-input pl-8 text-sm" placeholder="Search GIPHY…" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <p className="text-[10px] text-muted-foreground">Searches go to GIPHY (not encrypted). Powered by GIPHY.</p>
          <div className="pixel-scroll grid flex-1 auto-rows-min grid-cols-3 gap-2 overflow-y-auto">
            {loading && <div className="col-span-3 py-6"><Loader label="Searching" /></div>}
            {results.map((g) => (
              <button key={g.id} className="pixel-surface aspect-square overflow-hidden" onClick={() => sendRemote(g)} title={g.title}>
                <img src={g.preview} alt={g.title} className="h-full w-full object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
