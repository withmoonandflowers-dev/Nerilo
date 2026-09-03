# Nerilo: P2P Real-Time Chat Platform

## Quick Reference

```bash
npm run dev          # Start Vite dev server
npm run build        # TypeScript check + Vite build
npm run type-check   # tsc --noEmit
npm run lint         # ESLint (max 10 warnings; tests exempt from no-explicit-any)
npm run test:run     # Vitest unit tests (single run)
npm run test:e2e     # Playwright E2E tests (local, needs emulators)
npm run test:e2e:release  # Maintained release E2E under Firebase emulators (what CI runs)
npm run test:e2e:ci       # All files, including quarantined legacy diagnostics
npm run ci           # type-check + lint + unit tests
```

**Run unit tests:** `node ./node_modules/vitest/vitest.mjs run` (workaround for Windows node path issues)

> **New machine?** Read [docs/CROSS-MACHINE-HANDOFF.md](docs/CROSS-MACHINE-HANDOFF.md) first,
> it carries the cross-machine operational knowledge (E2E local loop, TURN rotation, CI/secrets layout,
> known pitfalls, pending-work snapshot). Update the handoff doc when you learn something the other machine needs.

> **Current truth:** changing status, verified counts and active priorities live in
> [docs/CURRENT-STATUS.md](docs/CURRENT-STATUS.md). Older roadmap/handoff sections are historical context.

## Tech Stack

- **Frontend (production):** React 18 + TypeScript 5 + Vite 5，手寫 CSS + design tokens（variables.css）
- **Frontend (重寫中, ADR-0017):** Vue 3 + Nuxt（SPA）於 `web-vue/`，iMessage 風設計系統；
  複用 `src/core|services|types|utils`（零 React 依賴）。nuxt 釘 4.4.2（4.4.4/4.4.5 ssr:false regression）。
  React 版凍結新功能，切換前仍是 production。
- **Auth/DB:** Firebase Auth + Firestore (signaling + fallback)
- **P2P:** WebRTC DataChannel (primary transport)
- **Crypto:** SubtleCrypto (ECDSA P-256 identity, ECDH key exchange, AES-256-GCM encryption)
- **Testing:** Vitest (unit) + Playwright (E2E)

## Architecture Overview

### Topology Strategy

| Participants | Topology | Module |
|---|---|---|
| 2 | Star (direct P2P; Vue line uses gossip for 2 too) | `P2PManager` |
| 3-6 | Full Mesh + Gossip | `MeshGossipManager` |
| 7-20 | Partial Mesh (wired, Spec 011/ADR-0035; rooms cap at 10, upgrade-only mid-session) | `AdaptiveTopologyManager` |
| >20 | Super-Node (dormant, ADR-0007) | `SuperNodeElection` |

### Core Layers

```
src/core/
├── p2p/            # WebRTC connections, signaling, channel bus
├── mesh/           # Gossip protocol, topology, heartbeat, identity
├── relay/          # Dual-layer relay infrastructure (see below)
├── crypto/         # SenderKeyManager (E2EE), ECDH（TreeKEM/GroupKeyManager 已退役，ADR-0034）
├── incentive/      # Relay credit system (LocalCreditProvider)
├── clock/          # Hybrid Logical Clock (HLC)
├── ordering/       # Message ordering (HLC-based)
├── messaging/      # 訊息層純邏輯 reducer：reactions / 已讀水位 / 回覆編碼（SDK 公開契約，Spec 013）
├── transport/      # Multi-channel bus, store-and-forward, DHT storage
├── ledger/         # Shared ledger engine
├── metrics/        # Performance metrics + remote telemetry (opt-out)
├── game/           # Game engine (ECS World, GameLoop) + Game Transport SDK
├── community/      # Roles, membership, channels, governance, reputation
└── adapters/       # Browser/Node runtime abstraction
```

Note: `game/`、`community/`、`transport/`、`ledger/`、`features/`（core 底下那個）與
`relay/onion/` 是 **PARK 模組**，已測但沒接進產品流，由 ESLint 圍籬凍結（ADR-0031）。
`chain/` 與 `protocol/` 已於 2026-07-26 刪除（引用 0，功能與 mesh 複寫日誌重疊）。

### Relay Infrastructure (`src/core/relay/`)

Dual-layer design **on paper**。實測（2026-07-26）：**出站路徑整條死的**，
`RelayManager.sendViaRelay()` 全 repo 零呼叫，只有入站 `handleRelayPacket` 被
`MeshGossipManager:478` 接。但 `MeshGossipManager.initialize()` 仍每場 `new RelayManager()`
並 `initialize()`，所以下列多數元件**有被實例化並啟動、只是服務一條沒有出口的路徑**。
標記口徑：**[未實例化]**＝連 new 都沒有；**[空轉]**＝有啟動但只服務死的出站路徑。

| Component | Purpose |
|---|---|
| `RelayManager` **[半接線]** | Orchestrator；每場 mesh 建構並 initialize（NAT 偵測＋3 組計時器），但送出 API 無呼叫端 |
| `SphinxPacket` **[未實例化]** | 2-3 hop onion routing (ECDH + AES-GCM per hop) |
| `KademliaRouter` **[空轉]** | XOR-distance DHT, S/Kademlia diversified routing |
| `PeerScoring` | GossipSub v1.1 multi-dimensional behavior scoring (-100 to +100) |
| `RateLimiter` **[空轉]** | Sliding window per-peer + global rate limits |
| `RelayScorer` **[空轉]** | Node quality: 0.35 latency + 0.25 reliability + 0.20 bandwidth + 0.10 uptime + 0.10 diversity |
| `MultiPathSelector` **[空轉]** | 2-4 independent paths, greedy construction avoiding shared nodes |
| `MessageAssembler` **[空轉]** | First-arrival-wins dedup, 5min TTL, 10K LRU |
| `PathQualityTracker` **[空轉]** | Rolling window feedback loop (50 samples) |
| `CoverTrafficGenerator` **[未啟用]** | Poisson dummy packets；`enableCoverTraffic` 預設 false 且無呼叫端開啟 |
| `NATDetector` **[空轉]** | ICE candidate analysis for NAT classification |
| `MessagePadding` **[空轉]** | 256-byte block padding to prevent size analysis |

### E2EE Flow

1. Identity: ECDSA P-256 key pair, persisted in IndexedDB
2. Key exchange: ECDH P-256 public key broadcast via P2PChannelBus
3. Group encryption: AES-256-GCM sender key, encrypted per-member via ECDH
4. Auto-rotation: After 100 messages or 1 hour (configurable)
5. Forward secrecy: Previous epoch keys retained for in-flight message decryption

### Incentive System

Phase 1: `LocalCreditProvider` (local credit tracking with `IIncentiveProvider` interface)
Phase 2: Blockchain-backed provider (future, same interface)

## Conventions

### Logging

Use `import { logger } from '@/utils/logger'` instead of `console.log`:
- `logger.debug()`, dev only, silenced in prod
- `logger.info()`, dev only, silenced in prod
- `logger.warn()`, always outputs, sanitizes sensitive fields
- `logger.error()`, always outputs, sanitizes sensitive fields

### Code Style

- **TypeScript strict mode**: `noUnusedLocals`, `noUnusedParameters` enabled
- **Path aliases:** `@/*` maps to `src/*`
- **Imports:** Use relative paths in core modules, `@/` in feature/page modules
- **Unused params:** Prefix with `_` (e.g., `_senderId`)

### Testing

- Unit tests: `tests/unit/*.spec.ts`, use Vitest
- E2E tests: `tests/e2e/*.spec.ts`, use Playwright
- Integration tests: Firestore emulator required (`npm run test:emulator`)

### Key Design Decisions

- **No blockchain yet**: relay incentives use local credits; blockchain is a future option
- **Firestore as fallback**: when P2P connections fail, messages relay through Firestore
- ~~**Fixed-size packets**：4096-byte relay payloads prevent traffic analysis~~ 未生效：該路徑未接線（2026-07-26 查證）
- **Score-based peer selection**: PeerScoring gates relay eligibility, gossip participation, and disconnect decisions

## CI/CD

- **Every PR / master push**: `ci.yml` quality gate (type-check + lint + unit tests, Node 24), stable E2E hard gate, and `e2e-tests.yml` maintained release E2E hard gate.
- **Every master push auto-deploys** hosting + Firestore rules/indexes to https://nerilo.web.app via `firebase-deploy.yml` (first successful run 2026-06-11)
- **Cloud Functions are NOT deployed**: never were in production; first deploy requires Blaze plan + Cloud Build API (steps in PR #15). CI still compile-validates `functions/`
- E2E in CI runs against Firebase emulators (Java 21 + cached emulator/Playwright binaries), no live Firebase, no secrets needed
