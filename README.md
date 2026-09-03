# Nerilo: P2P E2EE Real-Time Chat (Firebase + WebRTC)

Browser-first P2P chat and embeddable messaging layer with end-to-end encryption. Firebase handles room discovery, signaling and encrypted fallback; the primary message path uses WebRTC DataChannels.

Current implementation status, verified test baselines, active work and known gaps are maintained in [docs/CURRENT-STATUS.md](docs/CURRENT-STATUS.md). Use that file instead of older roadmap snapshots when deciding what is live today.

## What this is, and what it isn't

| Is | Isn't |
|---|---|
| E2EE group chat (AES-256-GCM, ECDH P-256 key exchange) | A polished consumer product |
| 2–10 peers in the currently supported room tiers; mesh + gossip topology auto-selected | A drop-in Signal/Slack replacement |
| Blind-courier experiment in the Vue candidate UI | Anonymous. **Onion routing is written and unit-tested but NOT wired** (see below) |
| Honest about its limits; read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before relying on it | Audited / certified for high-stakes use |

## Core features

- **E2EE messages.** React star rooms use sender-key rotation; mesh uses an AES-GCM room key distributed per recipient through ECDH P-256 and rotates when the roster changes. See the threat model for the forward-secrecy boundary.
- **Mesh + gossip.** 2-peer direct, 3–6 full mesh, 7–20 partial-mesh algorithm (current product tiers cap rooms at 10), >20 super-node path dormant.
- **Blind-courier experiment.** Implemented and exercised through the Vue candidate dashboard, but not exposed by the production React app or public SDK yet.
- **Firestore as signaling + fallback.** Message content is encrypted before any Firestore write.
- **IndexedDB persistence.** Clear browser data to forget everything.

### Written but not wired

Be aware before you rely on it: `src/core/relay/` contains a Sphinx-Lite onion-routing and Kademlia DHT stack that is implemented and unit-tested but **not connected to any send path**. `RelayManager.sendViaRelay()` has zero callers repo-wide; only the inbound handler is reachable. Nerilo therefore provides **no sender anonymity today**. Treat that code as a design study, not a shipped capability (verified 2026-07-26).

## Quick start

> **Embedding Nerilo as an SDK in your own app?** See [docs/SDK-QUICKSTART.md](docs/SDK-QUICKSTART.md): install `nerilo`, wire the injectable backends, run with zero Firebase. The section below is for running this repo's app locally.

### Prerequisites

| | Why |
|---|---|
| **Node.js 24** | Matches CI and the npm 11 lockfile. |
| **Java 21+** (Temurin recommended) | Firebase Tools 15 emulator requirement. |
| **Firebase account + 1–2 projects** | One for production (e.g. `nerilo`), one for staging (e.g. `nerilo-staging`). See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). |

### Install

```bash
npm install
# Functions project (only if you'll deploy them)
cd functions && npm install && cd ..
```

### Configure

Copy the example and fill in the real values from your Firebase project console (Project settings → General → Your apps):

```bash
cp .env.local.example .env.local
```

```env
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abcdef
```

**Then enable Anonymous auth** in the Firebase Console (Build → Authentication → Sign-in method → Anonymous → Enable). The app falls back to anonymous sign-in for guests; **without this, the first page load hangs with an empty role badge** and no UI feedback. This is the most common first-time setup mistake; see [Troubleshooting](#troubleshooting).

### Run

```bash
npm run dev                # http://localhost:3000 (dev mode, talks to real Firebase)
npm run build              # production bundle in dist/
npm run test:run           # unit tests (Vitest; current count in docs/CURRENT-STATUS.md)
npm run test:e2e:release   # Maintained release E2E with Firebase emulators auto-booted
npm run test:e2e:ci        # All files, including quarantined legacy diagnostics
```

### Connect an AI client through MCP

The repository includes a stdio MCP gateway with seven intent-level tools. The default runtime is deliberately a local, in-memory demo: it lets an AI client inspect and exercise the contract, but does **not** claim WebRTC, persistence or E2EE. The `nerilo_get_capabilities` tool exposes those limits to the agent.

```bash
NERILO_MCP_AGENT_ID=my-agent npm run mcp
```

For client configuration, read-only and room-allowlist policies, and the real browser-bridge design, see [docs/MCP-GATEWAY.md](docs/MCP-GATEWAY.md).

### Deploy

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full staging + production walkthrough. TL;DR:

```bash
npm run deploy:staging:safe      # type-check + lint + tests + Firebase Hosting preview channel
npm run deploy:production:safe   # same, but live
npm run deploy:web-vue:preview   # Vue candidate, isolated nerilo-staging channel only
```

All three deploy paths validate their Firebase env values and expected project before building.
The root `deploy:full` command is blocked unless Functions and Blaze billing are explicitly acknowledged; it is never used by CI.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page loads, `.role-badge` stays empty, no errors in UI | Anonymous auth not enabled in your Firebase project. Console → Authentication → Sign-in method → Anonymous → Enable. |
| `auth/network-request-failed` in console | Either your `.env.local` values are wrong, or the API key is restricted to a different referrer. Verify in Firebase Console → Project settings → General. |
| `auth/configuration-not-found` | `VITE_FIREBASE_AUTH_DOMAIN` mismatch; it must be exactly `<project-id>.firebaseapp.com`. The older `.appspot.com` form (used by some legacy projects) won't work for Auth. |
| `Failed to load resource: ERR_CONNECTION_REFUSED` to `127.0.0.1:9099` or `127.0.0.1:8080` | App is in test mode and emulators aren't running. Either: a) don't run with `--mode test`, or b) start emulators: `npx firebase emulators:start --only auth,firestore`. |
| `npm run test:e2e` hangs at "Waiting for http://localhost:4173" | Vite startup blocked. On Windows, the Playwright `webServer.command` already uses `node ./node_modules/vite/bin/vite.js` directly to avoid the npm-shim issue. If you're still seeing this, run `npm run dev:test` in another terminal first and let Playwright reuse it. |
| `npm run test:e2e:ci` exits with a Java version error | Install Java 21+ (Temurin). Required by Firebase Tools 15 emulators. |
| `firestore.rules` deploy fails with "Authentication Error" | Run `firebase login` first. |
| `npm run deploy:staging` errors with "REPLACE_ME_ placeholders" | You haven't filled in `.env.staging` yet. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Firebase Console walkthrough. |

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): React staging/production, Vue candidate preview, Firebase setup and rollback
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md): what privacy actually means; adversaries; Sphinx-Lite limits; recommended user practices
- [docs/MCP-GATEWAY.md](docs/MCP-GATEWAY.md): MCP setup, policy controls, honest runtime limits, browser-bridge production design
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): codebase architecture quick-reference

Older zh-TW design docs in [docs/](docs/) (架構文件, 協議文件, 新功能接入SOP, 上板與部署手冊).

## Architecture (one screen)

```
src/core/
├── p2p/          # WebRTC connections, channel bus, signaling, capability negotiation
├── mesh/         # Gossip protocol, topology selection, heartbeat, identity (ECDSA P-256)
├── relay/        # Blind-courier store-and-forward (wired) + onion/DHT stack (NOT wired)
├── crypto/       # ECDH P-256 key exchange + AES-256-GCM sender keys
├── transport/    # Multi-channel bus, store-and-forward, lifecycle
├── ordering/     # Causal ordering + HLC
└── metrics/      # MetricsCollector + opt-in console exporter
```

E2EE flow depends on the active topology. React star rooms use sender-key rotation; mesh derives pairwise wrapping keys with ECDH P-256, distributes an AES-GCM room key, and rotates it on roster changes. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for what this protects and what it doesn't.

## Security and privacy

**The honest version is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).** Short version:

- **Content** is unreadable to Firebase, relays, and passive observers.
- **Metadata** (who is in which room, when, message sizes) leaks to whoever runs the signaling layer.
- **No sender anonymity.** The onion-routing stack is unwired (see "Written but not wired"). Anyone carrying your traffic sees who sent it. Do not use this for activism in adversarial jurisdictions.
- **IndexedDB private keys** are stored at-rest, so physical device access or same-origin XSS can extract them.
- **Firestore rules** enforce: operation-shaped room updates, only-self meshIdentity writes, participant-only signaling reads/writes, and bounded fallback-message expiry.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tests must pass (`npm run ci`) before PR.

## License

Project delivery sample; adjust to your needs.
