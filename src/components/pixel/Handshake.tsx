import { useCallback, useEffect, useState } from "react";
import { ScanLine, ShieldCheck, Info, ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { decodeConnection, isValidRoomId, normalizeRoomId } from "@/lib/pixel/codec";
import type { PeerSession } from "@/lib/pixel/session";
import { CopyButton, Loader, QrCode, QrScanner } from "./ui";

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return <span className="pixel-label">Code expires in {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

function Explainer() {
  return (
    <p className="flex gap-2 text-xs text-muted-foreground">
      <Info size={14} className="mt-0.5 shrink-0 text-secondary" />
      A Room ID alone can't connect two browsers. The codes carry each side's connection details (and a fingerprint of its public key — never a private key) so you can link up directly with no server in between.
    </p>
  );
}

export function HostWait({ session, onBack }: { session: PeerSession; onBack: () => void }) {
  const [answer, setAnswer] = useState("");
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, force] = useState(0);
  useEffect(() => session.on("state", () => force((x) => x + 1)), [session]);

  const submit = useCallback(async (code: string) => {
    setBusy(true); setErr(null);
    try { await session.acceptAnswer(code); } catch (e: any) { setErr(e.message); toast.error(e.message); } finally { setBusy(false); }
  }, [session]);

  const st = session.state;
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 p-4 lg:grid-cols-2">
      <div className="pixel-box flex flex-col items-center gap-5 p-6 text-center">
        <button onClick={onBack} className="pixel-btn pixel-btn-sm self-start"><ArrowLeft size={12} /> Back</button>
        <span className="pixel-label">Your room</span>
        <div className="font-pixel text-base text-secondary sm:text-lg">{session.roomId}</div>
        <p className="text-sm text-muted-foreground">Step 1 · Share this Room ID <b>and</b> the code below with your friend.</p>
        {session.localCode && <QrCode value={session.localCode} />}
        {session.localCode && <CopyButton text={session.localCode} label="Copy invite code" />}
        {session.localCode && <CopyButton text={`Join my Pixolark room ${session.roomId}\n\n${session.localCode}`} label="Copy ID + code" />}
        <Countdown until={session.codeExpiresAt} />
      </div>
      <div className="pixel-box flex flex-col gap-5 p-6" data-state={st} data-pc={session.pc.connectionState}>
        {st === "waiting" && (
          <>
            <div className="flex flex-col items-center gap-4 py-2">
              <Loader label="Waiting for peer" />
            </div>
            <p className="text-sm text-muted-foreground">Step 2 · When your friend sends back their <b>answer code</b>, paste or scan it here.</p>
            <textarea className="pixel-input pixel-scroll h-28 resize-none font-mono text-xs" placeholder="PXC1.…  (answer code)" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            {err && <p className="text-sm text-destructive">{err}</p>}
            <div className="flex flex-wrap gap-4">
              <button className="pixel-btn pixel-btn-primary" disabled={!answer.trim() || busy} onClick={() => submit(answer)}>Connect</button>
              <button className="pixel-btn" onClick={() => setScan(true)}><ScanLine size={14} /> Scan answer</button>
            </div>
          </>
        )}
        {(st === "connecting" || st === "handshake") && (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <Loader label={st === "connecting" ? "Linking browsers" : "Exchanging keys"} />
            <p className="text-sm text-muted-foreground">{st === "connecting" ? "Finding a direct route between you…" : "Verifying encryption keys…"}</p>
          </div>
        )}
        {st === "failed" && <p className="text-sm text-destructive">{session.error}</p>}
        <Explainer />
      </div>
      {scan && <QrScanner onClose={() => setScan(false)} onResult={(t) => { setScan(false); setAnswer(t); void submit(t); }} />}
    </div>
  );
}

export function GuestJoin({ onJoin, session, onBack, initialRoom }: { onJoin: (room: string, code: string) => Promise<void>; session: PeerSession | null; onBack: () => void; initialRoom?: string }) {
  const [room, setRoom] = useState(initialRoom ?? "");
  const [code, setCode] = useState("");
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, force] = useState(0);
  useEffect(() => session?.on("state", () => force((x) => x + 1)), [session]);

  const go = async (r: string, c: string) => {
    setErr(null);
    const nr = normalizeRoomId(r);
    if (!isValidRoomId(nr)) { setErr("Invalid Room ID. It looks like PX-XXXXX-XXXXX."); return; }
    if (!c.trim()) { setErr("Paste or scan the invite code from the room creator."); return; }
    setBusy(true);
    try { await onJoin(nr, c); } catch (e: any) { setErr(e.message ?? "Could not join."); } finally { setBusy(false); }
  };

  const onScanned = async (t: string) => {
    setScan(false);
    // Allow pasting "ID + code" bundles
    const m = t.match(/PXC1\.[A-Za-z0-9_-]+/);
    const c = m ? m[0] : t;
    setCode(c);
    if (!room) { try { const p = await decodeConnection(c); setRoom(p.room); } catch (e: any) { setErr(e.message); } }
  };

  if (session && session.state !== "failed" && session.state !== "closed") {
    const st = session.state;
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-8 p-4 lg:grid-cols-2">
        <div className="pixel-box flex flex-col items-center gap-5 p-6 text-center">
          <span className="pixel-label">Room {session.roomId}</span>
          <p className="text-sm text-muted-foreground">Step 2 · Send this <b>answer code</b> back to the room creator (QR or copy).</p>
          {session.localCode && <QrCode value={session.localCode} />}
          {session.localCode && <CopyButton text={session.localCode} label="Copy answer code" />}
        </div>
        <div className="pixel-box flex flex-col items-center justify-center gap-5 p-6 text-center">
          <Loader label={st === "waiting" ? "Waiting for host" : st === "connecting" ? "Linking browsers" : "Exchanging keys"} />
          <p className="text-sm text-muted-foreground">The chat opens automatically once the creator applies your answer and the keys are verified.</p>
          <Explainer />
          <button className="pixel-btn pixel-btn-sm" onClick={onBack}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <div className="pixel-box flex flex-col gap-5 p-6">
        <button onClick={onBack} className="pixel-btn pixel-btn-sm self-start"><ArrowLeft size={12} /> Back</button>
        <h2 className="font-pixel text-sm text-secondary">Join a room</h2>
        <label className="flex flex-col gap-2">
          <span className="pixel-label">Room ID</span>
          <input className="pixel-input font-mono uppercase" placeholder="PX-XXXXX-XXXXX" value={room} onChange={(e) => setRoom(e.target.value)} maxLength={20} autoFocus />
        </label>
        <label className="flex flex-col gap-2">
          <span className="pixel-label">Invite code</span>
          <textarea className="pixel-input pixel-scroll h-28 resize-none font-mono text-xs" placeholder="PXC1.…" value={code} onChange={(e) => onScannedPaste(e.target.value, setCode, setRoom, room)} />
        </label>
        {(err || session?.error) && <p className="text-sm text-destructive">{err ?? session?.error}</p>}
        <div className="flex flex-wrap gap-4">
          <button className="pixel-btn pixel-btn-primary" disabled={busy} onClick={() => go(room, code)}><ShieldCheck size={14} /> {busy ? "Preparing…" : "Confirm & join"}</button>
          <button className="pixel-btn" onClick={() => setScan(true)}><ScanLine size={14} /> Scan QR</button>
        </div>
        <Explainer />
      </div>
      {scan && <QrScanner onClose={() => setScan(false)} onResult={onScanned} />}
    </div>
  );
}

function onScannedPaste(v: string, setCode: (s: string) => void, setRoom: (s: string) => void, room: string) {
  const roomMatch = v.match(/PX-[A-Z0-9]{5}-[A-Z0-9]{5}/);
  const codeMatch = v.match(/PXC1\.[A-Za-z0-9_-]+/);
  if (roomMatch && !room) setRoom(roomMatch[0]);
  setCode(codeMatch && roomMatch ? codeMatch[0] : v);
}
