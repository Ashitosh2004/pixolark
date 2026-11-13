# Pixolark Architecture

Pixolark is a browser-only communication platform. There is **no backend database, no
message relay and no account system** — by design, not by omission. The only
third-party infrastructure is:

1. **STUN** — to discover reachable network addresses for WebRTC (public, stateless).
2. **ntfy.sh pub/sub** — used two ways, both carrying **ciphertext or metadata only**:
   - *manual signaling*: hosts publish offer codes / guests publish answer codes under
     per-room topics (`pxl_<digits>_<offer|answer>`), usually via QR or copy/paste;
   - *discovery beacons*: hosts of public rooms publish short metadata every 45 s on the
     `pxl_rooms_v1` topic so the Discover screen can list live rooms.

Everything else happens directly between browsers over WebRTC DataChannels.

## Design rules (enforced in code review, not just aspiration)

- No database, no message relay, no server-side state beyond the pub/sub's short cache.
- After the hello handshake, **all** DataChannel traffic goes through
  `PeerSession.send` (AES-GCM frames). Nothing is ever sent in plaintext.
- Identity keys never leave the device. Chat history is local-only, encrypted,
  opt-in, and auto-deletes after 24 h when that preference is on.
- Listings (Discover) contain **only** live host beacons — no fake rooms, counts or
  "online" indicators. A beacon older than the freshness window is labeled
  "host offline".

## Module map

| Path | Role |
| --- | --- |
| `src/lib/pixel/crypto.ts` | 1:1 channel identity, ECDH P-256 + HKDF-SHA-256 → AES-GCM-256, frame seal/open with seq-number AAD (replay & tamper rejection) |
| `src/lib/pixel/session.ts` | `PeerSession`: WebRTC host/join, hello handshake, key commitment verification, encrypted frame pump, calls |
| `src/lib/pixel/signaling.ts` | Manual signaling over ntfy topics, offer/answer publish+subscribe, `ROOM_CLOSED` tombstones |
| `src/lib/pixel/group.ts` | `GroupSession`: host (coordinator/relay/moderator) and member logic, sender-key distribution, rate limiting, roster, snapshots, beacons |
| `src/lib/pixel/groupcrypto.ts` | Signal-style sender keys: per-sender hash ratchet, pairwise-sealed key envelopes, replay rejection |
| `src/lib/pixel/idb.ts` | IndexedDB: per-room **non-extractable** membership identity, encrypted history log |
| `src/lib/pixel/discovery.ts` | Beacon format, 45 s publish interval, staleness (`>90 s`), category/region/language catalogs, room check-fingerprints |
| `src/lib/pixel/notifications.ts` | Central notification router: DND, per-room mute, mention urgency, session activity log |
| `src/lib/pixel/storage.ts` | Preferences, drafts, scroll anchors, bookmarks + per-room mute, recent rooms, host room snapshots, passphrase-encrypted backup |
| `src/lib/pixel/pixelart.ts`, `stickers.ts`, `stickercatalog.ts` | Pure drawing code (`@ts-nocheck`) — no app logic |
| `src/components/pixel/*` | UI: `PixelApp` (flows), `Hub` (nav + screens), `ChatView`/`GroupView`, `MessageBubble`, `Composer`, `MemberPanel`, `DiscoverView`, `GroupCreate`, `Settings`, diagnostics |

## Private 1:1 chat

Unchanged from the original design: two `PeerSession`s exchange manually-created
offer/answer codes, perform the hello handshake, verify key commitments, derive
per-direction AES-GCM-256 keys from HKDF, and exchange sealed frames. Voice/video calls
renegotiate media over the same verified DTLS fingerprints. See the root `README.md`.

## Group rooms (private groups, public rooms, regional communities)

### Topology

A group is a **star** around one host device. The host is simultaneously:

- **coordinator** — owns the roster, roles, bans, pins, slow-mode rules;
- **relay** — every member keeps exactly *one* 1:1 `PeerSession` to the host, and the
  host forwards sealed content to the other members. The host can decrypt group
  content only if it holds the senders' chains (it does — it is a member too);
- **moderator** — enforces kick/ban/mute/approvals centrally (see below).

There is no group without its host: when the host leaves, the room stops until they
host again. This is stated honestly in the UI (member rejoin loop, "host offline"
badges in Discover).

### Membership identity

Each device stores, per room, a **stable non-extractable ECDH key** in IndexedDB
(`idb.ts`). It cannot decrypt anything by itself — it exists so "this device came
back" is provable across reconnects, keeping roles, approvals and bans stable without
accounts. All message keys remain memory-only.

### Sender-key encryption (Signal-style, not MLS)

Every member runs a `SenderChain{epoch, gen, chainKey, seq}`:

- a message is sealed with a key derived from the current chain key; the chain key
  hashes forward per message (hash ratchet), so receivers advance in lock-step;
- chain state is distributed **pairwise-sealed** (`sealToMember`/`openFromMember`)
  over each member's 1:1 channel to the host, who relays opaque envelopes;
- the epoch is bumped on every membership change (leave/removal/kick/ban/host
  restart) — removed members' keys stop working for future messages;
- the generation counter (`pxc.ggen.<room>`) is monotonic per device so a
  re-announced chain can never be mistaken for a replay;
- duplicate/replayed/reordered frames: duplicates are rejected as replays; short
  gaps ratchet forward; large skips (late joiners) fail closed — late joiners only
  ever receive the *current* chain position, never older keys.

Group messages reuse the 1:1 envelope shapes (`msg`, `file-start|chunk|end|cancel`)
plus group extensions (`g-react`, `g-edit`, `g-del`), so rendering, file chunks and
sticker logic are literally the same code paths as 1:1. Stickers always carry an
encrypted inline copy plus the sender's sticker-library version; receivers render the
local asset only when the sender's verified library matches theirs
(`resolveIncomingSticker`).

### Control frames

All ride the pairwise encrypted channels:

| Frame | Direction | Purpose |
| --- | --- | --- |
| `g-snap` | host → member | full roster/meta/epoch/pins/rules/bans state |
| `g-key` | member ↔ host ↔ member | pairwise-sealed sender-chain envelopes (host relays verbatim, cannot read them without being a key-holder itself) |
| `g-msg` | member → host → members | sealed content + coarse class `msg`/`chunk` outside the seal |
| `g-read` | member → host → members | read receipts (own sends only) |
| `g-pres` | both | typing/viewing/online presence |
| `g-note` | host → member | moderation notices (muted, kicked, approved, denied…) |
| `g-req` | member → host | moderation requests + `hist-req`/`keyreq` |
| `g-hist` | member ↔ host ↔ member | pairwise-sealed shared history items |

### Enforcement is real, not UI-only

- **Moderation**: every privileged action routes through `hostAct`, which checks the
  requester's *verified* roster role against `ACTION_RANK`
  (`approve/reject/role/rules/meta` need admin; `kick/ban/mute/unmute/pin` need mod),
  forbids acting on equal-or-higher roles, and never applies to the owner. Members'
  requests ride `g-req` and are re-checked host-side; their client UI cannot decide
  anything. All actions are appended to an audit log surfaced in MemberPanel.
- **Authorship**: the host tracks which sender produced each content id
  (`msgOwners`); `g-edit`/`g-del` from anyone else are rejected and audited as
  `forged-edit-denied`/`forged-del-denied`. Receivers re-check sender identity
  (defense in depth).
- **Rate limiting without decryption**: `g-msg` frames carry a coarse class claim
  (`msg` = chat content, `chunk` = file payload) outside the seal so the host can
  enforce slow mode / per-10 s message caps and a chunk byte budget (128 × 64 KiB per
  10 s = 8 MB) **without reading content**. Mislabeling still counts against the
  claimed class's budget.
- **Pending members**: unapproved joiners can connect but receive no keys and no
  relayed content until approved; reconnecting does not self-approve.

### History sharing & recovery

- Local history is opt-in, AES-GCM-encrypted in IndexedDB, honors the 24 h
  auto-delete cutoff, and is shared with approved newcomers only when the room's
  owner enabled `historyShare`. Sharing is pairwise-sealed per recipient.
- **Ownership recovery**: the host persists room snapshots (roster, roles, bans,
  pins, rules) locally (`pxc.gsnap.<room>`). Re-hosting the same room bumps the
  epoch (pre-outage keys void), restores approvals, and members re-key via `keyreq`.

## Presence, discovery, regional communities

- Hosts of public rooms publish beacons every 45 s (name, description, category,
  region, language, live member count, capacity, host name, host commitment,
  closed flag). The Discover screen polls recent beacons, dedupes per room, and
  marks anything older than 90 s "host offline"; closed rooms are listed last and
  cannot be joined.
- "Regional" and category filters are pure client-side views over the same live
  beacon feed — there is no server-side index of communities.
- The check fingerprint next to each listing is a whole-string hash of
  `hostId|room`, shown in MemberPanel too, so users can cross-check a listing
  against the room they actually joined.

## Notifications

One router (`notifications.ts`) decides for every surface whether an incoming
message may interrupt:

- **Do Not Disturb** (`pxc.dnd.until`): suppresses sounds and notifications
  absolutely, including mentions.
- **Per-room mute** (stored with bookmarks) and the transient global mute:
  suppress that room's sound + notifications.
- **Mentions** (`@name`): urgent — a desktop notification is shown even when the tab
  is visible, so a busy group cannot bury them. Deliberately no `@all`.
- Sounds go through the app's own WebAudio synth; the global sounds preference is
  applied inside `sound.ts`, the router only decides *whether* to play.
- The Alerts screen shows DND controls, permission state, muted rooms and a
  session-scoped activity log of delivered alerts (not persisted).

## Storage & backup

- Preferences by default; opt-in encrypted history; drafts, scroll anchors,
  bookmarks (with per-room mute), recent rooms, host room snapshots — all
  `localStorage`, all local.
- **Never stored**: identity keys (IndexedDB, non-extractable), session/group keys
  (memory-only), group chain generation counters.
- **Encrypted backup**: passphrase → PBKDF2-SHA-256 (210 000 iterations) → AES-GCM.
  Contains prefs, opt-in history, drafts, bookmarks, recents, room snapshots.
  Identity keys and `pxc.ggen.*` counters are excluded on purpose.

## Honest limitations & threat model

- **The group host is a choke point.** It sees group metadata (who is present, when,
  message sizes, frequency) even though content is sealed. A malicious host could
  refuse service, relay selectively, or drop messages — it cannot forge sender
  content (sender-key authentication), read others' sealed key envelopes without
  being a legitimate key-holder, or forge reads. Members' clients detect tampering
  of relays frames via the ratchet (integrity failure → visible notice).
- **Sender keys are not MLS.** There is no per-message forward secrecy beyond the
  hash ratchet and no post-compromise self-healing: if a member's *device* is
  compromised while holding an active chain key, that member's messages (and any
  chain they can read) are readable until the next epoch change. A silent
  long-term compromise is out of scope; removal + epoch bump is the recovery path.
- **ntfy.sh is third-party.** It sees topics, ciphertext, sizes and timing for both
  signaling and beacons. Topics are room-scoped but not authenticated: anyone who
  learns a room code can *poll* its signaling topic; they still cannot join without
  producing a valid WebRTC answer that completes the cryptographic handshake.
  Self-hosting ntfy (see DEPLOYMENT.md) removes that third party.
- **IP exposure**: WebRTC is peer-to-peer; participants see each other's IP.
  STUN servers see connection metadata. There is no TURN relay, so symmetric-NAT or
  firewall-restricted networks may fail to connect.
- **Host availability**: no host, no room. Discovery honestly shows stale hosts as
  offline; member clients give up after bounded retries.
- **Beacon spoofing**: a fake beacon can create a listing, but joining always
  re-authenticates against the room's real offer and host identity commitment —
  fake listings fail at join. There is no server-side truth to appeal to.
- **Not independently audited.** Browser-based crypto depends on the integrity of
  the delivered code and your browser. Malware, compromised devices or malicious
  extensions defeat everything above.

## Verification

- `npx tsc --noEmit` — strict TypeScript, `exactOptionalPropertyTypes` on.
- `npx vitest run` — unit tests for the crypto core (ratchet round-trips, replay
  rejection, late-joiner isolation, room/epoch/gen binding, pairwise envelope
  authentication), discovery (dedupe, staleness, closed rooms, malformed input,
  fingerprints), storage (drafts/bookmarks/recents/snapshots, backup round-trip,
  wrong-passphrase and tamper rejection) and the notification router (mention
  detection, DND, mutes, urgent path).
- `npx vite build` — full client + SSR + Nitro build must be clean.

A manual multi-browser/device checklist lives in `docs/DEPLOYMENT.md`.
