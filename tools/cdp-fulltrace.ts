/** Reload the joiner page with console capture from t=0, then join and dump logs. */
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
      logs.push("EXCEPTION: " + String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 400));
    }
    if (msg.method === "Log.entryAdded") {
      logs.push(`${msg.params.entry.level}: ${String(msg.params.entry.text).slice(0, 400)}`);
    }
  });
  await cdp(ws, "Log.enable");
  await cdp(ws, "Page.navigate", { url: "http://localhost:3000/chat" });
  await sleep(6000);
  // Click Discover
  const disc = await evalJs(ws, `(() => {
    const els = Array.from(document.querySelectorAll("button"));
    const m = els.filter((e) => /discover/i.test(e.innerText) && e.innerText.trim().length < 12);
    if (!m.length) return null;
    m[0].scrollIntoView({ block: "center" });
    const r = m[0].getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  if (!disc) { console.log(JSON.stringify({ fail: "no discover button", logs })); process.exit(2); }
  await mouseClick(ws, JSON.parse(disc).x, JSON.parse(disc).y);
  await sleep(12000);
  // Join on the Pixel Garden card (retry while the beacon list loads)
  let btn: string | null = null;
  for (let i = 0; i < 12 && !btn; i++) {
    btn = await evalJs(ws, `(() => {
    const cards = Array.from(document.querySelectorAll("div.pixel-box"));
    const pg = cards.find((c) => c.innerText.includes("Pixel Garden"));
    if (!pg) return null;
    const b = Array.from(pg.querySelectorAll("button")).find((x) => x.innerText.trim().toLowerCase() === "join");
    if (!b) return null;
    b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
    if (!btn) await sleep(3000);
  }
  if (!btn) { console.log(JSON.stringify({ fail: "no join button", logs })); process.exit(2); }
  await mouseClick(ws, JSON.parse(btn).x, JSON.parse(btn).y);
  await sleep(15000);
  const body = await evalJs(ws, `document.body.innerText.slice(0, 300)`);
  console.log(JSON.stringify({ body, logs }, null, 1));
}
main().then(() => process.exit(0), (e) => { console.error("ERR: " + e.message); process.exit(1); });
