/** One-off page inspection: composer elements + message bubbles. */
import { pageTarget, connect, evalJs } from "./cdp-lib";

async function main() {
  const port = Number(process.argv[2]);
  const t = await pageTarget(port);
  const ws = await connect(t.webSocketDebuggerUrl);
  const r = await evalJs(ws, `(() => {
    const tas = Array.from(document.querySelectorAll("textarea"));
    const eds = Array.from(document.querySelectorAll("[contenteditable='true']"));
    const inputs = Array.from(document.querySelectorAll("input"));
    const main = document.querySelector("main");
    return JSON.stringify({
      tas: tas.map((t) => ({ ph: t.placeholder, cls: t.className.slice(0, 50) })),
      eds: eds.map((e) => ({ cls: e.className.slice(0, 50), text: e.innerText.slice(0, 30) })),
      inputs: inputs.map((i) => ({ type: i.type, ph: i.placeholder })),
      mainTag: main ? main.tagName : null,
      bodyLen: document.body.innerText.length,
    });
  })()`);
  console.log(r);
}
main().then(() => process.exit(0), (e) => { console.error("ERR: " + e.message); process.exit(1); });
