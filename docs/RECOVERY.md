# Pixolark Recovery

What actually happens when something goes away — a coordinator restart, a
dropped connection, a missed message, a wiped browser — and how (or whether) the
app gets it back. Everything here maps to code and to tests in
`src/test/recovery.test.ts`, `src/test/coordinator.test.ts`,
`src/test/coordinator-room.test.ts` and `src/test/group-crypto.test.ts`.

The governing rule (from `PRODUCTION-PLAN.md`, enforced in the UI): **never fake
recovery, availability or counts — if data is gone, say so.**

## 1. Coordinator restart

The coordinator keeps **only** an in-memory room registry
(`server/src/registry.ts`) — "Nothing is ever written to disk." A restart
therefore means:

- The registry begins **empty and honest**: no rooms, no members, no ghosts.
  (`startCoordinator` even resets it on re-start inside the same process, so
  tests can simulate a restart without a second binary.)
- Until an owner re-registers, every join/probe answers
  `room-unavailable` → the UI shows
  **"Room temporarily unavailable — its coordinator lease is not live right now."**
  Discover shows listings as unavailable instead of pretending a room is up, and
  `/health` reports `rooms: 0`.
- Members that were in a room receive `room.offline` with a factual reason:
  `owner-left`, `lease-expired` or `unregistered`.
- **Nothing local is lost.** Chat history, identity, manifests and drafts live
  in the browser (see §4); the coordinator holds none of it.

Client-side connection states are explicit and honest
(`src/lib/pixel/coordinator.ts`): `idle → connecting → connected`, plus
`reconnecting (attempt)`, `room-unavailable (reason)` and `recovery-failed`.
There is no state that claims success before the coordinator actually answered.

**Tests (all passing, observed 2026-11-20):** `coordinator.test.ts` —
*restarts clean: an empty registry says so instead of pretending* (join after
restart → `room-unavailable`; owner re-registers with a fresh proof; the room
returns), *owner disconnect ends the room for members — no fake availability*,
*health reports live facts only*; `coordinator-room.test.ts` — *members learn
honestly when the owner's lease dies*.

## 2. Rejoin and re-advertise (after a reconnect or restart)

`CoordinatorClient` reconnects with **jittered exponential backoff (0.6 s → 8 s,
±30 %)** and, once the socket is back, runs `reassert()`:

1. **Owner side — re-advertise:** every owned room is re-registered with its
   *stored* manifest plus a **fresh nonce-bound ECDSA ownership proof** (proofs
   are single-connection: the per-connection nonce from `welcome` + a timestamp
   window, so a captured proof cannot be replayed). The lease loop then renews
   every **30 s** (lease TTL **90 s**). Re-registration needs no coordinator
   memory — the manifest and signing key come from the local recovery registry.
2. **Member side — rejoin:** `rejoinWithRetry` sends `room.join` up to
   **5 attempts, 3 s apart**, waiting **4 s** for `room.state` each time, while
   suppressing the *expected* racing `room-unavailable` (the owner's own
   re-registration can legitimately land after the member's first try). Only
   when the retries are exhausted does it surface the honest
   `room-unavailable` state — it never claims membership it does not have.
3. A `join()` or `probe()` issued while the socket is still `CONNECTING` waits
   (bounded, 8 s) for `welcome` instead of being silently dropped — two
   regressions pinned by tests: *a join() issued while the socket is still
   connecting is not dropped* and *a probe issued while the socket is still
   connecting is answered (ready() wait)*, plus *a member rejoining a restarted
   coordinator retries until the owner re-registers* (member reconnects **before**
   the owner and still recovers).

Room availability itself is a lease fact: registration/renewal require a valid
signature over the manifest **and** a fresh ownership proof from the manifest's
owner (or an authorized co-owner when `policy.recovery` says `co-owner`), so a
room cannot be taken over during a restart window by someone who merely knows
the room id.

## 3. Group rooms: ownership recovery and key rotation

- **Snapshot:** the host persists its room snapshot locally under
  `pxc.gsnap.<room>` (roster, roles, bans, pins, rules, meta — no message keys).
- **Re-hosting the same room** reopens from that snapshot with **epoch + 1**, so
  every key minted before the outage is void; saved roles are kept so approvals
  and bans can be restored, and members re-key automatically (they request keys
  with `keyreq` when a snapshot arrives without their chain).
- **Any membership change** (member left, kick, ban, re-host) calls `rotate()`:
  epoch bump → fresh sender chain → pairwise re-distribution to the *current*
  roster only, with an in-app notice ("Encryption keys updated …").
- **Member connection blips** get a **90 s reconnect grace** before the host
  treats them as gone (`RECONNECT_GRACE_MS`) — a flapping network does not kick
  members or force an epoch bump.
- **Removed members cannot decrypt future group messages:** after the epoch
  bump their chain is never re-distributed, and the relay drops their traffic.
  This is not retroactive for messages they already legitimately held keys for.
  Pinned by `group-crypto.test.ts` — *late joiners cannot decrypt messages sent
  before they received the chain* and *rejects frames from a different room,
  epoch or generation*.

## 4. Gap recovery for missed messages (`g-recover`)

Group DataChannels are created with **`ordered: true`**
(`src/lib/pixel/session.ts:116`), so delivery is in order — live gaps only
appear after a reconnect blip (a channel that died mid-stream), not from normal
network reordering.

When a frame arrives whose sequence is ahead of what the receiver has:

1. **Retain keys, not plaintext:** walking the ratchet forward over the gap
   keeps the skipped positions' message keys, bounded at
   **`MAX_SKIPPED_KEPT = 32` per sender** (oldest dropped, newest kept — gaps
   wider than that are honestly unrecoverable). Retained keys are single-use.
2. **Ask the original sender:** the receiver sends a pairwise-sealed
   `recover-req {epoch, gen, seqs}` (up to 64 sequence numbers) over
   **`g-recover`**. The host relays this envelope **verbatim and opaque** — it
   is sealed to the specific member pair (static-static ECDH + HKDF bound to the
   room), so the relay cannot read it.
3. **Sender replays sealed frames:** the sender keeps its last **64** outgoing
   sealed frames in memory (`sentLog`) and answers with `recover-resp` carrying
   the original **sealed** frames. No plaintext ever re-enters the wire; the
   receiver opens them with the retained skipped keys
   (`openRecoveredMessage`), re-emitting only ordinary messages, deduplicating
   via a bounded seen-set (512), and rejecting frames that are not the sender's
   own.
4. **Honest deadline:** the request is bounded at **8 s**; whatever did not
   arrive produces a single in-app note —
   *"N earlier messages from `<name>` couldn't be recovered."* — instead of a
   silent hole or a fake success. If the sender no longer retains a frame
   (already trimmed from `sentLog`), the same note fires.

**Tests:** `group-crypto.test.ts` — *retains skipped keys over a gap and
recovers the missed frames verbatim*, *recovered frames are authenticated,
sender-bound and key-bound*, *caps retained skipped keys, keeping the newest
chain positions*, *tolerates out-of-order delivery, then rejects the skipped
older frame*. The `g-recover` relay/round-trip through a live `GroupSession` is
exercised only indirectly by these unit tests — the full two-browser path was
validated manually (see [`TESTING.md`](TESTING.md) → live validation).

## 5. Local encrypted browser-storage recovery

Two separate, both-local mechanisms exist. Neither talks to the coordinator.

### 5a. Recovery registry (`src/lib/pixel/recovery.ts`) — identity & rooms

- **At rest:** the entire payload is one AES-GCM blob encrypted by a
  **device-local, non-extractable AES-GCM-256 key** stored in IndexedDB
  (`pixolark` → `recovery` store). Nothing is ever sent anywhere automatically.
- **What is stored (encrypted):** identity recovery material — display name,
  Pixolark id, the **ECDH identity private key** and the **manifest signing
  private key** (exportable PKCS8 clones, used only for backup/transfer) — plus
  owned/joined room ids, their signed manifests, last coordinator URL, last
  selected room per surface, drafts, pinned messages and preferences.
- **What is NOT in it:** message history (a separate per-room encrypted IndexedDB
  log with its own 24 h auto-delete preference), session/group message keys
  (memory-only by design), and group chain-generation counters.
- **Corrupt or missing data** loads as an honest empty payload — never a
  half-invented state. `clearEverything()` genuinely wipes registry + history +
  keys + localStorage (tested).
- **Export / import (device transfer):** `exportRecovery(password)` re-encrypts
  the payload with **PBKDF2-SHA-256, 600 000 iterations** (minimum password
  length 8); `importRecovery(backup, password)` validates the file shape
  ("Not a Pixolark backup file."), decrypts ("Wrong password or corrupted
  backup.") and writes into **this** device's registry. Round-trip onto a wiped
  device, wrong-password rejection and short-password rejection are all tested
  in `recovery.test.ts`.
- **If the coordinator restarts mid-session:** nothing in this registry is
  affected — it has no coordinator state beyond `lastCoordinator`. The client
  uses it to re-register (owner) or re-join (member) automatically once the
  coordinator is back (§2). If it never comes back, the app keeps saying so
  (`room-unavailable` / `recovery-failed`) rather than inventing availability.
- **If the browser storage is gone and there is no export:** recovery is
  **genuinely impossible** — the signing-key clone and identity exist nowhere
  else. The code says this explicitly and the UI must repeat it; nothing is
  reconstructed or faked.

### 5b. Passphrase backup file (`src/lib/pixel/storage.ts`) — history & prefs

A separate Settings → Data export: passphrase → **PBKDF2-SHA-256, 210 000
iterations** → AES-GCM. It contains preferences, opt-in 1:1 history, drafts,
bookmarks, recent rooms and host room snapshots. It deliberately **excludes**
identity keys (non-extractable, stay in IndexedDB) and group chain-generation
counters (a restored stale counter could confuse replay checks). Wrong
passphrases and tampered ciphertext are rejected by AES-GCM (tested in
`storage-notifications.test.ts`).

In short: **5a** recovers *who you are and which rooms you own/joined*;
**5b** recovers *what you saw and configured*. Use both for a full restore.

## Honest limits

- There is **no server-side copy of anything** to restore from — that is the
  product, not a missing feature. Cleared browser + no backup = gone, and the
  app says "cannot be recovered".
- A coordinator that stays down keeps rooms unjoinable; the UI never shows fake
  "online" counts to paper over it (directory listings show
  "temporarily unavailable" unless a live lease answers a probe).
- Gap recovery is best-effort and bounded (32 keys, 64 frames, 8 s): older or
  never-retained messages produce the honest note, not a silent gap.

See [`SECURITY.md`](SECURITY.md) for the cryptographic details,
[`ARCHITECTURE.md`](ARCHITECTURE.md) for design, and [`TESTING.md`](TESTING.md)
for the test inventory and the recorded two-browser validation.
