import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BarChart3, Check, Clock, Download, FolderPlus, Package, Plus, Search, Send, Star, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { autocomplete, loadLibrary, searchStickers, type Library, type LibSticker } from "@/lib/pixel/stickerlib";
import { randomId } from "@/lib/pixel/bytes";
import type { Prefs } from "@/lib/pixel/storage";
import { cn } from "@/lib/utils";
import { Loader } from "./ui";
import { StickerImg } from "./StickerImg";

type View = { k: "recent" } | { k: "favs" } | { k: "packs" } | { k: "pack"; id: string } | { k: "user"; id: string } | { k: "cat"; id: string } | { k: "classic" };
const POPULAR = ["love", "hug", "cry", "laugh", "angry", "cute cat", "good night", "best friend", "birthday", "missing you"];
const MAX_ANIMATED = 24;

interface Props { prefs: Prefs; setPrefs: (fn: (p: Prefs) => Prefs) => void; onSend: (id: string) => void; classic: ReactNode }

export function StickerPicker({ prefs, setPrefs, onSend, classic }: Props) {
  const [lib, setLib] = useState<Library | null>(null);
  const [err, setErr] = useState(false);
  const [view, setView] = useState<View>(() => (prefs.recentStickers.length ? { k: "recent" } : { k: "cat", id: "love" }));
  const [q, setQ] = useState("");
  const [focusSearch, setFocusSearch] = useState(false);
  const [sel, setSel] = useState<LibSticker | null>(null);
  const [collMenu, setCollMenu] = useState(false);
  const [newColl, setNewColl] = useState("");
  useEffect(() => { loadLibrary().then(setLib, () => setErr(true)); }, []);

  const favs = useMemo(() => new Set(prefs.favStickers), [prefs.favStickers]);
  const rm = prefs.reduceMotion;
  const toggleFav = (id: string) => setPrefs((p) => ({ ...p, favStickers: p.favStickers.includes(id) ? p.favStickers.filter((x) => x !== id) : [...p.favStickers, id] }));
  const send = (s: LibSticker) => {
    setPrefs((p) => ({ ...p, recentStickers: [s.id, ...p.recentStickers.filter((x) => x !== s.id)].slice(0, 40), stickerUsage: { ...p.stickerUsage, [s.id]: (p.stickerUsage[s.id] ?? 0) + 1 }, stickerSearches: q.trim() ? [q.trim(), ...p.stickerSearches.filter((x) => x !== q.trim())].slice(0, 8) : p.stickerSearches }));
    onSend(s.id);
  };

  const list: LibSticker[] = useMemo(() => {
    if (!lib) return [];
    const pick = (ids: string[]) => ids.map((id) => lib.byId.get(id)).filter((x): x is LibSticker => !!x);
    if (q.trim()) return searchStickers(lib, q, prefs.stickerUsage);
    switch (view.k) {
      case "recent": { const freq = Object.entries(prefs.stickerUsage).sort((a, b) => b[1] - a[1]).map(([id]) => id).filter((id) => !prefs.recentStickers.includes(id)).slice(0, 16); return pick([...prefs.recentStickers, ...freq]); }
      case "favs": return pick(prefs.favStickers);
      case "pack": return lib.stickers.filter((s) => s.packs.includes(view.id));
      case "user": return pick(prefs.userPacks.find((u) => u.id === view.id)?.ids ?? []);
      case "cat": return lib.stickers.filter((s) => s.category === view.id);
      default: return [];
    }
  }, [lib, q, view, prefs.stickerUsage, prefs.recentStickers, prefs.favStickers, prefs.userPacks]);

  const sugg = lib && q ? autocomplete(lib.vocab, q) : [];
  const catLabel = (id: string) => lib?.categories.find((c) => c.id === id);
  const tab = (active: boolean, onClick: () => void, children: ReactNode, label?: string) => (
    <button data-active={active} aria-label={label} aria-pressed={active} className="pixel-tab flex shrink-0 snap-start items-center gap-1 whitespace-nowrap px-2 py-1 text-xs" onClick={() => { setQ(""); onClick(); }}>{children}</button>
  );
  const isList = !q && view.k !== "packs" && view.k !== "classic";

  return (
    <div className="flex h-full flex-col">
      {/* search */}
      <div className="relative border-b-2 border-border p-2">
        <label className="relative block">
          <Search size={14} className="absolute left-3 top-3 text-muted-foreground" />
          <input className="pixel-input pl-8 pr-8 text-sm" placeholder="Search 1,000+ stickers…" value={q} aria-label="Search stickers"
            onChange={(e) => setQ(e.target.value)} onFocus={() => setFocusSearch(true)} onBlur={() => setTimeout(() => setFocusSearch(false), 150)}
            onKeyDown={(e) => { if (e.key === "Tab" && sugg[0]) { e.preventDefault(); setQ(q.replace(/\S*$/, sugg[0])); } }} />
          {q && <button className="absolute right-2 top-2.5 text-muted-foreground" onClick={() => setQ("")} aria-label="Clear search"><X size={14} /></button>}
        </label>
        {(sugg.length > 0 || (focusSearch && !q)) && (
          <div className="pixel-scroll mt-2 flex gap-1 overflow-x-auto" role="listbox" aria-label="Search suggestions">
            {(q ? sugg : [...prefs.stickerSearches.map((s) => "⏱ " + s), ...POPULAR]).slice(0, 12).map((s) => (
              <button key={s} role="option" aria-selected={false} className="pixel-surface shrink-0 px-2 py-0.5 text-[11px]" onMouseDown={(e) => { e.preventDefault(); const v = s.replace(/^⏱ /, ""); setQ(q ? q.replace(/\S*$/, v) : v); }}>{s}</button>
            ))}
          </div>
        )}
      </div>
      {/* top nav */}
      <div className="pixel-scroll flex snap-x gap-1 overflow-x-auto border-b-2 border-border px-2 py-1.5">
        {tab(view.k === "recent", () => setView({ k: "recent" }), <><Clock size={12} /> Recent</>)}
        {tab(view.k === "favs", () => setView({ k: "favs" }), <><Star size={12} /> Favs</>)}
        {tab(view.k === "packs", () => setView({ k: "packs" }), <><Package size={12} /> Packs</>)}
        {lib && prefs.installedPacks.map((id) => { const pk = lib.packs.find((p) => p.id === id); return pk ? <span key={id}>{tab(view.k === "pack" && view.id === id, () => setView({ k: "pack", id }), <><Download size={11} /> {pk.name}</>)}</span> : null; })}
        {prefs.userPacks.map((u) => <span key={u.id}>{tab(view.k === "user" && view.id === u.id, () => setView({ k: "user", id: u.id }), <><FolderPlus size={11} /> {u.name}</>)}</span>)}
        {tab(view.k === "classic", () => setView({ k: "classic" }), <>Classic & custom</>)}
      </div>
      {/* categories (swipeable) */}
      <div className="pixel-scroll flex snap-x gap-1 overflow-x-auto border-b-2 border-border px-2 py-1.5" aria-label="Sticker categories">
        {(lib?.categories ?? []).map((c) => <span key={c.id}>{tab(view.k === "cat" && view.id === c.id, () => setView({ k: "cat", id: c.id }), <><span aria-hidden>{c.icon}</span> {c.label}</>)}</span>)}
      </div>
      {/* preview */}
      {sel && (isList || q) && (
        <div className="relative flex items-center gap-3 border-b-2 border-border bg-background/50 p-2">
          <StickerImg id={sel.id} alt={sel.name} size={72} reduceMotion={rm} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{sel.name}</div>
            <div className="pixel-label mt-1">{catLabel(sel.category)?.icon} {catLabel(sel.category)?.label} · {sel.frames}f · {sel.fps}fps</div>
            <div className="mt-2 flex flex-wrap gap-1">
              <button className="pixel-btn pixel-btn-sm pixel-btn-primary" onClick={() => send(sel)}><Send size={12} /> Send</button>
              <button className="pixel-btn pixel-btn-sm" onClick={() => toggleFav(sel.id)} aria-label={favs.has(sel.id) ? "Remove favourite" : "Add favourite"}><Star size={12} className={cn(favs.has(sel.id) && "fill-secondary text-secondary")} /></button>
              <button className="pixel-btn pixel-btn-sm" onClick={() => setCollMenu((v) => !v)} aria-label="Add to collection"><FolderPlus size={12} /></button>
            </div>
          </div>
          <button className="absolute right-1 top-1 text-muted-foreground" onClick={() => setSel(null)} aria-label="Close preview"><X size={14} /></button>
          {collMenu && (
            <div className="pixel-box absolute right-2 top-full z-10 mt-1 flex w-56 flex-col gap-1 p-2 text-xs">
              {prefs.userPacks.map((u) => { const has = u.ids.includes(sel.id); return (
                <button key={u.id} className="flex items-center gap-2 px-1 py-1 text-left hover:bg-surface" onClick={() => setPrefs((p) => ({ ...p, userPacks: p.userPacks.map((x) => x.id === u.id ? { ...x, ids: has ? x.ids.filter((i) => i !== sel.id) : [...x.ids, sel.id] } : x) }))}>
                  {has ? <Check size={12} className="text-primary" /> : <Plus size={12} />} {u.name}
                </button>); })}
              <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); const n = newColl.trim().slice(0, 24); if (!n) return; setPrefs((p) => ({ ...p, userPacks: [...p.userPacks, { id: "u_" + randomId(6), name: n, ids: [sel.id] }] })); setNewColl(""); setCollMenu(false); toast.success(`Added to “${n}”`); }}>
                <input className="pixel-input !py-1 text-xs" placeholder="New collection" value={newColl} onChange={(e) => setNewColl(e.target.value)} />
                <button className="pixel-btn pixel-btn-sm" aria-label="Create collection"><Plus size={12} /></button>
              </form>
            </div>
          )}
        </div>
      )}
      {/* main */}
      <div className="min-h-0 flex-1">
        {err ? <p className="p-4 text-center text-sm text-destructive">Couldn't load the sticker library.</p>
          : !lib ? <div className="flex h-full items-center justify-center"><Loader label="Loading stickers" /></div>
          : view.k === "classic" && !q ? classic
          : view.k === "packs" && !q ? <PacksView lib={lib} prefs={prefs} setPrefs={setPrefs} open={(id) => setView({ k: "pack", id })} />
          : (
            <div className="flex h-full flex-col">
              {view.k === "pack" && !q && <PackHeader lib={lib} id={view.id} prefs={prefs} setPrefs={setPrefs} back={() => setView({ k: "packs" })} />}
              {view.k === "user" && !q && (
                <div className="flex items-center justify-between px-2 pt-2 text-xs">
                  <span className="pixel-label">Your collection</span>
                  <button className="flex items-center gap-1 text-destructive" onClick={() => { setPrefs((p) => ({ ...p, userPacks: p.userPacks.filter((u) => u.id !== view.id) })); setView({ k: "recent" }); }}><Trash2 size={12} /> Delete</button>
                </div>
              )}
              {list.length === 0 ? <Empty q={q} view={view} /> : (
                <VirtualGrid items={list} favs={favs} rm={rm} selected={sel?.id} label={q ? `Results for ${q}` : "Stickers"}
                  onPick={(s) => { setSel(s); setCollMenu(false); }} onSend={send} onFav={toggleFav} catIcon={(c) => catLabel(c)?.icon ?? ""} showCat={!!q || view.k !== "cat"} />
              )}
            </div>
          )}
      </div>
      {/* bottom quick access */}
      {lib && view.k !== "recent" && prefs.recentStickers.length > 0 && (
        <div className="pixel-scroll flex items-center gap-1 overflow-x-auto border-t-2 border-border px-2 py-1" aria-label="Recently used stickers">
          <Clock size={12} className="shrink-0 text-muted-foreground" />
          {prefs.recentStickers.slice(0, 10).map((id) => { const s = lib.byId.get(id); return s ? (
            <button key={id} className="shrink-0 hover:bg-surface" onClick={() => send(s)} aria-label={`Send ${s.name}`}><StickerImg id={id} alt="" size={32} animate={false} /></button>) : null; })}
        </div>
      )}
    </div>
  );
}

function Empty({ q, view }: { q: string; view: View }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
      <img src="/stickers/memes/072.png" alt="" width={64} height={64} className="pixelated opacity-80" />
      {q ? <>No stickers match “{q}”. Try “hug”, “cry” or “birthday”.</> : view.k === "favs" ? "No favourites yet — tap ★ on a sticker." : view.k === "recent" ? "Stickers you send will show up here." : "This collection is empty."}
    </div>
  );
}

function VirtualGrid({ items, favs, rm, selected, onPick, onSend, onFav, catIcon, showCat, label }: { items: LibSticker[]; favs: Set<string>; rm: boolean; selected?: string | undefined; onPick: (s: LibSticker) => void; onSend: (s: LibSticker) => void; onFav: (id: string) => void; catIcon: (c: string) => string; showCat: boolean; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(360), [h, setH] = useState(300), [top, setTop] = useState(0), [focus, setFocus] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => { setW(el.clientWidth); setH(el.clientHeight); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  useEffect(() => { ref.current?.scrollTo({ top: 0 }); setTop(0); setFocus(0); }, [items]);
  const cols = Math.max(4, Math.floor((w - 8) / 78)), cell = (w - 8) / cols;
  const rows = Math.ceil(items.length / cols);
  const r0 = Math.max(0, Math.floor(top / cell) - 2), r1 = Math.min(rows, Math.ceil((top + h) / cell) + 2);
  const firstVisible = Math.floor(top / cell) * cols;
  const move = (d: number) => {
    const n = Math.min(items.length - 1, Math.max(0, focus + d)); setFocus(n);
    const y = Math.floor(n / cols) * cell; const el = ref.current;
    if (el && (y < el.scrollTop || y + cell > el.scrollTop + el.clientHeight)) el.scrollTop = y - el.clientHeight / 2 + cell / 2;
    requestAnimationFrame(() => (el?.querySelector(`[data-i="${n}"]`) as HTMLElement | null)?.focus());
  };
  const cells = [];
  for (let r = r0; r < r1; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; const s = items[i]; if (!s) break;
    cells.push(
      <div key={s.id} role="gridcell" className="group absolute p-1" style={{ left: 4 + c * cell, top: r * cell, width: cell, height: cell }}>
        <button data-i={i} tabIndex={i === focus ? 0 : -1} aria-label={`${s.name}. Press Enter to preview, double-click to send`} onFocus={() => setFocus(i)}
          className={cn("pixel-surface flex h-full w-full items-center justify-center transition-transform hover:-translate-y-0.5 hover:bg-bg2", selected === s.id && "outline-2 outline-primary")}
          onClick={() => onPick(s)} onDoubleClick={() => onSend(s)}>
          <StickerImg id={s.id} alt="" size={Math.min(64, cell - 16)} reduceMotion={rm} animate={i >= firstVisible && i < firstVisible + MAX_ANIMATED} />
        </button>
        <button tabIndex={-1} className={cn("absolute right-0 top-0 bg-background p-0.5", !favs.has(s.id) && "opacity-0 group-hover:opacity-100 focus:opacity-100")} onClick={() => onFav(s.id)} aria-label={favs.has(s.id) ? "Remove favourite" : "Add favourite"}>
          <Star size={11} className={cn(favs.has(s.id) ? "fill-secondary text-secondary" : "text-muted-foreground")} />
        </button>
        {showCat && <span className="pointer-events-none absolute bottom-1 left-1 text-[10px]" aria-hidden>{catIcon(s.category)}</span>}
      </div>,
    );
  }
  return (
    <div ref={ref} role="grid" aria-label={label} className="pixel-scroll relative h-full overflow-y-auto" onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      onKeyDown={(e) => {
        const k = e.key;
        if (k === "ArrowRight") { e.preventDefault(); move(1); } else if (k === "ArrowLeft") { e.preventDefault(); move(-1); }
        else if (k === "ArrowDown") { e.preventDefault(); move(cols); } else if (k === "ArrowUp") { e.preventDefault(); move(-cols); }
        else if (k === "Enter" && e.shiftKey && items[focus]) { e.preventDefault(); onSend(items[focus]!); }
      }}>
      <div style={{ height: rows * cell + 8 }} />
      {cells}
    </div>
  );
}

function PacksView({ lib, prefs, setPrefs, open }: { lib: Library; prefs: Prefs; setPrefs: Props["setPrefs"]; open: (id: string) => void }) {
  return (
    <div className="pixel-scroll flex h-full flex-col gap-2 overflow-y-auto p-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <label className="flex items-center gap-2"><input type="checkbox" className="accent-primary" checked={prefs.reduceMotion} onChange={(e) => setPrefs((p) => ({ ...p, reduceMotion: e.target.checked }))} /> Reduce sticker motion</label>
        <a href="/sticker-stats" target="_blank" rel="noreferrer" className="flex items-center gap-1 underline"><BarChart3 size={12} /> Library stats</a>
      </div>
      {lib.packs.map((pk) => {
        const items = lib.stickers.filter((s) => s.packs.includes(pk.id));
        const inst = prefs.installedPacks.includes(pk.id), fav = prefs.favPacks.includes(pk.id);
        return (
          <div key={pk.id} className="pixel-surface flex items-center gap-2 p-2">
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => open(pk.id)} aria-label={`Open ${pk.name}`}>
              <div className="flex shrink-0">{items.slice(0, 3).map((s) => <StickerImg key={s.id} id={s.id} alt="" size={36} animate={false} />)}</div>
              <div className="min-w-0"><div className="truncate text-sm font-semibold">{pk.name}</div><div className="truncate text-[11px] text-muted-foreground">{items.length} stickers · {pk.desc}</div></div>
            </button>
            <button onClick={() => setPrefs((p) => ({ ...p, favPacks: fav ? p.favPacks.filter((x) => x !== pk.id) : [...p.favPacks, pk.id] }))} aria-label={fav ? "Unfavourite pack" : "Favourite pack"}><Star size={14} className={cn(fav ? "fill-secondary text-secondary" : "text-muted-foreground")} /></button>
            <InstallBtn inst={inst} toggle={() => setPrefs((p) => ({ ...p, installedPacks: inst ? p.installedPacks.filter((x) => x !== pk.id) : [...p.installedPacks, pk.id] }))} />
          </div>
        );
      })}
    </div>
  );
}
function InstallBtn({ inst, toggle }: { inst: boolean; toggle: () => void }) {
  return <button className={cn("pixel-btn pixel-btn-sm shrink-0", !inst && "pixel-btn-primary")} onClick={toggle}>{inst ? <><Trash2 size={11} /> Remove</> : <><Download size={11} /> Add</>}</button>;
}
function PackHeader({ lib, id, prefs, setPrefs, back }: { lib: Library; id: string; prefs: Prefs; setPrefs: Props["setPrefs"]; back: () => void }) {
  const pk = lib.packs.find((p) => p.id === id); if (!pk) return null;
  const inst = prefs.installedPacks.includes(id);
  return (
    <div className="flex items-center gap-2 px-2 pt-2">
      <button onClick={back} aria-label="Back to packs"><ArrowLeft size={14} /></button>
      <div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{pk.name}</div><div className="truncate text-[11px] text-muted-foreground">{pk.desc}</div></div>
      <InstallBtn inst={inst} toggle={() => setPrefs((p) => ({ ...p, installedPacks: inst ? p.installedPacks.filter((x) => x !== id) : [...p.installedPacks, id] }))} />
    </div>
  );
}
