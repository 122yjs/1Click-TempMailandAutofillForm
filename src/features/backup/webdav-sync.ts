/**
 * WebDAV Cloud Sync module for 1Click Temp Mail.
 * Allows users to test, upload, and download encrypted extension backups to WebDAV servers (Nextcloud, ownCloud, Fastmail, etc.).
 */
import { isSafeFetchUrl } from '@/utils/instance-validation.js';
import { logError } from '@/utils/logger.js';

export type WebDAVConfig = {
  url: string;
  username?: string;
  password?: string;
  /** Allow http:// URLs (cleartext). Default false — https required. */
  allowInsecureHttp?: boolean;
};

function validateWebDAVUrl(
  url: string,
  allowInsecureHttp = false
): { ok: boolean; error?: string } {
  if (!url?.trim()) {
    return { ok: false, error: 'Invalid WebDAV server URL' };
  }
  if (allowInsecureHttp && url.startsWith('http://')) {
    try {
      new URL(url);
      return { ok: true };
    } catch {
      /* ignore */
      return { ok: false, error: 'Invalid URL format' };
    }
  }
  return isSafeFetchUrl(url);
}

function getAuthHeaders(config: WebDAVConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.username || config.password) {
    const credentials = btoa(`${config.username || ''}:${config.password || ''}`);
    headers.Authorization = `Basic ${credentials}`;
  }
  return headers;
}

/**
 * Test WebDAV server connection and credentials using a PROPFIND or HEAD request.
 */
export async function testWebDAVConnection(
  config: WebDAVConfig
): Promise<{ success: boolean; message?: string }> {
  const safe = validateWebDAVUrl(config.url, config.allowInsecureHttp);
  if (!safe.ok) {
    return { success: false, message: safe.error || 'WebDAV URL is not allowed' };
  }
  try {
    const url = config.url.endsWith('/') ? config.url : `${config.url}/`;
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        ...getAuthHeaders(config),
        Depth: '0',
      },
    });
    if (res.ok || res.status === 207 || res.status === 405) {
      return { success: true };
    }
    if (res.status === 401 || res.status === 403) {
      return { success: false, message: 'Authentication failed (401/403)' };
    }
    return { success: false, message: `Server returned status ${res.status}` };
  } catch (err: unknown) {
    logError('WebDAV test failed', undefined, err instanceof Error ? err : new Error(String(err)));
    return { success: false, message: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Upload backup payload string (JSON) to WebDAV target directory.
 */
export async function uploadWebDAVBackup(
  config: WebDAVConfig,
  backupPayload: string,
  filename = '1click-mail-backup.json'
): Promise<{ success: boolean; error?: string }> {
  const safe = validateWebDAVUrl(config.url, config.allowInsecureHttp);
  if (!safe.ok) {
    return { success: false, error: safe.error || 'WebDAV URL is not allowed' };
  }
  try {
    const baseUrl = config.url.endsWith('/') ? config.url : `${config.url}/`;
    const targetUrl = `${baseUrl}${filename}`;
    const res = await fetch(targetUrl, {
      method: 'PUT',
      headers: {
        ...getAuthHeaders(config),
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: backupPayload,
    });
    if (res.ok || res.status === 201 || res.status === 204) {
      return { success: true };
    }
    return { success: false, error: `Upload failed (Status ${res.status})` };
  } catch (err: unknown) {
    logError(
      'WebDAV upload failed',
      undefined,
      err instanceof Error ? err : new Error(String(err))
    );
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

/**
 * Download backup payload string from WebDAV target directory.
 */
export async function downloadWebDAVBackup(
  config: WebDAVConfig,
  filename = '1click-mail-backup.json'
): Promise<{ success: boolean; payload?: string; error?: string }> {
  const safe = validateWebDAVUrl(config.url, config.allowInsecureHttp);
  if (!safe.ok) {
    return { success: false, error: safe.error || 'WebDAV URL is not allowed' };
  }
  try {
    const baseUrl = config.url.endsWith('/') ? config.url : `${config.url}/`;
    const targetUrl = `${baseUrl}${filename}`;
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: getAuthHeaders(config),
    });
    if (!res.ok) {
      return { success: false, error: `File download failed (Status ${res.status})` };
    }
    const payload = await res.text();
    return { success: true, payload };
  } catch (err: unknown) {
    logError(
      'WebDAV download failed',
      undefined,
      err instanceof Error ? err : new Error(String(err))
    );
    return { success: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}
