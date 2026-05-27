# Nerilo E2E Test Plan

Living document. Last updated **2026-05-27**.

The Playwright suite runs against Firebase emulators (`auth:9099`, `firestore:8080`) via `npm run test:e2e:ci`. Tests use the `baseURL=http://localhost:4173` from [playwright.config.ts](../playwright.config.ts) and are organised by user journey, not by source-file boundary.

This plan distinguishes:

- **Stable subset** — runs as a merge gate in `.github/workflows/ci.yml` (currently `continue-on-error: true`, flip to required once green for 2 weeks).
- **Full suite** — runs in `.github/workflows/e2e-tests.yml`.

## Current coverage (as of 2026-05-27)

| Spec | LoC | What it covers | Tier | Health |
|---|---:|---|---|---|
| `waiting-room.spec.ts` | 157 | Anon login → create room → waiting page UI (timer, share, cancel, leave) | **stable** | green when emulators run |
| `room-management.spec.ts` | 134 | Create new room closes old room; 2-person auto-redirect; 2-person 4-message exchange | **stable** | needs P2P (60 s timeouts) |
| `room-closed.spec.ts` | 96 | Closed room redirects to dashboard | **stable** | green |
| `room-timeout.spec.ts` | 50 | Waiting timer visible; full timeout flow noted but not exercised | **stable** | green |
| `guest-chat.spec.ts` | 68 | Anon-only golden path: 2 guests message exchange | full | needs P2P |
| `user-chat.spec.ts` | 69 | Same as guest-chat but assumes login | full | duplicates guest-chat |
| `single-user-room.spec.ts` | 71 | Single-user can enter chat + 2nd user joins later | full | needs P2P |
| `architecture-selection.spec.ts` | 193 | 2 peers ⇒ star, 3 peers ⇒ mesh (inspects console logs) | full | brittle (regex-greps logs) |
| `mesh-gossip.spec.ts` | 158 | 3-person mesh gossip relay | full | flaky on slow ICE |
| `core-lifecycle.spec.ts` | 258 | Single-user, 2-person full lifecycle, leave → rejoin | full | mostly green |
| `comprehensive-chat.spec.ts` | 502 | Big bag: auth/permission, room lifecycle, messages, reconnect | full | duplicates many others |
| `multi-user-stability.spec.ts` | 276 | 2-/3-peer message ordering | full | ⚠️ hardcodes `localhost:3000` |
| `stress-test.spec.ts` | 300 | LCP / FCP / heap / PC leak | full | ⚠️ hardcodes `localhost:3000` |
| `nerilo-smoke.spec.ts` | 112 | Old "happy path with screenshots" smoke run | full | ⚠️ hardcodes `localhost:3000` |

### Known coverage gaps

| Gap | Why it matters |
|---|---|
| **E2EE indicator** (commit [5d6acfb](../.git)) | New UI element, zero test. If the lock icon disappears, no test fails. |
| **Message delivery status** (sending → sent → delivered → failed → resend) | Visible to every sender, untested. |
| **Typing indicator** (star topology only) | Untested. |
| **Firestore fallback** when P2P is blocked | Mentioned but never isolated. We have no test that asserts "P2P fails ⇒ banner says 備援模式 ⇒ messages still flow." |
| **Unicode / emoji / 4 KB message** | Untested. Easy regression vector. |
| **Browser refresh mid-chat** | The dexie-backed history is documented behaviour. No test verifies it. |
| **Multi-tab same user** | Not exercised. |
| **Room access denied for non-participants** | The firestore rules enforce this (post-stress-test fix); a regression would be invisible without a test. |
| **Public-room visibility on dashboard** | Listed in DashboardPage UI, not tested. |
| **Share modal QR-code + copy** | Only the copy button presence is tested. |
| **404 / invalid roomId** | Should redirect to dashboard; untested. |
| **3-tab spam stability** | Documented as a goal; never asserted. |

## Test plan

### P0 — Must pass before any deploy (golden path)

These five run as the **stable subset**. If any P0 test fails, the deploy job is blocked.

| # | Test | Journey | Notes |
|---|---|---|---|
| P0.1 | `golden-path.spec.ts > anonymous user can land on the dashboard` | Open `/dashboard` → wait for `.role-badge` to read `guest` → "+ 建立新房間" button visible | Replaces the implicit role check in 6 other specs. |
| P0.2 | `golden-path.spec.ts > host can create a room` | Create room → land on `/waiting/:roomId` → 等待連線 banner visible | Smallest test, fastest failure signal. |
| P0.3 | `golden-path.spec.ts > second user joins via link and both see chat` | 2 contexts, B opens the `/chat/{roomId}` URL, both end up on `/chat`, both see "已連線" | The "did the product still work today?" check. |
| P0.4 | `golden-path.spec.ts > A sends, B receives` | Send "hello {timestamp}" from A → B sees it within 10 s | Real proof of working transport. |
| P0.5 | `golden-path.spec.ts > E2EE indicator is visible when connected` | After both peers are connected, `.e2ee-indicator-p2p` is visible on both sides; text contains "端到端加密" | Locks in [5d6acfb](../.git). |

### P1 — Core features (run on every PR, allowed to fail for now)

| # | Test | Journey |
|---|---|---|
| P1.1 | `chat-flow.spec.ts > delivery status progresses sending → sent → delivered` | Verify the 3 status icons appear in order for a sent message |
| P1.2 | `chat-flow.spec.ts > failed message can be resent` | Force a failure (close peer), see status=failed + resend button, click resend, status=sent |
| P1.3 | `chat-flow.spec.ts > unicode and emoji round-trip` | "👋 你好 🌏 émoji éclair" from A → identical bytes on B |
| P1.4 | `chat-flow.spec.ts > long message (5 KB body) round-trips` | Fill input with 5000 chars, send, receive — covers the 256 KB DataChannel cap is not over-restrictive |
| P1.5 | `chat-flow.spec.ts > rapid send burst — 10 messages in 1s preserved in order` | Send 10 messages back-to-back, all 10 visible in order on receiver |
| P1.6 | `connection-states.spec.ts > banner shows connecting → connected on first peer` | Inspect ConnectionBanner classes through the lifecycle |
| P1.7 | `connection-states.spec.ts > banner shows 備援模式 when P2P signaling is blocked` | Use Playwright route interception to break `/signals` writes; verify Firestore fallback path engages and messages still flow |
| P1.8 | `connection-states.spec.ts > E2EE indicator switches to fallback variant` | Same as P1.7 — `.e2ee-indicator-fallback` shows "備援模式" |
| P1.9 | `multi-peer.spec.ts > 3-peer mesh — every peer sees every other peer's messages` | 3 contexts, each sends one message, all 3 see all 3 (covers H-01 fix doesn't break basic mesh) |
| P1.10 | `refresh-recovery.spec.ts > messages persist across browser refresh` | Send 3 messages → reload one peer → all 3 still visible (Dexie history) |

### P2 — Security & privacy

| # | Test | Journey |
|---|---|---|
| P2.1 | `security.spec.ts > non-participant cannot read room` | Open `/chat/{someoneElsesRoomId}` as guest → expect redirect / permission-denied |
| P2.2 | `security.spec.ts > non-participant cannot read messages subcollection` | Direct firestore read attempt fails (via `page.evaluate` calling `getDocs(messages)`) |
| P2.3 | `security.spec.ts > anonymous user blocked from creating rooms when flag is off` | Spin up Vite with `VITE_ALLOW_GUEST_CREATE_ROOM=false` (or unset); button is disabled / room creation 403s |
| P2.4 | `security.spec.ts > meshIdentities cannot be overwritten by another participant` | Bob joins, tries `setDoc({meshIdentities: {alice_uid: bob_pubkey}})` → permission-denied (covers [b0b1204](../.git)) |
| P2.5 | `security.spec.ts > Firestore-fallback message bodies are encrypted` | Force fallback path, then read the messages subcollection directly — assert `content` field is base64 ciphertext, not plaintext |

### P3 — Edge cases & resilience

| # | Test | Journey |
|---|---|---|
| P3.1 | `edge-cases.spec.ts > slow network — Playwright route throttle to 100 KB/s` | Connection still establishes within 90 s, messages eventually flow |
| P3.2 | `edge-cases.spec.ts > 404 roomId redirects to dashboard` | `/chat/non-existent-room-id` → `/dashboard` |
| P3.3 | `edge-cases.spec.ts > multi-tab same user — second tab doesn't break first` | Same browser context opens two tabs to same room, no crash, both see new messages |
| P3.4 | `edge-cases.spec.ts > leave room → other user keeps chat open` | A leaves, B's chat page stays usable, room still listed for B |
| P3.5 | `edge-cases.spec.ts > public room appears on dashboard for other users` | A creates public room, B sees it in 公開房間 section |
| P3.6 | `edge-cases.spec.ts > host can cancel waiting room from dashboard re-entry` | A creates → goes back → re-enters → can still 取消房間 |
| P3.7 | `edge-cases.spec.ts > messages from a left peer remain in history` | Bob sends "x", leaves, "x" still visible on Alice |

### P4 — Future features (skipped until shipped)

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
2. **No hardcoded `localhost:3000`.** All new specs rely on the configured `baseURL` (4173 in tests). The three legacy specs (`multi-user-stability`, `stress-test`, `nerilo-smoke`) that hardcode `:3000` are quarantined — they'll be migrated or deleted in a follow-up.
3. **Replace `waitForTimeout` with `expect.toPass` or `locator.waitFor`.** The existing pattern of `await page.waitForTimeout(3000)` after a state change is brittle; new specs use proper waits.
4. **Each test is independent.** No `test.describe.serial` for the new specs unless explicitly needed (the cross-test state would have to be documented).
5. **Long timeouts only where physics demands them.** ICE gathering can take 30–60 s. Locator presence should rarely need > 10 s.
6. **Tag P0 tests with `@stable`.** The `test:e2e:stable` npm script runs only `@stable`-tagged tests, which becomes the merge gate.
7. **Multi-user pattern.** Use `browser.newContext()` per user, **not** `chromium.launch()` — Playwright reuses the browser process and per-context isolation is enough.

## Migration plan for legacy specs

Two-week clean-up after the P0/P1 specs ship:

1. Delete `user-chat.spec.ts` (full duplicate of `guest-chat.spec.ts`).
2. Migrate `nerilo-smoke.spec.ts` to use `baseURL` + delete it (its 9 steps are covered by new P0).
3. Migrate `multi-user-stability.spec.ts` to use `baseURL` + tag interesting cases as P1.
4. Migrate `stress-test.spec.ts` to use `baseURL` + move to a separate `tests/perf/` directory (it's a perf bench, not a correctness E2E).
5. Shrink `comprehensive-chat.spec.ts` to only the cases not covered elsewhere.

This brings the suite from 14 specs (2 444 LoC) down to roughly 10 specs (~1 800 LoC) with materially better coverage.

## CI integration

| Workflow | Scope | When |
|---|---|---|
| `ci.yml` → `e2e` job | `npm run test:e2e:stable` (P0 only) | every PR; merge gate eventually |
| `e2e-tests.yml` | `npm run test:e2e:ci` (everything) | every PR; `continue-on-error: true` while flakiness shakes out |

Both jobs set up Java 17 (Temurin) and cache `~/.cache/firebase/emulators`.

## How to extend

When a new feature lands:

1. Add tests to the appropriate tier in this document **first** (P0/P1/P2/P3/P4).
2. Implement them with the shared helpers.
3. Update the "Current coverage" table.
4. If the new feature affects the golden path, add a corresponding P0 entry.
