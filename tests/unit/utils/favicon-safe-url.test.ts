import { describe, expect, mock, test } from 'bun:test';

// favicon.ts imports { browser } from wxt/browser (via logger/storageMonitor);
// provide an in-memory mock so the module loads in the test runner.
const storageStore: Record<string, unknown> = {};
mock.module('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: async (keys?: string | string[] | null) => {
          if (keys === null || keys === undefined) return { ...storageStore };
          const keyArr = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const k of keyArr) if (k in storageStore) result[k] = storageStore[k];
          return result;
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(storageStore, items);
        },
        remove: async (keys: string | string[]) => {
          const keyArr = Array.isArray(keys) ? keys : [keys];
          for (const k of keyArr) delete storageStore[k];
        },
        getBytesInUse: async () => 0,
      },
      onChanged: { addListener: () => {} },
    },
    runtime: { sendMessage: async () => ({ success: false }) },
  },
}));

const { getSafeDomainFaviconUrl, getSafeRootDomainFaviconUrl } = await import('@/utils/favicon');

describe('getSafeDomainFaviconUrl (SSRF guard)', () => {
  test('direct favicon URL for a public host', () => {
    expect(getSafeDomainFaviconUrl('user@example.com')).toBe('https://example.com/favicon.ico');
  });

  test('falls back to Google proxy for localhost', () => {
    const url = getSafeDomainFaviconUrl('x@localhost');
    expect(url).toContain('google.com/s2/favicons');
    expect(url).not.toContain('localhost/favicon.ico');
  });

  test('falls back to Google proxy for loopback IPv4', () => {
    const url = getSafeDomainFaviconUrl('x@127.0.0.1');
    expect(url).toContain('google.com/s2/favicons');
  });

  test('falls back to Google proxy for private RFC1918 ranges', () => {
    for (const host of ['10.0.0.1', '192.168.1.5', '172.16.4.4']) {
      const url = getSafeDomainFaviconUrl(`x@${host}`);
      expect(url).toContain('google.com/s2/favicons');
      expect(url).not.toContain(`${host}/favicon.ico`);
    }
  });

  test('falls back to Google proxy for .local internal TLD', () => {
    const url = getSafeDomainFaviconUrl('x@internal-host.local');
    expect(url).toContain('google.com/s2/favicons');
  });

  test('falls back to Google proxy for link-local 169.254', () => {
    expect(getSafeDomainFaviconUrl('x@169.254.1.1')).toContain('google.com/s2/favicons');
  });

  test('accepts a bare domain (no @ sign)', () => {
    expect(getSafeDomainFaviconUrl('example.com')).toBe('https://example.com/favicon.ico');
  });

  test('strips a port for the host check but keeps public host direct', () => {
    expect(getSafeDomainFaviconUrl('user@example.com:8443')).toBe(
      'https://example.com:8443/favicon.ico'
    );
  });
});

describe('getSafeRootDomainFaviconUrl (SSRF guard)', () => {
  test('direct root favicon for public multi-level host', () => {
    expect(getSafeRootDomainFaviconUrl('user@mail.example.com')).toBe(
      'https://example.com/favicon.ico'
    );
  });

  test('Google proxy for internal root domain', () => {
    expect(getSafeRootDomainFaviconUrl('user@host.local')).toContain('google.com/s2/favicons');
  });

  test('handles multi-level TLD (public)', () => {
    expect(getSafeRootDomainFaviconUrl('user@example.co.uk')).toBe(
      'https://example.co.uk/favicon.ico'
    );
  });
});
