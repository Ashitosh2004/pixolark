# PIXOLARK

> **A retro pixel-art, end-to-end encrypted, peer-to-peer messenger.**  
> Completely standalone and private: zero accounts, **zero database**, zero telemetry, and zero third-party watermarks or branding.

---

## Overview

**Pixolark** is a private, client-side peer-to-peer chat application built with a nostalgic 8-bit pixel aesthetic. Browsers connect **directly** using WebRTC DataChannels with end-to-end encryption (E2EE): no message relay ever sees your plaintext messages, media, or keys.

Around that core sit three deliberately boring pieces of infrastructure — none of which is a database:

- a tiny **coordinator** (`server/src/index.ts`): an in-memory `http` + `ws` process that verifies signed room manifests, holds short-lived room leases, tracks live presence and relays WebRTC offer/answer SDP. It never sees chat content and never writes to disk;
- a **static signed room directory**: plain JSON files on ordinary HTTPS static hosting, each manifest ECDSA-signed by the room owner and verified client-side;
- **local encrypted browser storage** (IndexedDB + `localStorage`) for everything personal.

## The zero-database policy (absolute)

**No SQL, NoSQL, Redis, Firebase, SQLite, ORM or DBaaS anywhere in this project — not in `src/`, not in `server/`, not as a hidden dependency.** This is a privacy guarantee, not a performance choice:

| Instead of a database | Pixolark has |
| --- | --- |
| Backend persistence | **In-memory coordination only** — the coordinator's room registry dies with the process; a restart starts empty and says so honestly ("Room temporarily unavailable") |
| Server-side room listings | **Static signed JSON directory** — plain files, signature-verified and expiry-checked on every client |
| Accounts & profiles | Per-device, non-extractable identity keys (local only) |
| Message history in the cloud | **Local encrypted browser storage**, opt-in, 24 h auto-delete preference, passphrase backups |
| Analytics / telemetry | Nothing |

If Pixolark ever gains a database, it is a different product. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) → "What NOT to deploy" and [`docs/SECURITY.md`](docs/SECURITY.md).

## Features

- **Decentralized & Serverless:** Direct peer-to-peer communication via WebRTC. No central message relay or server database.
- **End-to-End Encrypted (E2EE):** AES-GCM-256 with ephemeral ECDH P-256 key exchange and HKDF-SHA-256 key derivation — WebCrypto only, in 1:1 chats **and** group rooms (Signal-style sender-key ratchet).
- **Clean & Unbranded:** Independent, unbranded interface with zero watermarks, tracking scripts, or vendor badges.
- **Rooms & Signaling:** Simple 6-digit room codes (e.g. `582914`), 1-click invite links, compact QR codes, and copyable invite/answer codes valid for 15 minutes — via the coordinator relay, the ntfy pub/sub fallback, or plain manual paste.
- **Rich Media & File Sharing:** Encrypted file transfer (up to 250 MB in 1:1, 25 MB in groups) chunked with backpressure handling.
- **Voice & Video Calls:** WebRTC DTLS-SRTP audio/video calls renegotiated directly over the secure channel.
- **Pixel Sticker Library:** Over 2,300 animated pixel stickers across 24 categories with custom packs, favorites, and search.
- **Custom Pixel Avatar Studio:** Built-in 8x8 pixel avatar editor with live painting, mirroring, random generation, and image uploads.
- **Modern Messaging Tools:** Typing indicators, delivery/read receipts, replies, reactions, local search, message pinning, and delete-for-me.
- **Retro Audio & Theming:** Authentic 8-bit sound synthesizer, sound effects toggle, and customizable dark/light retro themes.
- **Privacy Controls:** Configurable auto-delete (24h local history), manual data clearing, safety code verification, and session auto-expiry.

## Architecture

```text
Browser A                                        Browser B
 ┌─────────────┐                                ┌─────────────┐
 │ PeerSession │ ─── offer code (QR/copy) ────▶ │ PeerSession │
 │             │ ◀── answer code (QR/copy) ──── │             │
 └─────────────┘                                └─────────────┘
        │                                              │
        ▼                                              ▼
 ┌────────────────────────────────────────────────────────────┐
 │  RTCPeerConnection ◀═══ DTLS (direct, STUN) ═══▶           │
 │  DataChannel: hello{ECDH pub} ── verify commitment         │
 │  HKDF → AES-GCM-256 (per direction) → all frames encrypted │
 │  Voice/Video: DTLS-SRTP renegotiated over secure channel   │
 └────────────────────────────────────────────────────────────┘

          optional coordination (never content, never state)
 ┌──────────────────────────┐   ┌──────────────────────────────┐
 │ coordinator (in-memory)  │   │ static signed JSON directory │
 │ manifests · presence ·   │   │ owner-signed manifests on    │
 │ SDP relay · 90 s leases  │   │ plain static file hosting    │
 └──────────────────────────┘   └──────────────────────────────┘
```

- **Crypto, Session & Media:** Located in `src/lib/pixel/` (ECDH/AES-GCM crypto, frame codec, WebRTC session management, audio engine, animated sticker system).
- **Interface & Components:** Located in `src/components/pixel/` (chat view, media composer, avatar builder, calls overlay, handshake modal).
- **Coordinator:** Located in `server/src/` (Node `http` + `ws`, in-memory registry, ownership proofs, rate limits, `/health`).

Beyond private 1:1 chat, the app includes encrypted group rooms (host-run, sender-key encryption, moderation & audit), a live public-room directory ("Discover", global + regional views) driven by host beacons and/or the signed static directory, a notification center with do-not-disturb and per-room mutes, and an encrypted local backup. See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it all works, including honest limitations.
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, E2EE design, group ratchet, why-not-MLS, zero-database policy.
- [`docs/RECOVERY.md`](docs/RECOVERY.md) — coordinator restarts, rejoin/re-advertise, message gap recovery, local encrypted recovery.
- [`docs/TESTING.md`](docs/TESTING.md) — how to run the suite, spec-scenario coverage, recorded two-browser live validation.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — build, run, self-host the pub/sub, and the manual multi-device test checklist.
- [`docs/PRODUCTION-PLAN.md`](docs/PRODUCTION-PLAN.md) — the locked-in plan this architecture executes.

## How Signaling Works

WebRTC peers need session descriptions (signaling) to establish a direct connection. Pixolark can do this three ways — **all of which carry connection metadata only, never content**:

1. **Coordinator relay:** community rooms registered with the coordinator exchange `want`/`offer`/`answer` frames over its WebSocket (`rtc` messages). The coordinator sees SDP + ICE candidates, which are public-by-design connection data.
2. **ntfy pub/sub fallback:** offer/answer codes published under per-room topics (`pxl_<digits>_<offer|answer>`), usually via QR or copy/paste — this is what makes zero-infrastructure P2P possible.
3. **Fully manual:** scan/paste the offer code, produce the answer code, hand it back. No server involved at all.

In every case the handshake ends the same way:

1. **Host creates room:** generates a room ID, an ephemeral key pair, and an offer code/QR containing connection parameters and cryptographic commitments (valid 15 minutes).
2. **Peer joins room:** opens the invite link, scans the QR, or pastes the offer code; produces an answer code/QR.
3. **Encrypted handshake:** both browsers finalize the WebRTC connection, perform the in-band ECDH hello exchange, verify the key commitment against the connection code, derive per-direction AES-GCM-256 keys, and display a verifiable Safety Code for out-of-band comparison.

## Encryption & Security Specifications

- **Ephemeral Keys:** Fresh ECDH P-256 key pairs generated in memory for every session (non-extractable, discarded upon disconnect).
- **Key Derivation:** HKDF-SHA-256 derives distinct AES-GCM-256 keys for incoming and outgoing data streams; the transcript binds the room ID and both peers' DTLS fingerprints.
- **Nothing in plaintext:** after the hello handshake, **all** DataChannel traffic goes through `PeerSession.send` (AES-GCM frames). A plaintext frame arriving post-handshake kills the session.
- **Frame Authentication:** Each frame uses a unique 96-bit random IV and an incrementing sequence number as Additional Authenticated Data (AAD) to prevent replay and tampering attacks.
- **Group rooms:** Signal-style sender-key ratchet — AES-GCM-256 with a one-way hash chain per sender, epoch bumps on every membership change (removed members can't read future messages), pairwise-sealed chain distribution. Documented deviation from MLS: [`docs/SECURITY.md`](docs/SECURITY.md).
- **Media Chunking:** Files are transferred in 64 KB encrypted chunks over WebRTC DataChannels with flow control.
- **Calls:** Voice and video media streams use WebRTC DTLS-SRTP bound to verified DTLS fingerprints.
- **Honest:** metadata (who is in a room, sizes, timing) is visible to relays/hosts, WebRTC exposes participant IPs, and there is no TURN relay. Full threat model: [`docs/SECURITY.md`](docs/SECURITY.md).

## Quick start (development)

### Prerequisites
- [Bun](https://bun.sh) (recommended) or Node.js (v18+)

### Getting Started

```bash
# Install dependencies
bun install

# 1) start the zero-database coordinator (in-memory, :8787)
bun server/src/index.ts

# 2) in a second terminal, start the app dev server (:3000)
bun run dev
```

On Windows, `start.bat` does both and opens `http://localhost:3000`.

> The vite dev server does not proxy `/coordinator`, so point the client at the
> coordinator for local work — set `VITE_COORDINATOR_URL=ws://localhost:8787/coordinator`
> in `.env` (see [`.env.example`](.env.example); `start.bat` does it for you when
> `.env` leaves it unset). All environment variables are documented in
> [`.env.example`](.env.example).

### Commands

| Command | What it does |
| --- | --- |
| `bun run dev` | Vite dev server → http://localhost:3000 |
| `bun server/src/index.ts` (alias `bun run server`) | Coordinator → `ws://localhost:8787/coordinator`, health at `/health` (port via `PORT`) |
| `start.bat` | Windows launcher: coordinator + dev server in separate windows, opens the app |
| `bun run build` | Production build (client + SSR + Nitro) |
| `bun run preview` | Preview the production build |
| `bun run test` / `bun run test:watch` | Vitest suite — **13 test files / 87 tests, all passing (observed 2026-11-20)** |
| `npx tsc --noEmit` | Strict type check (root); also `cd server && npx tsc --noEmit` for the coordinator |
| `bun run lint` / `bun run format` | ESLint / Prettier |
| `bun run stickers:build` | Regenerate the generated sticker library (never hand-edit `public/stickers/`) |
| `bun run manifest` | Generate/sign a room manifest (owner tooling) |
| `bun run directory:build` / `bun run directory:seed` | Build the static signed room directory tree / seed demo rooms |

Details, coverage and honesty rules: [`docs/TESTING.md`](docs/TESTING.md).

### Sticker Catalog Build (Optional)

To regenerate or validate the animated sticker library:

```bash
bun run stickers:build
```

## Privacy Guarantees

- **E2EE by default:** message content, files, stickers and calls are encrypted between browsers; the coordinator, ntfy topics and static directory only ever carry ciphertext or public metadata.
- **Zero database:** no server-side storage of messages, history, or accounts — see the policy above.
- **Zero accounts:** identity is a per-device non-extractable key; there is no registration, login, or server-side profile.
- **Zero telemetry:** no analytics, crash reporting, or tracking scripts.
- **Local-only history:** opt-in, AES-GCM-encrypted in your browser, 24 h auto-delete preference, manual wipe, passphrase-encrypted backups.
- **Truthful UI:** availability, member counts and recovery are never faked — if something is offline or unrecoverable, the app says so.
- **Honest exposure:** peers see each other's IPs (WebRTC is peer-to-peer), and relays see metadata such as message sizes and timing. Details: [`docs/SECURITY.md`](docs/SECURITY.md).

## Browser Compatibility

- Compatible with modern Chromium-based browsers (Chrome, Edge, Brave), Firefox, and Safari on desktop and mobile (iOS & Android). The recorded two-browser validation used headless Chrome and Microsoft Edge ([`docs/TESTING.md`](docs/TESTING.md)).
- Media features (camera and microphone) require an HTTPS context or `localhost`.

## License

MIT License. Free and open source.
