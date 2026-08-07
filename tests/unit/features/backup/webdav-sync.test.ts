import { describe, expect, test } from 'bun:test';
import { testWebDAVConnection } from '@/features/backup/webdav-sync';

describe('WebDAV URL validation', () => {
  test('rejects cleartext http URLs by default', async () => {
    const result = await testWebDAVConnection({
      url: 'http://nextcloud.example.com/remote.php/dav/',
    });
    expect(result.success).toBe(false);
    expect(result.message?.toLowerCase()).toContain('https');
  });

  test('allows http when allowInsecureHttp is true', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 207 })) as unknown as typeof fetch;

    try {
      const result = await testWebDAVConnection({
        url: 'http://nextcloud.example.com/remote.php/dav/',
        allowInsecureHttp: true,
      });
      expect(result.success).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects private-network https URLs', async () => {
    const result = await testWebDAVConnection({ url: 'https://localhost/dav/' });
    expect(result.success).toBe(false);
    expect(result.message).toBeTruthy();
  });
});
