/**
 * DiscoverView — live browser for public rooms + regional communities.
 *
 * Listings come ONLY from host beacons (discovery.ts): no fake rooms, no invented
 * counts. A beacon older than the freshness window is marked "host offline", a
 * closed beacon is marked "Closed". Private rooms are unlisted — they are joined
 * by room code through the same screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Compass, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { CATEGORIES, fetchBeacons, LANGUAGES, REGIONS, roomFingerprint, type RoomBeacon } from "@/lib/pixel/discovery";
import { normalizeRoomId } from "@/lib/pixel/codec";
import { cn } from "@/lib/utils";
import { Loader } from "./ui";

const REGION_TAB_KEY = "pxc.discoverRegion";
const REGION_OPTIONS = Object.entries(REGIONS).map(([key, node]) => ({ value: key, label: node.name }));

interface Props {
  onJoin: (room: string) => void;
  joining: string | null;
  onBack?: (() => void) | undefined;
}

export function DiscoverView({ onJoin, joining, onBack }: Props) {
  const [tab, setTab] = useState<"all" | "regional">(() => (localStorage.getItem(REGION_TAB_KEY) === "regional" ? "regional" : "all"));
  const [beacons, setBeacons] = useState<Array<RoomBeacon & { stale: boolean }> | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [lang, setLang] = useState<string>("");
  const [region, setRegion] = useState<string>(() => localStorage.getItem(REGION_TAB_KEY) ?? "International");
  const [code, setCode] = useState("");

  const refresh = useCallback(async () => {
    const list = await fetchBeacons();
    setBeacons(list);
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => { localStorage.setItem(REGION_TAB_KEY, tab); }, [tab]);

  const filtered = useMemo(() => {
    let list = beacons ?? [];
    if (tab === "regional") {
      list = list.filter((b) => b.region === region || b.region.startsWith(`${region} ·`) || b.region.startsWith(`${region}/`));
    }
    if (cat) list = list.filter((b) => b.cat === cat);
    if (lang) list = list.filter((b) => b.lang === lang);
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((b) => b.name.toLowerCase().includes(needle) || b.desc.toLowerCase().includes(needle));
    return list;
  }, [beacons, tab, region, cat, lang, q]);

  const live = filtered.filter((b) => !b.closed);
  const closed = filtered.filter((b) => b.closed);

  const joinByCode = () => {
    try {
      const r = normalizeRoomId(code);
      onJoin(r);
    } catch {
      toast.error("That doesn't look like a room code.");
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-2">
        {onBack && <button className="pixel-btn pixel-btn-sm" onClick={onBack}><ArrowLeft size={12} /> Back</button>}
        <button className={cn("pixel-btn pixel-btn-sm", !onBack && "ml-auto")} onClick={() => void refresh()}><RefreshCw size={12} /> Refresh</button>
      </div>

      <div className="pixel-box mb-4 flex flex-col gap-3 p-4">
        <div className="flex gap-2">
          <button className={cn("pixel-btn pixel-btn-sm flex-1", tab === "all" && "pixel-btn-primary")} onClick={() => setTab("all")}><Compass size={12} /> All rooms</button>
          <button className={cn("pixel-btn pixel-btn-sm flex-1", tab === "regional" && "pixel-btn-primary")} onClick={() => setTab("regional")}>🌍 My region</button>
        </div>
        {tab === "regional" && (
          <select className="pixel-input" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region">
            {REGION_OPTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        )}
        <div className="flex items-center gap-2">
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input className="pixel-input" placeholder="Search live rooms…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap gap-1">
          <button className={cn("pixel-btn pixel-btn-sm", !cat && "pixel-btn-primary")} onClick={() => setCat(null)}>All topics</button>
          {CATEGORIES.map((c) => (
            <button key={c} className={cn("pixel-btn pixel-btn-sm", cat === c && "pixel-btn-primary")} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="pixel-label shrink-0">Language</span>
          <select className="pixel-input" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="">Any</option>
            {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      </div>

      <div className="pixel-box mb-4 flex flex-col gap-2 p-4">
        <span className="pixel-label">Join a private room by code</span>
        <div className="flex gap-2">
          <input className="pixel-input" placeholder="Room code (e.g. PX4F2K)" value={code} maxLength={24} onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && joinByCode()} />
          <button className="pixel-btn pixel-btn-gold" disabled={!code.trim() || !!joining} onClick={joinByCode}>Join</button>
        </div>
      </div>

      {beacons === null && <Loader label="Listening for room beacons" />}
      {beacons !== null && (
        <div className="flex flex-col gap-3">
          {live.length === 0 && closed.length === 0 && (
            <div className="pixel-box p-6 text-center text-sm text-muted-foreground">
              No rooms are broadcasting right now. Host one from the Groups tab — it will appear here within seconds.
            </div>
          )}
          {live.map((b) => <BeaconCard key={b.room} b={b} onJoin={() => onJoin(b.room)} joining={joining === b.room} />)}
          {closed.map((b) => <BeaconCard key={b.room} b={b} onJoin={undefined} joining={false} />)}
        </div>
      )}
    </div>
  );
}

function BeaconCard({ b, onJoin, joining }: { b: RoomBeacon & { stale: boolean }; onJoin?: (() => void) | undefined; joining: boolean }) {
  return (
    <div className={cn("pixel-box flex flex-col gap-2 p-4", b.closed && "opacity-60")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{b.name || "Untitled room"}</span>
            {b.closed ? <span className="pixel-label bg-destructive px-1.5 text-destructive-foreground">Closed</span>
              : b.stale ? <span className="pixel-label bg-muted px-1.5">host offline</span>
              : <span className="pixel-label bg-primary px-1.5 text-primary-foreground">live</span>}
          </div>
          {b.desc && <p className="mt-1 text-sm text-muted-foreground">{b.desc}</p>}
        </div>
        {onJoin && (
          <button className="pixel-btn pixel-btn-primary shrink-0" disabled={joining} onClick={onJoin}>{joining ? "Joining…" : "Join"}</button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{b.cat}</span>
        {b.region && <span>🌍 {b.region}</span>}
        {b.lang && <span>🗣 {b.lang}</span>}
        <span>{b.closed ? "closed by host" : `${b.members}/${b.cap || "?"} online`}</span>
        <span>host {b.hostName || "unknown"}</span>
        <span className="font-mono">check {roomFingerprint(b.hostId, b.room)}</span>
      </div>
    </div>
  );
}
