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
├── crypto/         # SenderKeyManager (E2EE), ECDH key exchange
├── incentive/      # Relay credit system (LocalCreditProvider)
├── community/      # Governance, reports, roles, channels, reputation (see below)
├── chain/          # Append-only log sync & merge
├── clock/          # Hybrid Logical Clock (HLC)
├── ordering/       # Message ordering (HLC-based)
├── transport/      # Multi-channel bus, store-and-forward, DHT storage
├── ledger/         # Shared ledger engine
└── metrics/        # Performance metrics
```

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

### Adaptive Key Distribution (`src/core/crypto/`)

| Group Size | Strategy | Module | Key Rotation Cost |
|---|---|---|---|
| <50 members | SenderKey | `SenderKeyManager` | O(N) ECDH per rotation |
| >=50 members | TreeKEM | `TreeKEMManager` | O(log N) ECDH per rotation |

`GroupKeyManager` auto-selects strategy based on group size with hysteresis (switch up at threshold, switch down at threshold-10).

**TreeKEM design:** Left-balanced binary tree where members are leaves. Key rotation regenerates the leaf-to-root path and encrypts each path secret to its co-path sibling — O(log N) ECDH operations instead of O(N). Tree rebuilds on member add/remove.

### Community Layer (`src/core/community/`)

Organizational structure on top of mesh/relay/crypto. A Community contains Channels (each backed by a MeshGossipManager room), Members with Roles, and governance primitives.

| Component | Purpose |
|---|---|
| `CommunityManager` | Orchestrator — unified API coordinating all sub-services |
| `RolePermissionManager` | RBAC enforcement (owner > admin > moderator > member > guest) |
| `MembershipService` | Member lifecycle: join, leave, invite, kick, ban, role changes |
| `ChannelRegistry` | Channel CRUD (text, announcement, voice), archive support |
| `ReportSystem` | Decentralized report + multi-moderator voting (configurable threshold) |
| `GovernanceVoting` | Community proposals with quorum + approval thresholds, ledger recording |
| `SocialReputation` | Dual-layer reputation: Network (PeerScoring) + Social (reports, governance) |

**Report Flow:** member files report → moderators vote → 3/5 (configurable) approve → action executed (warn/mute/kick/ban/dismiss)

**Governance Flow:** admin creates proposal → members vote within deadline → quorum + approval threshold checked → passed/rejected/expired

**Dual-Layer Reputation:** `combinedScore = networkScore * 0.5 + socialScore * 0.5` (configurable weights). Network score from PeerScoring, social score from report history + governance participation.

### Incentive System

Phase 1: `LocalCreditProvider` (local credit tracking with `IIncentiveProvider` interface)
Phase 2: Blockchain-backed provider (future, same interface)

### DHT Persistent Storage (`src/core/transport/`)

Decentralized offline message delivery using Kademlia DHT instead of Firestore.

| Component | Purpose |
|---|---|
| `DHTStorage` | In-memory message store with TTL, dedup, per-recipient limits, and DHT protocol handling |
| `DHTStoreAndForward` | Coordinator: finds K closest nodes via KademliaRouter, replicates messages, merges responses |
| `StoreAndForward` | Firestore-backed fallback (original, used when DHT has insufficient nodes) |

**Storage strategy:** Messages stored on K=8 closest nodes (XOR distance to recipient). On retrieval, query all K nodes, dedup responses, deliver to recipient. Falls back to Firestore when DHT overlay has <3 nodes.

**Protocol messages:** `DHT_STORE`, `DHT_RETRIEVE`, `DHT_RESPONSE`, `DHT_DELETE` — sent via P2PChannelBus or gossip layer.

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
