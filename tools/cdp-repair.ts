/** Repair session A's recents list (restore the group entry clobbered by the 1:1 rejoin bug). */
import { pageTarget, connect, evalJs } from "./cdp-lib";

async function main() {
  const port = Number(process.argv[2]);
  const roomId = process.argv[3] || "592302";
  const name = process.argv[4] || "Pixel Garden";
  const t = await pageTarget(port);
  const ws = await connect(t.webSocketDebuggerUrl);
  const r = await evalJs(ws, `(() => {
    const KEY = "pxc.recentRooms.v1";
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    const entry = { room: ${JSON.stringify(roomId)}, kind: "group", name: ${JSON.stringify(name)}, at: Date.now(), role: "host" };
    const next = [entry, ...list.filter((x) => !(x.room === entry.room && x.kind === "group"))];
    localStorage.setItem(KEY, JSON.stringify(next.slice(0, 12)));
    location.reload();
    return JSON.stringify(next.map((x) => x.room + ":" + x.kind));
  })()`);
  console.log(r);
}
main().then(() => process.exit(0), (e) => { console.error("ERR: " + e.message); process.exit(1); });
