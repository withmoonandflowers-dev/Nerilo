# Nerilo — P2P Real-Time Chat Platform

## Quick Reference

```bash
npm run dev          # Start Vite dev server
npm run build        # TypeScript check + Vite build
npm run type-check   # tsc --noEmit
npm run lint         # ESLint (max 100 warnings)
npm run test:run     # Vitest unit tests (single run)
npm run test:e2e     # Playwright E2E tests
npm run ci           # type-check + lint + unit tests
```

**Run unit tests:** `node ./node_modules/vitest/vitest.mjs run` (workaround for Windows node path issues)

## Tech Stack

- **Frontend:** React 18 + TypeScript 5 + Vite 5
- **Styling:** CSS Variables + Custom Design Tokens (dark mode support)
- **Auth/DB:** Firebase Auth + Firebase RTDB (signaling + fallback)
- **P2P:** WebRTC DataChannel (primary transport)
- **Crypto:** SubtleCrypto (ECDSA P-256 identity, ECDH key exchange, AES-256-GCM encryption)
- **i18n:** react-i18next (繁中 + English)
- **Error Tracking:** Sentry (optional, via VITE_SENTRY_DSN)
- **Testing:** Vitest (unit, 1039 cases) + Playwright (E2E)

## Architecture Overview

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                         │
├─────────────────────────────────────────────────────────────────┤
│  UI Layer (React 18)                                            │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ Landing   │ │ Login/   │ │Dashboard │ │ Chat     │          │
│  │ Page      │ │ Register │ │ Page     │ │ Page     │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐           │
│  │ Settings │ │ Waiting  │ │ ConnectionBanner     │           │
│  │ Page     │ │ Room     │ │ ShareModal/Toast     │           │
│  └──────────┘ └──────────┘ └──────────────────────┘           │
├─────────────────────────────────────────────────────────────────┤
│  Feature Layer                                                  │
│  ┌──────────────────────────────────────────────────────┐      │
│  │ ChatService (E2EE key exchange + encrypt/decrypt)     │      │
│  │ ChatFeature (payload validation + ledger append)      │      │
│  │ useChatMessages (binary insert + dedup + HLC sort)    │      │
│  │ useP2PArchitecture / useStarTopology / useMeshTopology│      │
│  └──────────────────────────────────────────────────────┘      │
├─────────────────────────────────────────────────────────────────┤
│  Core Layer (79 files, ~21K lines)                              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐      │
│  │ P2P    │ │ Mesh   │ │ Crypto │ │ Relay  │ │Community│      │
│  │ WebRTC │ │ Gossip │ │ E2EE   │ │ Sphinx │ │ RBAC   │      │
│  │ Signal │ │ Topo   │ │ TreeKEM│ │ DHT    │ │ Gov    │      │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘      │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐      │
│  │ Clock  │ │ Chain  │ │Transport│ │ Ledger│ │ Game   │      │
│  │ HLC    │ │ Sync   │ │ DHT S&F│ │ Fork  │ │ Engine │      │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘      │
├─────────────────────────────────────────────────────────────────┤
│  Infrastructure                                                 │
│  Firebase Auth │ Firebase RTDB │ IndexedDB │ Sentry │ i18next  │
└─────────────────────────────────────────────────────────────────┘
```

### Topology Strategy (with Hysteresis)

| Participants | Topology | Upgrade At | Downgrade At |
|---|---|---|---|
| 1-2 | Star (direct P2P) | 3 | — |
| 3-7 | Full Mesh + Gossip | 8 | 2 |
| 8-21 | Partial Mesh | 22 | 5 |
| 22+ | Super-Node | — | 18 |

Hysteresis prevents thrashing at boundary values (e.g., 7-8 users won't flip-flop).

### Core Layers

```
src/core/
├── adapters/       # Hybrid Node runtime abstraction
├── p2p/            # WebRTC connections, signaling, ICE batching, channel bus
├── mesh/           # Gossip protocol, topology, heartbeat, identity, CSPRNG shuffle
├── relay/          # Sphinx-Lite onion routing + Kademlia DHT
├── crypto/         # SenderKeyManager (E2EE), TreeKEM, GroupKeyManager, key zeroization
├── incentive/      # Relay credit system (LocalCreditProvider)
├── community/      # Governance, reports, roles, channels, reputation
├── chain/          # Append-only log sync & merge
├── clock/          # Hybrid Logical Clock (HLC) with drift guard
├── ordering/       # Message ordering (HLC-based, binary insert)
├── transport/      # Multi-channel bus, store-and-forward, DHT storage
├── ledger/         # Shared ledger engine with fork detection
├── game/           # Game engine (GameLoop, World, NetworkSync)
└── metrics/        # Performance metrics
```

### E2EE Flow

1. Identity: ECDSA P-256 key pair, persisted in IndexedDB
2. Key exchange: ECDH P-256 public key broadcast via P2PChannelBus (TOFU warning on key change)
3. Group encryption: AES-256-GCM sender key, encrypted per-member via ECDH
4. Replay protection: Mandatory seq counter per sender per epoch
5. Auto-rotation: After 100 messages or 1 hour (configurable)
6. Forward secrecy: Previous epoch keys retained for in-flight message decryption
7. Key zeroization: Raw ECDH shared bits zeroed after HKDF derivation

### Security Measures

- **RTDB rules:** Field-level write restrictions (ownerUid immutable, signals require from===auth.uid, payload <10KB)
- **Replay protection:** Mandatory seq field in SenderKey (bypass = rejection)
- **CSPRNG:** Gossip shuffle + cover traffic timing use crypto.getRandomValues()
- **Payload validation:** ChatFeature validates all 5 envelope types at runtime
- **Message size limit:** P2PChannelBus rejects >64KB messages
- **Signal isolation:** channelLabel + to + sessionStartedAt triple-layer + LRU cap (500)
- **HLC drift guard:** Remote timestamps clamped to local + 60s max

### Pages & Routes

| Route | Page | Description |
|---|---|---|
| `/` | LandingPage | Product landing with feature cards + CTA |
| `/login` | LoginPage | Email/password login + register + Google OAuth |
| `/dashboard` | DashboardPage | Room list (my rooms + public rooms) + create room |
| `/waiting/:roomId` | WaitingRoomPage | Wait for participants + share link/QR |
| `/chat/:roomId` | ChatPage | Main chat with E2EE, search, notifications |
| `/settings` | SettingsPage | Language, notifications, account, about |

### User Features

| Feature | Status | Details |
|---|---|---|
| Text messaging | ✅ | E2EE, delivery status, timestamp |
| User registration | ✅ | Email/password + Google OAuth |
| Room management | ✅ | Create/join/leave with custom names |
| Room sharing | ✅ | Link copy + QR code + native share API |
| Message persistence | ✅ | IndexedDB (survives page reload) |
| Message search | ✅ | In-chat search with result count |
| Browser notifications | ✅ | Web Notification API + tab title unread |
| Notification sound | ✅ | Web Audio API ping |
| Encryption indicator | ✅ | E2EE badge in chat header |
| Connection status | ✅ | 5-state banner with reconnect countdown |
| Fallback warning | ✅ | Amber warning when using server relay |
| i18n | ✅ | 繁體中文 + English |
| Settings | ✅ | Language, notifications, account |
| Graceful reconnect | ✅ | Soft reconnect without page reload |
| Mobile responsive | ✅ | Safe area + dvh + touch targets |

## Conventions

### Logging

Use `import { logger } from '@/utils/logger'` instead of `console.log`:
- `logger.debug()` — dev only, silenced in prod
- `logger.info()` — dev only, silenced in prod
- `logger.warn()` — always outputs, sanitizes sensitive fields
- `logger.error()` — always outputs, sanitizes sensitive fields

### Code Style

- **TypeScript strict mode** — `noUnusedLocals`, `noUnusedParameters` enabled
- **Path aliases:** `@/*` maps to `src/*`
- **Imports:** Use relative paths in core modules, `@/` in feature/page modules
- **Unused params:** Prefix with `_` (e.g., `_senderId`)
- **Crypto randomness:** Use `crypto.getRandomValues()` for all security-relevant randomness, never `Math.random()`

### Testing

- Unit tests: `tests/unit/*.spec.ts` — 67 files, 1039 cases
- E2E tests: `tests/e2e/*.spec.ts` — Playwright
- Run: `node ./node_modules/vitest/vitest.mjs run`

### Environment Variables

| Variable | Purpose |
|---|---|
| `VITE_FIREBASE_*` | Firebase project configuration (7 vars) |
| `VITE_FALLBACK_TURN_USERNAME` | Metered Open Relay username |
| `VITE_FALLBACK_TURN_CREDENTIAL` | Metered Open Relay credential |
| `VITE_TURN_CREDENTIAL_ENDPOINT` | Dynamic TURN credential Cloud Function URL |
| `VITE_SENTRY_DSN` | Sentry error tracking DSN (optional) |

### Review Pipeline

8 professional review prompts in `prompts/`:
- architect-review, senior-engineer-review, qa-full-test
- security-engineer-review, ux-reviewer, devops-sre-review
- performance-engineer-review, product-manager-review
- **REVIEW-PIPELINE.md** — SOP for full/daily/single-role reviews

### Automated Monitoring

- **Scheduled:** `nerilo-health-check` — weekdays 9am, runs tsc + tests + lint in parallel, writes `reports/health-YYYY-MM-DD.md`, monitoring-only (no fix, no commit)
- **Skills:** `/fix-errors` (auto-diagnose + fix), `/pre-deploy-check` (quality gate)

### Key Design Decisions

- **Firebase RTDB (not Firestore)** — lower latency for signaling, flat JSON model
- **RTDB as fallback** — when P2P connections fail, messages relay through RTDB with amber warning
- **Fixed-size packets** — 4096-byte relay payloads prevent traffic analysis
- **ICE candidate batching** — 200ms buffer reduces RTDB writes by ~80%
- **Binary insert** — O(log N) message insertion instead of O(N log N) full sort
- **TOFU key verification** — warn on peer ECDH public key change (MITM indicator)
- **Score-based peer selection** — PeerScoring gates relay eligibility, gossip participation, and disconnect decisions
