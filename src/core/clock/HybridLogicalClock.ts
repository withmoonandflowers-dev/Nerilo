/**
 * Hybrid Logical Clock (HLC)
 *
 * Combines physical wall-clock time with a logical counter to provide
 * causally-consistent timestamps even under clock skew across peers.
 *
 * Based on: "Logical Physical Clocks and Consistent Snapshots in Globally
 * Distributed Databases" (Kulkarni et al., 2014)
 */

export interface HLCTimestamp {
  /** Wall-clock time in ms since epoch */
  wallTime: number;
  /** Logical counter for events at the same wallTime */
  logical: number;
  /** Node identifier (first 8 chars of userId hash), used as tiebreaker */
  nodeId: string;
}

/** Maximum allowed clock drift (1 minute). Reject remote timestamps beyond this. */
const MAX_DRIFT_MS = 60_000;

export class HybridLogicalClock {
  private wallTime = 0;
  private logical = 0;

  constructor(private readonly nodeId: string) {}

  /**
   * Generate a timestamp for a local event (e.g. sending a message).
   * Ensures monotonic advancement.
   */
  now(): HLCTimestamp {
    const physicalNow = Date.now();

    if (physicalNow > this.wallTime) {
      this.wallTime = physicalNow;
      this.logical = 0;
    } else {
      this.logical++;
    }

    return {
      wallTime: this.wallTime,
      logical: this.logical,
      nodeId: this.nodeId,
    };
  }

  /**
   * Update the clock upon receiving a remote timestamp.
   * Merges the remote timestamp with local state to maintain causal ordering.
   */
  receive(remote: HLCTimestamp): HLCTimestamp {
    const physicalNow = Date.now();

    // Guard against extreme clock drift — clamp remote wallTime
    if (remote.wallTime - physicalNow > MAX_DRIFT_MS) {
      remote = { ...remote, wallTime: physicalNow + MAX_DRIFT_MS };
    }

    const prevWallTime = this.wallTime;

    if (physicalNow > prevWallTime && physicalNow > remote.wallTime) {
      // Local physical clock is ahead of both — reset logical
      this.wallTime = physicalNow;
      this.logical = 0;
    } else if (remote.wallTime > prevWallTime) {
      // Remote is ahead of local
      this.wallTime = remote.wallTime;
      this.logical = remote.logical + 1;
    } else if (prevWallTime > remote.wallTime) {
      // Local was already ahead
      this.wallTime = prevWallTime;
      this.logical++;
    } else {
      // Same wallTime — take max logical + 1
      this.wallTime = prevWallTime; // or remote.wallTime, they're equal
      this.logical = Math.max(this.logical, remote.logical) + 1;
    }

    return {
      wallTime: this.wallTime,
      logical: this.logical,
      nodeId: this.nodeId,
    };
  }

  /**
   * Compare two HLC timestamps for total ordering.
   * Returns negative if a < b, positive if a > b, 0 if equal.
   */
  static compare(a: HLCTimestamp, b: HLCTimestamp): number {
    if (a.wallTime !== b.wallTime) return a.wallTime - b.wallTime;
    if (a.logical !== b.logical) return a.logical - b.logical;
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  }

  /**
   * Serialize an HLC timestamp to string: "{wallTime}-{logical}-{nodeId8}"
   */
  static toString(ts: HLCTimestamp): string {
    return `${ts.wallTime}-${ts.logical}-${ts.nodeId.slice(0, 8)}`;
  }

  /**
   * Deserialize an HLC timestamp from its string representation.
   */
  static fromString(s: string): HLCTimestamp {
    const parts = s.split('-');
    if (parts.length < 3) {
      throw new Error(`Invalid HLC string: "${s}"`);
    }
    return {
      wallTime: parseInt(parts[0], 10),
      logical: parseInt(parts[1], 10),
      nodeId: parts.slice(2).join('-'), // nodeId may contain dashes
    };
  }
}
