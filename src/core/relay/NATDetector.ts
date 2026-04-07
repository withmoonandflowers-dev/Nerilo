/**
 * NATDetector — Detect NAT type using WebRTC ICE candidate analysis
 *
 * Classifies the local NAT type by examining ICE candidates:
 * - open: Has host candidates with public IPs
 * - full-cone: srflx candidates with consistent mapped ports
 * - restricted: srflx candidates available
 * - port-restricted: srflx candidates with varying mapped ports
 * - symmetric: Only relay (TURN) candidates succeed
 * - unknown: Cannot determine
 *
 * This information drives routing decisions:
 * - symmetric NAT → force relay (no direct P2P possible)
 * - open/full-cone → prefer direct connections
 */

import type { NATType } from './types';

/** ICE candidate analysis result */
interface CandidateAnalysis {
  hasHostPublic: boolean;
  srflxCount: number;
  srflxPorts: Set<number>;
  srflxIps: Set<string>;
  relayCount: number;
  peerReflexiveCount: number;
}

export class NATDetector {
  private detectedType: NATType = 'unknown';
  private lastDetectionAt = 0;
  private detecting = false;

  /** Get the last detected NAT type */
  getNATType(): NATType {
    return this.detectedType;
  }

  /** Get timestamp of last detection */
  getLastDetectionTime(): number {
    return this.lastDetectionAt;
  }

  /** Whether detection is currently running */
  isDetecting(): boolean {
    return this.detecting;
  }

  /**
   * Detect NAT type by creating a temporary RTCPeerConnection
   * and analyzing the gathered ICE candidates.
   *
   * @param stunServers STUN server URLs to use
   * @param timeoutMs Maximum time to wait for candidates
   */
  async detect(
    stunServers: string[] = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    timeoutMs = 5000
  ): Promise<NATType> {
    if (this.detecting) return this.detectedType;
    this.detecting = true;

    try {
      const analysis = await this.gatherCandidates(stunServers, timeoutMs);
      this.detectedType = this.classify(analysis);
      this.lastDetectionAt = Date.now();
      return this.detectedType;
    } finally {
      this.detecting = false;
    }
  }

  /**
   * Classify NAT type from an existing RTCPeerConnection's ICE candidates.
   * Use this when you already have a connection being established.
   */
  classifyFromCandidates(candidates: RTCIceCandidate[]): NATType {
    const analysis = this.analyzeCandidates(candidates);
    this.detectedType = this.classify(analysis);
    this.lastDetectionAt = Date.now();
    return this.detectedType;
  }

  /**
   * Should this NAT type force relay mode?
   * Symmetric NATs cannot do direct P2P — must use relay.
   */
  shouldForceRelay(): boolean {
    return this.detectedType === 'symmetric';
  }

  /**
   * Score this NAT type for relay capability (0-1).
   * Open NATs are best relays; symmetric NATs cannot relay.
   */
  getRelayCapabilityScore(): number {
    switch (this.detectedType) {
      case 'open': return 1.0;
      case 'full-cone': return 0.8;
      case 'restricted': return 0.5;
      case 'port-restricted': return 0.3;
      case 'symmetric': return 0.0;
      case 'unknown': return 0.2;
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async gatherCandidates(
    stunServers: string[],
    timeoutMs: number
  ): Promise<CandidateAnalysis> {
    const pc = new RTCPeerConnection({
      iceServers: stunServers.map((url) => ({ urls: url })),
    });

    const candidates: RTCIceCandidate[] = [];

    const gatherPromise = new Promise<void>((resolve) => {
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          candidates.push(event.candidate);
        } else {
          // Gathering complete
          resolve();
        }
      };

      // Timeout fallback
      setTimeout(resolve, timeoutMs);
    });

    // Create a dummy data channel to trigger ICE gathering
    pc.createDataChannel('nat-detect');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await gatherPromise;

    pc.close();

    return this.analyzeCandidates(candidates);
  }

  private analyzeCandidates(candidates: RTCIceCandidate[]): CandidateAnalysis {
    const analysis: CandidateAnalysis = {
      hasHostPublic: false,
      srflxCount: 0,
      srflxPorts: new Set(),
      srflxIps: new Set(),
      relayCount: 0,
      peerReflexiveCount: 0,
    };

    for (const candidate of candidates) {
      if (!candidate.candidate) continue;

      const parts = candidate.candidate.split(' ');
      const typeIndex = parts.indexOf('typ');
      if (typeIndex === -1) continue;

      const type = parts[typeIndex + 1];
      const ip = parts[4];
      const port = parseInt(parts[5], 10);

      switch (type) {
        case 'host':
          // Check if this is a public IP (not RFC1918/link-local)
          if (ip && !this.isPrivateIP(ip)) {
            analysis.hasHostPublic = true;
          }
          break;

        case 'srflx':
          analysis.srflxCount++;
          if (port) analysis.srflxPorts.add(port);
          if (ip) analysis.srflxIps.add(ip);
          break;

        case 'relay':
          analysis.relayCount++;
          break;

        case 'prflx':
          analysis.peerReflexiveCount++;
          break;
      }
    }

    return analysis;
  }

  private classify(analysis: CandidateAnalysis): NATType {
    // Has public host candidates → no NAT
    if (analysis.hasHostPublic) {
      return 'open';
    }

    // No srflx candidates at all → likely symmetric (only relay works)
    if (analysis.srflxCount === 0) {
      if (analysis.relayCount > 0) {
        return 'symmetric';
      }
      return 'unknown';
    }

    // Multiple srflx with same port → consistent mapping → full-cone or restricted
    if (analysis.srflxPorts.size === 1 && analysis.srflxCount > 1) {
      return 'full-cone';
    }

    // Multiple srflx with different ports → port-dependent mapping
    if (analysis.srflxPorts.size > 1 && analysis.srflxPorts.size < analysis.srflxCount) {
      return 'port-restricted';
    }

    // Each srflx has a unique port → symmetric-like behavior
    if (analysis.srflxPorts.size === analysis.srflxCount && analysis.srflxCount > 1) {
      return 'symmetric';
    }

    // Single srflx → can't distinguish, assume restricted
    if (analysis.srflxCount === 1) {
      return 'restricted';
    }

    return 'unknown';
  }

  private isPrivateIP(ip: string): boolean {
    // IPv4 private ranges
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('172.')) {
      const second = parseInt(ip.split('.')[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('169.254.')) return true; // link-local
    if (ip.startsWith('127.')) return true; // loopback
    // IPv6 private
    if (ip.startsWith('fe80:')) return true; // link-local
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA
    if (ip === '::1') return true; // loopback
    return false;
  }
}
