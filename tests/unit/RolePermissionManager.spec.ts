import { describe, it, expect } from 'vitest';
import { RolePermissionManager } from '../../src/core/community/RolePermissionManager';
import type { CommunityRole, PermissionAction } from '../../src/core/community/types';

describe('RolePermissionManager', () => {
  it('grants owner all permissions', () => {
    const pm = new RolePermissionManager();
    const actions: PermissionAction[] = [
      'channel:create', 'channel:delete', 'member:kick',
      'member:ban', 'community:delete', 'message:send',
    ];
    for (const action of actions) {
      expect(pm.can('owner', action)).toBe(true);
    }
  });

  it('denies guest most actions except message:send', () => {
    const pm = new RolePermissionManager();
    expect(pm.can('guest', 'message:send')).toBe(true);
    expect(pm.can('guest', 'channel:create')).toBe(false);
    expect(pm.can('guest', 'member:kick')).toBe(false);
    expect(pm.can('guest', 'community:delete')).toBe(false);
  });

  it('member can invite but not kick', () => {
    const pm = new RolePermissionManager();
    expect(pm.can('member', 'member:invite')).toBe(true);
    expect(pm.can('member', 'member:kick')).toBe(false);
  });

  it('moderator can kick but not ban', () => {
    const pm = new RolePermissionManager();
    expect(pm.can('moderator', 'member:kick')).toBe(true);
    expect(pm.can('moderator', 'member:ban')).toBe(false);
  });

  it('admin can ban and create channels', () => {
    const pm = new RolePermissionManager();
    expect(pm.can('admin', 'member:ban')).toBe(true);
    expect(pm.can('admin', 'channel:create')).toBe(true);
    expect(pm.can('admin', 'community:delete')).toBe(false);
  });

  it('assert throws on denied permission', () => {
    const pm = new RolePermissionManager();
    expect(() => pm.assert('guest', 'channel:create')).toThrow('Permission denied');
  });

  it('assert does not throw on allowed permission', () => {
    const pm = new RolePermissionManager();
    expect(() => pm.assert('owner', 'community:delete')).not.toThrow();
  });

  it('outranks checks strict hierarchy', () => {
    const pm = new RolePermissionManager();
    expect(pm.outranks('admin', 'member')).toBe(true);
    expect(pm.outranks('member', 'member')).toBe(false);
    expect(pm.outranks('guest', 'member')).toBe(false);
  });

  it('respects custom overrides', () => {
    const pm = new RolePermissionManager({ 'channel:create': 'member' });
    expect(pm.can('member', 'channel:create')).toBe(true);
    // default requires admin
    const defaultPm = new RolePermissionManager();
    expect(defaultPm.can('member', 'channel:create')).toBe(false);
  });

  it('setPermission updates policy at runtime', () => {
    const pm = new RolePermissionManager();
    expect(pm.can('guest', 'channel:create')).toBe(false);
    pm.setPermission('channel:create', 'guest');
    expect(pm.can('guest', 'channel:create')).toBe(true);
  });

  it('getPolicy returns a copy', () => {
    const pm = new RolePermissionManager();
    const policy = pm.getPolicy();
    policy['channel:create'] = 'guest';
    // Original should not be affected
    expect(pm.can('guest', 'channel:create')).toBe(false);
  });

  it('getRequiredRole returns minimum role', () => {
    const pm = new RolePermissionManager();
    expect(pm.getRequiredRole('community:delete')).toBe('owner');
    expect(pm.getRequiredRole('message:send')).toBe('guest');
  });

  it('validates all roles in hierarchy order', () => {
    const pm = new RolePermissionManager();
    const roles: CommunityRole[] = ['guest', 'member', 'moderator', 'admin', 'owner'];
    // Each role should be able to do everything the previous role can
    for (let i = 1; i < roles.length; i++) {
      const lower = roles[i - 1];
      const higher = roles[i];
      // If lower can do X, higher can too
      const actions: PermissionAction[] = ['message:send', 'member:invite', 'member:kick', 'member:ban', 'community:delete'];
      for (const action of actions) {
        if (pm.can(lower, action)) {
          expect(pm.can(higher, action)).toBe(true);
        }
      }
    }
  });
});
