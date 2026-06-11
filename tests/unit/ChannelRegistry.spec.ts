import { describe, it, expect } from 'vitest';
import { ChannelRegistry } from '../../src/core/community/ChannelRegistry';
import { RolePermissionManager } from '../../src/core/community/RolePermissionManager';
import type { CommunityEvent } from '../../src/core/community/types';

function createRegistry(): { registry: ChannelRegistry; events: CommunityEvent[] } {
  const permissions = new RolePermissionManager();
  const registry = new ChannelRegistry('test-community', permissions);
  const events: CommunityEvent[] = [];
  registry.onEvent((e) => events.push(e));
  return { registry, events };
}

describe('ChannelRegistry', () => {
  it('creates a text channel', () => {
    const { registry } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'general');
    expect(ch.name).toBe('general');
    expect(ch.type).toBe('text');
    expect(ch.roomId).toBeTruthy();
    expect(ch.archived).toBe(false);
  });

  it('creates an announcement channel', () => {
    const { registry } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'news', 'announcement');
    expect(ch.type).toBe('announcement');
  });

  it('rejects duplicate channel names', () => {
    const { registry } = createRegistry();
    registry.createChannel('admin1', 'admin', 'general');
    expect(() => registry.createChannel('admin1', 'admin', 'general')).toThrow('already exists');
  });

  it('allows reusing archived channel names', () => {
    const { registry } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'old-channel');
    registry.archiveChannel('admin1', 'admin', ch.channelId);
    // Should not throw — name is available again
    const ch2 = registry.createChannel('admin1', 'admin', 'old-channel');
    expect(ch2.channelId).not.toBe(ch.channelId);
  });

  it('denies channel creation for insufficient role', () => {
    const { registry } = createRegistry();
    expect(() => registry.createChannel('user1', 'member', 'general')).toThrow('Permission denied');
  });

  it('deletes a channel', () => {
    const { registry, events } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'temp');
    registry.deleteChannel('admin1', 'admin', ch.channelId);
    expect(registry.getChannel(ch.channelId)).toBeUndefined();
    expect(events.some(e => e.type === 'channel:deleted')).toBe(true);
  });

  it('archives a channel', () => {
    const { registry } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'archive-me');
    registry.archiveChannel('admin1', 'admin', ch.channelId);
    expect(registry.getChannel(ch.channelId)?.archived).toBe(true);
    // Should not appear in active channels
    expect(registry.getAllChannels().find(c => c.channelId === ch.channelId)).toBeUndefined();
    // Should appear in archived
    expect(registry.getArchivedChannels()).toHaveLength(1);
  });

  it('renames a channel', () => {
    const { registry } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'old-name');
    registry.renameChannel('mod1', 'moderator', ch.channelId, 'new-name');
    expect(registry.getChannel(ch.channelId)?.name).toBe('new-name');
  });

  it('rejects rename to existing name', () => {
    const { registry } = createRegistry();
    registry.createChannel('admin1', 'admin', 'channel-a');
    const ch2 = registry.createChannel('admin1', 'admin', 'channel-b');
    expect(() => registry.renameChannel('admin1', 'admin', ch2.channelId, 'channel-a')).toThrow('already exists');
  });

  it('canSendMessage returns true for text channels', () => {
    const { registry } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'general');
    expect(registry.canSendMessage('guest', ch.channelId)).toBe(true);
    expect(registry.canSendMessage('member', ch.channelId)).toBe(true);
  });

  it('canSendMessage restricts announcement channels', () => {
    const { registry } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'news', 'announcement');
    // Announcement requires moderator+
    expect(registry.canSendMessage('member', ch.channelId)).toBe(false);
    expect(registry.canSendMessage('moderator', ch.channelId)).toBe(true);
    expect(registry.canSendMessage('admin', ch.channelId)).toBe(true);
  });

  it('canSendMessage returns false for archived channels', () => {
    const { registry } = createRegistry();
    const ch = registry.createChannel('admin1', 'admin', 'old');
    registry.archiveChannel('admin1', 'admin', ch.channelId);
    expect(registry.canSendMessage('owner', ch.channelId)).toBe(false);
  });

  it('getChannelsByType filters correctly', () => {
    const { registry } = createRegistry();
    registry.createChannel('admin1', 'admin', 'general');
    registry.createChannel('admin1', 'admin', 'news', 'announcement');
    registry.createChannel('admin1', 'admin', 'random');
    expect(registry.getChannelsByType('text')).toHaveLength(2);
    expect(registry.getChannelsByType('announcement')).toHaveLength(1);
  });

  it('getChannelByName finds active channel', () => {
    const { registry } = createRegistry();
    registry.createChannel('admin1', 'admin', 'general');
    expect(registry.getChannelByName('general')).toBeTruthy();
    expect(registry.getChannelByName('nonexistent')).toBeUndefined();
  });

  it('getChannelOrThrow throws for missing channel', () => {
    const { registry } = createRegistry();
    expect(() => registry.getChannelOrThrow('no-such-id')).toThrow('not found');
  });

  it('emits events on create', () => {
    const { registry, events } = createRegistry();
    registry.createChannel('admin1', 'admin', 'new-ch');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('channel:created');
    expect(events[0].data?.name).toBe('new-ch');
  });
});
