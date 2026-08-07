import type { Account } from '@/utils/types.js';

export type AccountTagEntry = { name: string; color: string };

const DEFAULT_TAG_COLOR = '#6366F1';

/** Get tags list for an account (v3.0.0 multi-tag schema). */
export function accountTagsList(account: Account | null | undefined): AccountTagEntry[] {
  if (!account || !Array.isArray(account.tags)) return [];
  return account.tags
    .filter((t) => t?.name?.trim())
    .map((t) => ({ name: t.name.trim(), color: t.color || DEFAULT_TAG_COLOR }));
}

/** True if any tag name matches (case-insensitive substring). */
export function accountMatchesTagSearch(account: Account, search: string): boolean {
  if (!search) return true;
  const q = search.toLowerCase();
  return accountTagsList(account).some((t) => t.name.toLowerCase().includes(q));
}
