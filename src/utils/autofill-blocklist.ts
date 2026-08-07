/**
 * Lightweight domain blocklist check for content scripts.
 *
 * This module exists separately from `storage-keys.ts` to avoid pulling in
 * the entire `email-service.ts` → `providers.jsonc` chain (~60 KB) into the
 * content-script bundle. Only the `autofillBlocklist` string array is needed.
 */

import { browser } from 'wxt/browser';

/** Returns the autofill blocklist (list of blocked domain strings). */
export async function getAutofillBlocklist(): Promise<string[]> {
  const { autofillBlocklist = [] } = (await browser.storage.local.get(['autofillBlocklist'])) as {
    autofillBlocklist?: string[];
  };
  return autofillBlocklist;
}

/** Check if a domain is in the autofill blocklist. */
export async function isDomainBlocked(domain: string): Promise<boolean> {
  const blocklist = await getAutofillBlocklist();
  return blocklist.includes(domain);
}
