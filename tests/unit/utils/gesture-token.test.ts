import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ── Mock 'wxt/browser' BEFORE importing gesture-token ────────────────────────
// gesture-token.ts imports { browser } from 'wxt/browser'. In Bun's test
// runner there is no extension context, so we mock the modules we need.

const sessionStore: Record<string, unknown> = {};

mock.module('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'test-extension-id-12345',
    },
    storage: {
      session: {
        get: async (keys?: string | string[] | null) => {
          if (keys === null || keys === undefined) return { ...sessionStore };
          const keyArr = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const k of keyArr) {
            if (k in sessionStore) result[k] = sessionStore[k];
          }
          return result;
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, items);
        },
        remove: async (keys: string | string[]) => {
          const keyArr = Array.isArray(keys) ? keys : [keys];
          for (const k of keyArr) {
            delete sessionStore[k];
          }
        },
      },
    },
  },
}));

// Dynamic import so the mock is registered first
const { generateGestureToken, validateAndConsumeGestureToken, GESTURE_TOKEN_EXPIRY_MS } =
  await import('@/utils/gesture-token.js');

describe('gesture-token', () => {
  beforeEach(() => {
    for (const key of Object.keys(sessionStore)) {
      delete sessionStore[key];
    }
  });

  test('generateGestureToken produces a token with payload and expiry', async () => {
    const { token, expiresAt } = await generateGestureToken('autofill-create-address');
    expect(token).toContain('gt1|autofill-create-address|');
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt - Date.now()).toBeCloseTo(GESTURE_TOKEN_EXPIRY_MS, -2);
  });

  test('validateAndConsumeGestureToken accepts a valid token', async () => {
    const { token } = await generateGestureToken('autofill-create-address');
    const ok = await validateAndConsumeGestureToken(token, 'autofill-create-address');
    expect(ok).toBe(true);
  });

  test('validateAndConsumeGestureToken rejects wrong purpose', async () => {
    const { token } = await generateGestureToken('autofill-create-address');
    const ok = await validateAndConsumeGestureToken(token, 'other-purpose');
    expect(ok).toBe(false);
  });

  test('validateAndConsumeGestureToken rejects malformed token', async () => {
    const ok = await validateAndConsumeGestureToken('gt1|purpose|123|nonce|bad', 'purpose');
    expect(ok).toBe(false);
  });

  test('validateAndConsumeGestureToken rejects expired token', async () => {
    // Build a token with a timestamp far in the past
    const token = `gt1|autofill-create-address|${Date.now() - GESTURE_TOKEN_EXPIRY_MS * 2}|nonce|invalidsig`;
    const ok = await validateAndConsumeGestureToken(token, 'autofill-create-address');
    expect(ok).toBe(false);
  });

  test('validateAndConsumeGestureToken rejects wrong signature', async () => {
    const { token } = await generateGestureToken('autofill-create-address');
    // Tamper with the signature
    const parts = token.split('|');
    parts[4] = '0'.repeat(parts[4].length);
    const tampered = parts.join('|');
    const ok = await validateAndConsumeGestureToken(tampered, 'autofill-create-address');
    expect(ok).toBe(false);
  });

  test('validateAndConsumeGestureToken single-use: second consumption fails', async () => {
    const { token } = await generateGestureToken('autofill-create-address');
    const ok1 = await validateAndConsumeGestureToken(token, 'autofill-create-address');
    expect(ok1).toBe(true);
    const ok2 = await validateAndConsumeGestureToken(token, 'autofill-create-address');
    expect(ok2).toBe(false);
  });
});
