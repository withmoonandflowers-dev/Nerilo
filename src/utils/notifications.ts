/**
 * Browser Notification Utility
 *
 * Provides Web Notification API integration for new message alerts
 * when the tab is in the background.
 */

import { logger } from './logger';

let permissionGranted = false;

/** Request notification permission (should be called on user interaction) */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) {
    logger.info('[Notifications] Web Notification API not supported');
    return false;
  }

  if (Notification.permission === 'granted') {
    permissionGranted = true;
    return true;
  }

  if (Notification.permission === 'denied') {
    return false;
  }

  try {
    const result = await Notification.requestPermission();
    permissionGranted = result === 'granted';
    return permissionGranted;
  } catch {
    return false;
  }
}

/** Show a notification for a new message (only when tab is hidden) */
export function notifyNewMessage(senderName: string, content: string): void {
  if (!permissionGranted || !document.hidden) return;

  try {
    const notification = new Notification(`Nerilo — ${senderName}`, {
      body: content.length > 100 ? content.substring(0, 100) + '...' : content,
      icon: '/favicon.ico',
      tag: 'nerilo-message', // Replaces previous notification
      silent: false,
    });

    // Auto close after 5 seconds
    setTimeout(() => notification.close(), 5000);

    // Focus tab when clicked
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (e) {
    logger.debug('[Notifications] Failed to show notification', e);
  }
}

/** Play a subtle notification sound using Web Audio API */
let audioCtx: AudioContext | null = null;

export function playNotificationSound(): void {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(800, audioCtx.currentTime);
    osc.frequency.setValueAtTime(600, audioCtx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.2);
  } catch {
    // Audio not available (e.g. autoplay policy)
  }
}

/** Update document title with unread count */
let originalTitle = '';
let unreadCount = 0;

export function incrementUnread(): void {
  if (!document.hidden) return;
  if (!originalTitle) originalTitle = document.title;
  unreadCount++;
  document.title = `(${unreadCount}) ${originalTitle}`;
}

export function clearUnread(): void {
  if (originalTitle) {
    document.title = originalTitle;
    originalTitle = '';
  }
  unreadCount = 0;
}

// Auto-clear when tab becomes visible
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      clearUnread();
    }
  });
}
