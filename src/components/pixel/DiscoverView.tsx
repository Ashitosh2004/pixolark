/**
 * DiscoverView — live browser for public rooms + regional communities.
 *
 * Two honest sources, clearly labeled:
 * - LIVE beacons (discovery.ts): hosts broadcasting right now. Counts come from
 *   the host; a beacon older than the freshness window is "host offline".
 * - DIRECTORY (static signed manifest tree): rooms published by their owners to
 *   a static host. Presence ≠ availability — every card can be probed against
 *   the live coordinator lease, and the result is told exactly as it is
 *   ("available now" / "temporarily unavailable"). Tampered/expired manifests
 *   never reach this screen at all (the directory client verifies everything).
 *
 * Private rooms are unlisted — they are joined by room code through this screen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Compass, Globe2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { CATEGORIES, fetchBeacons, LANGUAGES, REGIONS, regionMatches, regionPath, roomFingerprint, type RoomBeacon } from "@/lib/pixel/discovery";
import { filterRooms, loadDirectory, type DirectoryRoom } from "@/lib/pixel/directory";
import type { RoomManifest } from "@/lib/pixel/manifest";
import { normalizeRoomId } from "@/lib/pixel/codec";
import { cn } from "@/lib/utils";
import { Loader } from "./ui";

const REGION_TAB_KEY = "pxc.discoverRegion";
const REGION_COUNTRY_KEY = "pxc.discoverCountry";
const REGION_OPTIONS = Object.entries(REGIONS).map(([key, node]) => ({ key, label: node.name }));

type Availability = "unknown" | "checking" | "available" | "unavailable";

interface Props {
  onJoin: (room: string) => void;
  /** Directory rooms join with their signed manifest (coordinator signaling). */
  onJoinManifest: (room: string, manifest: RoomManifest) => void;
  /** Honest availability probe against the live coordinator lease. */
  probeRoom: (roomId: string) => Promise<boolean | null>;
  joining: string | null;
  onBack?: (() => void) | undefined;
}

export function DiscoverView({ onJoin, onJoinManifest, probeRoom, joining, onBack }: Props) {
  const [tab, setTab] = useState<"all" | "regional">(() => (localStorage.getItem(REGION_TAB_KEY) === "regional" ? "regional" : "all"));
  const [beacons, setBeacons] = useState<Array<RoomBeacon & { stale: boolean }> | null>(null);
  const [directory, setDirectory] = useState<DirectoryRoom[] | null>(null);
  const [availability, setAvailability] = useState<Record<string, Availability>>({});
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [lang, setLang] = useState<string>("");
  const [region, setRegion] = useState<string>(() => {
    const saved = localStorage.getItem(REGION_COUNTRY_KEY);
    return saved && saved in REGIONS ? saved : "International";
  });
  const [subRegion, setSubRegion] = useState("");
  const [city, setCity] = useState("");
  const [code, setCode] = useState("");

  const refresh = useCallback(async () => {
    const [b, d] = await Promise.all([fetchBeacons(), loadDirectory().catch(() => [])]);
    setBeacons(b);
    setDirectory(d);
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  useEffect(() => { localStorage.setItem(REGION_TAB_KEY, tab); }, [tab]);
  useEffect(() => { localStorage.setItem(REGION_COUNTRY_KEY, region); }, [region]);

  const beaconRoomIds = useMemo(() => new Set((beacons ?? []).map((b) => b.room)), [beacons]);

  const listed = useMemo(() => {
    // Directory rooms already visible as live beacons are not repeated.
    const rooms = (directory ?? []).filter((d) => !beaconRoomIds.has(d.manifest.roomId));
    return filterRooms(rooms, {
      text: q,
      category: cat ?? undefined,
      language: lang || undefined,
      country: tab === "regional" && region !== "International" ? region : undefined,
      state: tab === "regional" && subRegion ? subRegion : undefined,
      city: tab === "regional" && city ? city : undefined,
    });
  }, [directory, beaconRoomIds, q, cat, lang, tab, region, subRegion, city]);

  const filtered = useMemo(() => {
    let list = beacons ?? [];
    if (tab === "regional") {
      const path = regionPath({ region: region === "International" ? "" : region, subRegion, city });
      list = list.filter((b) => regionMatches(b.region, path));
    }
    if (cat) list = list.filter((b) => b.cat === cat);
    if (lang) list = list.filter((b) => b.lang === lang);
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((b) => b.name.toLowerCase().includes(needle) || b.desc.toLowerCase().includes(needle));
    return list;
  }, [beacons, tab, region, cat, lang, q]);

  const live = filtered.filter((b) => !b.closed);
  const closed = filtered.filter((b) => b.closed);

  const check = useCallback(async (roomId: string): Promise<boolean> => {
    setAvailability((a) => ({ ...a, [roomId]: "checking" }));
    const ok = await probeRoom(roomId);
    setAvailability((a) => ({ ...a, [roomId]: ok ? "available" : "unavailable" }));
    return ok === true;
  }, [probeRoom]);

  const joinDirectory = (d: DirectoryRoom) => {
    if (availability[d.id] === "unavailable") {
      toast.error("Room temporarily unavailable — its host is not connected right now.");
      return;
    }
    void check(d.manifest.roomId).then((ok) => {
      if (ok) onJoinManifest(d.manifest.roomId, d.manifest);
      else toast.error("Room temporarily unavailable — its host is not connected right now.");
    });
  };

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
          <div className="flex flex-wrap gap-2">
            <select className="pixel-input" value={region} onChange={(e) => { setRegion(e.target.value); setSubRegion(""); setCity(""); }} aria-label="Country">
              {REGION_OPTIONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            {(REGIONS[region]?.children ?? []).length > 0 && (
              <select className="pixel-input" value={subRegion} onChange={(e) => { setSubRegion(e.target.value); setCity(""); }} aria-label="State">
                <option value="">Any state</option>
                {(REGIONS[region]?.children ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            {(subRegion ? REGIONS[region]?.cities?.[subRegion] ?? [] : []).length > 0 && (
              <select className="pixel-input" value={city} onChange={(e) => setCity(e.target.value)} aria-label="City">
                <option value="">Any city</option>
                {(REGIONS[region]?.cities?.[subRegion] ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
          </div>
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

      {(beacons === null || directory === null) && <Loader label="Loading rooms" />}

      {(beacons !== null && directory !== null) && (
        <div className="flex flex-col gap-3">
          {listed.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe2 size={14} /> Rooms from the verified public directory — press check to see if the host is live right now
            </div>
          )}
          {listed.map((d) => (
            <DirectoryCard
              key={d.id}
              d={d}
              state={availability[d.manifest.roomId] ?? "unknown"}
              onCheck={() => void check(d.manifest.roomId)}
              onJoin={() => joinDirectory(d)}
              joining={joining === d.manifest.roomId}
            />
          ))}
          {live.length === 0 && closed.length === 0 && listed.length === 0 && (
            <div className="pixel-box p-6 text-center text-sm text-muted-foreground">
              No rooms are broadcasting right now, and the public directory has no matches. Host one from the Groups tab — it will appear here within seconds.
            </div>
          )}
          {live.map((b) => <BeaconCard key={b.room} b={b} onJoin={() => onJoin(b.room)} joining={joining === b.room} />)}
          {closed.map((b) => <BeaconCard key={b.room} b={b} onJoin={undefined} joining={false} />)}
        </div>
      )}
    </div>
  );
}

function where(d: DirectoryRoom): string {
  const m = d.manifest;
  return [m.city, m.subRegion, m.region].filter(Boolean).join(" · ");
}

function DirectoryCard({ d, state, onCheck, onJoin, joining }: { d: DirectoryRoom; state: Availability; onCheck: () => void; onJoin: () => void; joining: boolean }) {
  const m = d.manifest;
  return (
    <div className="pixel-box flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-semibold">{m.name}</span>
            {state === "available" && <span className="pixel-label bg-primary px-1.5 text-primary-foreground">available now</span>}
            {state === "unavailable" && <span className="pixel-label bg-muted px-1.5">temporarily unavailable</span>}
            {state === "checking" && <span className="pixel-label bg-muted px-1.5">checking…</span>}
            {state === "unknown" && <span className="pixel-label bg-muted px-1.5">signed manifest</span>}
          </div>
          {m.desc && <p className="mt-1 text-sm text-muted-foreground">{m.desc}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {state !== "available" && <button className="pixel-btn pixel-btn-sm" disabled={state === "checking"} onClick={onCheck}>{state === "checking" ? "…" : "Check"}</button>}
          <button className="pixel-btn pixel-btn-primary" disabled={joining || state === "checking" || state === "unavailable"} onClick={onJoin}>{joining ? "Joining…" : "Join"}</button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{m.category}</span>
        {where(d) && <span>🌍 {where(d)}</span>}
        <span>🗣 {m.languages.join(", ")}</span>
        <span className="font-mono">room {m.roomId}</span>
        <span>owner {m.owner.id.slice(0, 8)}…</span>
      </div>
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
