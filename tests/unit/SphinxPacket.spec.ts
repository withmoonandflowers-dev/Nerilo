import { describe, it, expect } from 'vitest';
import {
  createSphinxPacket,
  peelSphinxLayer,
  decryptFinalPayload,
  getMaxHops,
  getPacketPayloadSize,
} from '../../src/core/relay/SphinxPacket';
import type { RouteHop } from '../../src/core/relay/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate an ECDH P-256 key pair for a hop node */
async function generateHopKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits'],
  );
}

/** Export an ECDH public key to raw Base64 */
async function exportPubKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey('raw', key);
  const bytes = new Uint8Array(raw);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Build a RouteHop from a key pair */
async function makeHop(id: string, kp: CryptoKeyPair): Promise<RouteHop> {
  return {
    nodeId: id,
    ephemeralPubKey: await exportPubKey(kp.publicKey),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SphinxPacket', () => {
  describe('createSphinxPacket + peelSphinxLayer round-trip', () => {
    it('creates and peels a 2-hop packet successfully', async () => {
      const hop1KP = await generateHopKeyPair();
      const hop2KP = await generateHopKeyPair();
      const destKP = await generateHopKeyPair();

      const route: RouteHop[] = [
        await makeHop('relay-1', hop1KP),
        await makeHop('relay-2', hop2KP),
      ];

      const plaintext = new TextEncoder().encode('hello sphinx 2-hop');
      const packet = await createSphinxPacket(
        plaintext,
        route,
        await exportPubKey(destKP.publicKey),
      );

      // Peel layer 1
      const layer1 = await peelSphinxLayer(packet, hop1KP.privateKey);
      expect(layer1.routingInfo.nextHop).toBe('relay-2');
      expect(layer1.forwardPacket).not.toBeNull();

      // Peel layer 2
      const layer2 = await peelSphinxLayer(layer1.forwardPacket!, hop2KP.privateKey);
      expect(layer2.routingInfo.nextHop).toBe('');
      expect(layer2.forwardPacket).toBeNull();

      // Decrypt final payload
      const decrypted = await decryptFinalPayload(layer2.payload, destKP.privateKey);
      expect(new TextDecoder().decode(decrypted)).toBe('hello sphinx 2-hop');
    });

    it('creates and peels a 3-hop packet successfully', async () => {
      const hop1KP = await generateHopKeyPair();
      const hop2KP = await generateHopKeyPair();
      const hop3KP = await generateHopKeyPair();
      const destKP = await generateHopKeyPair();

      const route: RouteHop[] = [
        await makeHop('relay-A', hop1KP),
        await makeHop('relay-B', hop2KP),
        await makeHop('relay-C', hop3KP),
      ];

      const plaintext = new TextEncoder().encode('3-hop message');
      const packet = await createSphinxPacket(
        plaintext,
        route,
        await exportPubKey(destKP.publicKey),
      );

      // Peel each layer
      const l1 = await peelSphinxLayer(packet, hop1KP.privateKey);
      expect(l1.routingInfo.nextHop).toBe('relay-B');
      expect(l1.forwardPacket).not.toBeNull();

      const l2 = await peelSphinxLayer(l1.forwardPacket!, hop2KP.privateKey);
      expect(l2.routingInfo.nextHop).toBe('relay-C');
      expect(l2.forwardPacket).not.toBeNull();

      const l3 = await peelSphinxLayer(l2.forwardPacket!, hop3KP.privateKey);
      expect(l3.routingInfo.nextHop).toBe('');
      expect(l3.forwardPacket).toBeNull();

      const decrypted = await decryptFinalPayload(l3.payload, destKP.privateKey);
      expect(new TextDecoder().decode(decrypted)).toBe('3-hop message');
    });
  });

  describe('hop limit', () => {
    it('rejects route exceeding MAX_HOPS (4)', async () => {
      const keys = await Promise.all(
        Array.from({ length: 5 }, () => generateHopKeyPair()),
      );
      const destKP = await generateHopKeyPair();
      const route: RouteHop[] = await Promise.all(
        keys.map((kp, i) => makeHop(`node-${i}`, kp)),
      );

      const plaintext = new TextEncoder().encode('too many hops');
      await expect(
        createSphinxPacket(plaintext, route, await exportPubKey(destKP.publicKey)),
      ).rejects.toThrow(/maximum.*4.*hops|exceeds/i);
    });

    it('accepts route with exactly MAX_HOPS (4)', async () => {
      expect(getMaxHops()).toBe(4);

      const keys = await Promise.all(
        Array.from({ length: 4 }, () => generateHopKeyPair()),
      );
      const destKP = await generateHopKeyPair();
      const route: RouteHop[] = await Promise.all(
        keys.map((kp, i) => makeHop(`node-${i}`, kp)),
      );

      const plaintext = new TextEncoder().encode('max hops');
      // Should not throw
      const packet = await createSphinxPacket(
        plaintext,
        route,
        await exportPubKey(destKP.publicKey),
      );
      expect(packet.header).toBeDefined();
    });
  });

  describe('payload padding', () => {
    it('has constant PACKET_PAYLOAD_SIZE of 4096', () => {
      expect(getPacketPayloadSize()).toBe(4096);
    });

    it('pads payload to fixed size regardless of input length', async () => {
      const hopKP = await generateHopKeyPair();
      const destKP = await generateHopKeyPair();
      const route: RouteHop[] = [await makeHop('relay', hopKP)];

      // Small payload
      const small = new TextEncoder().encode('hi');
      const pktSmall = await createSphinxPacket(
        small,
        route,
        await exportPubKey(destKP.publicKey),
      );
      expect(pktSmall.packetSize).toBe(4096);

      // Larger payload
      const larger = new TextEncoder().encode('x'.repeat(500));
      const pktLarger = await createSphinxPacket(
        larger,
        route,
        await exportPubKey(destKP.publicKey),
      );
      expect(pktLarger.packetSize).toBe(4096);
    });
  });

  describe('tamper detection', () => {
    it('fails to peel when ciphertext is tampered', async () => {
      const hopKP = await generateHopKeyPair();
      const destKP = await generateHopKeyPair();
      const route: RouteHop[] = [await makeHop('relay', hopKP)];

      const plaintext = new TextEncoder().encode('tamper test');
      const packet = await createSphinxPacket(
        plaintext,
        route,
        await exportPubKey(destKP.publicKey),
      );

      // Tamper with the routing info ciphertext
      const [ciphertext, iv] = packet.header.routingInfo.split('.');
      const tamperedCipher = ciphertext.slice(0, -4) + 'XXXX';
      packet.header.routingInfo = tamperedCipher + '.' + iv;

      await expect(
        peelSphinxLayer(packet, hopKP.privateKey),
      ).rejects.toThrow();
    });

    it('fails to peel when MAC is tampered', async () => {
      const hopKP = await generateHopKeyPair();
      const destKP = await generateHopKeyPair();
      const route: RouteHop[] = [await makeHop('relay', hopKP)];

      const plaintext = new TextEncoder().encode('mac tamper');
      const packet = await createSphinxPacket(
        plaintext,
        route,
        await exportPubKey(destKP.publicKey),
      );

      // Tamper with the MAC
      packet.header.mac = packet.header.mac.slice(0, -4) + 'ZZZZ';

      await expect(
        peelSphinxLayer(packet, hopKP.privateKey),
      ).rejects.toThrow();
    });
  });

  describe('invalid input handling', () => {
    it('throws on empty route', async () => {
      const destKP = await generateHopKeyPair();
      const plaintext = new TextEncoder().encode('no route');

      await expect(
        createSphinxPacket(plaintext, [], await exportPubKey(destKP.publicKey)),
      ).rejects.toThrow(/at least one hop/i);
    });

    it('throws on invalid ephemeral key in header during peel', async () => {
      const hopKP = await generateHopKeyPair();

      const badPacket = {
        header: {
          version: 1,
          ephemeralKey: 'not-valid-base64!!!',
          routingInfo: 'aaa.bbb',
          mac: 'ccc',
        },
        payload: '',
        packetSize: 4096,
      };

      await expect(
        peelSphinxLayer(badPacket, hopKP.privateKey),
      ).rejects.toThrow();
    });
  });
});
