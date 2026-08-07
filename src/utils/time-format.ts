/**
 * Time formatting helpers that require synchronous translations (tSync).
 *
 * This module is separate from `time.ts` to avoid pulling `i18n-utils.js`
 * (which statically imports `en.json` ~92 KB) into the content-script bundle.
 * The content script only needs `toMs` / `isMs` / `formatTimeLeft` from
 * `time.ts`, none of which require translations.
 */

import { tSync } from './i18n-utils.js';
import { toMs } from './time.js';

export function timeAgo(timestamp: number): string {
  if (!timestamp) return '';
  const now = Date.now();
  const secondsPast = (now - toMs(timestamp)) / 1000;
  if (secondsPast < 0) return tSync('time.justNow');
  if (secondsPast < 60) {
    return tSync('time.secondsAgo', { n: Math.round(secondsPast) });
  }
  if (secondsPast < 3600) {
    return tSync('time.minutesAgo', { n: Math.round(secondsPast / 60) });
  }
  if (secondsPast <= 86400) {
    return tSync('time.hoursAgo', { n: Math.round(secondsPast / 3600) });
  }
  return tSync('time.daysAgo', { n: Math.round(secondsPast / 86400) });
}

/**
 * Full, absolute date + time (e.g. "Aug 7, 2026, 4:32 PM") in the user's
 * locale — used as hover tooltip text over relative "x ago" labels so the
 * exact received moment is always one hover away.
 */
export function formatFullDateTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const date = new Date(toMs(ts));
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return date.toLocaleString();
  }
}

export function formatDate(ts: number | string): string {
  if (!ts) return tSync('time.never');
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return tSync('time.never');
  const now = new Date();
  // Use UTC to compute the diff of local calendar dates so that
  // daylight saving time (DST) transitions don't alter the exact 24h gap
  const startOfToday = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((startOfToday - startOfDate) / 86400000);
  if (diff === 0) return tSync('time.today');
  if (diff === 1) return tSync('time.yesterday');
  if (diff > 1 && diff <= 7) return tSync('time.daysAgoLong', { n: diff });
  return date.toLocaleDateString();
}
