import { describe, it, expect, beforeEach } from 'vitest';
import { CommunityManager } from '../../src/core/community/CommunityManager';
import type { CommunityEvent } from '../../src/core/community/types';

describe('ReportSystem', () => {
  let mgr: CommunityManager;
  let events: CommunityEvent[];

  beforeEach(() => {
    mgr = CommunityManager.create('Test Community', 'owner1', 'Owner', {
      reportConfig: {
        requiredVotes: 3,
        approvalThreshold: 0.6,
        reportCooldownMs: 1000, // short cooldown for tests
      },
    });
    events = [];
    mgr.onEvent((e) => events.push(e));

    // Add members: 1 admin, 3 moderators, 2 regular members
    mgr.joinCommunity('admin1', 'Admin');
    mgr.changeRole('owner1', 'admin1', 'admin');
    mgr.joinCommunity('mod1', 'Mod1');
    mgr.changeRole('owner1', 'mod1', 'moderator');
    mgr.joinCommunity('mod2', 'Mod2');
    mgr.changeRole('owner1', 'mod2', 'moderator');
    mgr.joinCommunity('mod3', 'Mod3');
    mgr.changeRole('owner1', 'mod3', 'moderator');
    mgr.joinCommunity('user1', 'User1');
    mgr.joinCommunity('user2', 'User2');
    events.length = 0;
  });

  // ── Filing Reports ────────────────────────────────────────────────

  it('allows a member to file a report', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming in general');
    expect(report.reportId).toBeTruthy();
    expect(report.targetId).toBe('user2');
    expect(report.reporterId).toBe('user1');
    expect(report.reason).toBe('spam');
    expect(report.status).toBe('pending');
  });

  it('emits report:created event', () => {
    mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    const evt = events.find(e => e.type === 'report:created');
    expect(evt).toBeTruthy();
    expect(evt!.actorId).toBe('user1');
    expect(evt!.targetId).toBe('user2');
  });

  it('rejects self-report', () => {
    expect(() => mgr.fileReport('user1', 'user1', 'spam', 'test'))
      .toThrow('Cannot report yourself');
  });

  it('rejects report from non-member', () => {
    expect(() => mgr.fileReport('stranger', 'user2', 'spam', 'test'))
      .toThrow(/not a member/);
  });

  it('rejects report against non-member', () => {
    expect(() => mgr.fileReport('user1', 'stranger', 'spam', 'test'))
      .toThrow(/not a member/);
  });

  it('enforces report cooldown', () => {
    mgr.fileReport('user1', 'user2', 'spam', 'first report');
    expect(() => mgr.fileReport('user1', 'user2', 'spam', 'second report'))
      .toThrow(/cooldown/);
  });

  // ── Moderator Voting ──────────────────────────────────────────────

  it('allows moderators to vote on reports', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    const result = mgr.castReportVote('mod1', report.reportId, 'approve', 'warn', 'First offense');
    expect(result).toBeNull(); // not enough votes yet

    const votes = mgr.reports.getVotesForReport(report.reportId);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.moderatorId).toBe('mod1');
  });

  it('rejects vote from regular member', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    expect(() => mgr.castReportVote('user1', report.reportId, 'approve', 'warn'))
      .toThrow(/requires role/);
  });

  it('rejects duplicate vote', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'warn');
    expect(() => mgr.castReportVote('mod1', report.reportId, 'approve', 'warn'))
      .toThrow('Already voted');
  });

  it('rejects vote on report about yourself', () => {
    const report = mgr.fileReport('user1', 'mod1', 'spam', 'Spamming');
    expect(() => mgr.castReportVote('mod1', report.reportId, 'approve', 'warn'))
      .toThrow('Cannot vote on a report about yourself');
  });

  // ── Resolution ────────────────────────────────────────────────────

  it('resolves a report when enough approve votes are cast (3/3 approve)', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'kick');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'kick');
    const resolution = mgr.castReportVote('mod3', report.reportId, 'approve', 'kick');

    expect(resolution).toBeTruthy();
    expect(resolution!.action).toBe('kick');
    expect(resolution!.votes).toHaveLength(3);

    // Check report status updated
    const updated = mgr.reports.getReport(report.reportId);
    expect(updated!.status).toBe('resolved');
    expect(updated!.resolvedAction).toBe('kick');
  });

  it('dismisses when majority rejects', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'reject', 'dismiss');
    mgr.castReportVote('mod2', report.reportId, 'reject', 'dismiss');
    const resolution = mgr.castReportVote('mod3', report.reportId, 'approve', 'kick');

    expect(resolution).toBeTruthy();
    expect(resolution!.action).toBe('dismiss');

    const updated = mgr.reports.getReport(report.reportId);
    expect(updated!.status).toBe('dismissed');
  });

  it('executes kick action on resolution', () => {
    const report = mgr.fileReport('user1', 'user2', 'harassment', 'Harassing');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'kick');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'kick');
    mgr.castReportVote('mod3', report.reportId, 'approve', 'kick');

    // user2 should be kicked
    expect(mgr.membership.isMember('user2')).toBe(false);
  });

  it('executes ban action on resolution', () => {
    const report = mgr.fileReport('user1', 'user2', 'hate-speech', 'Hate speech');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'ban');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'ban');
    mgr.castReportVote('mod3', report.reportId, 'approve', 'ban');

    expect(mgr.membership.isMember('user2')).toBe(false);
    expect(mgr.membership.isBanned('user2')).toBe(true);
  });

  it('picks most popular action among approvals', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'warn');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'kick');
    const resolution = mgr.castReportVote('mod3', report.reportId, 'approve', 'warn');

    // warn: 2 votes, kick: 1 vote → warn wins
    expect(resolution!.action).toBe('warn');
  });

  it('emits report:resolved event', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'warn');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'warn');
    mgr.castReportVote('mod3', report.reportId, 'approve', 'warn');

    const resolved = events.find(e => e.type === 'report:resolved');
    expect(resolved).toBeTruthy();
    expect(resolved!.data!.action).toBe('warn');
  });

  // ── Queries ───────────────────────────────────────────────────────

  it('returns pending reports', () => {
    mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    const pending = mgr.reports.getPendingReports();
    expect(pending).toHaveLength(1);
  });

  it('returns reports by target', () => {
    mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    const reports = mgr.reports.getReportsByTarget('user2');
    expect(reports).toHaveLength(1);
  });

  it('returns eligible voter count', () => {
    // owner + admin + 3 moderators = 5 eligible voters
    const count = mgr.reports.getEligibleVoterCount();
    expect(count).toBe(5);
  });

  it('returns user report stats', () => {
    const report = mgr.fileReport('user1', 'user2', 'spam', 'Spamming');
    mgr.castReportVote('mod1', report.reportId, 'approve', 'warn');
    mgr.castReportVote('mod2', report.reportId, 'approve', 'warn');
    mgr.castReportVote('mod3', report.reportId, 'approve', 'warn');

    const stats = mgr.reports.getUserReportStats('user2');
    expect(stats.reportsAgainst).toBe(1);
    expect(stats.confirmedReportsAgainst).toBe(1);

    const reporterStats = mgr.reports.getUserReportStats('user1');
    expect(reporterStats.reportsFiledThatHelped).toBe(1);
  });

  // ── Prune Expired ─────────────────────────────────────────────────

  it('prunes expired reports', async () => {
    const shortTTL = CommunityManager.create('Test', 'o', 'O', {
      reportConfig: { reportTTLMs: 1, requiredVotes: 3, approvalThreshold: 0.6, reportCooldownMs: 0 },
    });
    shortTTL.joinCommunity('a', 'A');
    shortTTL.joinCommunity('b', 'B');
    shortTTL.fileReport('a', 'b', 'spam', 'test');

    // Wait for expiry (TTL = 1ms)
    await new Promise(r => setTimeout(r, 10));
    const pruned = shortTTL.reports.pruneExpired();
    expect(pruned).toBe(1);
  });
});
