/**
 * Notification Service Tests
 *
 * Tests src/utils/notifications.ts:
 *  1. requestNotificationPermission with various states
 *  2. notifyNewMessage triggers only when tab is hidden
 *  3. notifyNewMessage does NOT trigger when tab is visible
 *  4. incrementUnread / clearUnread correctly update document.title
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Global DOM / Notification mocks ──────────────────────────────────────────

// We need to mock the DOM environment since this is a node test
let mockHidden = false;
let mockTitle = 'Nerilo';
let mockPermission: NotificationPermission = 'default';
let mockRequestPermissionResult: NotificationPermission = 'granted';
let mockNotificationInstances: Array<{
  close: ReturnType<typeof vi.fn>;
  onclick: ((e: Event) => void) | null;
  body: string;
  tag: string;
}> = [];

const mockFocus = vi.fn();
let visibilityChangeHandlers: Array<() => void> = [];

// Set up DOM globals before import
function setupGlobals() {
  // Reset state
  mockHidden = false;
  mockTitle = 'Nerilo';
  mockPermission = 'default';
  mockRequestPermissionResult = 'granted';
  mockNotificationInstances = [];
  visibilityChangeHandlers = [];

  Object.defineProperty(globalThis, 'document', {
    value: {
      get hidden() { return mockHidden; },
      get title() { return mockTitle; },
      set title(val: string) { mockTitle = val; },
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'visibilitychange') {
          visibilityChangeHandlers.push(handler);
        }
      }),
    },
    writable: true,
    configurable: true,
  });

  const MockNotificationClass = class MockNotification {
    body: string;
    tag: string;
    close = vi.fn();
    onclick: ((e: Event) => void) | null = null;

    static get permission() { return mockPermission; }
    static requestPermission = vi.fn(async () => {
      mockPermission = mockRequestPermissionResult;
      return mockRequestPermissionResult;
    });

    constructor(title: string, options?: NotificationOptions) {
      this.body = options?.body || '';
      this.tag = options?.tag || '';
      mockNotificationInstances.push(this);
    }
  };

  (globalThis as any).Notification = MockNotificationClass;

  Object.defineProperty(globalThis, 'window', {
    value: { focus: mockFocus, Notification: MockNotificationClass },
    writable: true,
    configurable: true,
  });
}

describe('NotificationService', () => {
  beforeEach(() => {
    setupGlobals();
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ──────────────────────────────────────────────────────────────────────
  // requestNotificationPermission
  // ──────────────────────────────────────────────────────────────────────

  describe('requestNotificationPermission', () => {
    it('should return true when permission is already granted', async () => {
      mockPermission = 'granted';
      const { requestNotificationPermission } = await import('../../src/utils/notifications');
      const result = await requestNotificationPermission();
      expect(result).toBe(true);
    });

    it('should return false when permission is denied', async () => {
      mockPermission = 'denied';
      const { requestNotificationPermission } = await import('../../src/utils/notifications');
      const result = await requestNotificationPermission();
      expect(result).toBe(false);
    });

    it('should request permission when state is default and user grants', async () => {
      mockPermission = 'default';
      mockRequestPermissionResult = 'granted';
      const { requestNotificationPermission } = await import('../../src/utils/notifications');
      const result = await requestNotificationPermission();
      expect(result).toBe(true);
      expect((globalThis as any).Notification.requestPermission).toHaveBeenCalled();
    });

    it('should return false when user denies the request', async () => {
      mockPermission = 'default';
      mockRequestPermissionResult = 'denied';
      const { requestNotificationPermission } = await import('../../src/utils/notifications');
      const result = await requestNotificationPermission();
      expect(result).toBe(false);
    });

    it('should return false when Notification API is not supported', async () => {
      // Remove Notification from both globalThis and window
      delete (globalThis as any).Notification;
      Object.defineProperty(globalThis, 'window', {
        value: { focus: mockFocus },
        writable: true,
        configurable: true,
      });
      const { requestNotificationPermission } = await import('../../src/utils/notifications');
      const result = await requestNotificationPermission();
      expect(result).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // notifyNewMessage
  // ──────────────────────────────────────────────────────────────────────

  describe('notifyNewMessage', () => {
    it('should create Notification when tab is hidden and permission granted', async () => {
      mockPermission = 'granted';
      const { requestNotificationPermission, notifyNewMessage } = await import('../../src/utils/notifications');
      await requestNotificationPermission();

      mockHidden = true;
      notifyNewMessage('Alice', 'Hello there');

      expect(mockNotificationInstances).toHaveLength(1);
      expect(mockNotificationInstances[0].body).toBe('Hello there');
    });

    it('should NOT create Notification when tab is visible', async () => {
      mockPermission = 'granted';
      const { requestNotificationPermission, notifyNewMessage } = await import('../../src/utils/notifications');
      await requestNotificationPermission();

      mockHidden = false;
      notifyNewMessage('Alice', 'Hello there');

      expect(mockNotificationInstances).toHaveLength(0);
    });

    it('should NOT create Notification when permission not granted', async () => {
      mockPermission = 'denied';
      const { requestNotificationPermission, notifyNewMessage } = await import('../../src/utils/notifications');
      await requestNotificationPermission();

      mockHidden = true;
      notifyNewMessage('Alice', 'Hello there');

      expect(mockNotificationInstances).toHaveLength(0);
    });

    it('should truncate long messages to 100 chars with ellipsis', async () => {
      mockPermission = 'granted';
      const { requestNotificationPermission, notifyNewMessage } = await import('../../src/utils/notifications');
      await requestNotificationPermission();

      mockHidden = true;
      const longMsg = 'A'.repeat(200);
      notifyNewMessage('Alice', longMsg);

      expect(mockNotificationInstances).toHaveLength(1);
      expect(mockNotificationInstances[0].body).toBe('A'.repeat(100) + '...');
    });

    it('should auto-close notification after 5 seconds', async () => {
      mockPermission = 'granted';
      const { requestNotificationPermission, notifyNewMessage } = await import('../../src/utils/notifications');
      await requestNotificationPermission();

      mockHidden = true;
      notifyNewMessage('Alice', 'Hi');

      expect(mockNotificationInstances[0].close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(mockNotificationInstances[0].close).toHaveBeenCalled();
    });

    it('should use nerilo-message tag for notification replacement', async () => {
      mockPermission = 'granted';
      const { requestNotificationPermission, notifyNewMessage } = await import('../../src/utils/notifications');
      await requestNotificationPermission();

      mockHidden = true;
      notifyNewMessage('Alice', 'msg1');
      notifyNewMessage('Bob', 'msg2');

      expect(mockNotificationInstances[0].tag).toBe('nerilo-message');
      expect(mockNotificationInstances[1].tag).toBe('nerilo-message');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // incrementUnread / clearUnread
  // ──────────────────────────────────────────────────────────────────────

  describe('incrementUnread / clearUnread', () => {
    it('should update document.title with unread count when hidden', async () => {
      const { incrementUnread } = await import('../../src/utils/notifications');

      mockHidden = true;
      mockTitle = 'Nerilo';

      incrementUnread();
      expect(mockTitle).toBe('(1) Nerilo');

      incrementUnread();
      expect(mockTitle).toBe('(2) Nerilo');

      incrementUnread();
      expect(mockTitle).toBe('(3) Nerilo');
    });

    it('should NOT update document.title when tab is visible', async () => {
      const { incrementUnread } = await import('../../src/utils/notifications');

      mockHidden = false;
      mockTitle = 'Nerilo';

      incrementUnread();
      expect(mockTitle).toBe('Nerilo');
    });

    it('clearUnread should restore original title', async () => {
      const { incrementUnread, clearUnread } = await import('../../src/utils/notifications');

      mockHidden = true;
      mockTitle = 'Nerilo';

      incrementUnread();
      incrementUnread();
      expect(mockTitle).toBe('(2) Nerilo');

      clearUnread();
      expect(mockTitle).toBe('Nerilo');
    });

    it('clearUnread should reset count so next increment starts at 1', async () => {
      const { incrementUnread, clearUnread } = await import('../../src/utils/notifications');

      mockHidden = true;
      mockTitle = 'Nerilo';

      incrementUnread();
      incrementUnread();
      clearUnread();

      mockHidden = true;
      incrementUnread();
      expect(mockTitle).toBe('(1) Nerilo');
    });

    it('clearUnread is idempotent (calling twice has no effect)', async () => {
      const { incrementUnread, clearUnread } = await import('../../src/utils/notifications');

      mockHidden = true;
      mockTitle = 'Nerilo';

      incrementUnread();
      clearUnread();
      clearUnread();

      expect(mockTitle).toBe('Nerilo');
    });
  });
});
