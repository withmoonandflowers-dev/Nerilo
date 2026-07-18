# Threat Model

This document describes what Nerilo's privacy and security guarantees mean in practice — what each cryptographic and network primitive does, who it defends against, and where the boundaries are. It is intentionally honest about the gaps so that users and operators can make informed decisions.

## TL;DR — what "資料隱私" actually means

Nerilo provides **end-to-end encrypted (E2EE) group messaging** with **best-effort sender anonymity** via simplified onion routing (Sphinx-Lite). Specifically:

- Message **content** is encrypted with AES-256-GCM under per-room sender keys distributed via ECDH P-256. Only group members can decrypt.
- For multi-hop relays, messages travel through **2–3 onion-routed hops**, so an intermediate relay can see neither sender, receiver, nor plaintext — only "I received an opaque blob; pass it to the next hop."
- **Metadata** (who is in which room, when messages flow, how big they are) is **not** end-to-end-protected against the Firebase signaling layer or a global passive observer.

If you need strong anonymity (e.g. journalism, activism in adversarial jurisdictions), use a dedicated tool like Tor / SecureDrop / Signal. Nerilo is a **chat application with strong content confidentiality and modest metadata protection** — not an anonymity network.

## Adversaries we consider

| Adversary | Capabilities | What we defend against | What we don't |
|---|---|---|---|
| **Passive network observer** (ISP, café Wi-Fi sniffer) | Can read all bytes on the wire | TLS everywhere (Firebase HTTPS, WebRTC DTLS-SRTP), plus E2EE inside | Cannot read message content, but **can observe timing, packet sizes, peer IPs**. Cover traffic and 256-byte block padding mitigate but do not eliminate this. |
| **Malicious relay node** (a peer carrying onion-routed traffic for others) | Decrypts only its own layer, sees ciphertext + next hop | Sphinx-Lite layered encryption: a relay learns nothing about sender, receiver, or content | A relay can **refuse to forward** (denial of service), drop packets, or attempt timing correlation. PeerScoring + multi-path routing partially compensate. |
| **Compromised signaling server** (Firebase Auth + Firestore breach) | Reads all WebRTC SDP/ICE, user identities, room membership | Cannot decrypt P2P traffic (DTLS-SRTP keys never touch Firebase). Cannot decrypt E2EE message content (sender keys never touch Firebase). | **Can deanonymize** room membership, link Firebase Auth UID → IP addresses (from ICE candidates), tamper with signaling to facilitate a MITM at WebRTC handshake (mitigated by ECDH TOFU on first message, see below). |
| **Malicious peer** (someone you let into a room) | Full E2EE access — they are a legitimate group member | Nothing prevents a member from screenshotting / forwarding content out of band. We provide **forward secrecy** so past sessions remain confidential after key rotation. | Trust is symmetric within a room. Do not invite people you don't trust. |
| **Global passive adversary** (nation-state with backbone access) | Sees all traffic, timing, sizes | The 256-byte padding + Poisson-distributed cover traffic raise the cost of size correlation | We do **not** claim resistance to a global passive adversary. With only 2–3 hops and no decoy guarantees, correlation attacks remain feasible. |

## Cryptographic primitives

### E2EE (content)

| Aspect | Choice | Source |
|---|---|---|
| Identity key | ECDSA P-256 | [src/core/mesh/IdentityManager.ts](../src/core/mesh/IdentityManager.ts) (TOFU on first message via ECDH pubkey announcement) |
| Key agreement | ECDH P-256, HKDF-SHA-256 to derive AES-256-GCM key per peer | [src/core/crypto/ECDHKeyExchange.ts](../src/core/crypto/ECDHKeyExchange.ts) |
| Group message encryption | AES-256-GCM with per-sender keys | [src/core/crypto/SenderKeyManager.ts](../src/core/crypto/SenderKeyManager.ts) |
| Sender key distribution | Encrypted per-member via ECDH; one wrapped copy per recipient | [src/core/crypto/SenderKeyManager.ts](../src/core/crypto/SenderKeyManager.ts) |
| Rotation | Every 100 messages or 1 hour (configurable); on member join/leave | [src/core/crypto/SenderKeyManager.ts](../src/core/crypto/SenderKeyManager.ts) |
| Forward secrecy | Previous-epoch sender keys retained briefly for in-flight messages, then deleted | Same |
| Implementation | Browser-native `SubtleCrypto` only; no custom curve code | All crypto modules |

### Mesh room content key（keyx，ADR-0023 P2；輪替口徑 Spec 012 Q4 拍板）

mesh／gossip 房（Vue 線含 2 人房）不走 per-sender key，而是**單一房間內容金鑰**：

| 面向 | 設計 | 出處 |
|---|---|---|
| 金鑰形態 | AES-256-GCM 房間金鑰；每則紀錄單一密文信封（nrec1），簽章覆蓋密文 | [RecordCrypto.ts](../src/core/mesh/RecordCrypto.ts) |
| 分發 | keyx 日誌紀錄：對每位成員以 ECDH 成對封裝一份；遲入／重進靠 anti-entropy 補齊 keyx 自行開鑰 | [RoomKeyDistribution.ts](../src/core/mesh/RoomKeyDistribution.ts) |
| 輪替 | **僅名冊變動時輪替**（加人／移除 → 新 epoch 新金鑰），無時間／訊息數週期輪替 | [RoomKeyCoordinator.ts](../src/core/mesh/RoomKeyCoordinator.ts) |
| 前向保密 | 對**離開者**成立：新 epoch 金鑰不封給離開者。對**在籍成員不成立**（見下） | 同上 |
| 金鑰未就緒 | 出口閘暫扣不送明文；交換逾時（60s）轉 fail-visible 阻斷式確認 | [MeshChatService.ts](../src/features/chat/MeshChatService.ts)、[securityLabel.ts](../src/core/security/securityLabel.ts) |
| 盲信使 | 只代管密文與 keyx（收側拒收明文紀錄，協議規則） | [courierEligibility.ts](../src/core/relay/courierEligibility.ts) |

**誠實口徑（刻意取捨，Spec 012 Q4）**：keyx 是永久日誌紀錄，任何在籍成員（含遲入者）
補齊 keyx 即可解該房**全部 epoch 的歷史**——這是「持久聊天室可補歷史」產品語義的直接後果。
因此：(1) 成員 ECDH 私鑰外洩 = 該房全歷史暴露，週期輪替救不了（攻擊者同樣能開全部 keyx），
故不做週期輪替、也不對外宣稱在籍前向保密；(2) 真前向保密（ratchet＋刪舊鑰）與補歷史語義
正面衝突，若未來需要，屬產品級重新定義，不是加個輪替參數。敏感對話的粗粒度界線
是「換房」（見 Recommended user practices 的 rotate rooms）。

### What E2EE protects

- ✅ **Message content** (text, file metadata, file chunks) is unreadable to anyone outside the room — including the relay nodes, Firebase, and a passive observer.
- ✅ **Forward secrecy after rotation**: if a current sender key is compromised, prior epochs remain confidential.
- ✅ **Per-group isolation**: a key compromise in one room does not affect other rooms.

### What E2EE does **not** protect

- ❌ **Metadata** — `from`, `to`, `ts`, `roomId`, message length (before padding), and the existence of a conversation are visible to whatever layer is carrying the envelope (Firebase signaling, or an intermediate relay before/after onion encryption).
- ❌ **Timing** — when you send, when peers ack. Useful for correlation by a global observer.
- ❌ **Group membership** — Firestore knows who is in which room.
- ❌ **Endpoint compromise** — if your device is malware-infected or someone shoulder-surfs, no encryption helps.
- ❌ **Out-of-band leakage** — a recipient can copy/paste/screenshot.

### Sphinx-Lite (onion routing)

Implementation: [src/core/relay/SphinxPacket.ts](../src/core/relay/SphinxPacket.ts).

**What it protects against:**
- A single relay node cannot identify both the sender and the receiver — it knows only the previous and next hop. So **no single intermediary** can link sender→receiver.
- Fixed 4096-byte payload + 256-byte block padding (see [MessagePadding.ts](../src/core/relay/MessagePadding.ts)) defeats size-based traffic analysis between hops.

**What it does NOT protect against — be explicit:**
- **Only 2–3 hops** vs Nym/Loopix's 5+. A determined adversary running 2 of those 3 nodes can fully deanonymize. Mitigated by `MultiPathSelector` (2–4 independent paths, greedy construction to avoid shared nodes) and `RelayScorer` peer reputation, but **not eliminated**.
- **No SURBs** (Single-Use Reply Blocks). Reply paths require the recipient to know an onion route back, which leaks more metadata than a full Sphinx implementation.
- **No timing decoys at the packet level** beyond `CoverTrafficGenerator`'s Poisson dummy stream, which is **battery-aware** (throttled on low battery) and therefore not constant-rate. A patient observer can correlate bursts.
- **Sybil attacks** on the relay set. We use S/Kademlia diversification + `PeerScoring` (GossipSub v1.1 style) to raise the bar, but a well-resourced attacker can flood the DHT with malicious nodes.
- **First-hop / last-hop linkage** when the sender or receiver IP is already known to the adversary (via Firebase auth, ICE candidates, etc.).

## Trust assumptions: Firebase signaling

Firebase Auth + Firestore are used for:
1. User identity (anonymous auth → `guest` role; email/Google → `user` role).
2. Room directory (who is in which room, owner, status).
3. WebRTC signaling (SDP offers/answers, ICE candidates).
4. Message fallback (when P2P fails, messages relay through Firestore — **always under E2EE**).

**What we trust Firebase to do:**
- Authenticate users honestly.
- Not silently drop or reorder signaling messages.
- Not collude with a network adversary for active MITM.

**What we do NOT trust Firebase with:**
- Plaintext message content. Firestore fallback messages are E2EE-wrapped before upload.
- WebRTC media keys. DTLS-SRTP fingerprints are exchanged via signaling but the keys themselves are negotiated end-to-end.

**Threat: a malicious Firebase admin / compromised Firebase account.** Such an adversary could:
- See all user IDs, rooms, and who connects to whom.
- See ICE candidates (peer IPs).
- Substitute a peer's ECDH public key during the first key exchange → MITM on E2EE.

**Mitigation against the MITM:** the project ships an ECDH TOFU (Trust On First Use) check on first message exchange. Users can manually compare identity fingerprints out-of-band. This is **opt-in vigilance**, not automatic safety.

## Known limitations (summary)

1. **2–3 onion hops, not 5+.** Lower anonymity-set than Nym/Loopix. Sufficient against curious-but-bounded adversaries; insufficient against nation-states or compromised relay majorities.
2. **No SURBs.** Reply paths require the responder to construct their own onion route, which leaks reply-direction metadata.
3. **Cover traffic is battery-aware.** Poisson dummy stream is throttled on low battery, which an observer can detect as device-state side-channel.
4. **IndexedDB private-key storage.** Long-term ECDSA identity keys are stored in browser IndexedDB. They are **not** encrypted at rest by Nerilo — they rely on the browser/OS sandbox. Anyone with physical or malware-level access to the device can read them.
5. **Firebase metadata layer.** Membership, timing, and IP addresses (via ICE) are visible to a compromised signaling server.
6. **Single Firebase project for now.** A breach of `nerilo` Firebase project compromises every user (no per-tenant isolation).
7. **No deniability / unlinkable identity.** ECDSA identity keys are stable per-device; multiple rooms on the same device share the same long-term identity.
8. **E2EE has no post-compromise security after epoch closes.** A future-compromise of a sender key reveals all messages in that epoch, even those received before the compromise was detected — until the next rotation.
9. **Mesh 房間金鑰對在籍成員無前向保密。** keyx 永存日誌、在籍者可解全歷史（補歷史語義的刻意取捨，Spec 012 Q4）；成員 ECDH 私鑰外洩＝該房全歷史暴露。界線靠換房，不靠輪替。

## Recommended user practices

- **Only invite people you trust into a room.** E2EE protects the wire; it does not protect against a member screenshotting.
- **Verify identity fingerprints out-of-band** when you first connect to a new peer (e.g. read them aloud over a known-secure channel like a phone call).
- **Keep your browser updated.** Nerilo relies entirely on the browser's `SubtleCrypto` and WebRTC implementations; a browser vulnerability defeats the whole stack.
- **Use a hardware-locked device.** Long-term keys live in IndexedDB — if your laptop is stolen and unlocked, those keys are extractable.
- **Don't reuse Nerilo for high-stakes operational security.** For activism, journalism in adversarial jurisdictions, or whistleblowing, prefer tools designed for that threat model (Signal, SecureDrop, Tor + tooling) — not a chat app that's transparent about being best-effort.
- **Be aware of metadata.** Even with E2EE, the fact that you and another user are in the same room is observable to whoever runs the Firebase backend.
- **Rotate rooms for sensitive conversations.** A room's history is bound to its sender-key epochs; abandoning a room and creating a new one provides a coarse "session boundary."

## Out-of-scope

The following are **not** part of Nerilo's threat model:
- Resistance to global passive adversaries (nation-state backbone surveillance).
- Coercion / "lawful intercept" of the Firebase operator.
- Side-channel attacks on the browser (Spectre-class, GPU side-channels).
- Supply-chain compromise of npm dependencies (mitigated by `npm audit` and lockfile review, not eliminated).
- Physical attacks on the user's device.

## Changelog

- 2026-07-18 — Spec 012：新增 mesh 房間金鑰（keyx）節與 Q4 輪替口徑（在籍者可解全歷史為刻意取捨）；known limitations 補第 9 點；出口閘／信使拒收明文入列。
- 2026-05-27 — initial draft. Covers Sphinx-Lite, ECDH+AES-GCM sender keys, Firebase trust boundary. Tracking gaps: cover-traffic battery side-channel; IndexedDB at-rest encryption; per-tenant Firebase isolation.
