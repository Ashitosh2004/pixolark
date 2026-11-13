# Deploying Pixolark

Pixolark builds to a Node server (TanStack Start + Nitro). There are no environment
variables, no API keys and no database to provision — the app is self-contained and
all state lives in users' browsers.

## Requirements

- Node 20+ (or Bun) for building and running.
- Users reach the site over **HTTPS** (or localhost): WebRTC, clipboard, camera,
  notifications and `crypto.subtle` all require a secure context.

## Build & run

```bash
npm install        # or: bun install
npm run build      # produces .output/ (public + server)
node .output/server/index.mjs   # serves app + SSR on PORT (default 3000)
```

Useful scripts vary by package manager; the build outputs are:

- `.output/server/index.mjs` — the Node server (SSR + client assets).
- `.output/public/` — static assets (can also be fronted by a CDN).

### systemd example

```ini
[Unit]
Description=Pixolark
After=network.target

[Service]
WorkingDirectory=/srv/pixolark
ExecStart=/usr/bin/node .output/server/index.mjs
Environment=PORT=3000
Restart=on-failure
User=pixolark

[Install]
WantedBy=multi-user.target
```

### Reverse proxy (Caddy)

```caddy
pixolark.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

nginx works the same way: proxy `/` to the Node process, keep default
`proxy_http_version 1.1` and pass `Host`. No WebSocket upgrade headers are needed
for the app itself (WebRTC media bypasses your server entirely).

## Infrastructure used at runtime

| Concern | Endpoint | Carries |
| --- | --- | --- |
| STUN (WebRTC) | public STUN URLs in `session.ts` | IP discovery metadata only |
| Manual signaling | `https://ntfy.sh/pxl_<digits>_<offer|answer>` | WebRTC offer/answer codes (ciphertext-level connection data) |
| Discovery beacons | `https://ntfy.sh/pxl_rooms_v1` | public room metadata every 45 s |

### Self-hosting the pub/sub (recommended for sensitive deployments)

Both features talk to ntfy with plain `fetch` against the base URL
`https://ntfy.sh/` (see `src/lib/pixel/signaling.ts` and
`src/lib/pixel/discovery.ts`). To remove the third party:

1. Run your own ntfy instance (e.g. `docker run -p 80:80 binwiederhier/ntfy serve`),
   configured with a default token or open topics as you prefer.
2. Change the base URL constant in those two modules and redeploy. Every client
   (host and guest) must use the same instance or rooms will not find each other.

The publish cadence (1 beacon / 45 s per hosted room, plus short signaling bursts)
fits comfortably inside ntfy's default rate limits.

## What NOT to deploy

- Do not add a database, message relay or analytics. The privacy guarantee depends
  on none existing (see `docs/ARCHITECTURE.md`).
- Do not place a proxy that buffers request bodies in front of signaling — offers
  and answers are small, but keep the path as short as practical.

## Operational notes

- **Rooms die with their host.** Hosting is a foreground user activity; there is no
  always-on host process to run server-side. This is intentional.
- **Sessions auto-expire** per the user's preference (default 4 h) — nothing to
  configure server-side.
- **Group files** cap at 25 MB; 1:1 files at 250 MB. They flow peer-to-peer; your
  server never sees them.

## Verification checklist (manual, multi-device)

Run this with two or more browsers/devices (a desktop + a phone is ideal). All
steps are end-user actions; nothing needs test credentials.

**Private 1:1**
1. Desktop creates a room; phone joins via QR, link or pasted codes → messages both
   ways, read receipts, typing indicator, reactions, replies, edits are not
   applicable, delete-for-me works.
2. Send a file photo → progress + download on the other side. Send a sticker →
   same animated sticker renders.
3. Start a voice call, then a video call; hang up cleanly.
4. Refresh the host tab mid-chat → host re-hosts automatically; guest reconnects
   without user action within ~30 s.
5. Close the guest tab, rejoin with the last-room button → history restored (only
   if the user enabled "save history").

**Groups**
6. Desktop hosts a public group via the wizard (pick a category/region). It appears
   in Discover on the phone within ~45 s, with the right name and online count.
7. Phone joins from Discover → host approves (if enabled) or joins directly;
   messages, reactions, replies, file transfer work group-wide.
8. Host kicks or mutes the phone → phone is removed/muted and does *not*
   reconnect-fight the moderation.
9. Third device joins → host redistributes keys; newcomer decrypts live messages
   but cannot read anything sent before they got the chain (unless history sharing
   was enabled).
10. Host refreshes the page and uses "Host again" from the hub → roster, roles,
    bans restored; epoch bumped; members re-key automatically and continue.
11. Promote a member to admin/mod; verify they can approve/kick but a mod cannot
    kick an admin, and nobody can act on the owner.

**Discovery & notifications**
12. Host closes the room → beacon flips to "Closed", join buttons disable.
13. Kill the host tab → listing shows "host offline" after ~90 s.
14. Phone mutes the room (bell icon) → no sounds/notifications from it; unmute
    restores.
15. Enable DND for 30 min → even `@mention` messages stay silent; turning DND off
    restores normal behavior. Mention a member by name with the tab visible → an
    urgent notification appears.
16. In Settings → Data, export an encrypted backup, wipe site data, restore with
    the passphrase → preferences, drafts, bookmarks, hosted-room rosters return.

**Diagnostics**
17. Settings → Diagnostics with a 1:1 session open shows channel state, safety
    code, frame counters; with a group open it shows role, epoch, chain state,
    relay/doorbell/beacon status.
