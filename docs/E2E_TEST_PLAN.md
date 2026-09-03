# Nerilo E2E Test Plan

Living document. Last updated **2026-09-03**.

The Playwright release suite runs against Firebase emulators (`auth:9099`, `firestore:8080`) via `npm run test:e2e:release`. Tests use the `baseURL=http://localhost:4173` from [playwright.config.ts](../playwright.config.ts) and are organised by user journey, not by source-file boundary. `npm run test:e2e:ci` remains an all-files diagnostic command and includes quarantined historical specs; it is not a release signal.

This plan distinguishes:

- **Stable subset**: 11 `@stable` tests run as a hard merge gate in `.github/workflows/ci.yml`.
- **Release suite**: 27 maintained `@release` P0/P1/P2 tests run as a hard gate in `.github/workflows/e2e-tests.yml`.
- **Legacy diagnostic suite**: historical files remain available for migration evidence, but conflict with current registered-user ownership rules or obsolete UI assumptions and are not release assertions.

## Maintained release coverage (as of 2026-09-03)

| Spec | Tests | What it covers | Tier |
|---|---:|---|---|
| `auth-flow.spec.ts` | 4 | Register, logout/login, invalid login, duplicate registration | P0 |
| `chat-dedup.spec.ts` | 1 | Bidirectional E2EE and exactly-once display | P0 |
| `golden-path.spec.ts` | 6 | Dashboard, create/join, chat, E2EE indicator, leave | P0 |
| `chat-flow.spec.ts` | 4 | Delivery status, Unicode, 5 KB body, rapid ordered burst | P1 |
| `connection-states.spec.ts` | 2 | Direct connection and encrypted Firestore fallback | P1 |
| `multi-peer.spec.ts` | 1 | Three-peer mesh delivery | P1 |
| `refresh-recovery.spec.ts` | 1 | IndexedDB history survives reload without waiting for P2P reconnect | P1 |
| `game-ttt.spec.ts` | 2 | Two-player moves and late-panel state sync | P1 |
| `mesh-diagnostic.spec.ts` | 1 | Three-peer exactly-once delivery matrix | P1 |
| `security.spec.ts` | 5 | Room rules, identity ownership, encrypted fallback, guest restriction | P2 |

## Legacy inventory (quarantined from release CI)

| Spec | LoC | What it covers | Tier | Health |
|---|---:|---|---|---|
| `waiting-room.spec.ts` | 157 | Anonymous create-room assumptions | legacy | guest creation is now denied by rules |
| `room-management.spec.ts` | 134 | Duplicate room lifecycle/message paths | legacy | old selectors and anonymous setup |
| `room-closed.spec.ts` | 96 | Closed-room paths | legacy | old selectors and anonymous setup |
| `room-timeout.spec.ts` | 50 | Waiting timer paths | legacy | old selectors and anonymous setup |
| `guest-chat.spec.ts` | 68 | Anonymous create-room path | legacy | contradicts P2.3 security policy |
| `user-chat.spec.ts` | 69 | Duplicated two-user path | legacy | does not actually register the user |
| `single-user-room.spec.ts` | 71 | Single-user room path | legacy | old anonymous setup |
| `architecture-selection.spec.ts` | 193 | Topology inferred from logs | legacy | brittle and uses old setup |
| `mesh-gossip.spec.ts` | 158 | Older mesh path | legacy | superseded by maintained mesh tests |
| `core-lifecycle.spec.ts` | 258 | Older lifecycle bag | legacy | duplicated by golden path/P1 tests |
| `comprehensive-chat.spec.ts` | 502 | Large duplicated scenario bag | legacy | stale selectors and setup |
| `multi-user-stability.spec.ts` | 276 | Older ordering scenarios | legacy | hardcodes `localhost:3000` |
| `stress-test.spec.ts` | 300 | Performance/heap/PC benchmarks | legacy/perf | hardcodes `localhost:3000`; not correctness E2E |
| `nerilo-smoke.spec.ts` | 112 | Old screenshot smoke | legacy | hardcodes `localhost:3000`; superseded by P0 |

### Known coverage gaps

| Gap | Why it matters |
|---|---|
| **Typing indicator** (star topology only) | Untested. |
| **Multi-tab same user** | Not exercised. |
| **Public-room visibility on dashboard** | Listed in DashboardPage UI, not tested. |
| **Share modal QR-code + copy** | Only the copy button presence is tested. |
| **404 / invalid roomId** | Should redirect to dashboard; untested. |
| **3-tab spam stability** | Documented as a goal; never asserted. |

## Test plan

### P0: Must pass before any deploy (golden path)

The golden path plus auth and dedup checks run as the 11-test **stable subset**. If any stable test fails, the deploy job is blocked.

| # | Test | Journey | Notes |
|---|---|---|---|
| P0.1 | `golden-path.spec.ts > registered user lands on dashboard` | Register → land on `/dashboard` → `.role-badge` reads `user` | Verifies the room owner is authenticated before creation. |
| P0.2 | `golden-path.spec.ts > host can create a room` | Create room → land on `/waiting/:roomId` → 等待連線 banner visible | Smallest test, fastest failure signal. |
| P0.3 | `golden-path.spec.ts > second user joins via link and both see chat` | 2 contexts, B opens the `/chat/{roomId}` URL, both end up on `/chat`, both see "已連線" | The "did the product still work today?" check. |
| P0.4 | `golden-path.spec.ts > A sends, B receives` | Send "hello {timestamp}" from A → B sees it within 10 s | Real proof of working transport. |
| P0.5 | `golden-path.spec.ts > E2EE indicator is visible when connected` | After both peers are connected, `.e2ee-indicator-p2p` is visible on both sides; text contains "端到端加密" | Locks in [5d6acfb](../.git). |

### P1: Core features (hard release gate)

| # | Test | Journey |
|---|---|---|
| P1.1 | `chat-flow.spec.ts > delivery status progresses sending → sent → delivered` | Verify the 3 status icons appear in order for a sent message |
| P1.2 | `chat-flow.spec.ts > failed message can be resent` | Force a failure (close peer), see status=failed + resend button, click resend, status=sent |
| P1.3 | `chat-flow.spec.ts > unicode and emoji round-trip` | "👋 你好 🌏 émoji éclair" from A → identical bytes on B |
| P1.4 | `chat-flow.spec.ts > long message (5 KB body) round-trips` | Fill input with 5000 chars, send, receive, covers the 256 KB DataChannel cap is not over-restrictive |
| P1.5 | `chat-flow.spec.ts > rapid send burst, 5 messages in 1s preserved in order` | Send 5 messages back-to-back, all 5 visible in order on receiver |
| P1.6 | `connection-states.spec.ts > banner shows connecting → connected on first peer` | Inspect ConnectionBanner classes through the lifecycle |
| P1.7 | `connection-states.spec.ts > banner shows 備援模式 when P2P signaling is blocked` | Use Playwright route interception to break `/signals` writes; verify Firestore fallback path engages and messages still flow |
| P1.8 | `connection-states.spec.ts > E2EE indicator switches to fallback variant` | Same as P1.7，`.e2ee-indicator-fallback` shows "備援模式" |
| P1.9 | `multi-peer.spec.ts > 3-peer mesh, every peer sees every other peer's messages` | 3 contexts, each sends one message, all 3 see all 3 (covers H-01 fix doesn't break basic mesh) |
| P1.10 | `refresh-recovery.spec.ts > messages persist across browser refresh` | Send 3 messages → reload one peer → all 3 still visible (Dexie history) |

### P2: Security & privacy

| # | Test | Journey |
|---|---|---|
| P2.1 | `security.spec.ts > non-participant cannot read room` | Open `/chat/{someoneElsesRoomId}` as guest → expect redirect / permission-denied |
| P2.2 | `security.spec.ts > non-participant cannot read messages subcollection` | Direct firestore read attempt fails (via `page.evaluate` calling `getDocs(messages)`) |
| P2.3 | `security.spec.ts > anonymous user blocked from creating rooms when flag is off` | Spin up Vite with `VITE_ALLOW_GUEST_CREATE_ROOM=false` (or unset); button is disabled / room creation 403s |
| P2.4 | `security.spec.ts > meshIdentities cannot be overwritten by another participant` | Bob joins, tries `setDoc({meshIdentities: {alice_uid: bob_pubkey}})` → permission-denied (covers [b0b1204](../.git)) |
| P2.5 | `security.spec.ts > Firestore-fallback message bodies are encrypted` | Force fallback path, then read the messages subcollection directly, assert `content` field is base64 ciphertext, not plaintext |

### P3: Edge cases & resilience

| # | Test | Journey |
|---|---|---|
| P3.1 | `edge-cases.spec.ts > slow network, Playwright route throttle to 100 KB/s` | Connection still establishes within 90 s, messages eventually flow |
| P3.2 | `edge-cases.spec.ts > 404 roomId redirects to dashboard` | `/chat/non-existent-room-id` → `/dashboard` |
| P3.3 | `edge-cases.spec.ts > multi-tab same user, second tab doesn't break first` | Same browser context opens two tabs to same room, no crash, both see new messages |
| P3.4 | `edge-cases.spec.ts > leave room → other user keeps chat open` | A leaves, B's chat page stays usable, room still listed for B |
| P3.5 | `edge-cases.spec.ts > public room appears on dashboard for other users` | A creates public room, B sees it in 公開房間 section |
| P3.6 | `edge-cases.spec.ts > host can cancel waiting room from dashboard re-entry` | A creates → goes back → re-enters → can still 取消房間 |
| P3.7 | `edge-cases.spec.ts > messages from a left peer remain in history` | Bob sends "x", leaves, "x" still visible on Alice |

### P4: Future features (skipped until shipped)

| Feature | Test idea |
|---|---|
| File transfer | A picks a 100 KB file → progress bar visible on B → file downloadable on B with same SHA-256 |
| Audio call | A starts call → B accepts → both see remote stream MediaTrack count > 0 |
| Video call | Same + video track present |
| Screen sharing | A shares screen → B sees new MediaStream with `screen` source |
| Email registration | New user can register → log in → role=`user` |
| Public room search | Search box filters dashboard list |

## Implementation principles

1. **Single source of truth for helpers.** A new `tests/e2e/_helpers/users.ts` exports `setupUser`, `createRoom`, `joinRoom`, `sendMessage`, `expectConnected`. Existing specs may continue using their inline copies; new specs use the shared helper.
2. **No hardcoded `localhost:3000`.** All new specs rely on the configured `baseURL` (4173 in tests). The three legacy specs (`multi-user-stability`, `stress-test`, `nerilo-smoke`) that hardcode `:3000` are quarantined, they'll be migrated or deleted in a follow-up.
3. **Replace `waitForTimeout` with `expect.toPass` or `locator.waitFor`.** The existing pattern of `await page.waitForTimeout(3000)` after a state change is brittle; new specs use proper waits.
4. **Each test is independent.** No `test.describe.serial` for the new specs unless explicitly needed (the cross-test state would have to be documented).
5. **Long timeouts only where physics demands them.** ICE gathering can take 30–60 s. Locator presence should rarely need > 10 s.
6. **Tag P0 tests with `@stable`.** The `test:e2e:stable` npm script runs only `@stable`-tagged tests, which becomes the merge gate.
7. **Multi-user pattern.** Use `browser.newContext()` per user, **not** `chromium.launch()`, Playwright reuses the browser process and per-context isolation is enough.

## Migration plan for legacy specs

The maintained suite now carries the release signal. Remaining clean-up:

1. Delete `user-chat.spec.ts` (full duplicate of `guest-chat.spec.ts`).
2. Migrate `nerilo-smoke.spec.ts` to use `baseURL` + delete it (its 9 steps are covered by new P0).
3. Migrate `multi-user-stability.spec.ts` to use `baseURL` + tag interesting cases as P1.
4. Migrate `stress-test.spec.ts` to use `baseURL` + move to a separate `tests/perf/` directory (it's a perf bench, not a correctness E2E).
5. Shrink `comprehensive-chat.spec.ts` to only the cases not covered elsewhere.

The release signal is already concentrated in 10 maintained specs; this cleanup removes misleading duplicate diagnostics without reducing release coverage.

## CI integration

| Workflow | Scope | When |
|---|---|---|
| `ci.yml` → `e2e` job | `npm run test:e2e:stable` (P0 only) | every PR; merge gate eventually |
| `e2e-tests.yml` | `npm run test:e2e:release` (27 maintained P0/P1/P2 cases) | every PR and push; hard gate |

Both jobs set up Java 21 (Temurin) and cache `~/.cache/firebase/emulators`.

## How to extend

When a new feature lands:

1. Add tests to the appropriate tier in this document **first** (P0/P1/P2/P3/P4).
2. Implement them with the shared helpers.
3. Update the "Maintained release coverage" table.
4. If the new feature affects the golden path, add a corresponding P0 entry.
