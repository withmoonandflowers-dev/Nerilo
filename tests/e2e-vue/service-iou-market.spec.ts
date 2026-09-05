/**
 * Spec 031 D6 服務欠條市場 E2E。
 *
 * 四個節點都停在 dashboard。B 是開票人兼信使，A 是第一手持有人，C 是第一條
 * 背書鏈的受讓人；D 只用來提出同一 seq 的分岔鏈，避免讓 B 經 relay 自連。
 * 本檔驗接線後的一次登記加兌換，以及登記失敗時不進入兌換。
 */
import { test, expect, type Page } from '@playwright/test';
import { setupUser, teardown } from './_helpers/users';

type ServiceDenominationUnit = 'relay-bytes' | 'custody-byte-days' | 'priority';

interface ServiceParty {
  nodeId: string;
  pubKey: string;
}

interface ServiceIOU {
  v: 'nsiou1';
  iouId: string;
  kind: 'registered' | 'endorsable';
  issuer: ServiceParty;
  holder: ServiceParty;
  denomination: { unit: ServiceDenominationUnit; amount: number };
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  signature: string;
}

interface ServiceEndorsement {
  v: 'nsend1';
  iouId: string;
  seq: number;
  from: ServiceParty;
  toNodeId: string;
  prevHash: string;
  swapPairHash: string | null;
  endorsedAt: number;
  nonce: string;
  signature: string;
}

type ServiceRedeemAck =
  | {
    accepted: true;
    remaining: number;
    serviceEffect: 'custody-quota';
    granted: number;
  }
  | {
    accepted: true;
    remaining: number;
    serviceEffect: 'none';
  }
  | {
    accepted: false;
    reason: string;
    serviceAvailable?: false;
  };

interface ServiceIouHook {
  myParty(): Promise<ServiceParty>;
  issue(
    holderNodeId: string,
    holderPubKey: string,
    unit: ServiceDenominationUnit,
    amount: number,
    expiresAt: number,
    kind: ServiceIOU['kind']
  ): Promise<ServiceIOU>;
  endorse(
    iou: ServiceIOU,
    chain: ServiceEndorsement[],
    toNodeId: string
  ): Promise<ServiceEndorsement>;
  redeem(
    courierUid: string,
    iou: ServiceIOU,
    chain: ServiceEndorsement[],
    unit: ServiceDenominationUnit,
    amount: number
  ): Promise<ServiceRedeemAck>;
}

interface NeriloTestWindow {
  __nerilo_test__?: {
    auth?: { currentUser?: { uid?: string } | null };
    relay?: {
      serviceIou?: ServiceIouHook;
      connectToRelayNode?: (uid: string) => Promise<void>;
      states?: () => string[];
    };
    presence?: { announcing?: () => boolean };
  };
}

async function currentUid(page: Page): Promise<string> {
  const uid = await page.evaluate(() => {
    const hook = (window as unknown as NeriloTestWindow).__nerilo_test__;
    return hook?.auth?.currentUser?.uid ?? '';
  });
  if (!uid) throw new Error('test hook auth.currentUser.uid 不可用');
  return uid;
}

async function waitServiceIou(page: Page): Promise<void> {
  await expect
    .poll(
      () => page.evaluate(() => {
        const hook = (window as unknown as NeriloTestWindow).__nerilo_test__;
        return Boolean(
          hook?.relay?.serviceIou?.myParty
            && hook.relay.serviceIou.issue
            && hook.relay.serviceIou.endorse
            && hook.relay.serviceIou.redeem
            && hook.presence?.announcing?.()
        );
      }),
      { timeout: 20_000, intervals: [250] }
    )
    .toBe(true);
}

async function myParty(page: Page): Promise<ServiceParty> {
  return page.evaluate(() => {
    const hook = (window as unknown as NeriloTestWindow).__nerilo_test__;
    return hook!.relay!.serviceIou!.myParty();
  });
}

async function connectToCourier(page: Page, courierUid: string): Promise<void> {
  await page.evaluate(async (uid) => {
    const hook = (window as unknown as NeriloTestWindow).__nerilo_test__;
    await hook!.relay!.connectToRelayNode!(uid);
  }, courierUid);
  await expect
    .poll(
      () => page.evaluate(() => {
        const hook = (window as unknown as NeriloTestWindow).__nerilo_test__;
        return hook?.relay?.states?.() ?? [];
      }),
      { timeout: 120_000, intervals: [1_000] }
    )
    .toContain('connected');
}

async function issue(
  page: Page,
  holder: ServiceParty,
  amount: number,
  expiresAt: number
): Promise<ServiceIOU> {
  return page.evaluate(
    ({ target, value, expiry }) => {
      const hook = (window as unknown as NeriloTestWindow).__nerilo_test__;
      return hook!.relay!.serviceIou!.issue(
        target.nodeId,
        target.pubKey,
        'custody-byte-days',
        value,
        expiry,
        'endorsable'
      );
    },
    { target: holder, value: amount, expiry: expiresAt }
  );
}

async function endorse(
  page: Page,
  iou: ServiceIOU,
  toNodeId: string
): Promise<ServiceEndorsement> {
  return page.evaluate(
    ({ certificate, recipient }) => {
      const hook = (window as unknown as NeriloTestWindow).__nerilo_test__;
      return hook!.relay!.serviceIou!.endorse(certificate, [], recipient);
    },
    { certificate: iou, recipient: toNodeId }
  );
}

async function redeem(
  page: Page,
  courierUid: string,
  iou: ServiceIOU,
  chain: ServiceEndorsement[],
  amount: number
): Promise<ServiceRedeemAck> {
  return page.evaluate(
    ({ uid, certificate, endorsements, value }) => {
      const hook = (window as unknown as NeriloTestWindow).__nerilo_test__;
      return hook!.relay!.serviceIou!.redeem(
        uid,
        certificate,
        endorsements,
        'custody-byte-days',
        value
      );
    },
    { uid: courierUid, certificate: iou, endorsements: chain, value: amount }
  );
}

test.describe('Spec 031 服務欠條接線 @iou', () => {
  test('custody-byte-days 登記後兌換，分岔鏈在登記步驟被拒', async ({ browser }, testInfo) => {
    test.setTimeout(150_000);
    const issuer = await setupUser(browser);
    const initialHolder = await setupUser(browser);
    const claimant = await setupUser(browser);
    const conflictingClaimant = await setupUser(browser);

    try {
      await Promise.all([
        waitServiceIou(issuer.page),
        waitServiceIou(initialHolder.page),
        waitServiceIou(claimant.page),
        waitServiceIou(conflictingClaimant.page),
      ]);
      const issuerUid = await currentUid(issuer.page);
      const [holderParty, claimantParty, conflictingParty] = await Promise.all([
        myParty(initialHolder.page),
        myParty(claimant.page),
        myParty(conflictingClaimant.page),
      ]);

      await connectToCourier(claimant.page, issuerUid);
      await connectToCourier(conflictingClaimant.page, issuerUid);

      const iou = await issue(
        issuer.page,
        holderParty,
        10,
        Date.now() + 60_000
      );
      const firstEndorsement = await endorse(initialHolder.page, iou, claimantParty.nodeId);
      const accepted = await redeem(claimant.page, issuerUid, iou, [firstEndorsement], 4);
      expect(accepted.accepted).toBe(true);
      expect(accepted.accepted && accepted.serviceEffect).toBe('custody-quota');
      expect(
        accepted.accepted && accepted.serviceEffect === 'custody-quota' && accepted.granted
      ).toBeGreaterThan(0);

      const conflictingEndorsement = await endorse(
        initialHolder.page,
        iou,
        conflictingParty.nodeId
      );
      const rejected = await redeem(
        conflictingClaimant.page,
        issuerUid,
        iou,
        [conflictingEndorsement],
        4
      );
      expect(rejected).toEqual({
        accepted: false,
        reason: 'already-endorsed-elsewhere',
      });

      const metrics = {
        denomination: iou.denomination,
        accepted,
        conflictingChain: rejected,
      };
      console.log(`SERVICE_IOU_METRICS=${JSON.stringify(metrics)}`);
      await testInfo.attach('service-iou-metrics', {
        body: JSON.stringify(metrics),
        contentType: 'application/json',
      });
    } finally {
      await teardown(issuer, initialHolder, claimant, conflictingClaimant);
    }
  });
});
