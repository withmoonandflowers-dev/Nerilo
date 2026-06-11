/**
 * RolePermissionManager
 *
 * Enforces role-based access control for community actions.
 * Each community can override the default permission policy.
 *
 * Role hierarchy: owner > admin > moderator > member > guest
 */

import type {
  CommunityRole,
  PermissionAction,
  PermissionPolicy,
} from './types';
import {
  ROLE_WEIGHT,
  DEFAULT_PERMISSION_POLICY,
} from './types';

export class RolePermissionManager {
  private policy: PermissionPolicy;

  constructor(overrides: Partial<PermissionPolicy> = {}) {
    this.policy = { ...DEFAULT_PERMISSION_POLICY, ...overrides };
  }

  /**
   * Check if a role has permission to perform an action.
   */
  can(role: CommunityRole, action: PermissionAction): boolean {
    const requiredRole = this.policy[action];
    if (!requiredRole) return false;
    return ROLE_WEIGHT[role] >= ROLE_WEIGHT[requiredRole];
  }

  /**
   * Assert permission — throws if denied.
   */
  assert(role: CommunityRole, action: PermissionAction): void {
    if (!this.can(role, action)) {
      throw new Error(
        `Permission denied: role "${role}" cannot perform "${action}" (requires "${this.policy[action]}")`
      );
    }
  }

  /**
   * Check if roleA outranks roleB (strictly higher).
   */
  outranks(roleA: CommunityRole, roleB: CommunityRole): boolean {
    return ROLE_WEIGHT[roleA] > ROLE_WEIGHT[roleB];
  }

  /**
   * Get the minimum role required for an action.
   */
  getRequiredRole(action: PermissionAction): CommunityRole {
    return this.policy[action];
  }

  /**
   * Update a permission policy entry.
   */
  setPermission(action: PermissionAction, minRole: CommunityRole): void {
    this.policy[action] = minRole;
  }

  /**
   * Get a snapshot of the current policy.
   */
  getPolicy(): PermissionPolicy {
    return { ...this.policy };
  }
}
