import { describe, expect, mock, test } from 'bun:test';

// notification-permission.ts imports { browser } from wxt/browser; provide an
// in-memory mock so the module loads in the test runner. The getters let each
// test simulate a missing native API or a failing navigation.
const api = {
  getPermissionLevel: undefined as (() => Promise<string>) | undefined,
  contains: async () => true,
  createTab: async (..._args: unknown[]) => ({}),
};
mock.module('wxt/browser', () => ({
  browser: {
    get notifications() {
      const getPermissionLevel = api.getPermissionLevel;
      return {
        ...(typeof getPermissionLevel === 'function'
          ? { getPermissionLevel: () => getPermissionLevel() }
          : {}),
      };
    },
    permissions: {
      contains: () => api.contains(),
    },
    tabs: {
      create: (...args: unknown[]) => api.createTab(...args),
    },
  },
}));

const { getNotificationPermissionStatus, openNotificationSettingsPage } = await import(
  '@/utils/notification-permission.js'
);

describe('getNotificationPermissionStatus', () => {
  test('returns denied when the native API reports denied', async () => {
    api.getPermissionLevel = async () => 'denied';
    expect(await getNotificationPermissionStatus()).toBe('denied');
  });

  test('returns granted when the native API reports granted', async () => {
    api.getPermissionLevel = async () => 'granted';
    expect(await getNotificationPermissionStatus()).toBe('granted');
  });

  test('falls back to the manifest permission when the native API is missing', async () => {
    api.getPermissionLevel = undefined;
    api.contains = async () => true;
    expect(await getNotificationPermissionStatus()).toBe('granted');
  });

  test('reports denied when the manifest permission was revoked', async () => {
    api.getPermissionLevel = undefined;
    api.contains = async () => false;
    expect(await getNotificationPermissionStatus()).toBe('denied');
  });

  test('reports denied via the DOM Notification permission when the native API is missing', async () => {
    api.getPermissionLevel = undefined;
    const globals = globalThis as unknown as { Notification?: { permission: string } };
    const prev = globals.Notification;
    globals.Notification = { permission: 'denied' };
    try {
      expect(await getNotificationPermissionStatus()).toBe('denied');
    } finally {
      if (prev === undefined) delete (globalThis as Record<string, unknown>).Notification;
      else globals.Notification = prev;
    }
  });

  test('tolerates a rejecting native API', async () => {
    api.getPermissionLevel = async () => {
      throw new Error('api unavailable');
    };
    api.contains = async () => true;
    expect(await getNotificationPermissionStatus()).toBe('granted');
  });
});

describe('openNotificationSettingsPage', () => {
  test('opens the chrome notification-settings page and reports success', async () => {
    const calls: unknown[] = [];
    api.createTab = async (args) => {
      calls.push(args);
      return { id: 1 };
    };
    expect(await openNotificationSettingsPage()).toBe(true);
    expect(calls[0]).toEqual({ url: 'chrome://settings/content/notifications', active: true });
  });

  test('reports failure when the browser blocks the navigation', async () => {
    api.createTab = async () => {
      throw new Error('Cannot access a chrome:// URL');
    };
    expect(await openNotificationSettingsPage()).toBe(false);
  });
});
