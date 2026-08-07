/**
 * Site blocklist learning — count autofill failures; suggest block after N.
 */

import { browser } from 'wxt/browser';
import { isDomainBlocked } from '@/utils/autofill-blocklist.js';
import { loadSmartAutofillSettings } from './smart-settings.js';
import { normalizeDomain } from './storage.js';

const KEY = 'autofillFailureCounts_v1';
const SUGGEST_KEY = 'autofillBlockSuggestions_v1';

export async function recordAutofillFailure(domain: string): Promise<{
  count: number;
  shouldSuggestBlock: boolean;
}> {
  const d = normalizeDomain(domain);
  if (!d) return { count: 0, shouldSuggestBlock: false };
  const isBlocked = await isDomainBlocked(d);
  if (isBlocked) return { count: 0, shouldSuggestBlock: false };

  const { autofillBlocklist = [] } = (await browser.storage.local.get(['autofillBlocklist'])) as {
    autofillBlocklist?: string[];
  };
  const isSubdomainBlocked = autofillBlocklist.some(
    (entry: string) => d !== entry && d.endsWith(`.${entry}`)
  );
  if (isSubdomainBlocked) return { count: 0, shouldSuggestBlock: false };

  const settings = await loadSmartAutofillSettings();
  const res = (await browser.storage.local.get([KEY])) as {
    [KEY]?: Record<string, number>;
  };
  const map = res[KEY] || {};
  map[d] = (map[d] || 0) + 1;
  await browser.storage.local.set({ [KEY]: map });

  const shouldSuggest = map[d] >= (settings.blockSuggestAfterFailures || 3);
  if (shouldSuggest) {
    const sug = (await browser.storage.local.get([SUGGEST_KEY])) as {
      [SUGGEST_KEY]?: string[];
    };
    const list = new Set(sug[SUGGEST_KEY] || []);
    list.add(d);
    await browser.storage.local.set({ [SUGGEST_KEY]: [...list].slice(0, 40) });
  }
  return { count: map[d], shouldSuggestBlock: shouldSuggest };
}

export async function recordAutofillSuccess(domain: string): Promise<void> {
  const d = normalizeDomain(domain);
  if (!d) return;
  try {
    const res = (await browser.storage.local.get([KEY, SUGGEST_KEY])) as {
      [KEY]?: Record<string, number>;
      [SUGGEST_KEY]?: string[];
    };
    const map = { ...(res[KEY] || {}) };
    delete map[d];
    const sug = (res[SUGGEST_KEY] || []).filter((x) => x !== d);
    await browser.storage.local.set({ [KEY]: map, [SUGGEST_KEY]: sug });
  } catch {
    /* ignore */
  }
}

export async function getBlockSuggestions(): Promise<string[]> {
  try {
    const res = (await browser.storage.local.get([SUGGEST_KEY])) as {
      [SUGGEST_KEY]?: string[];
    };
    return res[SUGGEST_KEY] || [];
  } catch {
    /* ignore */
    return [];
  }
}

export async function dismissBlockSuggestion(domain: string): Promise<void> {
  const d = normalizeDomain(domain);
  const list = (await getBlockSuggestions()).filter((x) => x !== d);
  await browser.storage.local.set({ [SUGGEST_KEY]: list });
  // Reset failure count so we don't re-suggest immediately
  try {
    const res = (await browser.storage.local.get([KEY])) as { [KEY]?: Record<string, number> };
    const map = { ...(res[KEY] || {}) };
    delete map[d];
    await browser.storage.local.set({ [KEY]: map });
  } catch {
    /* ignore */
  }
}

export async function acceptBlockSuggestion(domain: string): Promise<void> {
  const d = normalizeDomain(domain);
  const { autofillBlocklist = [] } = (await browser.storage.local.get(['autofillBlocklist'])) as {
    autofillBlocklist?: string[];
  };
  if (!autofillBlocklist.includes(d)) {
    await browser.storage.local.set({ autofillBlocklist: [...autofillBlocklist, d] });
  }
  await dismissBlockSuggestion(d);
}
