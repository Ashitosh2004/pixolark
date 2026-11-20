# Pixolark Security

Companion to [`ARCHITECTURE.md`](ARCHITECTURE.md) (design + honest limitations)
and [`PRODUCTION-PLAN.md`](PRODUCTION-PLAN.md) (locked-in decisions). This file
states what the code actually does — every claim below maps to code or to a
passing test; anything not covered by tests is labeled as such.

## Threat model summary

**Assets:** message content, media/files, voice/video, identity keys, room
signing keys, local chat history.

**Trust anchors:** the browser's WebCrypto (`crypto.subtle`) and the delivered
client code; the room's signed manifest + owner fingerprint; the human-readable
Safety Code compared out of band.

| Adversary | What they can do | What they cannot do |
| --- | --- | --- |
| Passive network / third-party transport (STUN, ntfy fallback, hosting provider) | See metadata: sizes, timing, room codes/topics, IP addresses | Read any message, file, or key — chat content never travels in plaintext |
| **The coordinator** | See signed manifests, live presence (member names/ids in a room), and relayed WebRTC SDP (ICE candidates, key commitments) | See message/file plaintext (it never carries chat traffic), recover history (it has none — in-memory registry only), or mint/forge a room (manifest signature + fresh ownership proof required) |
| Active MITM on signaling | Inject, reorder or drop offer/answer data | Impersonate a peer: the connection-code key commitment and DTLS fingerprints are bound into the derived keys, so a swapped key fails the handshake ("KEY MISMATCH") and stops the session |
| Malicious directory mirror | Serve stale listings | Forge a room or alter metadata: every manifest is signature-verified and expiry-checked client-side before it renders |
| Malicious group host | Refuse service, drop/selectively delay relayed frames, see group metadata (who, when, sizes) | Read pairwise-sealed key envelopes (unless it is itself a legitimate key-holder), forge sender content, forge read receipts, or act above its verified role — all moderation is re-checked host-side against the verified roster |
| Another member | Keep copies of messages they legitimately received | Read messages sent before they joined (one-way chain), read messages after removal (epoch bump), or tamper with frames (AEAD + sender binding) |
| Compromised device / malicious extension | Everything on that device | Nothing is protected — see "Not independently audited" below |

Out of scope by design (stated honestly): IP exposure inherent to peer-to-peer
WebRTC (there is **no TURN relay**), a silent long-term compromise of a member's
active chain key until the next epoch change, and traffic analysis of metadata.

## 1:1 end-to-end encryption

- **Handshake:** peers exchange manually-created offer/answer codes (QR or
  copy/paste). Once the DataChannel opens, both sides send one plaintext
  `hello` frame carrying an ECDH P-256 public key
  (`src/lib/pixel/session.ts`). The key is checked against the **commitment
  embedded in the connection code**; a mismatch aborts with a visible
  "KEY MISMATCH" notice. The room id and both peers' DTLS fingerprints are
  mixed into the key-derivation transcript, so the SDP/DTLS layer and the
  application layer are bound together.
- **Key derivation:** ECDH P-256 → HKDF-SHA-256 → two AES-GCM-256 keys, one per
  direction (`src/lib/pixel/crypto.ts`). Session private keys are
  **non-extractable** and memory-only.
- **Then: nothing in plaintext.** After the handshake, *all* DataChannel traffic
  goes through `PeerSession.send`, which encrypts before writing to the channel
  ("Never sends plaintext" — `session.ts`). This includes messages, typing
  indicators, presence, receipts, file chunks, **and** renegotiated SDP/ICE for
  calls. If any plaintext frame arrives after keys exist, the session kills
  itself ("Received unencrypted data after the secure handshake").
- **Replay/tamper rejection:** every frame uses a fresh random 96-bit IV and a
  monotonically increasing sequence number as Additional Authenticated Data.
  `openFrame` enforces the expected sequence — a replayed or reordered frame, or
  any bit-flip, fails AEAD/sequence checks and the channel stops with a visible
  notice rather than rendering unverified data. Unit tests:
  `src/test/pixel-crypto.test.ts` (*rejects tampered frames*, *rejects replayed
  frames*, *both peers derive the same safety code*).
- **Verifiable identity:** both sides display the same human-comparable Safety
  Code (key fingerprint) for out-of-band comparison.
- **Media:** voice/video rides WebRTC DTLS-SRTP; the DTLS fingerprints of both
  peers are additionally bound into the application-layer key derivation above.

## Group messaging = Signal-style sender-key ratchet

Groups reuse the same 1:1 channels: every member holds exactly one encrypted
`PeerSession` to the host, and the host relays sealed group frames to the others
(`src/lib/pixel/group.ts`, `src/lib/pixel/groupcrypto.ts`).

- Each member sends under a per-epoch `SenderChain { epoch, gen, chainKey, seq }`:
  message key = `HKDF(chainKey, "msg|epoch|sender|seq")`, then
  `chainKey ← HKDF(chainKey, "chain|epoch")` — a one-way hash ratchet.
  Frames are **AES-GCM-256** with the AAD binding
  `room | sender | epoch | gen | seq`, so a frame cannot be moved between rooms,
  epochs, generations or positions. All primitives are WebCrypto standard
  algorithms: ECDH P-256, HKDF-SHA-256, AES-GCM-256.
- **Chain distribution is pairwise-sealed** (`sealToMember`/`openFromMember`):
  static-static ECDH between member identities + HKDF bound to the room id, so
  only the intended member can open it, and possession of the sender's roster
  public key authenticates it. The host forwards these envelopes verbatim — it
  cannot read an envelope it is not a party to.
- **Replay & forgery rejection:** receivers track the highest sequence per
  (sender, epoch, generation); `seq ≤ lastSeq` is rejected as a replay; frames
  from another room/epoch/generation are rejected; tampered frames fail AEAD.
  Tests: `src/test/group-crypto.test.ts` (13 tests, all passing as observed
  2026-11-20).
- **Removal works:** any membership change (leave/kick/ban) bumps the epoch; the
  host mints a fresh chain and distributes it only to current roster members, and
  the relay drops removed members' traffic — **removed members cannot decrypt
  future group messages** (removal is not retroactive for messages they already
  legitimately held keys for).
- **Honest limits:** this is a sender-key design, not TreeKEM — there is no
  post-compromise self-healing within an epoch (see `ARCHITECTURE.md`), and
  distribution is O(N) per membership change (fine for small groups).

### Why not MLS (RFC 9420)

Pixolark group messaging uses a Signal-style sender-key ratchet (AES-GCM-256, ECDH P-256, HKDF via WebCrypto) rather than MLS (RFC 9420), because no browser-capable MLS implementation currently meets our bar: `ts-mls` v1.6.4 — the most mature candidate — carries open RFC-conformance and security defects at evaluation time (issues #856–#860, #831, #859), requires pure-JS cryptographic libraries (`@noble/*`) beyond WebCrypto, and its MLS 2.0 line remains pre-release. This is a documented deviation, not invented crypto: all primitives are WebCrypto standard algorithms. We will re-evaluate when a release containing those fixes ships.

## The coordinator sees no plaintext — and keeps nothing

- The coordinator (`server/src/index.ts`) relays exactly three classes of data:
  **signed room manifests, presence (live member ids/names), and WebRTC
  offer/answer SDP.** Chat content rides E2EE DataChannels between browsers and
  never touches it. Its own header states the hard guarantee: "NO database, NO
  persistence, NO message content ever."
- **No permanent history:** its only state is an in-memory room registry
  (`server/src/registry.ts` — "Nothing is ever written to disk"). A restart
  starts empty and says so honestly (joins answer `room-unavailable` until the
  owner re-registers with a fresh proof). Leases are 90 s and renewed every 30 s
  with a fresh, nonce-bound ECDSA proof, so the coordinator can never become a
  hidden store of "rooms that used to exist" and cannot be hijacked by someone
  who merely copied the public manifest.
- Abuse controls: per-connection frame budget (200 messages / 10 s, 64 KB frame
  cap) and honest error codes. `GET /health` reports live counts only.
- In group rooms the **host's** device is the relay: it sees group metadata and
  can refuse/drop service, but content is sealed to recipients and cannot be
  forged (sender-key authentication). This is the central choke point described
  in `ARCHITECTURE.md`.

## Signed static room directory (no listing database)

- A room's portable identity is a **manifest signed with ECDSA P-256 over
  canonical JSON** (recursively key-sorted, no whitespace, UTF-8) —
  `src/lib/pixel/manifest.ts`. The signature covers every field, so a directory
  file, a QR code and a hand-pasted copy are equally trustworthy sources.
- **Nothing secret ever goes in a manifest:** private encryption keys, plaintext
  messages, secret invitation tokens and private membership credentials are
  forbidden by construction; the owner's *public* signing key and a host key
  commitment are all it carries.
- **Verification everywhere it is consumed:** the coordinator re-verifies every
  manifest signature before registering a room; the directory client verifies
  signature + owner fingerprint + expiry before a listing renders
  (`src/lib/pixel/directory.ts`), drops expired entries even from its cache, and
  reports an honest empty list if every mirror is down. An edited (tampered)
  manifest fails signature verification — tests: `src/test/manifest.test.ts`
  (tamper, expiry, unsigned/structurally broken, fingerprint mismatch, canonical
  determinism) and `src/test/directory.test.ts` (tampered manifests dropped even
  when a mirror serves them; expired manifests never appear).
- Presence in a directory is never treated as availability: joining always
  probes a live coordinator lease, and the UI says "Room temporarily unavailable"
  when there is none.
- Publishing is a plain static-JSON tree on ordinary HTTPS hosting — no
  server-side listing state, no database (`tools/directory-publisher/`).

## Stickers and files stay encrypted

- Files (up to 250 MB 1:1, 25 MB in groups) are chunked into 64 KB
  **encrypted** DataChannel frames with backpressure handling — they travel the
  same `PeerSession.send`/group wire as text, so the coordinator and network see
  ciphertext only.
- Sticker messages carry an **encrypted inline copy of the file** plus the
  sender's sticker-library version. A receiver renders its local built-in asset
  only when the sender's verified library version matches its own
  (`resolveIncomingSticker`); otherwise it falls back to the encrypted inline
  file, and an unverified sticker id without a file is never rendered. Tests:
  `src/test/stickers.test.ts` (*uses the local asset only when the library
  version matches*, *falls back to the encrypted inline file when versions
  differ*, *never trusts an unverified ID without a file*).

## Local storage: encrypted, device-local, disposable

- **Membership identity:** per-room, non-extractable ECDH key pairs in
  IndexedDB — they cannot decrypt anything by themselves; they only prove
  "this device came back" so roles/rosters survive reconnects without accounts.
- **History:** opt-in, per-room AES-GCM keys (non-extractable) + message logs in
  IndexedDB, with a 24 h auto-delete preference. Session/group message keys are
  memory-only and never persisted.
- **Recovery registry:** the whole payload is encrypted at rest by a
  device-local non-extractable AES-GCM key; password exports use
  PBKDF2-SHA-256 (600 000 iterations). See [`RECOVERY.md`](RECOVERY.md).
- **Backup:** passphrase → PBKDF2-SHA-256 (210 000 iterations) → AES-GCM, with
  AES-GCM integrity rejecting tampered ciphertext and wrong passphrases (tests:
  `src/test/storage-notifications.test.ts`, `src/test/recovery.test.ts`).
- Clearing site data genuinely wipes it — `clearEverything` is tested to leave
  an honest empty registry.

## The absolute zero-database policy

No SQL, NoSQL, Redis, Firebase, SQLite, ORM or DBaaS exists anywhere in this
project — not in `src/`, not in `server/`, not as a hidden dependency:

- The **only** runtime server is the Node `http` + `ws` coordinator, whose sole
  state is an in-memory registry; it writes nothing to disk.
- Discovery uses a **static signed JSON directory** (plain files on static
  hosting) and/or live host beacons; listing state lives on the client.
- All user state lives in the **local, encrypted browser storage** described
  above.
- `package-lock.json` mentions database brand names only as *optional
  peer-dependency declarations of the build-time Nitro/unstorage toolchain*;
  no storage driver is installed as a direct dependency, configured, or
  imported anywhere in `src/`, `server/` or `tools/`.

This is a privacy guarantee, not a performance choice: if it ever gains a
database, it is a different product. See `docs/DEPLOYMENT.md` → "What NOT to
deploy".

## Known limitations (be honest with yourself)

- **Not independently audited.** Browser crypto depends on the integrity of the
  delivered code and your browser; malware, compromised devices or malicious
  extensions defeat everything above.
- **No TURN relay:** symmetric-NAT or restricted networks may fail to connect;
  WebRTC exposes participants' IPs to each other by nature.
- **Metadata is visible** to the coordinator/relays/host: who is in a room,
  message sizes and timing. Only content is strongly protected.
- **The ntfy.sh fallback transport** (manual signaling/discovery beacons, when
  used instead of the coordinator) is a third party that sees topics,
  ciphertext, sizes and timing; self-hosting it removes that party
  (`DEPLOYMENT.md`).

## Verification

- `npx vitest run` — **13 test files / 87 tests, all passing (observed
  2026-11-20)**; see [`TESTING.md`](TESTING.md) for the full inventory and the
  recorded two-browser live validation.
- `npx tsc --noEmit` (root) and `cd server && npx tsc --noEmit` — both exit 0
  (observed 2026-11-20).
- Manual multi-device checklist: [`DEPLOYMENT.md`](DEPLOYMENT.md).
