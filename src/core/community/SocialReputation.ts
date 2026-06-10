/**
 * SocialReputation — Dual-Layer Reputation System
 *
 * Extends network-level PeerScoring with a social reputation layer
 * derived from community behavior:
 *
 *   Network Reputation (PeerScoring):  delivery rate, mesh presence, etc.
 *   Social Reputation (this module):   reports, governance, helpfulness
 *
 * The combined score is used for:
 *   - Trust-weighted governance voting (future)
 *   - Relay node selection priority
 *   - Content visibility/prioritization
 *   - Community standing display
 *
 * Score range: -100 (toxic) to +100 (exemplary)
 */

import type { SocialReputationScore } from './types';
import type { ReportSystem } from './ReportSystem';
import type { GovernanceVoting } from './GovernanceVoting';
import type { PeerScoring } from '../relay/PeerScoring';

/** Weights for social reputation factors */
export interface SocialScoringWeights {
  /** Penalty per confirmed report against the user */
  confirmedReportPenalty: number;
  /** Penalty per unconfirmed report (lighter) */
  unconfirmedReportPenalty: number;
  /** Bonus for governance participation */
  governanceParticipationBonus: number;
  /** Bonus for filing helpful reports */
  helpfulReportBonus: number;
}

const DEFAULT_WEIGHTS: SocialScoringWeights = {
  confirmedReportPenalty: 20,
  unconfirmedReportPenalty: 3,
  governanceParticipationBonus: 30,
  helpfulReportBonus: 5,
};

/** Weights for combining network + social scores */
export interface DualLayerWeights {
  /** Weight for network reputation (0-1) */
  network: number;
  /** Weight for social reputation (0-1) */
  social: number;
}

const DEFAULT_DUAL_WEIGHTS: DualLayerWeights = {
  network: 0.5,
  social: 0.5,
};

export class SocialReputation {
  private scores = new Map<string, SocialReputationScore>();
  private weights: SocialScoringWeights;
  private dualWeights: DualLayerWeights;
  private reportSystem: ReportSystem;
  private governance: GovernanceVoting;
  private peerScoring: PeerScoring | null;

  constructor(
    reportSystem: ReportSystem,
    governance: GovernanceVoting,
    peerScoring: PeerScoring | null = null,
    weights: Partial<SocialScoringWeights> = {},
    dualWeights: Partial<DualLayerWeights> = {}
  ) {
    this.reportSystem = reportSystem;
    this.governance = governance;
    this.peerScoring = peerScoring;
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.dualWeights = { ...DEFAULT_DUAL_WEIGHTS, ...dualWeights };
  }

  /**
   * Recompute social reputation for a user based on current data.
   */
  recompute(userId: string): SocialReputationScore {
    const reportStats = this.reportSystem.getUserReportStats(userId);
    const govStats = this.governance.getUserParticipation(userId);

    // Governance participation rate (0-1)
    const participationRate = govStats.eligibleProposals > 0
      ? govStats.votescast / govStats.eligibleProposals
      : 0;

    // Compute social score
    const w = this.weights;
    const bonus =
      participationRate * w.governanceParticipationBonus +
      reportStats.reportsFiledThatHelped * w.helpfulReportBonus;

    const penalty =
      reportStats.confirmedReportsAgainst * w.confirmedReportPenalty +
      (reportStats.reportsAgainst - reportStats.confirmedReportsAgainst) * w.unconfirmedReportPenalty;

    const rawScore = bonus - penalty;
    const socialScore = Math.max(-100, Math.min(100, rawScore));

    const score: SocialReputationScore = {
      userId,
      reportCount: reportStats.reportsAgainst,
      confirmedReportCount: reportStats.confirmedReportsAgainst,
      governanceParticipation: participationRate,
      helpfulReportCount: reportStats.reportsFiledThatHelped,
      socialScore,
      lastUpdated: Date.now(),
    };

    this.scores.set(userId, score);
    return score;
  }

  /**
   * Get the social reputation score for a user.
   * Recomputes if stale (> 5 min) or not yet computed.
   */
  getSocialScore(userId: string): SocialReputationScore {
    const existing = this.scores.get(userId);
    const staleMs = 5 * 60 * 1000;

    if (!existing || Date.now() - existing.lastUpdated > staleMs) {
      return this.recompute(userId);
    }

    return existing;
  }

  /**
   * Get the combined dual-layer reputation score.
   * Network score from PeerScoring + Social score from this module.
   */
  getCombinedScore(userId: string): {
    networkScore: number;
    socialScore: number;
    combinedScore: number;
  } {
    const social = this.getSocialScore(userId);
    const networkScore = this.peerScoring?.getScore(userId) ?? 0;
    const combinedScore =
      networkScore * this.dualWeights.network +
      social.socialScore * this.dualWeights.social;

    return {
      networkScore,
      socialScore: social.socialScore,
      combinedScore: Math.max(-100, Math.min(100, combinedScore)),
    };
  }

  /**
   * Get all users ranked by combined score.
   */
  getRankedUsers(userIds: string[]): Array<{
    userId: string;
    networkScore: number;
    socialScore: number;
    combinedScore: number;
  }> {
    return userIds
      .map(userId => ({
        userId,
        ...this.getCombinedScore(userId),
      }))
      .sort((a, b) => b.combinedScore - a.combinedScore);
  }

  /**
   * Check if a user's social standing is "good" (score > 0).
   */
  isInGoodStanding(userId: string): boolean {
    const score = this.getSocialScore(userId);
    return score.socialScore > 0;
  }

  /**
   * Recompute all tracked users.
   */
  recomputeAll(): void {
    for (const userId of this.scores.keys()) {
      this.recompute(userId);
    }
  }

  /** Connect or update the PeerScoring reference */
  setPeerScoring(peerScoring: PeerScoring): void {
    this.peerScoring = peerScoring;
  }

  /** Get raw social reputation data */
  getRawScore(userId: string): SocialReputationScore | undefined {
    return this.scores.get(userId);
  }
}
