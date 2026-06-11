import { describe, it, expect } from 'vitest';
import { MembershipService } from '../../src/core/community/MembershipService';
import { RolePermissionManager } from '../../src/core/community/RolePermissionManager';
import type { CommunityInfo, CommunityEvent } from '../../src/core/community/types';

function createTestCommunity(
  overrides: Partial<CommunityInfo> = {}
): { membership: MembershipService; events: CommunityEvent[] } {
  const info: CommunityInfo = {
    communityId: 'test-community',
    name: 'Test Community',
    description: '',
    ownerId: 'owner1',
    createdAt: Date.now(),
    joinPolicy: 'open',
    requiredVouches: 1,
    permissionOverrides: {},
    ...overrides,
  };
  const permissions = new RolePermissionManager(info.permissionOverrides);
  const membership = new MembershipService(info, permissions);
  const events: CommunityEvent[] = [];
  membership.onEvent((e) => events.push(e));
  membership.addFounder('owner1', 'Owner');
  return { membership, events };
}

describe('MembershipService', () => {
  // ── Join / Leave ─────────────────────────────────────────────────────

  it('allows joining an open community', () => {
    const { membership } = createTestCommunity();
    const member = membership.join('user2', 'Alice');
    expect(member.role).toBe('member');
    expect(membership.getMemberCount()).toBe(2);
  });

  it('rejects joining an invite-only community', () => {
    const { membership } = createTestCommunity({ joinPolicy: 'invite-only' });
    expect(() => membership.join('user2', 'Alice')).toThrow('invite-only');
  });

  it('rejects duplicate join', () => {
    const { membership } = createTestCommunity();
    membership.join('user2', 'Alice');
    expect(() => membership.join('user2', 'Alice')).toThrow('Already a member');
  });

  it('allows leaving', () => {
    const { membership, events } = createTestCommunity();
    membership.join('user2', 'Alice');
    membership.leave('user2');
    expect(membership.isMember('user2')).toBe(false);
    expect(events.some(e => e.type === 'member:left')).toBe(true);
  });

  it('owner cannot leave', () => {
    const { membership } = createTestCommunity();
    expect(() => membership.leave('owner1')).toThrow('Owner cannot leave');
  });

  // ── Invite / Vouch ──────────────────────────────────────────────────

  it('invite admits immediately when requiredVouches = 1', () => {
    const { membership } = createTestCommunity({ joinPolicy: 'invite-only', requiredVouches: 1 });
    const result = membership.invite('owner1', 'user2', 'Alice');
    expect(result.admitted).toBe(true);
    expect(membership.isMember('user2')).toBe(true);
  });

  it('invite requires multiple vouches when configured', () => {
    // Use multi-vouch community with 2 founders to have 2 vouchers
    const info: CommunityInfo = {
      communityId: 'c1', name: 'C1', description: '', ownerId: 'owner1',
      createdAt: Date.now(), joinPolicy: 'invite-only', requiredVouches: 2,
      permissionOverrides: {},
    };
    const permissions = new RolePermissionManager();
    const svc = new MembershipService(info, permissions);
    svc.addFounder('owner1', 'Owner');
    svc.addFounder('member2', 'Member2');

    // First vouch — not yet admitted
    const r1 = svc.invite('owner1', 'newUser', 'New');
    expect(r1.admitted).toBe(false);
    expect(r1.vouchesReceived).toBe(1);

    // Second vouch — now admitted
    const r2 = svc.invite('member2', 'newUser', 'New');
    expect(r2.admitted).toBe(true);
    expect(svc.isMember('newUser')).toBe(true);
  });

  it('multi-vouch invite flow works', () => {
    const info: CommunityInfo = {
      communityId: 'c1', name: 'C1', description: '', ownerId: 'owner1',
      createdAt: Date.now(), joinPolicy: 'invite-only', requiredVouches: 2,
      permissionOverrides: {},
    };
    const permissions = new RolePermissionManager();
    const svc = new MembershipService(info, permissions);
    svc.addFounder('owner1', 'Owner');

    // Manually add a second existing member for vouching
    svc.addFounder('member2', 'Member2'); // hack: addFounder doesn't check uniqueness semantics

    // First vouch
    const r1 = svc.invite('owner1', 'newUser', 'New');
    expect(r1.admitted).toBe(false);
    expect(r1.vouchesReceived).toBe(1);
    expect(r1.vouchesRequired).toBe(2);

    // Second vouch — should admit
    const r2 = svc.invite('member2', 'newUser', 'New');
    expect(r2.admitted).toBe(true);
    expect(r2.vouchesReceived).toBe(2);
    expect(svc.isMember('newUser')).toBe(true);
  });

  // ── Kick / Ban ──────────────────────────────────────────────────────

  it('moderator can kick member', () => {
    const { membership } = createTestCommunity();
    membership.join('mod1', 'Mod');
    membership.join('user2', 'Alice');
    // Promote mod1
    membership.changeRole('owner1', 'mod1', 'moderator');
    membership.kick('mod1', 'user2');
    expect(membership.isMember('user2')).toBe(false);
  });

  it('member cannot kick another member', () => {
    const { membership } = createTestCommunity();
    membership.join('user2', 'Alice');
    membership.join('user3', 'Bob');
    expect(() => membership.kick('user2', 'user3')).toThrow('Permission denied');
  });

  it('cannot kick a higher-ranked member', () => {
    const { membership } = createTestCommunity();
    membership.join('mod1', 'Mod');
    membership.changeRole('owner1', 'mod1', 'moderator');
    expect(() => membership.kick('mod1', 'owner1')).toThrow('equal or higher role');
  });

  it('ban prevents rejoin', () => {
    const { membership } = createTestCommunity();
    membership.join('user2', 'Alice');
    membership.ban('owner1', 'user2');
    expect(membership.isBanned('user2')).toBe(true);
    expect(() => membership.join('user2', 'Alice')).toThrow('banned');
  });

  // ── Role changes ───────────────────────────────────────────────────

  it('admin can promote member to moderator', () => {
    const { membership } = createTestCommunity();
    membership.join('admin1', 'Admin');
    membership.changeRole('owner1', 'admin1', 'admin');
    membership.join('user2', 'Alice');
    membership.changeRole('admin1', 'user2', 'moderator');
    expect(membership.getMember('user2')?.role).toBe('moderator');
  });

  it('cannot promote to equal or higher role', () => {
    const { membership } = createTestCommunity();
    membership.join('admin1', 'Admin');
    membership.changeRole('owner1', 'admin1', 'admin');
    membership.join('user2', 'Alice');
    expect(() => membership.changeRole('admin1', 'user2', 'admin')).toThrow('equal to or higher');
  });

  it('cannot set owner role via changeRole', () => {
    const { membership } = createTestCommunity();
    membership.join('user2', 'Alice');
    expect(() => membership.changeRole('owner1', 'user2', 'owner')).toThrow('transferOwnership');
  });

  // ── Ownership transfer ─────────────────────────────────────────────

  it('transfers ownership correctly', () => {
    const { membership } = createTestCommunity();
    membership.join('user2', 'Alice');
    membership.transferOwnership('owner1', 'user2');
    expect(membership.getMember('user2')?.role).toBe('owner');
    expect(membership.getMember('owner1')?.role).toBe('admin');
  });

  it('non-owner cannot transfer ownership', () => {
    const { membership } = createTestCommunity();
    membership.join('user2', 'Alice');
    expect(() => membership.transferOwnership('user2', 'owner1')).toThrow('Only the owner');
  });

  // ── Queries ────────────────────────────────────────────────────────

  it('getMembersByRole filters correctly', () => {
    const { membership } = createTestCommunity();
    membership.join('user2', 'Alice');
    membership.join('user3', 'Bob');
    membership.changeRole('owner1', 'user2', 'moderator');
    expect(membership.getMembersByRole('moderator')).toHaveLength(1);
    expect(membership.getMembersByRole('member')).toHaveLength(1);
    expect(membership.getMembersByRole('owner')).toHaveLength(1);
  });

  it('events are emitted correctly', () => {
    const { membership, events } = createTestCommunity();
    membership.join('user2', 'Alice');
    membership.leave('user2');
    expect(events).toHaveLength(2); // joined + left
    expect(events[0].type).toBe('member:joined');
    expect(events[1].type).toBe('member:left');
  });

  it('getPendingVouches returns correct counts', () => {
    const info: CommunityInfo = {
      communityId: 'c1', name: 'C1', description: '', ownerId: 'owner1',
      createdAt: Date.now(), joinPolicy: 'invite-only', requiredVouches: 3,
      permissionOverrides: {},
    };
    const svc = new MembershipService(info, new RolePermissionManager());
    svc.addFounder('owner1', 'Owner');
    svc.invite('owner1', 'pending1', 'P1');
    const status = svc.getPendingVouches('pending1');
    expect(status.received).toBe(1);
    expect(status.required).toBe(3);
  });
});
