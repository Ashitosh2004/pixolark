import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, PhoneOff, Phone, SwitchCamera, Volume2, VolumeX, Signal } from "lucide-react";
import type { PeerSession } from "@/lib/pixel/session";
import type { ChatApi } from "./useChat";
import type { PeerProfile } from "./types";
import { AvatarImg } from "./ui";
import { randomAvatar } from "@/lib/pixel/pixelart";
import { cn } from "@/lib/utils";

function VideoEl({ stream, muted, className, volume = 1, sinkId, onPlayingChange }: { stream: MediaStream | null; muted?: boolean; className?: string; volume?: number; sinkId?: string; onPlayingChange?: (playing: boolean) => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
    if (!stream) return;
    // Mobile browsers (iOS Safari in particular) stall a WebRTC <video> that was
    // hidden or not yet rendering when the stream attached. Keep nudging play()
    // until it sticks; a later tap anywhere also resumes it.
    const tryPlay = () => { if (el.paused) void el.play().catch(() => {}); };
    tryPlay();
    const iv = window.setInterval(tryPlay, 500);
    const onDown = () => tryPlay();
    window.addEventListener("pointerdown", onDown);
    return () => { window.clearInterval(iv); window.removeEventListener("pointerdown", onDown); };
  }, [stream]);
  useEffect(() => { if (ref.current) ref.current.volume = volume; }, [volume]);
  useEffect(() => { const el: any = ref.current; if (el && sinkId && el.setSinkId) el.setSinkId(sinkId).catch(() => {}); }, [sinkId]);
  // Report actual playback state — track.muted alone misses frames that arrive later.
  useEffect(() => {
    const el = ref.current;
    if (!el || !onPlayingChange) return;
    if (!stream) { onPlayingChange(false); return; }
    const report = () => onPlayingChange(!el.paused && !el.ended);
    report();
    const evs = ["playing", "pause", "waiting", "ended"] as const;
    evs.forEach((e) => el.addEventListener(e, report));
    return () => evs.forEach((e) => el.removeEventListener(e, report));
  }, [onPlayingChange, stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} className={className} />;
}

export function CallOverlay({ api, session, peer }: { api: ChatApi; session: PeerSession | null; peer: PeerProfile | null }) {
  const { call } = api;
  const [now, setNow] = useState(Date.now());
  const [rtt, setRtt] = useState<number | null>(null);
  const [vol, setVol] = useState(1);
  const [speakerOff, setSpeakerOff] = useState(false);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [sink, setSink] = useState("");
  const [hasMultiCam, setHasMultiCam] = useState(false);
  const [peerAvatar] = useState(randomAvatar);
  const [remotePlaying, setRemotePlaying] = useState(false);
  const [, force] = useState(0);
  const onRemotePlaying = useCallback((p: boolean) => setRemotePlaying(p), []);

  useEffect(() => {
    // React doesn't observe track mute/unmute — re-render when remote video
    // actually starts/stops sending frames (tracks arrive muted on mobile).
    const s = api.remoteStream;
    if (!s) { setRemotePlaying(false); return; }
    const bump = () => force((x) => x + 1);
    const tracks = s.getVideoTracks();
    tracks.forEach((t) => { t.addEventListener("mute", bump); t.addEventListener("unmute", bump); });
    return () => tracks.forEach((t) => { t.removeEventListener("mute", bump); t.removeEventListener("unmute", bump); });
  }, [api.remoteStream]);

  useEffect(() => {
    if (call.phase !== "active") return;
    const t = setInterval(async () => { setNow(Date.now()); setRtt((await session?.rttMs()) ?? null); }, 1000);
    navigator.mediaDevices?.enumerateDevices().then((d) => {
      setOutputs(d.filter((x) => x.kind === "audiooutput" && x.deviceId));
      setHasMultiCam(d.filter((x) => x.kind === "videoinput").length > 1);
    }).catch(() => {});
    return () => clearInterval(t);
  }, [call.phase, session]);

  if (call.phase === "idle") return null;
  const name = peer?.name ?? "Friend";
  const avatar = peer?.avatar ?? peerAvatar;
  const remoteHasVideo = (!!api.remoteStream?.getVideoTracks().some((t) => t.readyState === "live" && !t.muted)) || remotePlaying;
  const dur = call.startedAt ? Math.floor((now - call.startedAt) / 1000) : 0;
  const quality = rtt == null ? "…" : rtt < 150 ? "Good" : rtt < 350 ? "Fair" : "Poor";

  if (call.phase === "incoming") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4" role="alertdialog" aria-label="Incoming call">
        <div className="pixel-box animate-pop flex w-full max-w-sm flex-col items-center gap-5 p-8 text-center">
          <AvatarImg avatar={avatar} size={96} className="animate-bob" />
          <div className="font-pixel text-xs text-secondary">Incoming {call.incomingVideo ? "video" : "voice"} call</div>
          <div className="text-lg font-semibold">{name}</div>
          <div className="flex flex-wrap justify-center gap-4">
            <button className="pixel-btn pixel-btn-danger" onClick={api.rejectCall}><PhoneOff size={14} /> Decline</button>
            <button className="pixel-btn pixel-btn-primary" onClick={() => api.acceptCall(false)}><Phone size={14} /> Voice</button>
            {call.incomingVideo && <button className="pixel-btn pixel-btn-gold" onClick={() => api.acceptCall(true)}><Video size={14} /> Video</button>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="relative flex-1 overflow-hidden bg-pixel-dark">
        {/* Keep the remote element always rendered — display:none stalls WebRTC
            video on mobile browsers. Fade it in/out instead. */}
        <VideoEl stream={api.remoteStream} muted={speakerOff} volume={vol} sinkId={sink} onPlayingChange={onRemotePlaying} className={cn("h-full w-full object-contain", !remoteHasVideo && "opacity-0")} />
        {!remoteHasVideo && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <AvatarImg avatar={avatar} size={128} className="animate-bob" />
            <div className="text-lg font-semibold">{name}</div>
          </div>
        )}
        {api.localStream?.getVideoTracks().length ? (
          <VideoEl stream={api.localStream} muted className="pixel-surface absolute bottom-4 right-4 h-36 w-28 -scale-x-100 object-cover sm:h-48 sm:w-36" />
        ) : null}
        <div className="absolute left-4 top-4 flex flex-col gap-2">
          <span className="pixel-surface px-3 py-2 font-pixel text-[10px]">
            {call.phase === "outgoing" ? <>Calling {name}<span className="animate-blink">…</span></> : `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, "0")}`}
          </span>
          {call.phase === "active" && (
            <span className="pixel-surface flex items-center gap-2 px-3 py-1 text-xs"><Signal size={12} className={quality === "Good" ? "text-primary" : quality === "Fair" ? "text-secondary" : "text-destructive"} /> {quality}{rtt != null ? ` · ${Math.round(rtt)} ms` : ""}</span>
          )}
          <span className="pixel-surface px-3 py-1 text-[10px] text-muted-foreground">DTLS-SRTP encrypted · direct P2P</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3 border-t-4 border-border bg-bg2 p-4" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
        <button className="pixel-btn pixel-icon-btn" onClick={api.toggleMic} aria-label={call.micOn ? "Mute microphone" : "Unmute microphone"}>{call.micOn ? <Mic size={18} /> : <MicOff size={18} className="text-destructive" />}</button>
        {call.video && <button className="pixel-btn pixel-icon-btn" onClick={api.toggleCam} aria-label={call.camOn ? "Turn camera off" : "Turn camera on"}>{call.camOn ? <Video size={18} /> : <VideoOff size={18} className="text-destructive" />}</button>}
        {call.video && hasMultiCam && <button className="pixel-btn pixel-icon-btn" onClick={api.switchCamera} aria-label="Switch camera"><SwitchCamera size={18} /></button>}
        <button className="pixel-btn pixel-icon-btn" onClick={() => setSpeakerOff((v) => !v)} aria-label="Toggle speaker">{speakerOff ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
        <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => setVol(Number(e.target.value))} className="w-24 accent-primary" aria-label="Speaker volume" />
        {outputs.length > 1 && (
          <select className="pixel-input !w-auto text-xs" value={sink} onChange={(e) => setSink(e.target.value)} aria-label="Audio output">
            <option value="">Default speaker</option>
            {outputs.map((o) => <option key={o.deviceId} value={o.deviceId}>{o.label || "Speaker"}</option>)}
          </select>
        )}
        <button className="pixel-btn pixel-btn-danger" onClick={api.endCall}><PhoneOff size={16} /> End</button>
      </div>
    </div>
  );
}
