// --- Time helpers ---
import type { Account } from './types.js';

export function isMs(timestamp: number, threshold = 5e10): boolean {
  return timestamp > threshold;
}

export function toMs(receivedAt: number): number {
  if (!receivedAt) return 0;
  return isMs(receivedAt) ? receivedAt : receivedAt * 1000;
}

export function toSeconds(receivedAt: number): number {
  if (!receivedAt) return 0;
  return isMs(receivedAt) ? Math.floor(receivedAt / 1000) : receivedAt;
}

// timeAgo and formatDate have been moved to time-format.ts to avoid pulling
// i18n-utils → en.json into the content-script bundle via time.ts.

export function formatTimeLeft(ms: number): string {
  if (!ms || ms <= 0) return 'Expired';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, '0')}`;
  return `${minutes}m`;
}

/** @deprecated Prefer `@/utils/account-status` helpers; kept for call-site stability. */
export function getEmailStatus(inbox: Account): string {
  if (inbox.accountStatus === 'deleted') return 'deleted';
  if (inbox.accountStatus === 'archived') return 'archived';
  // expiresAt === 0 means unknown/no expiry — do not treat as expired
  const exp = inbox.expiresAt || 0;
  if (exp > 0 && Date.now() > exp) return 'expired';
  return 'active';
}

/**
 * Simple debounce helper to rate-limit execution of a function.
 */
export function debounce<F extends (...args: unknown[]) => unknown>(
  fn: F,
  delayMs: number
): (...args: Parameters<F>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return (...args: Parameters<F>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = null;
    }, delayMs);
  };
}
