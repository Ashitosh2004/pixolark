import { useCallback, useEffect, useState } from "react";
import { ScanLine, ShieldCheck, Info, ArrowLeft, Share2, ClipboardPaste, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { decodeConnection, isValidRoomId, normalizeRoomId } from "@/lib/pixel/codec";
import type { PeerSession } from "@/lib/pixel/session";
import { publishSignal, fetchSignal, subscribeSignal } from "@/lib/pixel/signaling";
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
      Pixolark connects browsers directly using end-to-end encrypted WebRTC. You can connect automatically using just the 6-digit code, or manually via QR/copy codes.
    </p>
  );
}

export function HostWait({ session, onBack }: { session: PeerSession; onBack: () => void }) {
  const [, force] = useState(0);

  useEffect(() => session.on("state", () => force((x) => x + 1)), [session]);

  const submit = useCallback(
    async (code: string) => {
      try {
        await session.acceptAnswer(code);
      } catch (e: any) {
        toast.error(e.message);
      }
    },
    [session],
  );

  // Auto-signaling: publish offer and listen for guest answer automatically via 6-digit room code
  useEffect(() => {
    if (!session.localCode || session.state !== "waiting") return;
    void publishSignal(session.roomId, "offer", session.localCode);
    const unsub = subscribeSignal(session.roomId, "answer", (ans) => {
      if (session.state === "waiting") void submit(ans);
    });
    return unsub;
  }, [session.localCode, session.roomId, session.state, submit]);

  const inviteLink =
    typeof window !== "undefined"
      ? `${window.location.origin}/chat?mode=join&room=${session.roomId}`
      : "";

  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const handleShare = async () => {
    if (!inviteLink) return;
    try {
      await navigator.share({
        title: "Join my Pixolark room",
        text: `Join my private Pixolark room with code: ${session.roomId}`,
        url: inviteLink,
      });
    } catch {
      // User canceled share
    }
  };

  const st = session.state;

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-8 p-4 lg:grid-cols-2">
      {/* Left Column: 6-digit Code & QR */}
      <div className="pixel-box flex flex-col items-center gap-4 p-6 text-center">
        <button onClick={onBack} className="pixel-btn pixel-btn-sm self-start">
          <ArrowLeft size={12} /> Leave
        </button>
        <span className="pixel-label">6-Digit Room Code</span>
        <div className="font-pixel text-3xl tracking-widest text-secondary sm:text-4xl">
          {session.roomId}
        </div>
        <p className="text-xs text-muted-foreground">
          Tell your friend to enter this <b>6-digit code</b>, scan the QR, or use the 1-click link.
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

        <Countdown until={session.codeExpiresAt} label="Room valid for" />
      </div>

      {/* Right Column: Connection Status */}
      <div className="pixel-box flex flex-col gap-4 p-6" data-state={st} data-pc={session.pc.connectionState}>
        {st === "waiting" && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <Loader label="Waiting for friend" />
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <Sparkles size={14} /> Automatic 6-digit pairing active: your friend just needs code <b>{session.roomId}</b>
            </p>
            <p className="text-xs text-muted-foreground">
              The moment your friend scans your QR, opens your link or pastes the code, the room connects automatically — nothing else to copy or paste.
            </p>
          </div>
        )}

        {(st === "connecting" || st === "handshake") && (
          <div className="flex flex-col items-center gap-4 py-8 text-center">
            <Loader label={st === "connecting" ? "Linking browsers" : "Verifying keys"} />
            <p className="text-sm text-muted-foreground">
              {st === "connecting"
                ? "Connecting directly via WebRTC... (STUN/TURN active, up to 2 minutes allowed)"
                : "Exchanging cryptographic keys..."}
            </p>
            <ConnectingTimer />
          </div>
        )}

        {st === "failed" && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-destructive">{session.error}</p>
            <button className="pixel-btn pixel-btn-sm" onClick={onBack}>
              Back
            </button>
          </div>
        )}

        <Explainer />
      </div>
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
  initialRoom?: string | undefined;
  initialCode?: string | undefined;
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

  // Auto-signaling: once guest creates answer, broadcast it so host automatically receives it
  useEffect(() => {
    if (!session?.localCode || session.state !== "waiting") return;
    void publishSignal(session.roomId, "answer", session.localCode);
  }, [session?.localCode, session?.roomId, session?.state]);

  const go = async (r: string, c: string) => {
    setErr(null);
    let targetCode = c.trim();
    let targetRoom = normalizeRoomId(r);

    // If only 6-digit code was given, auto-fetch host's offer
    if (!targetCode && isValidRoomId(targetRoom)) {
      setBusy(true);
      try {
        const fetchedOffer = await fetchSignal(targetRoom, "offer");
        if (fetchedOffer) {
          targetCode = fetchedOffer;
          setCode(fetchedOffer);
        } else {
          setErr("No active host found for this 6-digit code yet. Ensure host is waiting, or paste their invite code/QR.");
          setBusy(false);
          return;
        }
      } catch {
        setErr("Could not reach pairing service. Please paste the invite code or scan host's QR.");
        setBusy(false);
        return;
      }
    }

    // If only code was pasted, extract room from payload automatically
    if (targetCode && (!targetRoom || !isValidRoomId(targetRoom))) {
      try {
        const payload = await decodeConnection(targetCode);
        targetRoom = normalizeRoomId(payload.room);
        setRoom(targetRoom);
      } catch (e: any) {
        setErr(e.message ?? "Could not decode connection code.");
        setBusy(false);
        return;
      }
    }

    if (!isValidRoomId(targetRoom)) {
      setErr("Enter a valid 6-digit Room Code or paste an invite code.");
      return;
    }
    if (!targetCode) {
      setErr("Enter the 6-digit room code or paste the invite code.");
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
      <div className="mx-auto w-full max-w-xl p-4">
        <div className="pixel-box flex flex-col items-center gap-5 p-8 text-center">
          <span className="pixel-label">Room {session.roomId}</span>
          <Loader
            label={
              st === "waiting"
                ? "Waiting for host to connect"
                : st === "connecting"
                  ? "Linking browsers"
                  : "Verifying keys"
            }
          />
          <p className="flex items-center justify-center gap-1.5 text-xs text-primary">
            <Sparkles size={14} /> Paired via code {session.roomId}! Auto-linking browsers...
          </p>
          <p className="text-sm text-muted-foreground">
            Connecting directly via WebRTC. (STUN/TURN active, up to 2 minutes connection window).
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
          <span className="pixel-label font-bold text-foreground">6-Digit Room Code (Fast Join)</span>
          <input
            className="pixel-input font-mono text-xl tracking-widest uppercase text-secondary"
            placeholder="e.g. 582914"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            maxLength={20}
            autoFocus
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            className="pixel-btn pixel-btn-primary flex-1"
            disabled={busy || !room.trim()}
            onClick={() => go(room, code)}
          >
            <ShieldCheck size={14} /> {busy ? "Connecting…" : "Join with 6-Digit Code"}
          </button>
          <button className="pixel-btn" onClick={() => setScan(true)}>
            <ScanLine size={14} /> Scan QR
          </button>
        </div>

        <div className="border-t border-border/40 pt-2">
          <span className="pixel-label">Or Paste Invite Code / 1-Click Link</span>
          <textarea
            className="pixel-input pixel-scroll mt-1 h-20 resize-none font-mono text-xs"
            placeholder="Paste invite link or full code (PXC1.…) if joining manually"
            value={code}
            onChange={(e) => onScannedPaste(e.target.value, setCode, setRoom, room)}
          />
          <div className="mt-2 flex gap-2">
            <button className="pixel-btn pixel-btn-sm" onClick={pasteClipboard}>
              <ClipboardPaste size={14} /> Paste from Clipboard
            </button>
          </div>
        </div>

        {err && <p className="text-sm text-destructive">{err}</p>}

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
