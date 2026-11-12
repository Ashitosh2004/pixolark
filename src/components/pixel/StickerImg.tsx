import { useEffect, useRef, useState } from "react";
import { stickerAsset } from "@/lib/pixel/stickerlib";
import { cn } from "@/lib/utils";

const reduceQuery = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Built-in animated sticker. Shows the static thumbnail until it is on screen, then swaps to the
 *  animated file; offscreen or reduced-motion stickers fall back to the thumbnail (stops decoding). */
export function StickerImg({ id, alt, size, animate = true, reduceMotion = false, className }: { id: string; alt: string; size: number; animate?: boolean; reduceMotion?: boolean; className?: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el || typeof IntersectionObserver === "undefined") { setVisible(true); return undefined; }
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting), { rootMargin: "40px" });
    io.observe(el); return () => io.disconnect();
  }, []);
  const play = animate && visible && !reduceMotion && !reduceQuery();
  const src = stickerAsset(id, !play) ?? "";
  return <img ref={ref} src={src} alt={alt} width={size} height={size} loading="lazy" decoding="async" draggable={false} className={cn("pixelated object-contain", className)} style={{ width: size, height: size }} />;
}
