# Nerilo — P2P Real-Time Chat Platform

## Quick Reference

```bash
npm run dev          # Start Vite dev server
npm run build        # TypeScript check + Vite build
npm run type-check   # tsc --noEmit
npm run lint         # ESLint (max 10 warnings; tests exempt from no-explicit-any)
npm run test:run     # Vitest unit tests (single run)
npm run test:e2e     # Playwright E2E tests (local, needs emulators)
npm run test:e2e:ci  # Full E2E under Firebase emulators (what CI runs)
npm run ci           # type-check + lint + unit tests
```

**Run unit tests:** `node ./node_modules/vitest/vitest.mjs run` (workaround for Windows node path issues)

## Tech Stack

- **Frontend:** React 18 + TypeScript 5 + Vite 5
- **Styling:** Tailwind CSS + shadcn/ui
- **Auth/DB:** Firebase Auth + Firestore (signaling + fallback)
- **P2P:** WebRTC DataChannel (primary transport)
- **Crypto:** SubtleCrypto (ECDSA P-256 identity, ECDH key exchange, AES-256-GCM encryption)
- **Testing:** Vitest (unit) + Playwright (E2E)

## Architecture Overview

### Topology Strategy

| Participants | Topology | Module |
|---|---|---|
| 2 | Star (direct P2P) | `P2PManager` |
| 3-5 | Full Mesh + Gossip | `MeshGossipManager` |
| 6-20 | Partial Mesh | `AdaptiveTopologyManager` |
| >20 | Super-Node | `SuperNodeElection` |

### Core Layers

```
src/core/
├── p2p/            # WebRTC connections, signaling, channel bus
├── mesh/           # Gossip protocol, topology, heartbeat, identity
├── relay/          # Dual-layer relay infrastructure (see below)
├── crypto/         # SenderKeyManager (E2EE), ECDH, TreeKEM + GroupKeyManager
├── incentive/      # Relay credit system (LocalCreditProvider)
├── chain/          # Append-only log sync & merge
├── clock/          # Hybrid Logical Clock (HLC)
├── ordering/       # Message ordering (HLC-based)
├── transport/      # Multi-channel bus, store-and-forward, DHT storage
├── ledger/         # Shared ledger engine
├── metrics/        # Performance metrics + remote telemetry (opt-out)
├── game/           # Game engine (ECS World, GameLoop) + Game Transport SDK
├── community/      # Roles, membership, channels, governance, reputation
└── adapters/       # Browser/Node runtime abstraction
```

Note: `game/`, `community/`, `adapters/`, TreeKEM, and DHT storage are **dormant
modules** — fully tested but not yet wired into app flows (mined from PR #5).

### Relay Infrastructure (`src/core/relay/`)

Dual-layer design: Sphinx-Lite onion routing + Kademlia DHT.

| Component | Purpose |
|---|---|
| `RelayManager` | Orchestrator — coordinates all relay sub-components |
| `SphinxPacket` | 2-3 hop onion routing (ECDH + AES-GCM per hop) |
| `KademliaRouter` | XOR-distance DHT, S/Kademlia diversified routing |
| `PeerScoring` | GossipSub v1.1 multi-dimensional behavior scoring (-100 to +100) |
| `RateLimiter` | Sliding window per-peer + global rate limits |
| `RelayScorer` | Node quality: 0.35 latency + 0.25 reliability + 0.20 bandwidth + 0.10 uptime + 0.10 diversity |
| `MultiPathSelector` | 2-4 independent paths, greedy construction avoiding shared nodes |
| `MessageAssembler` | First-arrival-wins dedup, 5min TTL, 10K LRU |
| `PathQualityTracker` | Rolling window feedback loop (50 samples) |
| `CoverTrafficGenerator` | Poisson-distributed dummy packets, battery-aware |
| `NATDetector` | ICE candidate analysis for NAT classification |
| `MessagePadding` | 256-byte block padding to prevent size analysis |

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
- `logger.debug()` — dev only, silenced in prod
- `logger.info()` — dev only, silenced in prod
- `logger.warn()` — always outputs, sanitizes sensitive fields
- `logger.error()` — always outputs, sanitizes sensitive fields

### Code Style

- **TypeScript strict mode** — `noUnusedLocals`, `noUnusedParameters` enabled
- **Path aliases:** `@/*` maps to `src/*`
- **Imports:** Use relative paths in core modules, `@/` in feature/page modules
- **Unused params:** Prefix with `_` (e.g., `_senderId`)

### Testing

- Unit tests: `tests/unit/*.spec.ts` — use Vitest
- E2E tests: `tests/e2e/*.spec.ts` — use Playwright
- Integration tests: Firestore emulator required (`npm run test:emulator`)

### Key Design Decisions

- **No blockchain yet** — relay incentives use local credits; blockchain is a future option
- **Firestore as fallback** — when P2P connections fail, messages relay through Firestore
- **Fixed-size packets** — 4096-byte relay payloads prevent traffic analysis
- **Score-based peer selection** — PeerScoring gates relay eligibility, gossip participation, and disconnect decisions

## CI/CD

- **Every PR / master push**: `ci.yml` quality gate (type-check + lint + unit tests, Node 24) + emulator-backed E2E (soft gate, `continue-on-error`)
- **Every master push auto-deploys** hosting + Firestore rules/indexes to https://nerilo.web.app via `firebase-deploy.yml` (first successful run 2026-06-11)
- **Cloud Functions are NOT deployed** — never were in production; first deploy requires Blaze plan + Cloud Build API (steps in PR #15). CI still compile-validates `functions/`
- E2E in CI runs against Firebase emulators (Java 17 + cached emulator/Playwright binaries) — no live Firebase, no secrets needed
