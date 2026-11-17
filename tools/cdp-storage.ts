/** Dump the app's localStorage keys (recent rooms / bookmarks / lastRoom). */
import { pageTarget, connect, evalJs } from "./cdp-lib";

async function main() {
  const port = Number(process.argv[2]);
  const t = await pageTarget(port);
  const ws = await connect(t.webSocketDebuggerUrl);
  const r = await evalJs(ws, `(() => {
    const keys = Object.keys(localStorage);
    const out = {};
    for (const k of keys) out[k] = localStorage.getItem(k);
    return JSON.stringify(out);
  })()`);
  console.log(r);
}
main().then(() => process.exit(0), (e) => { console.error("ERR: " + e.message); process.exit(1); });
