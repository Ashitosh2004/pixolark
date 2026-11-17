/** List clickable elements (buttons/links/roles) with text + tag. */
import { pageTarget, connect, evalJs } from "./cdp-lib";

async function main() {
  const port = Number(process.argv[2]);
  const t = await pageTarget(port);
  const ws = await connect(t.webSocketDebuggerUrl);
  const r = await evalJs(ws, `(() => {
    const els = Array.from(document.querySelectorAll("button, a, [role='tab'], [role='button']"));
    return JSON.stringify(els.map((e) => ({ tag: e.tagName, text: e.innerText.slice(0, 30), aria: e.getAttribute("aria-label") })));
  })()`);
  console.log(r);
}
main().then(() => process.exit(0), (e) => { console.error("ERR: " + e.message); process.exit(1); });
