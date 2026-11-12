## Project rules
- Pixolark has no backend: signaling is manual (QR/copy codes) via `PeerSession`; never add a database or message relay. Why: core privacy requirement.
- All DataChannel traffic after the hello handshake goes through `PeerSession.send` (AES-GCM frames); never send plaintext. Why: E2EE guarantee and tamper/replay rejection.
- `src/lib/pixel/pixelart.ts` and `stickers.ts` are `@ts-nocheck` pure drawing code; keep app logic out of them.
- Built-in stickers are generated assets: edit `stickercatalog.ts`/`stickerart.ts`, then run `bun run stickers:build`; never hand-edit `public/stickers/` or `sticker-version.ts`. Why: manifests, IDs and the P2P library version must stay consistent.
- A received built-in sticker ID is rendered locally only when the sender's `stickerLib` equals ours (`resolveIncomingSticker`); otherwise use the encrypted inline file. Why: never assume both devices have the same asset.
