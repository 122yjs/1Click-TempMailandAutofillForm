/**
 * Connectivity log — records online/offline transitions with UTC timestamps so
 * the mailbox can show "no mail received while offline" labels between emails.
 *
 * Stored under `connectivityLog`. Events are compact `[type, tsMs]` tuples,
 * capped to the most recent entries to bound storage growth.
 */
import { browser } from 'wxt/browser';

export type ConnectivityEventType = 'online' | 'offline';
export type ConnectivityEvent = readonly [type: ConnectivityEventType, tsMs: number];

const STORAGE_KEY = 'connectivityLog';
const MAX_EVENTS = 200;

/** Prune overlapping / redundant consecutive events (e.g. online→online). */
function normalize(events: ConnectivityEvent[]): ConnectivityEvent[] {
  const out: ConnectivityEvent[] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (last && last[0] === ev[0]) {
      // Collapse consecutive same-type events into one (keep the latest ts).
      out[out.length - 1] = [ev[0], ev[1]];
    } else {
      out.push(ev);
    }
  }
  return out.slice(-MAX_EVENTS);
}

export async function getConnectivityLog(): Promise<ConnectivityEvent[]> {
  try {
    const res = (await browser.storage.local.get([STORAGE_KEY])) as {
      connectivityLog?: ConnectivityEvent[];
    };
    const raw = res.connectivityLog;
    if (!Array.isArray(raw)) return [];
    return normalize(
      raw.filter(
        (e): e is ConnectivityEvent =>
          Array.isArray(e) &&
          e.length === 2 &&
          (e[0] === 'online' || e[0] === 'offline') &&
          typeof e[1] === 'number'
      )
    );
  } catch {
    return [];
  }
}

/** Append an online/offline event (deduped) and persist. */
export async function recordConnectivityEvent(type: ConnectivityEventType): Promise<void> {
  try {
    const events = await getConnectivityLog();
    events.push([type, Date.now()]);
    await browser.storage.local.set({ connectivityLog: normalize(events) });
  } catch {
    /* ignore */
  }
}

/**
 * Build the list of offline intervals relevant to a time range [fromTs, toTs].
 * Each interval is `{ fromTs, toTs }` where both are clipped to the range.
 * Consecutive offline events (offline→online) define intervals; a trailing
 * offline event with no matching online is "offline until now".
 */
export function getOfflineIntervalsInRange(
  events: ConnectivityEvent[],
  fromTs: number,
  toTs: number
): Array<{ fromTs: number; toTs: number }> {
  const intervals: Array<{ fromTs: number; toTs: number }> = [];
  let offlineStart: number | null = null;

  for (const [type, ts] of events) {
    if (type === 'offline') {
      offlineStart = ts;
    } else if (type === 'online' && offlineStart !== null) {
      const start = Math.max(offlineStart, fromTs);
      const end = Math.min(ts, toTs);
      if (start < end) intervals.push({ fromTs: start, toTs: end });
      offlineStart = null;
    }
  }
  // Trailing offline (no matching online yet) — assume it extends to toTs.
  if (offlineStart !== null) {
    const start = Math.max(offlineStart, fromTs);
    if (start < toTs) intervals.push({ fromTs: start, toTs: toTs });
  }
  return intervals;
}

/**
 * True when the time range [fromTs, toTs] is FULLY covered by offline periods.
 * If any part of the range was online (or a mail could have arrived), false —
 * this implements the "don't label gaps where mail is actually present" rule.
 */
export function isRangeFullyOffline(
  events: ConnectivityEvent[],
  fromTs: number,
  toTs: number
): boolean {
  if (fromTs >= toTs) return false;
  const intervals = getOfflineIntervalsInRange(events, fromTs, toTs);
  // Sort and merge; the range is fully offline if the merged coverage spans it.
  const sorted = [...intervals].sort((a, b) => a.fromTs - b.fromTs);
  let coveredUntil = fromTs;
  for (const iv of sorted) {
    if (iv.fromTs > coveredUntil) return false; // online gap inside the range
    coveredUntil = Math.max(coveredUntil, iv.toTs);
  }
  return coveredUntil >= toTs;
}
