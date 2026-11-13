/**
 * Hub — the platform home screen: desktop left nav rail, mobile bottom nav.
 * Tabs: Chats (1:1), Groups, Discover (global + regional), Saved, Alerts.
 * Settings lives in the existing modal (rail item on desktop, header on mobile).
 *
 * Listings are live only: group recents come from this device's own history,
 * Discover from host beacons. Nothing here invents rooms or counts.
 */
import { useCallback, useEffect, useState } from "react";
import {
  MessageCircle, Users, Compass, Bookmark, Bell, Settings as Cog, Plus, LogIn, History,
  VolumeX, Volume2, Trash2, Clock, BellRing, RefreshCw, Crown, Radio,
} from "lucide-react";
import { toast } from "sonner";
import type { LastRoom, Prefs, RoomBookmark } from "@/lib/pixel/storage";
import {
  isRoomMuted, loadBookmarks, loadRecentRooms, loadGroupSnapshot, removeBookmark,
  setRoomMuted, type RecentRoom,
} from "@/lib/pixel/storage";
import {
  DND_PRESETS, dndUntil, ensureNotificationPermission, notificationPermission,
  onNotificationsChanged, recentNotifications, setDndUntil, type DeliveryLog,
} from "@/lib/pixel/notifications";
import type { Avatar } from "@/lib/pixel/pixelart";
import { cn } from "@/lib/utils";
import { AvatarImg, Loader } from "./ui";
import { DiscoverView } from "./DiscoverView";

export type HubTab = "chats" | "groups" | "discover" | "saved" | "alerts";

const TABS: { id: HubTab; label: string; icon: typeof MessageCircle }[] = [
  { id: "chats", label: "Chats", icon: MessageCircle },
  { id: "groups", label: "Groups", icon: Users },
  { id: "discover", label: "Discover", icon: Compass },
  { id: "saved", label: "Saved", icon: Bookmark },
  { id: "alerts", label: "Alerts", icon: Bell },
];

interface Props {
  prefs: Prefs;
  busy: boolean;
  lastRoom: LastRoom | null;
  joiningRoom: string | null;
  activeGroup?: { room: string; name: string; role: "host" | "member" } | null | undefined;
  tab: HubTab;
  setTab: (t: HubTab) => void;
  onRejoinLast: () => void;
  onCreateRoom: () => void; // 1:1
  onJoinRoom: () => void; // 1:1 join screen
  onCreateGroup: () => void; // GroupCreate screen
  onHostGroupAgain: (room: string) => void;
  onJoinGroup: (room: string) => void;
  onJoinPeer: (room: string) => void; // 1:1 join by room id
  onReturnToGroup?: (() => void) | undefined;
  onLeaveGroup?: (() => void) | undefined;
  onOpenSettings: () => void;
}

export function Hub(p: Props) {
  const [recents, setRecents] = useState<RecentRoom[]>([]);
  const [bookmarks, setBookmarks] = useState<RoomBookmark[]>([]);
  const [log, setLog] = useState<DeliveryLog[]>([]);
  const [dnd, setDnd] = useState(0);
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");

  const refreshLocal = useCallback(() => {
    setRecents(loadRecentRooms());
    setBookmarks(loadBookmarks());
    setDnd(dndUntil());
    setLog([...recentNotifications()]);
    setPerm(notificationPermission());
  }, []);

  useEffect(() => {
    refreshLocal();
    const off = onNotificationsChanged(() => setLog([...recentNotifications()]));
    const iv = window.setInterval(refreshLocal, 5000); // keeps DND countdown & lists fresh
    return () => { off(); window.clearInterval(iv); };
  }, [refreshLocal, p.tab]);

  const dndRemaining = dnd > Date.now() ? Math.ceil((dnd - Date.now()) / 60000) : 0;

  const toggleBookmarkMute = (b: RoomBookmark) => {
    const next = !b.muted;
    setRoomMuted(b.room, b.kind, b.name, next);
    refreshLocal();
    toast(next ? `Muted: ${b.name}` : `Unmuted: ${b.name}`);
  };

  const groups = recents.filter((r) => r.kind === "group");
  const peers = recents.filter((r) => r.kind === "peer");

  return (
    <div className="flex min-h-dvh">
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col gap-1 border-r-4 border-border bg-bg2 p-3 md:flex">
        <a href="/" className="mb-4 px-2 font-pixel text-xs text-primary">PIXO<span className="text-secondary">LARK</span></a>
        {TABS.map((t) => (
          <button key={t.id} className={cn("pixel-btn justify-start text-left", p.tab === t.id && "pixel-btn-primary")} onClick={() => p.setTab(t.id)}>
            <t.icon size={14} /> {t.label}
            {t.id === "alerts" && log.some((e) => e.mention) && <span className="ml-auto h-2 w-2 rounded-full bg-destructive" />}
          </button>
        ))}
        <button className="pixel-btn justify-start text-left" onClick={p.onOpenSettings}><Cog size={14} /> Settings</button>
        <div className="mt-auto flex items-center gap-2 px-2 py-2">
          <AvatarImg avatar={p.prefs.avatar as Avatar} size={32} />
          <div className="min-w-0">
            <div className="truncate text-xs font-semibold">{p.prefs.username}</div>
            <div className="truncate text-[10px] text-muted-foreground">{p.prefs.status || "on Pixolark"}</div>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Mobile header */}
        <header className="flex items-center justify-between gap-2 border-b-4 border-border bg-bg2 px-4 py-3 md:hidden">
          <a href="/" className="font-pixel text-xs text-primary">PIXO<span className="text-secondary">LARK</span></a>
          <div className="flex items-center gap-2">
            <AvatarImg avatar={p.prefs.avatar as Avatar} size={28} />
            <button className="pixel-btn pixel-icon-btn" onClick={p.onOpenSettings} aria-label="Settings"><Cog size={14} /></button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-3xl p-4 pb-24 md:pb-8">
          {p.busy && <div className="mb-4"><Loader label="Working" /></div>}

          {p.tab === "chats" && (
            <Section title="Private chats" sub="End-to-end encrypted 1:1 rooms. Nothing is stored on any server.">
              <div className="grid gap-3 sm:grid-cols-2">
                <button className="pixel-btn pixel-btn-primary justify-start" disabled={p.busy} onClick={p.onCreateRoom}><Plus size={14} /> New private room</button>
                <button className="pixel-btn pixel-btn-gold justify-start" onClick={p.onJoinRoom}><LogIn size={14} /> Join with code</button>
              </div>
              {p.lastRoom && (
                <button className="pixel-btn justify-start" disabled={p.busy} onClick={p.onRejoinLast}>
                  <History size={14} /> Rejoin room {p.lastRoom.roomId}
                  <span className="ml-1 text-[10px] text-muted-foreground">({p.lastRoom.role === "host" ? "you hosted" : "you joined"})</span>
                </button>
              )}
              <RoomList
                title="Recent chats"
                rooms={peers}
                actionLabel="Open"
                onOpen={(r) => p.onJoinPeer(r.room)}
                joiningRoom={p.joiningRoom}
                empty="No private chats yet on this device."
              />
            </Section>
          )}

          {p.tab === "groups" && (
            <Section title="Group rooms" sub="Encrypted group chat you host yourself — the room lives on the host's device.">
              {p.activeGroup && p.onReturnToGroup && (
                <div className="flex flex-wrap items-center gap-2 border-2 border-secondary bg-secondary/10 px-3 py-2">
                  <Radio size={14} className="text-secondary" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <span className="font-semibold">{p.activeGroup.name || p.activeGroup.room}</span> is open in the background ({p.activeGroup.role}).
                  </span>
                  <button className="pixel-btn pixel-btn-sm pixel-btn-primary" onClick={p.onReturnToGroup}>Return to room</button>
                  {p.onLeaveGroup && <button className="pixel-btn pixel-btn-sm pixel-btn-danger" onClick={p.onLeaveGroup}>Leave</button>}
                </div>
              )}
              <button className="pixel-btn pixel-btn-primary justify-start" disabled={p.busy} onClick={p.onCreateGroup}><Plus size={14} /> Host a new group</button>
              <RoomList
                title="My rooms"
                rooms={groups}
                actionLabel={(r) => (r.role === "host" ? "Host again" : "Rejoin")}
                onOpen={(r) => { r.role === "host" ? p.onHostGroupAgain(r.room) : p.onJoinGroup(r.room); }}
                joiningRoom={p.joiningRoom}
                empty="No groups yet — host one, or join via Discover / a room code."
                icon={(r) => (r.role === "host" ? <Crown size={12} className="text-secondary" /> : <Users size={12} className="text-muted-foreground" />)}
              />
              <p className="text-xs text-muted-foreground">
                <Radio size={12} className="mr-1 inline" />
                Hosting again restores your saved roster, roles and bans from this device, and re-keys the room so old visitors' keys stop working.
              </p>
            </Section>
          )}

          {p.tab === "discover" && (
            <DiscoverView onJoin={p.onJoinGroup} joining={p.joiningRoom} onBack={() => p.setTab("groups")} />
          )}

          {p.tab === "saved" && (
            <Section title="Saved rooms" sub="Bookmarked rooms stay here for one-tap access. Mutes are per room.">
              {bookmarks.length === 0 && <p className="text-sm text-muted-foreground">Nothing saved yet. Rooms you join can be bookmarked from the chat header.</p>}
              <div className="flex flex-col gap-2">
                {bookmarks.map((b) => (
                  <div key={b.room} className="flex flex-wrap items-center gap-2 border-2 border-border bg-bg2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">{b.name || b.room}</span>
                        <span className="pixel-label">{b.kind === "group" ? "group" : "1:1"}</span>
                        {b.muted && <VolumeX size={12} className="text-muted-foreground" />}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground">{b.room}</div>
                    </div>
                    <button className="pixel-btn pixel-btn-sm" onClick={() => { b.kind === "group" ? p.onJoinGroup(b.room) : p.onJoinPeer(b.room); }} disabled={p.joiningRoom === b.room}>Open</button>
                    <button className="pixel-btn pixel-btn-sm" onClick={() => toggleBookmarkMute(b)} aria-label="Toggle mute">{b.muted ? <Volume2 size={12} /> : <VolumeX size={12} />}</button>
                    <button className="pixel-btn pixel-btn-sm pixel-btn-danger" onClick={() => { removeBookmark(b.room); refreshLocal(); }} aria-label="Remove bookmark"><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {p.tab === "alerts" && (
            <Section title="Notifications" sub="Everything is delivered on this device only. No push service, no server copies.">
              <div className="flex flex-wrap items-center gap-2 border-2 border-border bg-surface p-3 text-sm">
                <Clock size={14} className="text-secondary" />
                {dndRemaining > 0 ? (
                  <>
                    <span>Do not disturb — <span className="font-semibold">{dndRemaining} min</span> left.</span>
                    <button className="pixel-btn pixel-btn-sm" onClick={() => { setDndUntil(0); setDnd(0); toast("Do not disturb off"); }}>Turn off</button>
                  </>
                ) : (
                  <>
                    <span>Do not disturb is off.</span>
                    {DND_PRESETS.filter((d) => d.minutes > 0).map((d) => (
                      <button key={d.minutes} className="pixel-btn pixel-btn-sm" onClick={() => { setDndUntil(Date.now() + d.minutes * 60000); setDnd(Date.now() + d.minutes * 60000); toast(`DND for ${d.label}`); }}>{d.label}</button>
                    ))}
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-2 border-border bg-surface p-3 text-sm">
                <BellRing size={14} className="text-secondary" />
                {perm === "unsupported" && <span>Desktop notifications aren't available in this browser — in-room sounds still work.</span>}
                {perm === "granted" && <span className="text-primary">Desktop notifications are allowed.</span>}
                {perm === "denied" && <span>Notifications were blocked in the browser's site settings. Sounds still play.</span>}
                {perm === "default" && (
                  <>
                    <span>Desktop notifications are not enabled.</span>
                    <button className="pixel-btn pixel-btn-sm pixel-btn-primary" onClick={async () => { const ok = await ensureNotificationPermission(); setPerm(notificationPermission()); toast(ok ? "Notifications enabled" : "Permission not granted"); }}>Enable</button>
                  </>
                )}
              </div>

              <div>
                <span className="pixel-label">Muted rooms</span>
                {bookmarks.filter((b) => b.muted).length === 0 && <p className="text-sm text-muted-foreground">No room is muted. Mute from Saved or the room's bell icon.</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {bookmarks.filter((b) => b.muted).map((b) => (
                    <button key={b.room} className="pixel-btn pixel-btn-sm" onClick={() => toggleBookmarkMute(b)}>
                      <Volume2 size={12} /> {b.name || b.room} (unmute)
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="pixel-label">Recent activity (this session)</span>
                {log.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet. Alerts that sound or notify show up here.</p>}
                <div className="mt-2 flex flex-col gap-1">
                  {log.slice(0, 25).map((e, i) => (
                    <div key={`${e.ts}-${i}`} className="flex gap-2 border-b border-border py-1 text-xs">
                      <span className="shrink-0 text-muted-foreground">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {e.mention && <span className="mr-1 pixel-label bg-destructive px-1 text-destructive-foreground">mention</span>}
                        <span className="font-semibold">{e.senderName}</span> · {e.roomName}: {e.body}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{e.notified ? "🔔" : e.sound ? "🔊" : "seen"}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Section>
          )}
        </main>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t-4 border-border bg-bg2 md:hidden">
          {TABS.map((t) => (
            <button key={t.id} className={cn("relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px]", p.tab === t.id ? "text-primary" : "text-muted-foreground")} onClick={() => p.setTab(t.id)}>
              <t.icon size={18} />
              {t.label}
              {t.id === "alerts" && log.some((e) => e.mention) && <span className="absolute right-1/4 top-1 h-2 w-2 rounded-full bg-destructive" />}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="font-pixel text-sm text-primary">{title}</h1>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </div>
      {children}
    </div>
  );
}

function RoomList({
  title, rooms, actionLabel, onOpen, joiningRoom, empty, icon,
}: {
  title: string;
  rooms: RecentRoom[];
  actionLabel: string | ((r: RecentRoom) => string);
  onOpen: (r: RecentRoom) => void;
  joiningRoom: string | null;
  empty: string;
  icon?: (r: RecentRoom) => React.ReactNode;
}) {
  const [muteState, setMuteState] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const m: Record<string, boolean> = {};
    for (const r of rooms) m[r.room] = isRoomMuted(r.room);
    setMuteState(m);
  }, [rooms]);
  return (
    <div className="flex flex-col gap-2">
      <span className="pixel-label">{title}</span>
      {rooms.length === 0 && <p className="text-sm text-muted-foreground">{empty}</p>}
      {rooms.map((r) => (
        <div key={r.room} className="flex flex-wrap items-center gap-2 border-2 border-border bg-bg2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {icon?.(r)}
              <span className="truncate text-sm font-semibold">{r.name || r.room}</span>
              {muteState[r.room] && <VolumeX size={12} className="text-muted-foreground" />}
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">{r.room}</div>
          </div>
          <button className="pixel-btn pixel-btn-sm" disabled={joiningRoom === r.room} onClick={() => onOpen(r)}>
            <RefreshCw size={12} /> {typeof actionLabel === "function" ? actionLabel(r) : actionLabel}
          </button>
          <button
            className="pixel-btn pixel-btn-sm" aria-label="Toggle mute for this room"
            onClick={() => { const next = !muteState[r.room]; setRoomMuted(r.room, r.kind, r.name, next); setMuteState((m) => ({ ...m, [r.room]: next })); }}
          >
            {muteState[r.room] ? <Volume2 size={12} /> : <VolumeX size={12} />}
          </button>
        </div>
      ))}
    </div>
  );
}
