<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.

## What Lovable manages

Rules outside this block are the project's own. Change the pieces below in
Lovable, not by hand. With the [Lovable MCP](https://mcp.lovable.dev)
connected, `send_message` asks Lovable to do it; otherwise ask the user to
use the editor.

- **Database.** Do not add or edit `supabase/migrations/` or `drizzle/`.
  Ask Lovable to change the schema.
- **Generated files.** Do not edit a file whose header says it is automatically
  generated.
- **AI gateway.** Keep model calls on Lovable's gateway, and keep
  `LOVABLE_API_KEY` out of browser code.
- **Connectors.** Lovable provides native connectors. `list_connectors` shows
  which are enabled; `add_connector` only returns the dashboard link. When a
  connector is enabled, calls go through the connector gateway and need
  `LOVABLE_API_KEY`. When Lovable does not provide one, users can bring their
  own key and store it in Secrets.
- **Secrets.** Lovable manages them. Do not put secret values in the repo.
<!-- LOVABLE:END -->

## Project rules
- Pixolark has no backend: signaling is manual (QR/copy codes) via `PeerSession`; never add a database or message relay. Why: core privacy requirement.
- All DataChannel traffic after the hello handshake goes through `PeerSession.send` (AES-GCM frames); never send plaintext. Why: E2EE guarantee and tamper/replay rejection.
- `src/lib/pixel/pixelart.ts` and `stickers.ts` are `@ts-nocheck` pure drawing code; keep app logic out of them.
- Built-in stickers are generated assets: edit `stickercatalog.ts`/`stickerart.ts`, then run `bun run stickers:build`; never hand-edit `public/stickers/` or `sticker-version.ts`. Why: manifests, IDs and the P2P library version must stay consistent.
- A received built-in sticker ID is rendered locally only when the sender's `stickerLib` equals ours (`resolveIncomingSticker`); otherwise use the encrypted inline file. Why: never assume both devices have the same asset.
