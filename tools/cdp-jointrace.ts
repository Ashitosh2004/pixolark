/** Click Join on the Pixel Garden card and capture the page console live. */
import { attach, cdp, evalJs, mouseClick } from "./cdp-lib";
import { setTimeout as sleep } from "node:timers/promises";

async function main() {
  const port = Number(process.argv[2]);
  const ws = await attach(port);
  const logs: string[] = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.method === "Runtime.consoleAPICalled") {
      const line = msg.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ");
      logs.push(`${msg.params.type}: ${line}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      logs.push("EXCEPTION: " + JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 300));
    }
  });

  const btn = await evalJs(ws, `(() => {
    const cards = Array.from(document.querySelectorAll("div.pixel-box"));
    const pg = cards.find((c) => c.innerText.includes("Pixel Garden"));
    if (!pg) return null;
    const b = Array.from(pg.querySelectorAll("button")).find((x) => x.innerText.trim().toLowerCase() === "join");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  if (!btn) { console.log(JSON.stringify({ error: "no card/button", logs })); process.exit(2); }
  const { x, y } = JSON.parse(btn) as { x: number; y: number };
  await mouseClick(ws, x, y);
  await sleep(15000);
  console.log(JSON.stringify({ clicked: true, logs }, null, 1));
}
main().then(() => process.exit(0), (e) => { console.error("ERR: " + e.message); process.exit(1); });
