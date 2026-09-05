/**
 * Protocol Spec 031 的開票人背書登記簿、雙重背書證據與代理受理佇列。
 *
 * 登記簿是開票人對自身憑證的唯一裁決點。代理只保存受理順序並轉交，
 * 回傳型別刻意不含 accepted，避免把代理受理誤當成完成轉手。
 */
import {
  endorsementHash,
  iouHash,
  verifyEndorsementChain,
  verifyServiceEndorsementSignature,
  type ServiceEndorsement,
  type ServiceIOU,
  type ServiceIOURejectReason,
} from './ServiceIOU';
import {
  verifySwapBundle,
  type SwapEndorsementLeg,
  type SwapIntent,
  type SwapPair,
} from './ServiceIOUMatching';

export interface EndorsementChainHead {
  seq: number;
  endorsementHash: string;
  toNodeId: string;
}

export interface DoubleEndorsementEvidence {
  iouId: string;
  seq: number;
  fromNodeId: string;
  registered: ServiceEndorsement;
  conflicting: ServiceEndorsement;
}

export interface SwapRegistrationBundle {
  pair: SwapPair;
  intents: [SwapIntent, SwapIntent];
  endorsements: [SwapEndorsementLeg, SwapEndorsementLeg];
}

export interface RegistrationOptions {
  now: number;
  maxChainLength?: number;
  swapBundles?: ReadonlyMap<number, SwapRegistrationBundle>;
}

export type EndorsementRegistrationResult =
  | { status: 'accepted'; changed: boolean; head: EndorsementChainHead }
  | { status: 'rejected'; reason: ServiceIOURejectReason };

interface PersistedRegistration {
  iou: ServiceIOU;
  chain: ServiceEndorsement[];
}

export interface IssuerEndorsementRegistrySnapshot {
  version: 1;
  issuerNodeId: string;
  registrations: PersistedRegistration[];
  evidence: DoubleEndorsementEvidence[];
}

export interface IssuerEndorsementRegistryPersistence {
  load(issuerNodeId: string): Promise<IssuerEndorsementRegistrySnapshot | null>;
  save(snapshot: IssuerEndorsementRegistrySnapshot): Promise<void>;
}

interface RegisteredChain extends PersistedRegistration {
  hashes: string[];
  head: EndorsementChainHead;
}

function rejected(reason: ServiceIOURejectReason): EndorsementRegistrationResult {
  return { status: 'rejected', reason };
}

async function chainHashes(chain: readonly ServiceEndorsement[]): Promise<string[]> {
  return Promise.all(chain.map((endorsement) => endorsementHash(endorsement)));
}

async function bundleContainsChain(
  iou: ServiceIOU,
  chain: readonly ServiceEndorsement[],
  bundle: SwapRegistrationBundle
): Promise<boolean> {
  const [targetIOUHash, targetChainHashes] = await Promise.all([
    iouHash(iou),
    chainHashes(chain),
  ]);
  for (const leg of bundle.endorsements) {
    const [legIOUHash, legChainHashes] = await Promise.all([
      iouHash(leg.iou),
      chainHashes(leg.chain),
    ]);
    if (legIOUHash === targetIOUHash
      && legChainHashes.length === targetChainHashes.length
      && legChainHashes.every((hash, index) => hash === targetChainHashes[index])) {
      return true;
    }
  }
  return false;
}

/**
 * 只靠兩則背書驗證可轉移的雙重背書證據，不讀憑證、登記簿或本機狀態。
 */
export async function verifyDoubleEndorsementEvidence(
  registered: ServiceEndorsement,
  conflicting: ServiceEndorsement
): Promise<boolean> {
  if (registered.iouId !== conflicting.iouId
    || registered.seq !== conflicting.seq
    || registered.from.nodeId !== conflicting.from.nodeId
    || registered.toNodeId === conflicting.toNodeId) {
    return false;
  }
  const [registeredValid, conflictingValid] = await Promise.all([
    verifyServiceEndorsementSignature(registered),
    verifyServiceEndorsementSignature(conflicting),
  ]);
  return registeredValid.ok && conflictingValid.ok;
}

/** 開票人端的先到先認登記簿。 */
export class IssuerEndorsementRegistry {
  private readonly registrations = new Map<string, RegisteredChain>();
  private readonly doubleEndorsementEvidence: DoubleEndorsementEvidence[] = [];
  private readonly evidenceKeys = new Set<string>();
  private revision = 0;
  private persistedRevision = 0;
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(
    readonly issuerNodeId: string,
    private readonly persistence?: IssuerEndorsementRegistryPersistence
  ) {}

  async register(
    iou: ServiceIOU,
    chain: readonly ServiceEndorsement[],
    options: RegistrationOptions
  ): Promise<EndorsementRegistrationResult> {
    // 鏈驗證必須先做，登記衝突不得蓋掉斷鏈、壞簽章或過期等真正原因。
    const chainValidation = await verifyEndorsementChain(iou, chain, {
      now: options.now,
      maxChainLength: options.maxChainLength,
    });
    if (!chainValidation.ok) return rejected(chainValidation.reason);
    if (iou.issuer.nodeId !== this.issuerNodeId) return rejected('unknown-iou');
    if (chain.length === 0) return rejected('malformed');

    const hashes = await chainHashes(chain);
    const finalEndorsement = chain[chain.length - 1];
    const finalHash = hashes[hashes.length - 1];
    const head: EndorsementChainHead = {
      seq: finalEndorsement.seq,
      endorsementHash: finalHash,
      toNodeId: finalEndorsement.toNodeId,
    };
    const existing = this.registrations.get(iou.iouId);
    const sharedLength = existing
      ? Math.min(existing.hashes.length, hashes.length)
      : 0;
    const divergenceIndex = existing
      ? Array.from({ length: sharedLength }, (_, index) => index)
        .find((index) => existing.hashes[index] !== hashes[index])
      : undefined;
    const coveredPrefixLength = existing && divergenceIndex === undefined
      ? sharedLength
      : divergenceIndex ?? 0;
    for (let index = coveredPrefixLength; index < chain.length; index++) {
      const endorsement = chain[index];
      if (endorsement.swapPairHash === null) continue;
      const bundle = options.swapBundles?.get(endorsement.seq);
      if (!bundle) return rejected('swap-incomplete');
      const bundleValidation = await verifySwapBundle(
        bundle.pair,
        bundle.intents,
        bundle.endorsements,
        { now: options.now, maxChainLength: options.maxChainLength }
      );
      if (!bundleValidation.ok) return rejected(bundleValidation.reason);
      if (!(await bundleContainsChain(iou, chain.slice(0, index + 1), bundle))) {
        return rejected('swap-incomplete');
      }
    }

    if (!existing) {
      this.registrations.set(iou.iouId, this.registeredChain(iou, chain, hashes, head));
      this.revision++;
      return { status: 'accepted', changed: true, head: { ...head } };
    }

    if (divergenceIndex !== undefined) {
      const registered = existing.chain[divergenceIndex];
      const conflicting = chain[divergenceIndex];
      this.recordEvidence(
        iou.iouId,
        registered,
        conflicting,
        existing.hashes[divergenceIndex],
        hashes[divergenceIndex]
      );
      return rejected('already-endorsed-elsewhere');
    }

    if (hashes.length > existing.hashes.length) {
      this.registrations.set(iou.iouId, this.registeredChain(iou, chain, hashes, head));
      this.revision++;
      return { status: 'accepted', changed: true, head: { ...head } };
    }

    // 完全相同的重送與已登記鏈的舊前綴都不建立第二筆登記，也不倒退鏈頭。
    return { status: 'accepted', changed: false, head: { ...existing.head } };
  }

  headFor(iouId: string): EndorsementChainHead | null {
    const head = this.registrations.get(iouId)?.head;
    return head ? { ...head } : null;
  }

  registrationCount(): number {
    return this.registrations.size;
  }

  evidence(): DoubleEndorsementEvidence[] {
    return structuredClone(this.doubleEndorsementEvidence);
  }

  evidenceFor(fromNodeId: string): DoubleEndorsementEvidence[] {
    return this.evidence().filter((item) => item.fromNodeId === fromNodeId);
  }

  private registeredChain(
    iou: ServiceIOU,
    chain: readonly ServiceEndorsement[],
    hashes: string[],
    head: EndorsementChainHead
  ): RegisteredChain {
    return {
      iou: structuredClone(iou),
      chain: structuredClone([...chain]),
      hashes: [...hashes],
      head: { ...head },
    };
  }

  private recordEvidence(
    iouId: string,
    registered: ServiceEndorsement,
    conflicting: ServiceEndorsement,
    registeredHash: string,
    conflictingHash: string
  ): void {
    if (registered.toNodeId === conflicting.toNodeId) return;
    const key = `${iouId}:${registered.seq}:${[registeredHash, conflictingHash].sort().join(':')}`;
    if (this.evidenceKeys.has(key)) return;
    this.evidenceKeys.add(key);
    this.doubleEndorsementEvidence.push({
      iouId,
      seq: registered.seq,
      fromNodeId: registered.from.nodeId,
      registered: structuredClone(registered),
      conflicting: structuredClone(conflicting),
    });
    this.revision++;
  }

  private snapshot(): IssuerEndorsementRegistrySnapshot {
    return {
      version: 1,
      issuerNodeId: this.issuerNodeId,
      registrations: [...this.registrations.values()].map(({ iou, chain }) => ({
        iou: structuredClone(iou),
        chain: structuredClone(chain),
      })),
      evidence: this.evidence(),
    };
  }

  async flush(): Promise<boolean> {
    if (!this.persistence || this.persistedRevision >= this.revision) return true;
    const targetRevision = this.revision;
    let ok = true;
    this.persistenceTail = this.persistenceTail.then(async () => {
      if (this.persistedRevision >= targetRevision) return;
      try {
        const savedRevision = this.revision;
        await this.persistence!.save(this.snapshot());
        this.persistedRevision = savedRevision;
      } catch {
        ok = false;
      }
    });
    await this.persistenceTail;
    return ok && this.persistedRevision >= targetRevision;
  }

  async hydrate(options: { now: number }): Promise<void> {
    if (!this.persistence) return;
    let snapshot: IssuerEndorsementRegistrySnapshot | null;
    try {
      snapshot = await this.persistence.load(this.issuerNodeId);
    } catch {
      return;
    }
    if (!snapshot
      || snapshot.version !== 1
      || snapshot.issuerNodeId !== this.issuerNodeId
      || !Array.isArray(snapshot.registrations)
      || !Array.isArray(snapshot.evidence)) return;

    this.registrations.clear();
    this.doubleEndorsementEvidence.length = 0;
    this.evidenceKeys.clear();
    for (const persisted of snapshot.registrations) {
      if (!persisted || !persisted.iou || !Array.isArray(persisted.chain) || persisted.chain.length === 0) continue;
      const verificationNow = Math.min(options.now, persisted.iou.expiresAt);
      const validation = await verifyEndorsementChain(persisted.iou, persisted.chain, {
        now: verificationNow,
      });
      if (!validation.ok || persisted.iou.issuer.nodeId !== this.issuerNodeId) continue;
      const hashes = await chainHashes(persisted.chain);
      const final = persisted.chain[persisted.chain.length - 1];
      this.registrations.set(persisted.iou.iouId, this.registeredChain(
        persisted.iou,
        persisted.chain,
        hashes,
        { seq: final.seq, endorsementHash: hashes[hashes.length - 1], toNodeId: final.toNodeId }
      ));
    }
    for (const evidence of snapshot.evidence) {
      if (await verifyDoubleEndorsementEvidence(
        evidence.registered,
        evidence.conflicting
      )) {
        this.doubleEndorsementEvidence.push(structuredClone(evidence));
        const hashes = await Promise.all([
          endorsementHash(evidence.registered),
          endorsementHash(evidence.conflicting),
        ]);
        this.evidenceKeys.add(
          `${evidence.iouId}:${evidence.seq}:${hashes.sort().join(':')}`
        );
      }
    }
    this.revision = 1;
    this.persistedRevision = 0;
    await this.flush();
  }
}

export interface ProxyPendingReceipt {
  status: 'pending-issuer-decision';
  sequence: number;
  receivedAt: number;
}

interface ProxyQueuedRegistration extends ProxyPendingReceipt {
  iou: ServiceIOU;
  chain: ServiceEndorsement[];
  swapBundles?: ReadonlyMap<number, SwapRegistrationBundle>;
}

export interface ProxyForwardedDecision {
  sequence: number;
  receivedAt: number;
  decision: EndorsementRegistrationResult;
}

/** 信使代理只受理與轉交，不驗鏈、不處理衝突，也不產生 accepted 結果。 */
export class ProxyRegistrationQueue {
  private readonly queue: ProxyQueuedRegistration[] = [];
  private nextSequence = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  enqueue(
    iou: ServiceIOU,
    chain: readonly ServiceEndorsement[],
    options: { swapBundles?: ReadonlyMap<number, SwapRegistrationBundle> } = {}
  ): ProxyPendingReceipt {
    const pending: ProxyQueuedRegistration = {
      status: 'pending-issuer-decision',
      sequence: this.nextSequence++,
      receivedAt: this.now(),
      iou: structuredClone(iou),
      chain: structuredClone([...chain]),
      swapBundles: options.swapBundles ? structuredClone(options.swapBundles) : undefined,
    };
    this.queue.push(pending);
    return {
      status: pending.status,
      sequence: pending.sequence,
      receivedAt: pending.receivedAt,
    };
  }

  pendingCount(): number {
    return this.queue.length;
  }

  async forwardTo(
    registry: IssuerEndorsementRegistry,
    options: { now: number; maxChainLength?: number }
  ): Promise<ProxyForwardedDecision[]> {
    const queued = this.queue.splice(0).sort((a, b) => a.sequence - b.sequence);
    const decisions: ProxyForwardedDecision[] = [];
    for (const item of queued) {
      decisions.push({
        sequence: item.sequence,
        receivedAt: item.receivedAt,
        decision: await registry.register(item.iou, item.chain, {
          now: options.now,
          maxChainLength: options.maxChainLength,
          swapBundles: item.swapBundles,
        }),
      });
    }
    return decisions;
  }
}
