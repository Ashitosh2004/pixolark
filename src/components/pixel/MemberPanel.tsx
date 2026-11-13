/**
 * MemberPanel â€” roster + moderation surface for a group room.
 * Every action goes through the GroupApi (hostAct server-side rules on the host;
 * member requests ride g-req and are re-checked against the requester's verified
 * roster role), so the UI can only ever ask, never decide.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Check, Shield, UserCog, Volume2, VolumeX, UserMinus, Ban, ArrowUpRight, ScrollText } from "lucide-react";
import { ROLE_RANK, type GroupRole, type GroupSession } from "@/lib/pixel/group";
import { roomFingerprint } from "@/lib/pixel/discovery";
import { cn } from "@/lib/utils";
import type { GroupApi } from "./useGroup";
import { AvatarImg, Modal } from "./ui";

const ROLE_BADGE: Record<GroupRole, string> = {
  owner: "bg-primary text-primary-foreground",
  admin: "bg-secondary text-secondary-foreground",
  mod: "bg-surface text-foreground",
  member: "bg-muted text-muted-foreground",
};

interface Props {
  open: boolean;
  onClose: () => void;
  group: GroupSession;
  api: GroupApi;
}

export function MemberPanel({ open, onClose, group, api }: Props) {
  const [tab, setTab] = useState<"members" | "settings" | "log">("members");
  const snap = api.snap;
  const me = snap?.roster.find((r) => r.id === group.myId);
  const myRole = api.myRole;
  const canModerate = myRole === "owner" || myRole === "admin" || myRole === "mod";
  const canAdmin = myRole === "owner" || myRole === "admin";
  const pending = api.pending;

  const canActOn = (target: GroupRole) => myRole !== "member" && target !== "owner" && ROLE_RANK[myRole] > ROLE_RANK[target];

  const act = async (fn: () => unknown, done: string) => {
    await fn();
    toast(`${done} â€” the room's host decides based on your role.`);
  };

  const fingerprint = useMemo(() => (snap ? roomFingerprint(group.myId, snap.meta.room) : ""), [snap, group.myId]);

  if (!snap || !me) return null;
  const roster = [...snap.roster].sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.name.localeCompare(b.name));

  return (
    <Modal open={open} onClose={onClose} title={`${snap.meta.name} â€” members`} wide>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {([["members", "Members", UserCog], ["settings", "Room rules", Shield], ["log", "Audit log", ScrollText]] as const).map(([id, label, Icon]) => (
            <button key={id} className={cn("pixel-btn pixel-btn-sm", tab === id && "pixel-btn-primary")} onClick={() => setTab(id)}>
              <Icon size={12} /> {label}
            </button>
          ))}
        </div>
        <span className="pixel-label">You: {myRole}</span>
      </div>

      {tab === "members" && (
        <div className="flex flex-col gap-3">
          <div className="pixel-box bg-surface px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span><span className="font-semibold">{api.onlineCount}</span> online</span>
              <span><span className="font-semibold">{snap.roster.length}</span>/{snap.meta.cap} members</span>
              <span>Room <button className="underline" onClick={() => { void navigator.clipboard?.writeText(snap.meta.room); toast("Room code copied"); }}>{snap.meta.room}</button></span>
              <span>Room key check: <span className="font-mono">{fingerprint}</span></span>
            </div>
          </div>

          {pending.length > 0 && canAdmin && (
            <div className="flex flex-col gap-2 border-2 border-secondary p-2">
              <span className="pixel-label text-secondary">Join requests ({pending.length})</span>
              {pending.map((r) => (
                <div key={r.id} className="flex items-center gap-2">
                  <AvatarImg avatar={r.avatar} size={28} online={false} />
                  <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
                  <button className="pixel-btn pixel-btn-sm pixel-btn-primary" onClick={() => void act(() => api.mod.approve(r.id), "Approve request sent")}><Check size={12} /> Approve</button>
                  <button className="pixel-btn pixel-btn-sm pixel-btn-danger" onClick={() => void act(() => api.mod.reject(r.id), "Reject request sent")}>Reject</button>
                </div>
              ))}
            </div>
          )}
          {pending.length > 0 && !canAdmin && (
            <p className="text-xs text-muted-foreground">{pending.length} join request(s) waiting for an admin.</p>
          )}

          <div className="flex flex-col gap-2">
            {roster.map((r) => {
              const online = api.presence[r.id]?.online ?? false;
              const mutedUntil = snap.muted[r.id] ?? 0;
              const isMe = r.id === group.myId;
              return (
                <div key={r.id} className="flex flex-wrap items-center gap-2 border-2 border-border bg-bg2 px-2 py-1.5">
                  <AvatarImg avatar={r.avatar} size={30} online={online} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold">{r.name}{isMe ? " (you)" : ""}</span>
                      <span className={cn("px-1 font-pixel text-[8px] uppercase", ROLE_BADGE[r.role])}>{r.role}</span>
                      {r.pending && <span className="px-1 font-pixel text-[8px] uppercase bg-gold/30">pending</span>}
                      {mutedUntil > Date.now() && <VolumeX size={12} className="text-destructive" aria-label="muted" />}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">{r.status || " "}</div>
                  </div>
                  {canActOn(r.role) && (
                    <div className="flex flex-wrap items-center gap-1">
                      {canAdmin && (
                        <select
                          className="pixel-input !min-h-7 !w-auto px-1 py-0 text-xs" value={r.role} aria-label={`Role for ${r.name}`}
                          onChange={(e) => { const role = e.target.value as GroupRole; if (role !== r.role) void act(() => api.mod.setRole(r.id, role), `Role change to ${role} sent`); }}
                        >
                          <option value="member">member</option>
                          <option value="mod">mod</option>
                          <option value="admin">admin</option>
                        </select>
                      )}
                      {mutedUntil > Date.now()
                        ? <button className="pixel-btn pixel-btn-sm" onClick={() => void act(() => api.mod.unmute(r.id), "Unmute request sent")} title="Unmute"><Volume2 size={12} /></button>
                        : <button className="pixel-btn pixel-btn-sm" onClick={() => void act(() => api.mod.mute(r.id, 600_000), "Mute request sent (10 min)")} title="Mute 10 min"><VolumeX size={12} /></button>}
                      <button className="pixel-btn pixel-btn-sm" onClick={() => void act(() => api.mod.kick(r.id), "Kick request sent")} title="Remove from room"><UserMinus size={12} /></button>
                      {canAdmin && <button className="pixel-btn pixel-btn-sm pixel-btn-danger" onClick={() => void act(() => api.mod.ban(r.id), "Ban request sent")} title="Ban"><Ban size={12} /></button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {myRole === "owner" && (
            <div className="flex flex-col gap-2 border-2 border-dashed border-border p-2 text-sm">
              <span className="pixel-label"><ArrowUpRight size={12} className="inline" /> Transfer ownership</span>
              <p className="text-xs text-muted-foreground">Hand the room to a trusted admin before you leave. You keep admin rights.</p>
              <div className="flex flex-wrap gap-1">
                {snap.roster.filter((r) => r.role === "admin" && r.id !== group.myId).map((r) => (
                  <button key={r.id} className="pixel-btn pixel-btn-sm" onClick={() => { if (api.mod.transferOwnership(r.id)) toast(`Ownership transferred to ${r.name}`); else toast.error("Transfer failed â€” the host decides."); }}>
                    â†’ {r.name}
                  </button>
                ))}
                {snap.roster.filter((r) => r.role === "admin" && r.id !== group.myId).length === 0 && <span className="text-xs text-muted-foreground">No admins yet â€” promote one above first.</span>}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "settings" && <RoomRules api={api} canAdmin={canAdmin} />}
      {tab === "log" && <AuditLog api={api} />}
    </Modal>
  );
}

function RoomRules({ api, canAdmin }: { api: GroupApi; canAdmin: boolean }) {
  const snap = api.snap;
  const [name, setName] = useState(snap?.meta.name ?? "");
  const [desc, setDesc] = useState(snap?.meta.desc ?? "");
  const [rules, setRules] = useState(snap?.meta.rules ?? "");
  const [slow, setSlow] = useState(String(snap?.rules.slowModeSec ?? 0));
  const [per10, setPer10] = useState(String(snap?.rules.msgsPer10s ?? 12));
  if (!snap) return null;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="pixel-box bg-surface p-3 text-xs">
        <p><span className="font-semibold">Category:</span> {snap.meta.cat}</p>
        <p><span className="font-semibold">Region:</span> {snap.meta.region || "â€”"} Â· <span className="font-semibold">Language:</span> {snap.meta.lang}</p>
        <p><span className="font-semibold">Visibility:</span> {snap.meta.isPublic ? "Listed in Discover" : "Private (invite only)"}</p>
        <p><span className="font-semibold">Encryption:</span> sender-key chains, epoch {snap.epoch} â€” keys change whenever membership changes.</p>
      </div>
      {canAdmin ? (
        <>
          <label className="flex flex-col gap-1"><span className="pixel-label">Room name</span>
            <input className="pixel-input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className="pixel-label">Description</span>
            <input className="pixel-input" value={desc} maxLength={160} onChange={(e) => setDesc(e.target.value)} /></label>
          <label className="flex flex-col gap-1"><span className="pixel-label">Rules shown to members</span>
            <textarea className="pixel-input min-h-20" value={rules} maxLength={500} onChange={(e) => setRules(e.target.value)} /></label>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1"><span className="pixel-label">Slow mode (sec)</span>
              <input className="pixel-input w-24" type="number" min={0} max={300} value={slow} onChange={(e) => setSlow(e.target.value)} /></label>
            <label className="flex flex-col gap-1"><span className="pixel-label">Messages / 10 s</span>
              <input className="pixel-input w-24" type="number" min={1} max={60} value={per10} onChange={(e) => setPer10(e.target.value)} /></label>
          </div>
          <div className="flex justify-end gap-2">
            <button className="pixel-btn pixel-btn-primary" onClick={() => { api.mod.setGroupMeta({ name, desc, rules }); api.mod.setRules({ slowModeSec: Number(slow) || 0, msgsPer10s: Number(per10) || 12 }); toast("Changes requested"); }}>
              Apply changes
            </button>
          </div>
        </>
      ) : (
        <div className="text-xs text-muted-foreground">
          {snap.meta.rules ? <p className="whitespace-pre-wrap text-foreground">{snap.meta.rules}</p> : <p>No room rules published.</p>}
          <p className="mt-2">Slow mode: {snap.rules.slowModeSec}s between messages Â· max {snap.rules.msgsPer10s} msgs/10s.</p>
          <p>Only admins can change room settings.</p>
        </div>
      )}
    </div>
  );
}

function AuditLog({ api }: { api: GroupApi }) {
  const entries = api.audit;
  const nameOf = (id: string) => api.snap?.roster.find((r) => r.id === id)?.name ?? id.slice(0, 10) + "â€¦";
  return (
    <div className="flex flex-col gap-1 text-xs">
      {entries.length === 0 && <p className="text-muted-foreground">Nothing recorded yet. Moderation actions are logged here by the host.</p>}
      {[...entries].reverse().slice(0, 60).map((e, i) => (
        <div key={`${e.ts}-${i}`} className="flex gap-2 border-b border-border py-1">
          <span className="shrink-0 text-muted-foreground">{new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold">{nameOf(e.actor)}</span> {e.action.replace(":", " ")} <span className="text-muted-foreground">â†’ {e.target === "group" ? "room" : nameOf(e.target)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
