import { filterEmails } from '@/features/inbox/email-filters.js';
import { logError } from '@/utils/logger.js';
import { parseSearchShortcuts } from '@/utils/search-shortcuts.js';
import type { Email, SavedSearchFilter } from '@/utils/types.js';

export interface FilterCriteria {
  searchQuery: string;
  otpOnly: boolean;
  hasAttachment: boolean;
  senderDomain: string;
  senderEmail: string;
  recipient: string;
  subject: string;
  /** Exclude emails from this sender domain (!from:domain) */
  notSenderDomain: string;
  /** Exclude emails from this sender email (!from:email) */
  notSenderEmail: string;
  /** Exclude emails to this recipient (!to:address) */
  notRecipient: string;
  /** Exclude emails whose subject contains this text (!subject:text) */
  notSubject: string;
  selectedSenders: string[];
  dateFrom: string;
  dateTo: string;
  sortBy: string;
  emailTagsById?: Record<string, string[]>;
}

export interface EmailFiltersState {
  /** Current search query */
  searchQuery: string;
  /** OTP-only filter */
  otpOnly: boolean;
  /** Has-attachment filter */
  hasAttachment: boolean;
  /** Sender domain filter */
  senderDomain: string;
  /** Selected senders */
  selectedSenders: string[];
  /** Date from filter */
  dateFrom: string;
  /** Date to filter */
  dateTo: string;
  /** Sort option */
  sortBy: string;
  /** Saved filters */
  savedSearchFilters: SavedSearchFilter[];
}

export interface EmailFiltersResult {
  /** Filtered and sorted emails */
  filteredEmails: Email[];
  /** Current filter criteria */
  criteria: FilterCriteria;
  /** Whether any filter is active */
  hasActiveFilter: boolean;
}

/**
 * Apply filter criteria to an email list.
 * Pure function - no side effects.
 */
export function applyFilters(emails: Email[], criteria: FilterCriteria): Email[] {
  return filterEmails(emails, criteria);
}

/**
 * Check if any non-default filter is active.
 */
export function hasActiveFilter(criteria: FilterCriteria): boolean {
  return (
    criteria.searchQuery !== '' ||
    criteria.otpOnly ||
    criteria.hasAttachment ||
    criteria.senderDomain !== '' ||
    criteria.senderEmail !== '' ||
    criteria.recipient !== '' ||
    criteria.subject !== '' ||
    criteria.notSenderDomain !== '' ||
    criteria.notSenderEmail !== '' ||
    criteria.notRecipient !== '' ||
    criteria.notSubject !== '' ||
    criteria.selectedSenders.length > 0 ||
    criteria.dateFrom !== '' ||
    criteria.dateTo !== '' ||
    criteria.sortBy !== 'newest'
  );
}

/**
 * Parse search query with shortcuts and apply to filter criteria.
 * This function takes a raw search query and returns updated filter criteria
 * with shortcuts extracted and applied.
 *
 * @param rawQuery - The raw search query string (may contain shortcuts)
 * @param currentCriteria - Current filter criteria to update
 * @returns Updated filter criteria with shortcuts applied
 */
export function applySearchShortcuts(
  rawQuery: string,
  currentCriteria: FilterCriteria
): FilterCriteria {
  const parsed = parseSearchShortcuts(rawQuery);

  return {
    ...currentCriteria,
    searchQuery: parsed.searchQuery,
    // Explicit shortcut wins; absent shortcut leaves the current state alone
    otpOnly: parsed.otpOnlySet ? parsed.otpOnly : currentCriteria.otpOnly,
    hasAttachment: parsed.hasAttachmentSet ? parsed.hasAttachment : currentCriteria.hasAttachment,
    // Value shortcuts (from:/to:/subject: and their negated ! forms) are the
    // ONLY writers of these fields — there are no dedicated chips — so the raw
    // query is the source of truth: a present token sets it, an absent token
    // clears it. This makes pill removal round-trip cleanly.
    senderDomain: parsed.senderDomainSet ? parsed.senderDomain : '',
    senderEmail: parsed.senderDomainSet ? parsed.senderEmail : '',
    recipient: parsed.recipientSet ? parsed.recipient : '',
    subject: parsed.subjectSet ? parsed.subject : '',
    notSenderDomain: parsed.senderDomainSet ? parsed.notSenderDomain : '',
    notSenderEmail: parsed.senderDomainSet ? parsed.notSenderEmail : '',
    notRecipient: parsed.recipientSet ? parsed.notRecipient : '',
    notSubject: parsed.subjectSet ? parsed.notSubject : '',
  };
}

/**
 * Load saved filters from extension storage.
 */
export async function loadSavedFilters(
  storage: typeof browser.storage.local
): Promise<SavedSearchFilter[]> {
  try {
    const result = await storage.get(['savedSearchFilters']);
    const filters = (result as Record<string, unknown>).savedSearchFilters;
    if (Array.isArray(filters)) {
      return filters as SavedSearchFilter[];
    }
    return [];
  } catch (e) {
    logError('Error loading saved filters', {
      message: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * Save a new filter to storage.
 * Returns the updated filters array.
 */
/** Normalize filter identity for uniqueness checks (ignore id/name/timestamps). */
export function filterSignature(f: {
  searchQuery?: string;
  hasOTP?: boolean;
  hasAttachment?: boolean;
  senderDomain?: string;
  dateFrom?: string;
  dateTo?: string;
  selectedSenders?: string[];
  sortBy?: string;
  recipient?: string;
  subject?: string;
  notSenderDomain?: string;
  notSenderEmail?: string;
  notRecipient?: string;
  notSubject?: string;
}): string {
  return JSON.stringify({
    q: (f.searchQuery || '').trim().toLowerCase(),
    otp: !!f.hasOTP,
    att: !!f.hasAttachment,
    domain: (f.senderDomain || '').trim().toLowerCase(),
    from: f.dateFrom || '',
    to: f.dateTo || '',
    senders: [...(f.selectedSenders || [])].map((s) => s.toLowerCase()).sort(),
    sort: f.sortBy || '',
    recipient: (f.recipient || '').toLowerCase(),
    subject: (f.subject || '').toLowerCase(),
    notDomain: (f.notSenderDomain || '').trim().toLowerCase(),
    notEmail: (f.notSenderEmail || '').toLowerCase(),
    notRecipient: (f.notRecipient || '').toLowerCase(),
    notSubject: (f.notSubject || '').toLowerCase(),
  });
}

export async function saveFilterToStorage(
  storage: typeof browser.storage.local,
  existingFilters: SavedSearchFilter[],
  filter: SavedSearchFilter
): Promise<SavedSearchFilter[]> {
  try {
    const sig = filterSignature(filter);
    const isDup = existingFilters.some((f) => filterSignature(f) === sig);
    if (isDup) {
      // Return existing list unchanged — caller should toast “already exists”
      return existingFilters.map((f) => ({ ...f }));
    }
    const updated = [...existingFilters.map((f) => ({ ...f })), filter];
    await storage.set({ savedSearchFilters: JSON.parse(JSON.stringify(updated)) });
    return updated;
  } catch (e) {
    logError('Error saving filter', { message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * Delete a filter from storage.
 * Returns the updated filters array.
 */
export async function deleteFilterFromStorage(
  storage: typeof browser.storage.local,
  existingFilters: SavedSearchFilter[],
  filterId: string
): Promise<SavedSearchFilter[]> {
  try {
    const updated = existingFilters.filter((f) => f.id !== filterId).map((f) => ({ ...f }));
    await storage.set({ savedSearchFilters: JSON.parse(JSON.stringify(updated)) });
    return updated;
  } catch (e) {
    logError('Error deleting filter', { message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * Rename a filter in storage.
 * Returns the updated filters array.
 */
export async function renameFilterInStorage(
  storage: typeof browser.storage.local,
  existingFilters: SavedSearchFilter[],
  filterId: string,
  newName: string
): Promise<SavedSearchFilter[]> {
  try {
    const updated = existingFilters.map((f) =>
      f.id === filterId ? { ...f, name: newName } : { ...f }
    );
    await storage.set({ savedSearchFilters: JSON.parse(JSON.stringify(updated)) });
    return updated;
  } catch (e) {
    logError('Error renaming filter', { message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

/**
 * Create a new saved filter object.
 */
export function createFilter(
  name: string,
  searchQuery: string,
  hasOTP: boolean,
  hasAttachment: boolean,
  senderDomain: string,
  dateFrom: string,
  dateTo: string,
  selectedSenders: string[] = [],
  sortBy: string = 'newest',
  recipient: string = '',
  subject: string = '',
  notSenderDomain: string = '',
  notSenderEmail: string = '',
  notRecipient: string = '',
  notSubject: string = ''
): SavedSearchFilter {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  return {
    id: uuid,
    name,
    searchQuery,
    hasOTP,
    hasAttachment,
    senderDomain,
    selectedSenders,
    dateFrom,
    dateTo,
    sortBy,
    recipient,
    subject,
    notSenderDomain,
    notSenderEmail,
    notRecipient,
    notSubject,
    createdAt: Date.now(),
  };
}

/**
 * Build a SavedSearchFilter from current criteria.
 */
export function buildFilterFromCriteria(name: string, criteria: FilterCriteria): SavedSearchFilter {
  return createFilter(
    name,
    criteria.searchQuery,
    criteria.otpOnly,
    criteria.hasAttachment,
    criteria.senderDomain,
    criteria.dateFrom,
    criteria.dateTo,
    criteria.selectedSenders,
    criteria.sortBy,
    criteria.recipient,
    criteria.subject,
    criteria.notSenderDomain,
    criteria.notSenderEmail,
    criteria.notRecipient,
    criteria.notSubject
  );
}

/**
 * Extract filter criteria from a SavedSearchFilter.
 */
export function extractCriteriaFromFilter(filter: SavedSearchFilter): Partial<FilterCriteria> {
  return {
    searchQuery: filter.searchQuery,
    otpOnly: filter.hasOTP,
    hasAttachment: !!filter.hasAttachment,
    senderDomain: filter.senderDomain,
    selectedSenders: filter.selectedSenders || [],
    dateFrom: filter.dateFrom,
    dateTo: filter.dateTo,
    sortBy: filter.sortBy || 'newest',
    recipient: filter.recipient || '',
    subject: filter.subject || '',
    notSenderDomain: filter.notSenderDomain || '',
    notSenderEmail: filter.notSenderEmail || '',
    notRecipient: filter.notRecipient || '',
    notSubject: filter.notSubject || '',
  };
}
