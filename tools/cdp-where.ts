/** What element actually sits at the computed Join-button coordinates? */
import { attach, evalJs } from "./cdp-lib";

async function main() {
  const port = Number(process.argv[2]);
  const ws = await attach(port);
  const r = await evalJs(ws, `(() => {
    const cards = Array.from(document.querySelectorAll("div.pixel-box"));
    const pg = cards.find((c) => c.innerText.includes("Pixel Garden"));
    if (!pg) return "no-card";
    const b = Array.from(pg.querySelectorAll("button")).find((x) => x.innerText.trim().toLowerCase() === "join");
    if (!b) return "no-button";
    const rect = b.getBoundingClientRect();
    const at = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const cardsInfo = cards.slice(0, 3).map((c) => c.innerText.slice(0, 40));
    return JSON.stringify({
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      atPoint: at ? { tag: at.tagName, cls: at.className.slice(0, 60), text: at.innerText.slice(0, 30) } : null,
      disabled: b.disabled,
      viewport: { w: innerWidth, h: innerHeight },
      firstCards: cardsInfo,
    });
  })()`);
  console.log(r);
}
main().then(() => process.exit(0), (e) => { console.error("ERR: " + e.message); process.exit(1); });
