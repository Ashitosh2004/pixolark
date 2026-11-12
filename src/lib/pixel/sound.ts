/** Original 8-bit style blips synthesized with WebAudio (no audio assets). */
let ctx: AudioContext | null = null;
let enabled = true;
export function setSoundEnabled(v: boolean) { enabled = v; }

type Note = [freq: number, dur: number];
const SFX: Record<string, Note[]> = {
  send: [[880, 0.05], [1320, 0.06]],
  receive: [[660, 0.05], [990, 0.08]],
  connect: [[523, 0.08], [659, 0.08], [784, 0.08], [1047, 0.14]],
  join: [[392, 0.07], [523, 0.1]],
  leave: [[523, 0.08], [392, 0.08], [262, 0.14]],
  click: [[1200, 0.025]],
  sticker: [[784, 0.05], [988, 0.05], [1175, 0.08]],
  ring: [[880, 0.12], [0, 0.06], [880, 0.12], [0, 0.3]],
  error: [[200, 0.12], [150, 0.18]],
};

export function play(name: keyof typeof SFX | string) {
  if (!enabled || typeof window === "undefined") return;
  try {
    ctx ??= new AudioContext();
    let t = ctx.currentTime;
    for (const [f, d] of SFX[name] ?? []) {
      if (f > 0) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "square";
        o.frequency.value = f;
        g.gain.setValueAtTime(0.06, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + d);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + d);
      }
      t += d;
    }
  } catch { /* audio unavailable */ }
}
