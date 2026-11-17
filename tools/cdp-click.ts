/**
 * Click a page element by regex over its text, using REAL CDP mouse events
 * (Input.dispatchMouseEvent) at the element's center — the reliable path in
 * headless when synthetic el.click() doesn't reach React's handlers.
 * Usage: bun tools/cdp-click.ts <port> <regex> [tabIndex]
 */
import { pageTarget, connect, cdp } from "./cdp-lib";
import { setTimeout as sleep } from "node:timers/promises";

async function main() {
  const port = Number(process.argv[2]);
  const pattern = new RegExp(process.argv[3] ?? ".", "i");
  const t = await pageTarget(port);
  const ws = await connect(t.webSocketDebuggerUrl);
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Page.enable");

  const findExpr = `(() => {
    const els = Array.from(document.querySelectorAll("button, a, [role='button']"));
    const matches = els.filter((e) => ${pattern.toString()}.test(e.innerText) || ${pattern.toString()}.test(e.getAttribute("aria-label") || ""));
    const vis = matches.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    return JSON.stringify(vis.map((e) => { const r = e.getBoundingClientRect(); return { text: e.innerText.slice(0, 30), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }));
  })()`;
  const res = await cdp(ws, "Runtime.evaluate", { expression: findExpr, returnByValue: true });
  const targets = JSON.parse(res.result.value) as Array<{ text: string; x: number; y: number }>;
  const first = targets[0];
  if (!first) {
    console.error(JSON.stringify({ clicked: false, reason: "no visible match for " + pattern }));
    process.exit(2);
  }
  const { x, y } = first;
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(600);
  const body = await cdp(ws, "Runtime.evaluate", { expression: "document.body.innerText.slice(0, 300)", returnByValue: true });
  console.log(JSON.stringify({ clicked: first.text, body: body.result.value }));
}
main().then(() => process.exit(0), (e) => { console.error("ERR: " + e.message); process.exit(1); });
