import { useEffect, useState } from "react";
import { Shuffle, Upload, Download, Trash2, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { AVATAR_BGS, AVATAR_COLORS, randomAvatar, type PixelAvatar } from "@/lib/pixel/pixelart";
import type { PeerSession } from "@/lib/pixel/session";
import type { Prefs } from "@/lib/pixel/storage";
import { cn } from "@/lib/utils";
import { resizeImage } from "./MediaPicker";
import { AvatarImg, Modal } from "./ui";

type Tab = "profile" | "privacy" | "app" | "security" | "data" | "diag" | "keys";

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  initialTab?: Tab | undefined;
  prefs: Prefs;
  setPrefs: (fn: (p: Prefs) => Prefs) => void;
  session: PeerSession | null;
  muted: boolean; setMuted: (v: boolean) => void;
  blocked: boolean; setBlocked: (v: boolean) => void;
  verified: boolean; setVerified: (v: boolean) => void;
  onClearChat: () => void;
  onExport: () => void;
  onClearAll: () => void;
  onReconnect: () => void;
  onLeave: () => void;
}

function Toggle({ label, desc, checked, onChange, scope }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void; scope?: "local" | "both" }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="text-sm font-medium">{label}</span>
        {scope && <span className={cn("ml-2 px-1 font-pixel text-[7px]", scope === "local" ? "bg-surface text-muted-foreground" : "bg-secondary text-secondary-foreground")}>{scope === "local" ? "LOCAL" : "NEEDS BOTH"}</span>}
        {desc && <span className="block text-xs text-muted-foreground">{desc}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={cn("pixel-surface relative mt-1 h-6 w-12 shrink-0", checked && "bg-primary")}>
        <span className={cn("absolute top-1 h-4 w-4 bg-foreground transition-all", checked ? "left-7" : "left-1")} />
      </button>
    </label>
  );
}

export function AvatarEditor({ prefs, setPrefs }: { prefs: Prefs; setPrefs: SettingsProps["setPrefs"] }) {
  const av: PixelAvatar = prefs.avatar.kind === "pixel" ? prefs.avatar : randomAvatar();
  const [mirror, setMirror] = useState(true);
  const [brush, setBrush] = useState<"1" | "2" | "0">("1");
  const set = (a: PixelAvatar) => setPrefs((p) => ({ ...p, avatar: a }));
  const paint = (i: number) => {
    const cells = av.cells.split("");
    cells[i] = cells[i] === brush ? "0" : brush;
    if (mirror) { const y = Math.floor(i / 8), x = i % 8; cells[y * 8 + (7 - x)] = cells[i]; }
    set({ ...av, cells: cells.join("") });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="grid grid-cols-8 gap-px bg-pixel-dark p-px" style={{ background: av.bg }}>
          {av.cells.split("").map((c, i) => (
            <button key={i} aria-label={`Pixel ${i}`} onClick={() => paint(i)} className="h-6 w-6 border border-pixel-dark/30" style={{ background: c === "1" ? av.fg : c === "2" ? av.accent : "transparent" }} />
          ))}
        </div>
        <div className="flex flex-col gap-2">
          <AvatarImg avatar={prefs.avatar} size={64} />
          <button className="pixel-btn pixel-btn-sm" onClick={() => set(randomAvatar())}><Shuffle size={12} /> Random</button>
          <label className="pixel-btn pixel-btn-sm cursor-pointer"><Upload size={12} /> Upload
            <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return;
              try { const url = await resizeImage(f, 96); setPrefs((p) => ({ ...p, avatar: { kind: "image", url } })); } catch { toast.error("Couldn't read image."); }
            }} />
          </label>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="pixel-label">Brush</span>
        {(["1", "2", "0"] as const).map((b) => (
          <button key={b} data-active={brush === b} className="pixel-tab pixel-surface px-2 py-1" onClick={() => setBrush(b)}>{b === "1" ? "Main" : b === "2" ? "Accent" : "Eraser"}</button>
        ))}
        <label className="ml-2 flex items-center gap-1"><input type="checkbox" checked={mirror} onChange={(e) => setMirror(e.target.checked)} className="accent-primary" /> Mirror</label>
      </div>
      {(["fg", "accent", "bg"] as const).map((k) => (
        <div key={k} className="flex flex-wrap items-center gap-2">
          <span className="pixel-label w-14">{k === "fg" ? "Main" : k === "accent" ? "Accent" : "Back"}</span>
          {(k === "bg" ? AVATAR_BGS : AVATAR_COLORS).map((c) => (
            <button key={c} aria-label={c} onClick={() => set({ ...av, [k]: c })} className={cn("h-6 w-6 border-2", av[k] === c ? "border-foreground" : "border-pixel-dark")} style={{ background: c }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SettingsPanel(p: SettingsProps) {
  const [tab, setTab] = useState<Tab>(p.initialTab ?? "profile");
  const [diag, setDiag] = useState<Record<string, string>>({});
  useEffect(() => { if (p.open && p.initialTab) setTab(p.initialTab); }, [p.open, p.initialTab]);
  useEffect(() => {
    if (!p.open || tab !== "diag" || !p.session) return;
    const run = () => p.session!.diagnostics().then(setDiag);
    run();
    const t = setInterval(run, 2000);
    return () => clearInterval(t);
  }, [p.open, tab, p.session]);

  const up = <K extends keyof Prefs>(k: K, v: Prefs[K]) => p.setPrefs((x) => ({ ...x, [k]: v }));
  const TABS: [Tab, string][] = [["profile", "Profile"], ["privacy", "Privacy"], ["app", "Theme & sound"], ["security", "Security"], ["data", "Data"], ["diag", "Diagnostics"], ["keys", "Shortcuts"]];

  return (
    <Modal open={p.open} onClose={p.onClose} title="Settings" wide>
      <div className="flex flex-col gap-4 sm:flex-row">
        <nav className="pixel-scroll flex gap-1 overflow-x-auto sm:w-40 sm:flex-col">
          {TABS.map(([id, l]) => <button key={id} data-active={tab === id} className="pixel-tab shrink-0 px-3 py-2 text-left text-xs" onClick={() => setTab(id)}>{l}</button>)}
        </nav>
        <div className="min-w-0 flex-1 space-y-3">
          {tab === "profile" && (
            <>
              <label className="flex flex-col gap-1"><span className="pixel-label">Username</span>
                <input className="pixel-input" maxLength={32} value={p.prefs.username} onChange={(e) => up("username", e.target.value)} /></label>
              <label className="flex flex-col gap-1"><span className="pixel-label">Pixel status</span>
                <input className="pixel-input" maxLength={60} value={p.prefs.status} onChange={(e) => up("status", e.target.value)} placeholder="🎮 Playing, 💤 AFK…" /></label>
              <div className="flex flex-wrap gap-2">
                {["🟢 Online", "🎮 Gaming", "💤 AFK", "📚 Busy", "☕ Break"].map((s) => <button key={s} className="pixel-surface px-2 py-1 text-xs" onClick={() => up("status", s)}>{s}</button>)}
              </div>
              <span className="pixel-label">Avatar</span>
              <AvatarEditor prefs={p.prefs} setPrefs={p.setPrefs} />
            </>
          )}
          {tab === "privacy" && (
            <>
              <Toggle scope="both" label="Read receipts" desc="Tells your friend when you've read messages. Shown only if both of you enable it." checked={p.prefs.readReceipts} onChange={(v) => up("readReceipts", v)} />
              <Toggle scope="both" label="Typing indicator" desc="Shares when you're typing." checked={p.prefs.typingIndicator} onChange={(v) => up("typingIndicator", v)} />
              <Toggle scope="local" label="Save chat history on this device" desc="Off by default. Text-only history is stored in this browser (files are not kept)." checked={p.prefs.saveHistory} onChange={(v) => up("saveHistory", v)} />
              <Toggle scope="local" label="Auto-delete saved history after 24 hours" checked={p.prefs.autoDelete24h} onChange={(v) => up("autoDelete24h", v)} />
              <Toggle scope="local" label="Mute this conversation" desc="No sounds or notifications." checked={p.muted} onChange={p.setMuted} />
              <Toggle scope="local" label="Block incoming messages" desc="Drops messages, files and calls from this session. The other person isn't told." checked={p.blocked} onChange={p.setBlocked} />
              <Toggle scope="local" label="GIF search (GIPHY)" desc="Sends search terms and your IP to GIPHY. Not end-to-end encrypted. Uses the API key built into this app (.env)." checked={p.prefs.giphyEnabled} onChange={(v) => up("giphyEnabled", v)} />
              <label className="flex items-center justify-between gap-4 py-2"><span className="text-sm">Auto-disconnect session after</span>
                <select className="pixel-input !w-32 text-sm" value={p.prefs.sessionHours} onChange={(e) => up("sessionHours", Number(e.target.value))}>
                  {[0.5, 1, 2, 4, 8, 24].map((h) => <option key={h} value={h}>{h < 1 ? "30 min" : `${h} h`}</option>)}
                </select></label>
            </>
          )}
          {tab === "app" && (
            <>
              <div className="flex gap-3">
                {(["dark", "light"] as const).map((t) => <button key={t} className={cn("pixel-btn pixel-btn-sm", p.prefs.theme === t && "pixel-btn-primary")} onClick={() => up("theme", t)}>{t}</button>)}
              </div>
              <Toggle label="Retro sound effects" checked={p.prefs.sounds} onChange={(v) => up("sounds", v)} />
              <Toggle label="Desktop notifications" desc="Shown when the tab is in the background." checked={p.prefs.notifications} onChange={async (v) => {
                if (v && "Notification" in window) {
                  const r = await Notification.requestPermission();
                  if (r !== "granted") { toast.error("Notifications are blocked in your browser settings."); return; }
                }
                up("notifications", v);
              }} />
            </>
          )}
          {tab === "security" && (
            <div className="space-y-3 text-sm">
              {p.session?.fingerprint ? (
                <>
                  <p className="flex items-center gap-2 text-primary"><ShieldCheck size={16} /> End-to-end encryption active (AES-GCM-256, ECDH P-256, HKDF-SHA-256).</p>
                  <div className="pixel-surface p-3"><span className="pixel-label">Safety code</span><div className="mt-2 font-mono text-base tracking-wider text-secondary">{p.session.fingerprint}</div></div>
                  <p className="text-muted-foreground">Compare this code with your friend over a different channel (in person, a phone call). If it matches, nobody is intercepting. If it differs, leave the room.</p>
                  <div className="flex flex-wrap gap-3">
                    <button className="pixel-btn pixel-btn-sm pixel-btn-primary" onClick={() => p.setVerified(true)} disabled={p.verified}>{p.verified ? "Verified ✓" : "Codes match"}</button>
                    <button className="pixel-btn pixel-btn-sm pixel-btn-danger" onClick={() => { toast.error("Codes don't match — leaving for your safety."); p.onLeave(); }}>Codes differ</button>
                  </div>
                </>
              ) : <p className="text-muted-foreground">Not connected — no session keys exist.</p>}
              <div className="pixel-surface space-y-2 p-3 text-xs text-muted-foreground">
                <p className="flex items-center gap-2 font-semibold text-foreground"><ShieldAlert size={14} /> Limitations</p>
                <p>• Not independently audited. Browser-based encryption depends on the integrity of this website's code and your browser.</p>
                <p>• Malware, a compromised device or malicious extensions can read messages.</p>
                <p>• Direct P2P exposes your IP address to your friend. STUN servers see connection metadata. Message sizes and timing are visible on the network.</p>
                <p>• Voice/video use WebRTC's DTLS-SRTP; its keys are bound to the same verified DTLS fingerprints.</p>
                <p>• Keys live only in memory and are discarded when you leave. They are never saved to storage.</p>
              </div>
            </div>
          )}
          {tab === "data" && (
            <div className="flex flex-col items-start gap-4">
              <button className="pixel-btn pixel-btn-sm" onClick={p.onExport}><Download size={12} /> Export chat (JSON)</button>
              <button className="pixel-btn pixel-btn-sm" onClick={p.onClearChat}><Trash2 size={12} /> Clear chat on this device</button>
              <button className="pixel-btn pixel-btn-sm pixel-btn-danger" onClick={p.onLeave}>Leave room & delete session keys</button>
              <button className="pixel-btn pixel-btn-sm pixel-btn-danger" onClick={p.onClearAll}>Clear ALL local data</button>
              <p className="text-xs text-muted-foreground">Clearing data here never deletes what your friend already received or saved.</p>
            </div>
          )}
          {tab === "diag" && (
            <div className="space-y-3">
              <table className="w-full text-xs"><tbody>
                {Object.entries(diag).map(([k, v]) => <tr key={k} className="border-b border-border/40"><td className="py-1 pr-3 text-muted-foreground">{k}</td><td className="py-1 font-mono">{v}</td></tr>)}
              </tbody></table>
              {!p.session && <p className="text-sm text-muted-foreground">No active connection.</p>}
              <button className="pixel-btn pixel-btn-sm" onClick={p.onReconnect}><RefreshCw size={12} /> Reconnect</button>
              <p className="text-xs text-muted-foreground">"relay" routes are not used (no TURN). If both networks block direct links, connection may fail.</p>
            </div>
          )}
          {tab === "keys" && (
            <table className="w-full text-sm"><tbody>
              {[["Enter", "Send message"], ["Shift + Enter", "New line"], ["Ctrl/⌘ + K", "Search messages"], ["Ctrl/⌘ + E", "Emoji picker"], ["Ctrl/⌘ + Shift + S", "Sticker picker"], ["Ctrl/⌘ + ,", "Settings"], ["Esc", "Close panel / cancel reply"], [":word", "Emoji autocomplete"]].map(([k, v]) => (
                <tr key={k} className="border-b border-border/40"><td className="py-2 pr-4"><kbd className="pixel-surface px-2 py-0.5 font-mono text-xs">{k}</kbd></td><td>{v}</td></tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>
    </Modal>
  );
}
