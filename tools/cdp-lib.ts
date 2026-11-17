/** Shared CDP helpers for real-browser Pixolark validation (bun).
 *  All interactions use REAL Input events (mouse/keyboard), not synthetic
 *  DOM clicks — headless Chrome's React handlers only respond to these. */
import { setTimeout as sleep } from "node:timers/promises";

export interface Target { id: string; type: string; url: string; webSocketDebuggerUrl: string }

export const base = (port: number) => "http://127.0.0.1:" + port;

export async function pageTarget(port: number): Promise<Target> {
  const list = (await (await fetch(base(port) + "/json/list")).json()) as Target[];
  const page = list.find((t) => t.type === "page" && !t.url.startsWith("chrome://"));
  if (!page) throw new Error("no page target");
  return page;
}

export function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(url);
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error("ws error"));
  });
}

export type WS = Awaited<ReturnType<typeof connect>>;

export function cdp(ws: WS, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === id) {
        ws.removeEventListener("message", onMsg);
        if (msg.error) reject(new Error(method + ": " + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(method + " timeout")), 70_000);
  });
}

export async function evalJs(ws: WS, expr: string): Promise<any> {
  const res = await cdp(ws, "Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) {
    throw new Error("page threw: " + (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
  }
  return res.result?.value;
}

/** Attach to the first page target and navigate it. */
export async function openApp(port: number, url: string): Promise<WS> {
  const t = await pageTarget(port);
  const ws = await connect(t.webSocketDebuggerUrl);
  await cdp(ws, "Runtime.enable");
  await cdp(ws, "Page.enable");
  await cdp(ws, "Page.navigate", { url });
  await sleep(1500);
  return ws;
}

/** Attach without navigating (for follow-up commands on the open page). */
export async function attach(port: number): Promise<WS> {
  const t = await pageTarget(port);
  const ws = await connect(t.webSocketDebuggerUrl);
  await cdp(ws, "Runtime.enable");
  return ws;
}

export async function waitFor(ws: WS, expr: string, timeoutMs: number, step = 500): Promise<any> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const v = await evalJs(ws, expr);
      if (v) return v;
    } catch { /* not ready */ }
    await sleep(step);
  }
  throw new Error("waitFor timeout: " + expr.slice(0, 110));
}

export const bodyText = (ws: WS) => evalJs(ws, `document.body.innerText.slice(0, 700)`);

/** REAL mouse click on the first visible element matching the regex.
 *  Scrolls the element into view first — headless viewports are small and
 *  long pages push targets below the fold. */
export async function clickText(ws: WS, pattern: RegExp): Promise<{ text: string }> {
  const find = `(() => {
    const els = Array.from(document.querySelectorAll("button, a, [role='button'], [role='tab']"));
    const rx = ${pattern.toString()};
    const matches = els.filter((e) => rx.test(e.innerText) || rx.test(e.getAttribute("aria-label") || ""));
    if (!matches.length) return "[]";
    matches[0].scrollIntoView({ block: "center" });
    const vis = matches.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
    return JSON.stringify(vis.map((e) => { const r = e.getBoundingClientRect(); return { text: e.innerText.slice(0, 30), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; }));
  })()`;
  const res = await evalJs(ws, find);
  const targets = JSON.parse(res) as Array<{ text: string; x: number; y: number }>;
  const first = targets[0];
  if (!first) throw new Error("no visible match for " + pattern);
  await mouseClick(ws, first.x, first.y);
  return { text: first.text };
}

export async function mouseClick(ws: WS, x: number, y: number): Promise<void> {
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp(ws, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
}

/** Click + type real text into an element matched by a CSS selector. */
export async function fillSelector(ws: WS, selector: string, value: string): Promise<void> {
  const res = await evalJs(ws, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    el.focus();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  if (!res) throw new Error("no element for selector " + selector);
  const { x, y } = JSON.parse(res) as { x: number; y: number };
  await mouseClick(ws, x, y);
  await cdp(ws, "Input.insertText", { text: value });
  await sleep(300);
}
