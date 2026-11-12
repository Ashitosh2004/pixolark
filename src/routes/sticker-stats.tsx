import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { loadLibrary, type Library } from "@/lib/pixel/stickerlib";
import { StickerImg } from "@/components/pixel/StickerImg";

export const Route = createFileRoute("/sticker-stats")({
  head: () => ({
    meta: [
      { title: "Sticker library stats — Pixolark" },
      { name: "description", content: "Verified counts for Pixolark's 1,000+ original animated pixel stickers, by category and pack." },
      { property: "og:title", content: "Sticker library stats — Pixolark" },
      { property: "og:description", content: "Verified counts for Pixolark's 1,000+ original animated pixel stickers." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StickerStats,
});

interface Report { version: string; total: number; verified: number; animated: number; missing: number; invalid: number; duplicates: number; bytes: number; generatedAt: string }

function StickerStats() {
  const [lib, setLib] = useState<Library | null>(null);
  const [rep, setRep] = useState<Report | null>(null);
  const [check, setCheck] = useState<{ done: number; missing: number; bad: number; dupes: number } | null>(null);
  useEffect(() => { void loadLibrary().then(setLib); void fetch("/stickers/report.json").then((r) => r.json()).then(setRep); }, []);

  const verify = async () => {
    if (!lib) return;
    const st = { done: 0, missing: 0, bad: 0, dupes: 0 };
    const hashes = new Set<string>();
    for (const s of lib.stickers) if (hashes.has(s.sha256)) st.dupes++; else hashes.add(s.sha256);
    let i = 0;
    const worker = async () => {
      while (i < lib.stickers.length) {
        const s = lib.stickers[i++]!;
        try {
          const r = await fetch(s.asset);
          if (!r.ok) st.missing++;
          else { const b = new Uint8Array(await r.arrayBuffer()); const txt = new TextDecoder("latin1").decode(b.subarray(0, 200)); if (b[1] !== 0x50 || !txt.includes("acTL")) st.bad++; }
        } catch { st.missing++; }
        st.done++; if (st.done % 25 === 0) setCheck({ ...st });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    setCheck({ ...st });
  };

  const stat = (label: string, v: number | string) => (<div className="pixel-surface p-3"><div className="pixel-label">{label}</div><div className="mt-1 font-pixel text-lg text-primary">{v}</div></div>);
  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-8">
      <Link to="/" className="pixel-label underline">← Pixolark</Link>
      <h1 className="mt-4 font-pixel text-xl">Sticker library</h1>
      {!lib || !rep ? <p className="mt-6 text-muted-foreground">Loading…</p> : (
        <>
          <p className="mt-2 text-sm text-muted-foreground">Version {lib.version} · built {new Date(rep.generatedAt).toLocaleDateString()} · {(rep.bytes / 1024 / 1024).toFixed(1)} MB on disk</p>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stat("Verified stickers", lib.stickers.length)}
            {stat("Animated assets", check ? check.done - check.missing - check.bad : rep.animated)}
            {stat("Sticker packs", lib.packs.length)}
            {stat("Categories", lib.categories.length)}
            {stat("Missing assets", check ? check.missing : rep.missing)}
            {stat("Invalid animations", check ? check.bad : rep.invalid)}
            {stat("Duplicate assets", check ? check.dupes : rep.duplicates)}
            <div className="pixel-surface flex flex-col justify-center gap-2 p-3">
              <button className="pixel-btn pixel-btn-sm" onClick={verify} disabled={!!check && check.done < lib.stickers.length}>Re-verify in browser</button>
              {check && <span className="text-[11px] text-muted-foreground">{check.done}/{lib.stickers.length} checked</span>}
            </div>
          </div>
          <h2 className="mt-8 font-pixel text-sm">By category</h2>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {lib.categories.map((c) => { const first = lib.stickers.find((s) => s.category === c.id); return (
              <div key={c.id} className="pixel-surface flex items-center gap-3 p-2">
                {first && <StickerImg id={first.id} alt={first.name} size={48} />}
                <span className="flex-1">{c.icon} {c.label}</span><b className="font-pixel text-xs">{c.count}</b>
              </div>); })}
          </div>
          <h2 className="mt-8 font-pixel text-sm">Packs</h2>
          <ul className="mt-3 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
            {lib.packs.map((p) => <li key={p.id} className="flex justify-between border-b border-border py-1"><span>{p.name}</span><span className="text-muted-foreground">{lib.stickers.filter((s) => s.packs.includes(p.id)).length}</span></li>)}
          </ul>
        </>
      )}
    </main>
  );
}
