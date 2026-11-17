/**
 * CDP driver for real-browser session validation of Pixolark (Input-event based).
 *
 * Drives headless Chrome instances (separate profiles = two real devices) over
 * the DevTools protocol with REAL mouse/keyboard input. Nothing simulated:
 * the actual wizard forms, Discover listing, coordinator handshake and
 * DataChannel traffic run inside real Chrome.
 *
 * Usage: bun tools/cdp-driver.ts <cdpPort> <command> [args...]
 *   nav <url>              navigate the page
 *   state                  dump the page body text
 *   waitText <text> <ms>   poll until text appears in the page body
 *   host                   full public-group host flow → prints the room id
 *   rehost <room>          MY ROOMS → host again (ownership recovery)
 *   join <room>            Discover → Join → wait for the room
 *   send <text>            send a chat message in the open group
 *   msgs                   dump the last message bubbles
 *   leave                  leave the current room
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  attach, bodyText, clickText, connect, cdp, evalJs, fillSelector, openApp, waitFor, type WS,
} from "./cdp-lib";

const port = Number(process.argv[2]);
const cmd = process.argv[3];
const arg1 = process.argv[4] ?? "";
const arg2 = Number(process.argv[5] ?? 20000);

const inRoom = () => evalJs(ws, `(() => !!(document.body.innerText.includes("MEMBERS") && document.body.innerText.includes("Encrypted room")))()`);

let ws: WS;

async function main() {
  switch (cmd) {
    case "nav": {
      ws = await openApp(port, arg1);
      await sleep(1200);
      console.log(JSON.stringify({ body: await bodyText(ws) }));
      break;
    }
    case "state": {
      ws = await attach(port);
      console.log(JSON.stringify({ body: await bodyText(ws) }));
      break;
    }
    case "waitText": {
      ws = await attach(port);
      await waitFor(ws, `document.body.innerText.includes(${JSON.stringify(arg1)})`, arg2);
      console.log(JSON.stringify({ found: arg1 }));
      break;
    }
    case "host": {
      ws = await openApp(port, arg1 || "http://localhost:3000/chat");
      await waitFor(ws, `document.body.innerText.length > 100`, 30000);
      await clickText(ws, /groups/i);
      await waitFor(ws, `/host a new group/i.test(document.body.innerText)`, 15000);
      await clickText(ws, /host a new group/i);
      await waitFor(ws, `/1\\. basics|group name/i.test(document.body.innerText)`, 15000);
      await fillSelector(ws, "input[placeholder*='Pixel Garden']", "Pixel Garden");
      await fillSelector(ws, "input[placeholder*='about']", "Cozy public room for the two-session test");
      await clickText(ws, /^next$/i);
      await sleep(800);
      await clickText(ws, /^next$/i);
      await sleep(800);
      await clickText(ws, /open room/i);
      await waitFor(ws, `/members/i.test(document.body.innerText) && /encrypted room/i.test(document.body.innerText)`, 30000);
      const roomId = await evalJs(ws, `JSON.parse(localStorage.getItem("pxc.lastRoom.v1")).roomId`);
      console.log(JSON.stringify({ hosted: roomId }));
      break;
    }
    case "rehost": {
      // Ownership recovery: leave any open room → GROUPS → MY ROOMS → host again.
      ws = await openApp(port, "http://localhost:3000/chat");
      await waitFor(ws, `document.body.innerText.length > 100`, 25000);
      await evalJs(ws, `(() => {
        const b = Array.from(document.querySelectorAll("button")).find((x) => /^(leave)$/i.test(x.innerText.trim()));
        if (b) b.click();
        return "ok";
      })()`);
      await sleep(1200);
      await clickText(ws, /groups/i);
      await waitFor(ws, `/my rooms/i.test(document.body.innerText)`, 15000);
      await clickText(ws, /host again/i);
      await waitFor(ws, `/members/i.test(document.body.innerText) && /encrypted room/i.test(document.body.innerText)`, 30000);
      const roomId = await evalJs(ws, `JSON.parse(localStorage.getItem("pxc.lastRoom.v1")).roomId`);
      console.log(JSON.stringify({ rehosted: roomId, recovered: roomId === arg1 }));
      break;
    }
    case "join": {
      ws = await openApp(port, "http://localhost:3000/chat");
      await waitFor(ws, `document.body.innerText.length > 100`, 25000);
      await clickText(ws, /discover/i);
      await waitFor(ws, `document.body.innerText.includes("Pixel Garden")`, 30000);
      const card = await waitFor(ws, `(() => {
        const cards = Array.from(document.querySelectorAll("div.pixel-box"));
        return cards.map((c) => c.innerText).find((t) => t.includes("Pixel Garden"));
      })()`, 15000);
      if (!card.includes("LIVE")) {
        console.log(JSON.stringify({ joined: false, reason: "card-not-live", card: card.slice(0, 200) }));
        return;
      }
      // The card's own Join button (scroll into view, then a real mouse click).
      const btn = await evalJs(ws, `(() => {
        const cards = Array.from(document.querySelectorAll("div.pixel-box"));
        const pg = cards.find((c) => c.innerText.includes("Pixel Garden"));
        if (!pg) return null;
        const b = Array.from(pg.querySelectorAll("button")).find((x) => x.innerText.trim().toLowerCase() === "join");
        if (!b) return null;
        b.scrollIntoView({ block: "center" });
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`);
      if (!btn) throw new Error("no join button on the Pixel Garden card");
      const { x, y } = JSON.parse(btn) as { x: number; y: number };
      const { mouseClick } = await import("./cdp-lib");
      await mouseClick(ws, x, y);
      await waitFor(ws, `/members/i.test(document.body.innerText)`, 60000);
      const phase = await evalJs(ws, `(() => document.body.innerText.includes("connecting")) ? "connecting" : "in-room"`);
      console.log(JSON.stringify({ joined: true, phase, card: card.slice(0, 110) }));
      break;
    }
    case "send": {
      ws = await attach(port);
      await fillSelector(ws, "textarea[placeholder*='Type a message']", arg1);
      // Send with a real Enter keypress.
      await cdp(ws, "Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await cdp(ws, "Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await sleep(1500);
      console.log(JSON.stringify({ sent: true }));
      break;
    }
    case "msgs": {
      ws = await attach(port);
      const msgs = await evalJs(ws, `(() => {
        const bubbles = Array.from(document.querySelectorAll("[class*='bubble'], [class*='message'], [class*='msg']"));
        const texts = bubbles.map((b) => b.innerText.trim()).filter((t) => t.length > 0 && t.length < 200);
        return JSON.stringify(texts.slice(-6));
      })()`);
      console.log(msgs);
      break;
    }
    case "leave": {
      ws = await attach(port);
      await clickText(ws, /leave group/i);
      await sleep(1500);
      console.log(JSON.stringify({ left: true }));
      break;
    }
    default:
      console.error("unknown command: " + cmd);
      process.exit(1);
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error("DRIVER ERROR: " + (e?.message ?? e)); process.exit(2); },
);
