import { describe, it, expect } from 'vitest';
import { roomDisplayName } from '../../src/utils/roomDisplayName';

describe('roomDisplayName', () => {
  it('uses the custom room name when present', () => {
    expect(roomDisplayName({ roomName: '家庭聚餐群', roomId: 'a3f9c2e1-xxxx' })).toBe('家庭聚餐群');
  });

  it('falls back to truncated id when no name', () => {
    expect(roomDisplayName({ roomId: 'a3f9c2e1abcd' })).toBe('房間 a3f9c2e1');
  });

  it('falls back when room name is only whitespace', () => {
    expect(roomDisplayName({ roomName: '   ', roomId: 'a3f9c2e1abcd' })).toBe('房間 a3f9c2e1');
  });

  it('trims surrounding whitespace from a real name', () => {
    expect(roomDisplayName({ roomName: '  專案討論  ', roomId: 'x' })).toBe('專案討論');
  });

  it('handles a missing id gracefully', () => {
    expect(roomDisplayName({})).toBe('房間 ');
  });
});
