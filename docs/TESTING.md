# Testing Pixolark

Everything in this file was verified by running the commands on **2026-11-22** on
Windows (`bun` + `vitest 4.1.11`, `vite 8.3.8`). Numbers below are what a run
actually reported, not targets. Failing or untested things are labeled as such —
we never write down a pass we did not observe.

## How to run

| Command | What it does |
| --- | --- |
| `npx vitest run` (alias: `bun run test`) | Full unit/integration suite. **Observed 2026-11-22: 14 test files, 99 tests, all passing** (~22 s). |
| `npx vitest` (alias: `bun run test:watch`) | Same suite in watch mode. |
| `npx tsc --noEmit` | Strict TypeScript check from the repo root (`exactOptionalPropertyTypes` on). **Observed 2026-11-22: exit 0.** |
| `cd server && npx tsc --noEmit` | Strict check for the coordinator (`server/tsconfig.json`). **Observed 2026-11-22: exit 0.** |
| `npx vite build` (alias: `bun run build`) | Full client + SSR + Nitro production build. |
| `bun run stickers:build` | Regenerates/validates the generated sticker library (`scripts/build-stickers.ts`). Only needed when editing `stickercatalog.ts`/`stickerart.ts` — never hand-edit `public/stickers/` or `sticker-version.ts`. |
| `bun run lint` / `bun run format` | ESLint / Prettier. |

Notes:

- The suite count (14 files / 99 tests) is a snapshot **as observed on
  2026-11-22**; the sticker tests in particular are regenerated assets and may
  change with catalog work. Re-run the command instead of trusting this line if
  it matters.
- Tests run under `vitest` (`vitest.config.ts`): jsdom by default,
  `node` environment for the coordinator suites, `fake-indexeddb` for storage.
  `bun test` (Bun's own runner) is **not** the entry point — the tests import
  from `vitest`.

## Suite inventory (14 files / 99 tests)

| Test file | Covers | Tests |
| --- | --- | --- |
| `src/test/coordinator.test.ts` | Real coordinator server + real WS client: registration, proofs, relay, restart | 8 |
| `src/test/coordinator-hardening.test.ts` | Coordinator abuse surface: malformed/oversized frames, floods, room-id validation, name sanitization, connection/room/member caps, origin allowlist, heartbeat reaper | 10 |
| `src/test/coordinator-room.test.ts` | Coordinator↔room signaling glue against the real coordinator | 6 |
| `src/test/group-crypto.test.ts` | Sender-key ratchet, replay/tamper/epoch rejection, gap recovery | 13 |
| `src/test/group-identity-adapter.test.ts` | Per-room non-extractable identity → session identity adapter | 3 |
| `src/test/pixel-crypto.test.ts` | 1:1 ECDH/AES-GCM: safety code, tamper/replay rejection, code expiry | 6 |
| `src/test/manifest.test.ts` | ECDSA-P256 signed manifests: canonical bytes, tamper/expiry/fingerprint | 7 |
| `src/test/directory.test.ts` | Static signed directory client: verification, mirrors, filters, outage | 5 |
| `src/test/discovery.test.ts` | Host beacons: dedupe, staleness, closed rooms, malformed input, fingerprints; three-level region catalog + `regionPath`/`regionMatches` | 8 |
| `src/test/recovery.test.ts` | Encrypted local recovery registry: round-trip, export/import, wipe | 6 |
| `src/test/storage-notifications.test.ts` | Prefs/drafts/bookmarks/recents/snapshots/backup + notification router | 11 |
| `src/test/signaling-rate.test.ts` | ntfy fallback transport: retries, tombstones, SSE/poll behavior, 429 backoff | 8 |
| `src/test/stickers.test.ts` | Sticker catalog/assets/version guard + incoming-sticker rules | 7 |
| `src/test/app-routing.test.tsx` | Route matching for `/` | 1 |

## Master-spec scenario coverage (honest mapping)

The "Complete Production-Ready Messenger" master spec itself is **not committed to
this repo** — it is only referenced by `docs/PRODUCTION-PLAN.md` and by the test
headers in `src/test/coordinator.test.ts` ("Covers the master spec's mandatory
scenarios") and `src/test/coordinator-room.test.ts`. The spec targets **16
mandatory scenarios, including two real browser sessions**. Below is the mapping
of what those headers name to the tests that actually assert it — scenario →
test file → assertion:

### Coordinator scenarios (named in `coordinator.test.ts`'s header)

| Scenario | Test file / test | What it asserts |
| --- | --- | --- |
| Owner registration with a fresh proof | `coordinator.test.ts` — *registers an owner with a valid manifest + fresh proof and answers joins* | `room.registered` for a signed manifest + nonce-bound proof; a joining member receives `room.state` whose member list is exactly the **live** owner + joiner (no invented members) |
| Hijack attempt via tampered manifest / forged proof | `coordinator.test.ts` — *rejects a tampered manifest and a forged ownership proof (hijack attempt)* | Editing any field → `manifest-invalid`; a proof signed by a different key → `proof-invalid` |
| Replayed proof from another connection | `coordinator.test.ts` — *refuses replayed proofs bound to another connection's nonce* | Captured (manifest, proof) replayed on a fresh socket → `proof-invalid` (per-connection nonce + timestamp tolerance) |
| Honest "room unavailable" answers | `coordinator.test.ts` — *answers joins on an unknown/expired room honestly* | Joining a room with no live lease → `room-unavailable`, never a fake room state |
| Signaling relay scoped to live members | `coordinator.test.ts` — *relays WebRTC signaling only between live members of the room* | `rtc` offer reaches the joined member; relaying to a non-member → `peer-absent` (nothing is buffered into a fake state) |
| Lease expiry / no fake availability | `coordinator.test.ts` — *owner disconnect ends the room for members — no fake availability* | Owner disconnect → members get `room.offline` with `owner-left`; a subsequent join is honestly refused. **Honest gap:** no test fast-forwards the 90 s lease TTL itself, so the `lease-expired` reason of `room.offline` is exercised by the registry sweeper in production, not in the suite. |
| Restart recovery | `coordinator.test.ts` — *restarts clean: an empty registry says so instead of pretending* | After `startCoordinator` restarts: joins → `room-unavailable`; owner re-registers with a fresh proof and the room returns; no backend memory involved |
| Health endpoint truthfulness | `coordinator.test.ts` — *health reports live facts only* | `GET /health` → `ok: true`, `rooms ≥ 0`, `connections ≥ 0` (counts come from the live registry) |

### Signaling-glue scenarios (`coordinator-room.test.ts`)

| Scenario | Test | What it asserts |
| --- | --- | --- |
| want → offer → answer → adoption choreography | *routes want → offer → answer → adoption between owner and member* | Member's `want` returns the owner's doorbell offer through the relay; the member's answer completes the handshake and the reception adopts the session |
| Stale/superseded answers | *stale answers (superseded doorbell) are refused and re-asks get the fresh offer* | After rotation, an old answer fails the sid guard, the member is told honestly (`stale`), and a re-ask completes on the fresh doorbell |
| Honest offline signaling | *members learn honestly when the owner's lease dies* | Owner disconnect → member observes `room.offline` = `owner-left` |
| Regression: `join()` before the socket opened | *a join() issued while the socket is still connecting is not dropped* | `room.join` waits for `welcome` (bounded) instead of being silently discarded on a CONNECTING socket |
| Regression: `probe()` before the socket opened | *a probe issued while the socket is still connecting is answered (ready() wait)* | `ready()` brings the socket up so the first Discover→Join probe gets a real answer instead of a false "not available" |
| Regression: rejoin race after restart | *a member rejoining a restarted coordinator retries until the owner re-registers* | After `registry.reset()` (restart semantics), a member reconnecting **before** the owner retries until membership is restored instead of banner-and-give-up |

### Honest gaps (labeled, not hidden)

- **Two real browser sessions are not covered by vitest.** `RTCPeerConnection`
  does not exist in the test environments, so `coordinator-room.test.ts` drives
  the doorbell through a contract-faithful double (its header says so). The real
  E2EE path was validated manually with two real browsers — see the recorded run
  below.
- **Time-based lease expiry** (`room.offline` reason `lease-expired`) is not
  simulated with fake timers; only owner-disconnect (`owner-left`) is.
- **Signaling-rate tests mock `fetch`/SSE** — they pin cadence and backoff
  behavior, they do not hit ntfy.sh.
- The remaining spec areas (E2EE core, group crypto, manifests, directory,
  discovery, recovery, storage, notifications, stickers) are covered by the
  inventory table above; the spec's own numbered list is not in the repo, so no
  claim is made that any particular spec number is "scenario N".

## Live two-browser validation (2026-11-20)

Recorded result of a real end-to-end run against the live coordinator — not a
simulation, and not part of the vitest suite:

- **Setup:** coordinator running locally (`bun server/src/index.ts`); room
  **358885** hosted in **headless Chrome (CDP :9222)**; joined from a second,
  separate **real browser (Microsoft Edge)**.
- **Traffic:** **5 consecutive guest → host messages and 4 host → guest
  replies — 9 messages total — all decrypted and rendered on both sides**
  (the full 9-message conversation visible in each browser).
- **Coordinator:** `GET /health` reported `{"rooms":1,"connections":2}` while the
  session was live.
- **What this validated:** the **group sender-key ratchet fix in commit
  `3d3aa3c` ("Fix group sender-key ratchet (3rd+ message key drift) + gap
  recovery")**. On the previous build the same run failed to decrypt message
  **#3** on the receiving side; after the fix, all 9 messages decrypt in
  order. The ratchet regression is additionally pinned by the unit test
  *"opens a long run of consecutive messages without key drift (regression:
  3rd message)"* in `src/test/group-crypto.test.ts`.
- **Why gaps were not part of this run:** group DataChannels are created with
  `ordered: true` (`src/lib/pixel/session.ts:116`), so in-flight delivery is
  in-order — real gaps only arise from reconnect blips, which is exactly what
  the `g-recover` path (`src/lib/pixel/group.ts`) and its unit tests are for.

## Honesty rules (enforced)

- No simulated successes: a pass is only written down if the command produced it.
- Anything failing, skipped, mocked or untested is labeled as such above.
- The two-browser scenario is reported as a **manual live validation**, never as
  an automated test.
- Re-run the suite before quoting the "14 files / 99 tests" number — this
  document records what was observed on 2026-11-22.

See also: [`ARCHITECTURE.md`](ARCHITECTURE.md) (design + honest limitations),
[`SECURITY.md`](SECURITY.md) (threat model), [`RECOVERY.md`](RECOVERY.md)
(recovery paths), [`DEPLOYMENT.md`](DEPLOYMENT.md) (manual multi-device
checklist).
