import { useCallback, useEffect, useState } from "react";
import { ScanLine, ShieldCheck, Info, ArrowLeft, Share2, ClipboardPaste } from "lucide-react";
import { toast } from "sonner";
import { decodeConnection, isValidRoomId, normalizeRoomId } from "@/lib/pixel/codec";
import type { PeerSession } from "@/lib/pixel/session";
import { CopyButton, Loader, QrCode, QrScanner } from "./ui";

function Countdown({ until, label = "Code valid for" }: { until: number; label?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((until - now) / 1000));
  return (
    <span className="pixel-label">
      {label} {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}

function ConnectingTimer() {
  const [seconds, setSeconds] = useState(120);
  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="pixel-label text-secondary">
      Connection window: {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} remaining
    </span>
  );
}

function Explainer() {
  return (
    <p className="flex gap-2 text-xs text-muted-foreground">
      <Info size={14} className="mt-0.5 shrink-0 text-secondary" />
      Because Pixolark is strictly peer-to-peer with no central database or message server, browsers exchange encrypted connection codes (via QR or copy) to locate each other directly.
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

  const submit = useCallback(
    async (code: string) => {
      setBusy(true);
      setErr(null);
      try {
        await session.acceptAnswer(code);
      } catch (e: any) {
        setErr(e.message);
        toast.error(e.message);
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setAnswer(text);
        void submit(text);
      }
    } catch {
      toast.error("Clipboard permission denied. Please paste manually into the box.");
    }
  };

  const inviteLink =
    typeof window !== "undefined" && session.localCode
      ? `${window.location.origin}/chat?mode=join&room=${session.roomId}&code=${encodeURIComponent(session.localCode)}`
      : "";

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const handleShare = async () => {
    if (!inviteLink) return;
    try {
      await navigator.share({
        title: "Join my Pixolark room",
        text: `Join my private Pixolark room: ${session.roomId}`,
        url: inviteLink,
      });
    } catch {
      // User canceled share
    }
  };

  const st = session.state;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 p-4 lg:grid-cols-2">
      {/* Left Column: Room ID & Invite */}
      <div className="pixel-box flex flex-col items-center gap-4 p-6 text-center">
        <button onClick={onBack} className="pixel-btn pixel-btn-sm self-start">
          <ArrowLeft size={12} /> Leave
        </button>
        <span className="pixel-label">6-Digit Room Code</span>
        <div className="font-pixel text-2xl tracking-widest text-secondary sm:text-3xl">
          {session.roomId}
        </div>
        <p className="text-xs text-muted-foreground">
          Step 1 · Ask your friend to scan this QR or share the invite link/code.
        </p>

        {session.localCode && <QrCode value={session.localCode} />}

        <div className="flex flex-wrap justify-center gap-2">
          {inviteLink && <CopyButton text={inviteLink} label="Copy 1-Click Link" />}
          {session.localCode && <CopyButton text={session.localCode} label="Copy Invite Code" />}
          {canShare && (
            <button className="pixel-btn pixel-btn-sm" onClick={handleShare}>
              <Share2 size={12} /> Share
            </button>
          )}
        </div>

        <Countdown until={session.codeExpiresAt} label="Invite valid for" />
      </div>

      {/* Right Column: Answer Code */}
      <div className="pixel-box flex flex-col gap-4 p-6" data-state={st} data-pc={session.pc.connectionState}>
        {st === "waiting" && (
          <>
            <div className="flex flex-col items-center gap-3 py-1">
              <Loader label="Waiting for friend" />
            </div>
            <p className="text-sm text-muted-foreground">
              Step 2 · When your friend creates their <b>answer code</b>, paste or scan it below:
            </p>
            <textarea
              className="pixel-input pixel-scroll h-28 resize-none font-mono text-xs"
              placeholder="Paste friend's answer code (PXC1.…) or scan their QR"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
            {err && <p className="text-sm text-destructive">{err}</p>}
            <div className="flex flex-wrap gap-3">
              <button
                className="pixel-btn pixel-btn-primary"
                disabled={!answer.trim() || busy}
                onClick={() => submit(answer)}
              >
                Connect
              </button>
              <button className="pixel-btn" onClick={pasteClipboard}>
                <ClipboardPaste size={14} /> Paste
              </button>
              <button className="pixel-btn" onClick={() => setScan(true)}>
                <ScanLine size={14} /> Scan friend's QR
              </button>
            </div>
          </>
        )}

        {(st === "connecting" || st === "handshake") && (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <Loader label={st === "connecting" ? "Linking browsers" : "Verifying keys"} />
            <p className="text-sm text-muted-foreground">
              {st === "connecting"
                ? "Connecting directly via WebRTC... Up to 2 minutes allowed for peer link."
                : "Exchanging cryptographic keys..."}
            </p>
            <ConnectingTimer />
          </div>
        )}

        {st === "failed" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-destructive">{session.error}</p>
            <button className="pixel-btn pixel-btn-primary self-start" onClick={() => submit(answer)}>
              Try Connecting Again
            </button>
          </div>
        )}

        <Explainer />
      </div>

      {scan && (
        <QrScanner
          onClose={() => setScan(false)}
          onResult={(t) => {
            setScan(false);
            setAnswer(t);
            void submit(t);
          }}
        />
      )}
    </div>
  );
}

export function GuestJoin({
  onJoin,
  session,
  onBack,
  initialRoom,
  initialCode,
}: {
  onJoin: (room: string, code: string) => Promise<void>;
  session: PeerSession | null;
  onBack: () => void;
  initialRoom?: string;
  initialCode?: string;
}) {
  const [room, setRoom] = useState(initialRoom ?? "");
  const [code, setCode] = useState(initialCode ?? "");
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, force] = useState(0);

  useEffect(() => session?.on("state", () => force((x) => x + 1)), [session]);

  // If initialCode was supplied in URL, extract room and auto-populate
  useEffect(() => {
    if (initialCode && !code) {
      setCode(initialCode);
      try {
        void decodeConnection(initialCode).then((p) => {
          if (p.room) setRoom(p.room);
        });
      } catch {
        // ignore
      }
    }
  }, [initialCode, code]);

  const go = async (r: string, c: string) => {
    setErr(null);
    let targetCode = c.trim();
    let targetRoom = normalizeRoomId(r);

    // If only code was pasted, extract room from payload automatically
    if (targetCode && (!targetRoom || !isValidRoomId(targetRoom))) {
      try {
        const payload = await decodeConnection(targetCode);
        targetRoom = normalizeRoomId(payload.room);
        setRoom(targetRoom);
      } catch (e: any) {
        setErr(e.message ?? "Could not decode connection code.");
        return;
      }
    }

    if (!isValidRoomId(targetRoom)) {
      setErr("Enter a valid 6-digit Room Code or paste an invite code.");
      return;
    }
    if (!targetCode) {
      setErr("Paste or scan the invite code from your friend.");
      return;
    }

    setBusy(true);
    try {
      await onJoin(targetRoom, targetCode);
    } catch (e: any) {
      setErr(e.message ?? "Could not join.");
    } finally {
      setBusy(false);
    }
  };

  const onScanned = async (t: string) => {
    setScan(false);
    const m = t.match(/PXC1\.[A-Za-z0-9_-]+/);
    const c = m ? m[0] : t;
    setCode(c);
    try {
      const p = await decodeConnection(c);
      if (p.room) setRoom(p.room);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const pasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        onScannedPaste(text, setCode, setRoom, room);
      }
    } catch {
      toast.error("Clipboard permission denied. Please paste manually into the box.");
    }
  };

  // If session is already created and waiting for host
  if (session && session.state !== "failed" && session.state !== "closed") {
    const st = session.state;
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-8 p-4 lg:grid-cols-2">
        <div className="pixel-box flex flex-col items-center gap-4 p-6 text-center">
          <span className="pixel-label">Room {session.roomId}</span>
          <p className="text-sm text-muted-foreground">
            Step 2 · Send this <b>Answer Code</b> back to your friend (show QR or copy):
          </p>
          {session.localCode && <QrCode value={session.localCode} />}
          {session.localCode && <CopyButton text={session.localCode} label="Copy Answer Code" />}
          <Countdown until={session.codeExpiresAt} label="Answer valid for" />
        </div>
        <div className="pixel-box flex flex-col items-center justify-center gap-5 p-6 text-center">
          <Loader
            label={
              st === "waiting"
                ? "Waiting for friend to connect"
                : st === "connecting"
                  ? "Linking browsers"
                  : "Verifying keys"
            }
          />
          <p className="text-sm text-muted-foreground">
            The chat connects automatically once your friend pastes or scans your answer code.
          </p>
          <ConnectingTimer />
          <Explainer />
          <button className="pixel-btn pixel-btn-sm" onClick={onBack}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-xl p-4">
      <div className="pixel-box flex flex-col gap-4 p-6">
        <button onClick={onBack} className="pixel-btn pixel-btn-sm self-start">
          <ArrowLeft size={12} /> Back
        </button>
        <h2 className="font-pixel text-sm text-secondary">Join Room</h2>

        <label className="flex flex-col gap-1">
          <span className="pixel-label">6-Digit Room Code (or leave blank if pasting code)</span>
          <input
            className="pixel-input font-mono uppercase text-base"
            placeholder="e.g. 582914"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            maxLength={20}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="pixel-label">Invite Code or 1-Click Link</span>
          <textarea
            className="pixel-input pixel-scroll h-24 resize-none font-mono text-xs"
            placeholder="Paste invite link or code (PXC1.…) here"
            value={code}
            onChange={(e) => onScannedPaste(e.target.value, setCode, setRoom, room)}
          />
        </label>

        {err && <p className="text-sm text-destructive">{err}</p>}

        <div className="flex flex-wrap gap-3">
          <button
            className="pixel-btn pixel-btn-primary"
            disabled={busy}
            onClick={() => go(room, code)}
          >
            <ShieldCheck size={14} /> {busy ? "Preparing…" : "Join & Generate Answer"}
          </button>
          <button className="pixel-btn" onClick={pasteClipboard}>
            <ClipboardPaste size={14} /> Paste
          </button>
          <button className="pixel-btn" onClick={() => setScan(true)}>
            <ScanLine size={14} /> Scan QR
          </button>
        </div>

        <Explainer />
      </div>

      {scan && <QrScanner onClose={() => setScan(false)} onResult={onScanned} />}
    </div>
  );
}

function onScannedPaste(
  v: string,
  setCode: (s: string) => void,
  setRoom: (s: string) => void,
  currentRoom: string,
) {
  // If a URL was pasted, parse search params
  if (v.includes("?") && (v.includes("code=") || v.includes("room="))) {
    try {
      const url = new URL(v.startsWith("http") ? v : `http://localhost/${v}`);
      const c = url.searchParams.get("code");
      const r = url.searchParams.get("room");
      if (c) setCode(decodeURIComponent(c));
      if (r && !currentRoom) setRoom(r);
      return;
    } catch {
      // ignore
    }
  }

  const roomMatch = v.match(/\b\d{6}\b/) || v.match(/PX-[A-Z0-9]{5}-[A-Z0-9]{5}/) || v.match(/PX-\d{6}/);
  const codeMatch = v.match(/PXC1\.[A-Za-z0-9_-]+/);
  if (roomMatch && !currentRoom) setRoom(roomMatch[0]);
  setCode(codeMatch ? codeMatch[0] : v);
}
