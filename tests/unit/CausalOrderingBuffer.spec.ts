import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CausalOrderingBuffer } from '../../src/core/ordering/CausalOrderingBuffer';
import type { CausalMessage } from '../../src/types';

function makeMsg(
  id: string,
  deps: string[] = [],
  timestamp = Date.now()
): CausalMessage {
  return {
    messageId: id,
    from: 'user-a',
    content: `msg-${id}`,
    timestamp,
    deps,
  };
}

describe('CausalOrderingBuffer', () => {
  let buffer: CausalOrderingBuffer;
  let delivered: { msg: CausalMessage; forced: boolean }[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

    buffer = new CausalOrderingBuffer();
    delivered = [];
    buffer.onDeliver((msg, forced) => {
      delivered.push({ msg, forced });
    });
  });

  afterEach(() => {
    buffer.destroy();
    vi.useRealTimers();
  });

  it('should deliver immediately when no deps', () => {
    const msg = makeMsg('m1');
    buffer.receive(msg);

    expect(delivered.length).toBe(1);
    expect(delivered[0].msg.messageId).toBe('m1');
    expect(delivered[0].forced).toBe(false);
  });

  it('should deliver immediately when all deps are satisfied', () => {
    buffer.receive(makeMsg('m1')); // deliver m1
    buffer.receive(makeMsg('m2', ['m1'])); // dep satisfied → deliver

    expect(delivered.length).toBe(2);
    expect(delivered[1].msg.messageId).toBe('m2');
  });

  it('should buffer when deps are missing', () => {
    // m2 depends on m1, but m1 hasn't arrived yet
    buffer.receive(makeMsg('m2', ['m1']));

    expect(delivered.length).toBe(0);
    expect(buffer.pendingCount).toBe(1);
  });

  it('should deliver buffered message when dep arrives', () => {
    buffer.receive(makeMsg('m2', ['m1'])); // buffered
    expect(delivered.length).toBe(0);

    buffer.receive(makeMsg('m1')); // deliver m1 → triggers m2 delivery
    expect(delivered.length).toBe(2);
    expect(delivered[0].msg.messageId).toBe('m1');
    expect(delivered[1].msg.messageId).toBe('m2');
  });

  it('should handle chain of dependencies', () => {
    buffer.receive(makeMsg('m3', ['m2'])); // buffered
    buffer.receive(makeMsg('m2', ['m1'])); // buffered
    expect(delivered.length).toBe(0);

    buffer.receive(makeMsg('m1')); // delivers m1 → m2 → m3
    expect(delivered.length).toBe(3);
    expect(delivered.map((d) => d.msg.messageId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('should force-deliver after 5 second timeout', () => {
    buffer.receive(makeMsg('m2', ['m1-never-arrives']));
    expect(delivered.length).toBe(0);

    vi.advanceTimersByTime(6_000); // past 5s timeout

    expect(delivered.length).toBe(1);
    expect(delivered[0].msg.messageId).toBe('m2');
    expect(delivered[0].forced).toBe(true);
  });

  it('should not deliver the same message twice', () => {
    const msg = makeMsg('m1');
    buffer.receive(msg);
    buffer.receive(msg); // duplicate

    expect(delivered.length).toBe(1);
  });

  it('should handle multiple deps correctly', () => {
    buffer.receive(makeMsg('m3', ['m1', 'm2'])); // needs both
    expect(delivered.length).toBe(0);

    buffer.receive(makeMsg('m1')); // only one dep satisfied
    expect(delivered.length).toBe(1); // only m1 delivered

    buffer.receive(makeMsg('m2')); // now both satisfied
    expect(delivered.length).toBe(3); // m1, m2, m3
  });

  it('should handle empty deps array', () => {
    buffer.receive(makeMsg('m1', []));
    expect(delivered.length).toBe(1);
  });

  it('pendingCount should reflect buffer state', () => {
    expect(buffer.pendingCount).toBe(0);
    buffer.receive(makeMsg('m2', ['m1']));
    expect(buffer.pendingCount).toBe(1);
    buffer.receive(makeMsg('m1'));
    expect(buffer.pendingCount).toBe(0);
  });

  it('destroy should clean up', () => {
    buffer.receive(makeMsg('m2', ['m1']));
    buffer.destroy();
    expect(buffer.pendingCount).toBe(0);
  });
});
