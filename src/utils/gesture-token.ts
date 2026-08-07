/**
 * Gesture token system — requires explicit user interaction in the extension
 * UI (popup / sidepanel / app tab) before privileged operations like
 * createInbox can be invoked from a content script context.
 *
 * Security model:
 * - Tokens are HMAC-SHA256 signed with a key derived from the extension's
 *   runtime ID (constant per extension, not forgeable by web page code).
 * - Tokens carry a purpose string, timestamp, and random nonce.
 * - Tokens are single-use: the background script tracks consumed token
 *   nonces in session storage.
 * - Tokens expire after GESTURE_TOKEN_EXPIRY_MS (5 s) — the user must
 *   have opened the extension UI within this window.
 */

import { browser } from 'wxt/browser';

/** How long a gesture token remains valid (5 seconds). */
export const GESTURE_TOKEN_EXPIRY_MS = 5_000;

const GESTURE_TOKEN_PREFIX = 'gt1';
const CONSUMED_TOKENS_KEY = 'gesture_token_nonces';

/** Derive a signing key from the extension runtime ID. */
async function getSigningKey(): Promise<CryptoKey> {
  const extId = (await browser.runtime.id) || 'fallback';
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(extId),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g);
  if (!pairs) return new Uint8Array(0);
  return Uint8Array.from(pairs.map((p) => parseInt(p, 16)));
}

/** A signed, time-limited gesture token. */
export interface GestureToken {
  token: string;
  expiresAt: number;
}

/**
 * Generate a new gesture token for the given purpose.
 * Called from the background script when the extension UI is opened
 * with a reason that implies user interaction (e.g. autofill-create-address).
 */
export async function generateGestureToken(purpose: string): Promise<GestureToken> {
  const key = await getSigningKey();
  const timestamp = Date.now();
  const nonce = crypto.randomUUID?.() ?? `${timestamp}-${Math.random().toString(36).slice(2, 15)}`;
  const payload = `${GESTURE_TOKEN_PREFIX}|${purpose}|${timestamp}|${nonce}`;
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload) as BufferSource
  );
  const sigHex = bytesToHex(new Uint8Array(sig));
  const token = `${payload}|${sigHex}`;
  return { token, expiresAt: timestamp + GESTURE_TOKEN_EXPIRY_MS };
}

/**
 * Validate a gesture token: verify signature, check expiry, and enforce
 * single-use by tracking the nonce in session storage.
 *
 * Returns `true` only when the token is genuine, unexpired, and unused.
 */
export async function validateAndConsumeGestureToken(
  token: string,
  expectedPurpose: string
): Promise<boolean> {
  try {
    const key = await getSigningKey();
    const parts = token.split('|');
    if (parts.length !== 5) return false;
    const [prefix, purpose, timestampStr, nonce, signature] = parts;
    if (prefix !== GESTURE_TOKEN_PREFIX) return false;
    if (purpose !== expectedPurpose) return false;

    const timestamp = parseInt(timestampStr, 10);
    if (Number.isNaN(timestamp)) return false;
    if (Date.now() - timestamp > GESTURE_TOKEN_EXPIRY_MS) return false;

    const payload = `${prefix}|${purpose}|${timestampStr}|${nonce}`;
    const sigBytes = hexToBytes(signature) as BufferSource;
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      new TextEncoder().encode(payload) as BufferSource
    );
    if (!isValid) return false;

    // Enforce single-use: track the nonce in session storage
    const { [CONSUMED_TOKENS_KEY]: consumedRaw } = (await browser.storage.session.get(
      CONSUMED_TOKENS_KEY
    )) as { [CONSUMED_TOKENS_KEY]?: string[] };
    const consumed = Array.isArray(consumedRaw) ? consumedRaw : [];
    if (consumed.includes(nonce)) return false; // already used
    consumed.push(nonce);
    // Trim old entries to avoid unbounded growth
    const fresh = consumed; // nonce is opaque; we just keep the list bounded
    if (fresh.length > 100) {
      fresh.splice(0, fresh.length - 100);
    }
    void browser.storage.session.set({ [CONSUMED_TOKENS_KEY]: fresh });

    return true;
  } catch {
    return false;
  }
}

/**
 * Store a gesture token in session storage so the content script can
 * retrieve it. Called by the background when `openExtensionUi` is invoked
 * with `reason: 'autofill-create-address'`.
 */
export async function storePendingGestureToken(token: GestureToken): Promise<void> {
  const { pendingGestureTokens = {} } = (await browser.storage.session.get([
    'pendingGestureTokens',
  ])) as {
    pendingGestureTokens?: Record<string, { token: string; expiresAt: number }>;
  };
  pendingGestureTokens['autofill-create-address'] = {
    token: token.token,
    expiresAt: token.expiresAt,
  };
  await browser.storage.session.set({ pendingGestureTokens });
}

/**
 * Retrieve and consume a pending gesture token for the given purpose.
 * Returns the token string, or null if no valid token exists.
 */
export async function consumePendingGestureToken(purpose: string): Promise<string | null> {
  const { pendingGestureTokens } = (await browser.storage.session.get([
    'pendingGestureTokens',
  ])) as {
    pendingGestureTokens?: Record<string, { token: string; expiresAt: number }>;
  };
  if (!pendingGestureTokens?.[purpose]) return null;
  const entry = pendingGestureTokens[purpose];
  if (entry.expiresAt < Date.now()) {
    delete pendingGestureTokens[purpose];
    await browser.storage.session.set({ pendingGestureTokens });
    return null;
  }
  delete pendingGestureTokens[purpose];
  await browser.storage.session.set({ pendingGestureTokens });
  return entry.token;
}
