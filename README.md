# PIXOLARK

> **A retro pixel-art, end-to-end encrypted, peer-to-peer messenger.**  
> Completely standalone and private: zero accounts, zero database, zero telemetry, and zero third-party watermarks or branding.

---

## Overview

**Pixolark** is a private, client-side peer-to-peer chat application built with a nostalgic 8-bit pixel aesthetic. It connects browsers directly using WebRTC DataChannels and media streams with end-to-end encryption (E2EE). No central servers or relays ever see your plaintext messages, media, or keys.

## Features

- **Decentralized & Serverless:** Direct peer-to-peer communication via WebRTC. No central message relay or server database.
- **End-to-End Encrypted (E2EE):** AES-GCM-256 with ephemeral ECDH P-256 key exchange and HKDF-SHA-256 key derivation.
- **Clean & Unbranded:** Independent, unbranded interface with zero watermarks, tracking scripts, or vendor badges.
- **Rooms & Manual Signaling:** Simple 6-digit room codes (e.g. `582914`), 1-click invite links, compact QR codes, and copyable invite/answer codes with an extended 2-minute connection window.
- **Rich Media & File Sharing:** Encrypted file transfer (up to 250 MB) chunked with backpressure handling.
- **Voice & Video Calls:** WebRTC DTLS-SRTP audio/video calls renegotiated directly over the secure channel.
- **Pixel Sticker Library:** Over 1,000 animated pixel stickers across 10 categories with custom packs, favorites, and search.
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
```

- **Crypto, Session & Media:** Located in `src/lib/pixel/` (ECDH/AES-GCM crypto, frame codec, WebRTC session management, audio engine, animated sticker system).
- **Interface & Components:** Located in `src/components/pixel/` (chat view, media composer, avatar builder, calls overlay, handshake modal).

Beyond private 1:1 chat, the app includes encrypted group rooms (host-run, sender-key encryption, moderation & audit), a live public-room directory ("Discover", global + regional views) driven by host beacons, a notification center with do-not-disturb and per-room mutes, and an encrypted local backup. See:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how it all works, including honest limitations.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — build, run, self-host the pub/sub, and the manual multi-device test checklist.

## How Signaling Works

WebRTC peers require session descriptions (signaling) to establish direct connections. Pixolark performs this manually without intermediary signaling servers:

1. **Host Creates Room:** Generates a random room ID, an ephemeral key pair, and an offer code/QR containing connection parameters and cryptographic commitments.
2. **Peer Joins Room:** Scans or pastes the offer code, produces an answer code/QR, and returns it to the host.
3. **Encrypted Handshake:** Both browsers finalize the WebRTC connection, perform an in-band ECDH exchange, derive symmetric encryption keys, and display a verifiable Safety Code for out-of-band comparison.

## Encryption & Security Specifications

- **Ephemeral Keys:** Fresh ECDH P-256 key pairs generated in memory for every session (non-extractable, discarded upon disconnect).
- **Key Derivation:** HKDF-SHA-256 derives distinct AES-GCM-256 keys for incoming and outgoing data streams.
- **Frame Authentication:** Each frame uses a unique 96-bit random IV and an incrementing sequence number as Additional Authenticated Data (AAD) to prevent replay and tampering attacks.
- **Media Chunking:** Files are transferred in 64 KB encrypted chunks over WebRTC DataChannels with flow control.
- **Calls:** Voice and video media streams use WebRTC DTLS-SRTP bound to verified DTLS fingerprints.

## Development & Build

### Prerequisites
- [Bun](https://bun.sh) (recommended) or Node.js (v18+)

### Getting Started

```bash
# Install dependencies
bun install

# Start local development server
bun run dev

# Build production bundle
bun run build

# Run unit and cryptographic test suite
bun test
```

### Sticker Catalog Build (Optional)

To regenerate or validate the animated sticker library:

```bash
bun run stickers:build
```

## Browser Compatibility

- Compatible with modern Chromium-based browsers (Chrome, Edge, Brave), Firefox, and Safari on desktop and mobile (iOS & Android).
- Media features (camera and microphone) require an HTTPS context or `localhost`.

## License

MIT License. Free and open source.
