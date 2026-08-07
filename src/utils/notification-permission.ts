import { browser } from 'wxt/browser';
import { logError } from '@/utils/logger.js';

export type NotificationPermissionStatus = 'granted' | 'denied' | 'unknown';

/**
 * Best-effort, cross-browser check of whether the extension's notifications
 * permission is actually usable.
 *
 * `browser.notifications.getPermissionLevel()` reflects browser/OS-level
 * blocking (e.g. the user turned notifications off for this extension in the
 * browser's site settings), which `browser.permissions.contains()` alone can't
 * see. Falls back to the DOM `Notification.permission` and finally to the
 * manifest permission when the native API is unavailable (Safari, etc.).
 */
export async function getNotificationPermissionStatus(): Promise<NotificationPermissionStatus> {
  // 1) Native API — Chrome + Firefox.
  const notifications = browser.notifications as typeof browser.notifications & {
    getPermissionLevel?: () => Promise<string>;
  };
  if (typeof notifications.getPermissionLevel === 'function') {
    try {
      const level = await notifications.getPermissionLevel();
      if (level === 'denied') return 'denied';
      if (level === 'granted') return 'granted';
      // 'unspecified' (Firefox) → continue to the finer-grained checks below.
    } catch {
      /* fall through to fallbacks */
    }
  }
  // 2) DOM Notification API (extension pages / service worker contexts).
  try {
    const domPermission = typeof Notification !== 'undefined' ? Notification.permission : undefined;
    if (domPermission === 'denied') return 'denied';
    if (domPermission === 'granted') return 'granted';
  } catch {
    /* ignore */
  }
  // 3) Last resort: is the manifest permission itself still granted?
  try {
    const has = await browser.permissions.contains({ permissions: ['notifications'] });
    return has ? 'granted' : 'denied';
  } catch {
    return 'unknown';
  }
}

/**
 * Best-effort "open site settings" for the extension's notifications.
 * Chrome-family → chrome://settings/content/notifications (one of the
 * chrome:// pages Chrome lets extensions open); Firefox → about:preferences#privacy.
 * Returns false when the browser blocks the navigation so callers can surface
 * manual instructions instead.
 */
export async function openNotificationSettingsPage(): Promise<boolean> {
  const isFirefox = typeof navigator !== 'undefined' && /Firefox\//i.test(navigator.userAgent);
  const url = isFirefox ? 'about:preferences#privacy' : 'chrome://settings/content/notifications';
  try {
    await browser.tabs.create({ url, active: true });
    return true;
  } catch (error) {
    logError(
      'Could not open browser notification settings',
      { url },
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  }
}
