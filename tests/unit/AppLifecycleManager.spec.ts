/**
 * AppLifecycleManager 單元測試
 *
 * 驗證行動裝置背景/前景切換的處理邏輯：
 *  - visibilitychange 事件偵測
 *  - 離線時長計算
 *  - 重連閾值判斷
 *  - drain-inbox 事件觸發
 *  - online/offline 網路事件
 *  - freeze/resume Page Lifecycle API
 *  - 清理機制
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AppLifecycleManager,
  type LifecycleEvent,
} from '../../src/core/transport/AppLifecycleManager';

// ── Mock document/window ─────────────────────────────────────────────────

function createMockDoc(initialVisibility: DocumentVisibilityState = 'visible') {
  const handlers: Map<string, Set<Function>> = new Map();
  let visibilityState: DocumentVisibilityState = initialVisibility;

  return {
    get visibilityState() {
      return visibilityState;
    },
    set _visibilityState(v: DocumentVisibilityState) {
      visibilityState = v;
    },
    addEventListener(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    removeEventListener(event: string, handler: Function) {
      handlers.get(event)?.delete(handler);
    },
    /** 手動觸發事件 */
    fireEvent(event: string) {
      handlers.get(event)?.forEach((h) => h());
    },
    getHandlerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

function createMockWin() {
  const handlers: Map<string, Set<Function>> = new Map();

  return {
    navigator: { onLine: true },
    addEventListener(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    removeEventListener(event: string, handler: Function) {
      handlers.get(event)?.delete(handler);
    },
    fireEvent(event: string) {
      handlers.get(event)?.forEach((h) => h());
    },
    getHandlerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AppLifecycleManager', () => {
  let manager: AppLifecycleManager;
  let doc: ReturnType<typeof createMockDoc>;
  let win: ReturnType<typeof createMockWin>;

  beforeEach(() => {
    doc = createMockDoc();
    win = createMockWin();
    manager = new AppLifecycleManager();
    manager.start(doc as any, win as any);
  });

  // ── 初始狀態 ───────────────────────────────────────────────────────

  describe('initialization', () => {
    it('should start in active state when document is visible', () => {
      expect(manager.getState()).toBe('active');
      expect(manager.isBackground()).toBe(false);
    });

    it('should start in hidden state when document is hidden', () => {
      const hiddenDoc = createMockDoc('hidden');
      const m = new AppLifecycleManager();
      m.start(hiddenDoc as any, win as any);

      expect(m.getState()).toBe('hidden');
      expect(m.isBackground()).toBe(true);
      m.stop(hiddenDoc as any, win as any);
    });
  });

  // ── visibilitychange ───────────────────────────────────────────────

  describe('visibilitychange', () => {
    it('should transition to hidden when document becomes hidden', () => {
      const events: LifecycleEvent[] = [];
      manager.on('state-change', (e) => events.push(e));

      (doc as any)._visibilityState = 'hidden';
      doc.fireEvent('visibilitychange');

      expect(manager.getState()).toBe('hidden');
      expect(manager.isBackground()).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0].previousState).toBe('active');
      expect(events[0].currentState).toBe('hidden');
    });

    it('should transition back to active when document becomes visible', () => {
      // Go hidden
      (doc as any)._visibilityState = 'hidden';
      doc.fireEvent('visibilitychange');

      const events: LifecycleEvent[] = [];
      manager.on('state-change', (e) => events.push(e));

      // Go visible
      (doc as any)._visibilityState = 'visible';
      doc.fireEvent('visibilitychange');

      expect(manager.getState()).toBe('active');
      expect(events[0].previousState).toBe('hidden');
      expect(events[0].currentState).toBe('active');
      expect(events[0].offlineDurationMs).toBeDefined();
    });

    it('should calculate offline duration correctly', async () => {
      // Go hidden
      (doc as any)._visibilityState = 'hidden';
      doc.fireEvent('visibilitychange');

      // Wait
      await new Promise((r) => setTimeout(r, 50));

      const events: LifecycleEvent[] = [];
      manager.on('state-change', (e) => events.push(e));

      // Go visible
      (doc as any)._visibilityState = 'visible';
      doc.fireEvent('visibilitychange');

      expect(events[0].offlineDurationMs).toBeGreaterThanOrEqual(40);
    });

    it('should not emit duplicate events for same state', () => {
      const events: LifecycleEvent[] = [];
      manager.on('state-change', (e) => events.push(e));

      (doc as any)._visibilityState = 'visible';
      doc.fireEvent('visibilitychange'); // already active → no change

      expect(events).toHaveLength(0);
    });
  });

  // ── reconnect-needed ───────────────────────────────────────────────

  describe('reconnect-needed', () => {
    it('should fire reconnect-needed when offline duration exceeds threshold', async () => {
      const shortThreshold = new AppLifecycleManager({
        reconnectThresholdMs: 30,
      });
      shortThreshold.start(doc as any, win as any);

      const reconnectEvents: LifecycleEvent[] = [];
      shortThreshold.on('reconnect-needed', (e) => reconnectEvents.push(e));

      // Go hidden
      (doc as any)._visibilityState = 'hidden';
      doc.fireEvent('visibilitychange');

      await new Promise((r) => setTimeout(r, 50));

      // Go visible
      (doc as any)._visibilityState = 'visible';
      doc.fireEvent('visibilitychange');

      expect(reconnectEvents).toHaveLength(1);
      expect(reconnectEvents[0].offlineDurationMs).toBeGreaterThanOrEqual(30);

      shortThreshold.stop(doc as any, win as any);
    });

    it('should NOT fire reconnect-needed for short offline durations', async () => {
      const reconnectEvents: LifecycleEvent[] = [];
      manager.on('reconnect-needed', (e) => reconnectEvents.push(e));

      // Go hidden briefly
      (doc as any)._visibilityState = 'hidden';
      doc.fireEvent('visibilitychange');

      // Immediately go visible (< 60s default threshold)
      (doc as any)._visibilityState = 'visible';
      doc.fireEvent('visibilitychange');

      expect(reconnectEvents).toHaveLength(0);
    });
  });

  // ── drain-inbox ────────────────────────────────────────────────────

  describe('drain-inbox', () => {
    it('should fire drain-inbox when returning to active from any background state', () => {
      const drainEvents: LifecycleEvent[] = [];
      manager.on('drain-inbox', (e) => drainEvents.push(e));

      // Go hidden
      (doc as any)._visibilityState = 'hidden';
      doc.fireEvent('visibilitychange');

      // Go visible
      (doc as any)._visibilityState = 'visible';
      doc.fireEvent('visibilitychange');

      expect(drainEvents).toHaveLength(1);
    });

    it('should fire drain-inbox on freeze → resume', () => {
      const drainEvents: LifecycleEvent[] = [];
      manager.on('drain-inbox', (e) => drainEvents.push(e));

      // Freeze
      doc.fireEvent('freeze');
      expect(manager.getState()).toBe('frozen');

      // Resume
      doc.fireEvent('resume');
      expect(manager.getState()).toBe('active');

      expect(drainEvents).toHaveLength(1);
    });
  });

  // ── online/offline ─────────────────────────────────────────────────

  describe('network events', () => {
    it('should emit network event on online', () => {
      const networkEvents: LifecycleEvent[] = [];
      manager.on('network', (e) => networkEvents.push(e));

      win.fireEvent('online');

      expect(networkEvents).toHaveLength(1);
    });

    it('should emit network event on offline', () => {
      const networkEvents: LifecycleEvent[] = [];
      manager.on('network', (e) => networkEvents.push(e));

      win.fireEvent('offline');

      expect(networkEvents).toHaveLength(1);
    });

    it('should emit reconnect-needed on online when already active', () => {
      const reconnectEvents: LifecycleEvent[] = [];
      manager.on('reconnect-needed', (e) => reconnectEvents.push(e));

      win.fireEvent('online');

      expect(reconnectEvents).toHaveLength(1);
    });
  });

  // ── freeze / resume ────────────────────────────────────────────────

  describe('Page Lifecycle API', () => {
    it('should transition to frozen on freeze event', () => {
      doc.fireEvent('freeze');
      expect(manager.getState()).toBe('frozen');
      expect(manager.isBackground()).toBe(true);
    });

    it('should transition to active on resume event', () => {
      doc.fireEvent('freeze');
      doc.fireEvent('resume');
      expect(manager.getState()).toBe('active');
      expect(manager.isBackground()).toBe(false);
    });
  });

  // ── beforeunload ───────────────────────────────────────────────────

  describe('beforeunload', () => {
    it('should transition to terminated on beforeunload', () => {
      const events: LifecycleEvent[] = [];
      manager.on('state-change', (e) => events.push(e));

      win.fireEvent('beforeunload');

      expect(manager.getState()).toBe('terminated');
      expect(events[0].currentState).toBe('terminated');
    });
  });

  // ── 清理 ──────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('should remove all event listeners', () => {
      manager.stop(doc as any, win as any);

      // 確認 handlers 已被移除
      const events: LifecycleEvent[] = [];
      manager.on('state-change', (e) => events.push(e));

      (doc as any)._visibilityState = 'hidden';
      doc.fireEvent('visibilitychange');

      // manager 已停止，不應收到事件
      // 但因為 listeners.clear() 在 stop 中，新加的 listener 也被清除了
      // 所以這裡的 events 應該為空
      expect(events).toHaveLength(0);
    });
  });

  // ── 取消訂閱 ──────────────────────────────────────────────────────

  describe('event unsubscribe', () => {
    it('should allow unsubscribing from events', () => {
      const events: LifecycleEvent[] = [];
      const unsub = manager.on('state-change', (e) => events.push(e));

      (doc as any)._visibilityState = 'hidden';
      doc.fireEvent('visibilitychange');
      expect(events).toHaveLength(1);

      unsub();

      (doc as any)._visibilityState = 'visible';
      doc.fireEvent('visibilitychange');
      // 不應再收到事件
      expect(events).toHaveLength(1);
    });
  });
});
