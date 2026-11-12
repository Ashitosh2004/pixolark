import { useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { X, Camera, ImageUp, Copy, Check } from "lucide-react";
import { avatarSrc, mascotSvg, svgUri, type Avatar } from "@/lib/pixel/pixelart";
import { cn } from "@/lib/utils";

export function Mascot({ size = 96, className }: { size?: number; className?: string }) {
  return <img src={svgUri(mascotSvg("bob"))} width={size} height={size * (12 / 14)} alt="Pixolark mascot" className={cn("pixelated", className)} />;
}

export function AvatarImg({ avatar, size = 40, online, className }: { avatar: Avatar; size?: number; online?: boolean | null; className?: string }) {
  return (
    <span className={cn("relative inline-block shrink-0", className)} style={{ width: size, height: size }}>
      <img src={avatarSrc(avatar)} alt="avatar" width={size} height={size} className="pixelated pixel-surface h-full w-full object-cover" />
      {online != null && (
        <span className={cn("absolute -bottom-1 -right-1 h-3 w-3 border-2 border-border", online ? "bg-primary" : "bg-muted-foreground")} aria-label={online ? "online" : "offline"} />
      )}
    </span>
  );
}

export function PixelBackground({ dense = false }: { dense?: boolean }) {
  const [stars] = useState(() =>
    Array.from({ length: dense ? 60 : 30 }, () => ({
      x: Math.random() * 100, y: Math.random() * 60, d: Math.random() * 3, s: Math.random() > 0.8 ? 4 : 2,
    })),
  );
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {stars.map((s, i) => (
        <span key={i} className="animate-twinkle absolute bg-foreground" style={{ left: `${s.x}%`, top: `${s.y}%`, width: s.s, height: s.s, animationDelay: `${s.d}s` }} />
      ))}
      <Cloud top="12%" delay="-10s" />
      <Cloud top="28%" delay="-38s" scale={0.7} />
    </div>
  );
}

function Cloud({ top, delay, scale = 1 }: { top: string; delay: string; scale?: number }) {
  return (
    <div className="animate-drift absolute opacity-20" style={{ top, animationDelay: delay }}>
      <div style={{ transform: `scale(${scale})` }} className="flex flex-col items-center">
        <div className="h-4 w-16 bg-foreground" />
        <div className="h-4 w-28 bg-foreground" />
        <div className="h-4 w-36 bg-foreground" />
      </div>
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 p-0 sm:items-center sm:p-4" onMouseDown={onClose} role="dialog" aria-modal aria-label={title}>
      <div className={cn("pixel-box animate-pop flex max-h-[92dvh] w-full flex-col", wide ? "sm:max-w-3xl" : "sm:max-w-lg")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b-4 border-border px-4 py-3">
          <h2 className="font-pixel text-xs text-secondary">{title}</h2>
          <button className="pixel-btn pixel-btn-sm pixel-icon-btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <div className="pixel-scroll overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(value, { errorCorrectionLevel: "L", margin: 2, width: size * 2, color: { dark: "#111318", light: "#F5F5F5" } })
      .then((u) => { setSrc(u); setErr(null); })
      .catch(() => setErr("This code is too long for a QR image. Use the copy button instead."));
  }, [value, size]);
  if (err) return <p className="text-sm text-muted-foreground">{err}</p>;
  return src ? <img src={src} width={size} height={size} alt="Connection QR code" className="pixelated pixel-surface" /> : <Loader label="Drawing QR" />;
}

export function CopyButton({ text, label = "Copy code" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="pixel-btn pixel-btn-gold"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch {
          const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
        }
        setDone(true); setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? "Copied!" : label}
    </button>
  );
}

export function Loader({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-3" role="status">
      <div className="relative h-4 w-40 overflow-hidden bg-background pixel-surface">
        <div className="animate-load absolute inset-y-0 w-10 bg-primary" />
      </div>
      <span className="pixel-label">{label}<span className="animate-blink">_</span></span>
    </div>
  );
}

/** QR scanner: native BarcodeDetector when available, jsQR fallback; also scans uploaded images. */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        const tick = () => {
          if (doneRef.current) return;
          if (v.videoWidth) {
            canvas.width = v.videoWidth; canvas.height = v.videoHeight;
            ctx.drawImage(v, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (r?.data) { doneRef.current = true; onResult(r.data); return; }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch (e: any) {
        setError(e?.name === "NotAllowedError" ? "Camera permission was denied. Allow camera access in your browser settings, or upload a screenshot of the QR code." : "No camera available. Upload a screenshot of the QR code instead.");
      }
    })();
    return () => { doneRef.current = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onResult]);

  const fromFile = async (f: File) => {
    const bmp = await createImageBitmap(f);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext("2d")!;
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height);
    const r = jsQR(d.data, d.width, d.height);
    if (r?.data) onResult(r.data); else setError("No QR code found in that image.");
  };

  return (
    <Modal open onClose={onClose} title="Scan QR code">
      <div className="flex flex-col items-center gap-4">
        {!error && <video ref={videoRef} playsInline muted className="pixel-surface aspect-square w-full max-w-sm bg-background object-cover" />}
        {error && <p className="text-sm text-destructive"><Camera className="mr-2 inline" size={14} />{error}</p>}
        <label className="pixel-btn cursor-pointer">
          <ImageUp size={14} /> Scan from image
          <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && fromFile(e.target.files[0])} />
        </label>
      </div>
    </Modal>
  );
}
