# Nerilo — P2P E2EE Real-Time Chat (Firebase + WebRTC)

Browser-only P2P chat with end-to-end encryption. Firebase handles signaling and fallback only; message content travels over WebRTC DataChannels encrypted with per-room sender keys.

Current implementation status, verified test baselines, active work and known gaps are maintained in [docs/CURRENT-STATUS.md](docs/CURRENT-STATUS.md). Use that file instead of older roadmap snapshots when deciding what is live today.

## What this is — and isn't

| ✅ Is | ❌ Isn't |
|---|---|
| E2EE group chat (AES-256-GCM, ECDH P-256 key exchange) | A polished consumer product |
| 2–20 peers, mesh + gossip topology auto-selected | A drop-in Signal/Slack replacement |
| Best-effort sender anonymity via 2–3-hop onion routing | A strong anonymity network (see [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)) |
| Honest about its limits — read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) before relying on it | Audited / certified for high-stakes use |

## Core features

- 🔒 **E2EE messages** — AES-256-GCM sender keys, distributed per-recipient via ECDH P-256. Auto-rotates every 100 messages or 1 hour.
- 🕸️ **Mesh + gossip** — 2-peer direct, 3–5 full mesh, 6–20 partial mesh, >20 super-node. Auto-migrates on join/leave.
- 🛰️ **Sphinx-Lite onion routing** — 2–3 hops, fixed 4 KB packets, Poisson cover traffic. Defeats single-relay deanonymization (not global passive adversaries).
- 📦 **Firestore as signaling + fallback** — message content is encrypted before any Firestore write.
- 📝 **IndexedDB** persistence — clear browser data to forget everything.

## Quick start

> **Embedding Nerilo as an SDK in your own app?** See [docs/SDK-QUICKSTART.md](docs/SDK-QUICKSTART.md) — install `nerilo`, wire the injectable backends, run with zero Firebase. The section below is for running this repo's app locally.

### Prerequisites

| | Why |
|---|---|
| **Node.js 24** | Matches CI and the npm 11 lockfile. |
| **Java 21+** (Temurin recommended) | Firebase Tools 15 emulator requirement. |
| **Firebase account + 1–2 projects** | One for production (e.g. `nerilo`), one for staging (e.g. `nerilo-staging`) — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). |

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

**Then enable Anonymous auth** in the Firebase Console (Build → Authentication → Sign-in method → Anonymous → Enable). The app falls back to anonymous sign-in for guests; **without this, the first page load hangs with an empty role badge** and no UI feedback. This is the #1 first-time setup mistake — see [Troubleshooting](#troubleshooting).

### Run

```bash
npm run dev                # http://localhost:3000 (dev mode, talks to real Firebase)
npm run build              # production bundle in dist/
npm run test:run           # unit tests (Vitest; current count in docs/CURRENT-STATUS.md)
npm run test:e2e:ci        # E2E tests with Firebase emulators auto-booted
```

### Deploy

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full staging + production walkthrough. TL;DR:

```bash
npm run deploy:staging:safe      # type-check + lint + tests + Firebase Hosting preview channel
npm run deploy:production:safe   # same, but live
```

Both scripts refuse to run while `.env.staging` / `.env.production` contain `REPLACE_ME_*` placeholders.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Page loads, `.role-badge` stays empty, no errors in UI | Anonymous auth not enabled in your Firebase project. Console → Authentication → Sign-in method → Anonymous → Enable. |
| `auth/network-request-failed` in console | Either your `.env.local` values are wrong, or the API key is restricted to a different referrer. Verify in Firebase Console → Project settings → General. |
| `auth/configuration-not-found` | `VITE_FIREBASE_AUTH_DOMAIN` mismatch — it must be exactly `<project-id>.firebaseapp.com`. The older `.appspot.com` form (used by some legacy projects) won't work for Auth. |
| `Failed to load resource: ERR_CONNECTION_REFUSED` to `127.0.0.1:9099` or `127.0.0.1:8080` | App is in test mode and emulators aren't running. Either: a) don't run with `--mode test`, or b) start emulators: `npx firebase emulators:start --only auth,firestore`. |
| `npm run test:e2e` hangs at "Waiting for http://localhost:4173" | Vite startup blocked. On Windows, the Playwright `webServer.command` already uses `node ./node_modules/vite/bin/vite.js` directly to avoid the npm-shim issue. If you're still seeing this, run `npm run dev:test` in another terminal first and let Playwright reuse it. |
| `npm run test:e2e:ci` exits with a Java version error | Install Java 21+ (Temurin). Required by Firebase Tools 15 emulators. |
| `firestore.rules` deploy fails with "Authentication Error" | Run `firebase login` first. |
| `npm run deploy:staging` errors with "REPLACE_ME_ placeholders" | You haven't filled in `.env.staging` yet. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the Firebase Console walkthrough. |

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — staging + production deploy, Firebase project setup, Sentry wiring, local E2E with emulators
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — what privacy actually means; adversaries; Sphinx-Lite limits; recommended user practices
- [docs/PR-5-analysis.md](docs/PR-5-analysis.md) — analysis of the in-flight feature/multi-room-improvements branch
- [CLAUDE.md](CLAUDE.md) — codebase architecture quick-reference

Older zh-TW design docs in [docs/](docs/) (架構文件, 協議文件, 新功能接入SOP, 上板與部署手冊).

## Architecture (one screen)

```
src/core/
├── p2p/          # WebRTC connections, channel bus, signaling, capability negotiation
├── mesh/         # Gossip protocol, topology selection, heartbeat, identity (ECDSA P-256)
├── relay/        # Sphinx-Lite onion routing + Kademlia DHT + peer scoring
├── crypto/       # ECDH P-256 key exchange + AES-256-GCM sender keys
├── transport/    # Multi-channel bus, store-and-forward, lifecycle
├── ordering/     # Causal ordering + HLC
└── metrics/      # MetricsCollector + opt-in console exporter
```

E2EE flow: ECDH P-256 between peers → derive AES-256-GCM sender key → AES-256-GCM encrypt per message → rotate every 100 messages / 1 hour. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for what this protects and what it doesn't.

## Security & privacy

**The honest version is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).** Short version:

- ✅ **Content** is unreadable to Firebase, relays, and passive observers.
- ⚠️ **Metadata** (who is in which room, when, message sizes) leaks to whoever runs the signaling layer.
- ⚠️ **2–3 onion hops** is not strong anonymity. Don't use this for activism in adversarial jurisdictions.
- ⚠️ **IndexedDB private keys** are stored at-rest — physical device access or same-origin XSS can extract them.
- ✅ **Firestore rules** enforce: only-self meshIdentity writes, participant-only signaling reads, ±30 s anti-replay on fallback messages.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tests must pass (`npm run ci`) before PR.

## License

Project delivery sample — adjust to your needs.
