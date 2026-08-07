<script lang="ts">
import { onDestroy, onMount, tick, untrack } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import {
  getSelectedIdentity,
  loadIdentities,
  selectIdentity,
} from '@/features/identities/identity-actions.js';
import { filterEmails } from '@/features/inbox/email-filters.js';
import { canUnarchive } from '@/features/inbox/inbox-management.js';
import AccountCard from '@/ui/blocks/account/AccountCard.svelte';
import AccountSelector from '@/ui/blocks/account/AccountSelectorBar.svelte';
import TagDialog from '@/ui/blocks/dialogs/TagDialog.svelte';
import FilterList from '@/ui/blocks/mail/FilterList.svelte';
import SelectionToolbar from '@/ui/blocks/mail/SelectionToolbar.svelte';
import EmptyState from '@/ui/components/composites/EmptyState.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Checkbox, Toggle } from '@/ui/components/primitives';
import AutoRenewToggle from '@/ui/components/primitives/AutoRenewToggle.svelte';
import FaviconImage from '@/ui/components/primitives/FaviconImage.svelte';
import Skeleton from '@/ui/components/primitives/Skeleton.svelte';
import TagPill from '@/ui/components/primitives/TagPill.svelte';
import { AVATAR_MUTED, avatarColor } from '@/utils/avatar-color.js';
import { copyToClipboardAndSchedulePurge } from '@/utils/clipboard.js';
import {
  type ConnectivityEvent,
  getConnectivityLog,
  isRangeFullyOffline,
} from '@/utils/connectivity-log.js';
import {
  DEFAULT_PROVIDER,
  loadAllProviderConfigs,
  loadProviderConfig,
} from '@/utils/email-service.js';
import { isEmailStarred, starKeyForEmail, toggleStarInSet } from '@/utils/email-star-key.js';
import { emailTagsStore } from '@/utils/email-tags-store.js';
import type { EmailThread } from '@/utils/email-threads.js';
import { groupEmailsByThread } from '@/utils/email-threads.js';
import {
  getRootDomain,
  getSafeDomainFaviconUrl,
  getSafeRootDomainFaviconUrl,
} from '@/utils/favicon.js';
import { fitActionButtonsLayout, fitButtonsLabelFont } from '@/utils/fit-label-font.js';
import { logError } from '@/utils/logger.js';
import {
  collectIntersectingIds,
  isInteractiveTarget,
  isMarqueeSelectionEnabled,
  MARQUEE_THRESHOLD,
  normalizeMarquee,
} from '@/utils/marquee-selection.js';
import { formatRemaining } from '@/utils/otp-magic-expiry.js';
import { PORTAL_Z_CLASS, portalToBody } from '@/utils/portal-layers.js';
import { htmlToPlainText } from '@/utils/sanitize-html.js';
import {
  highlightMatches,
  parseSearchShortcuts,
  SHORTCUT_REGEX,
} from '@/utils/search-shortcuts.js';
import { toMs } from '@/utils/time.js';
import { formatFullDateTime, timeAgo } from '@/utils/time-format.js';
import { useCurrentTime } from '@/utils/time-store.js';
import type { Account, Email, Identity, SavedSearchFilter } from '@/utils/types.js';

let otpCollapsed = $state(false);
let otpDropupOpen = $state(false);
/** Dynamic font & layout for mailbox action row labels (single-line, no truncate/wrap) */
let actionBtnFontPx = $state(12);
let actionBtnEqualWidth = $state(true);
let actionRowEl = $state<HTMLElement | null>(null);

// Renewal strip state - session-only dismissal. Re-appears on reload.
let renewalStripDismissed = $state(false);
let renewalStripCollapsed = $state(false);

type OtpHistoryItem = {
  otp: string;
  from: string;
  from_name: string;
  received_at: number;
  inboxAddress: string;
};

let otpHistoryCurrent = $state<OtpHistoryItem[]>([]);
let otpHistoryOther = $state<OtpHistoryItem[]>([]);

// Identity state
let identities = $state<Identity[]>([]);
let selectedIdentityId = $state<string | null>(null);
let showAutofillStrip = $state(true);
let showSavedLoginStrip = $state(true);
let showMagicLinkStrip = $state(true);
let showFilterAppliedStrip = $state(true);
/** Hide "Save as filter" after a successful quick-save */
let filterQuickSaved = $state(false);
/** Inbox lifecycle intelligence suggestions for current / all accounts */
let lifecycleHints = $state<
  Array<{ kind: string; inboxId: string; address: string; reasonKey: string; score: number }>
>([]);
let lifecycleHintDismissed = $state(false);
/** Layout prefs: allow user to hide bottom strips permanently until re-enabled */
let preferHideOtpStrip = $state(false);
let preferHideAutofillStrip = $state(false);
let preferHideMagicStrip = $state(false);
let currentDomain = $state<string>('');
let showIdentityDropdown = $state(false);

// Track which bottom strip should be in front
let frontStrip = $state<'autofill' | 'otp' | 'savedLogin' | 'magic' | 'filter'>('autofill');

// Track previous values to detect actual changes - plain let, NOT $state,
// so mutations inside $effect don't re-trigger the effect.
let _prevFormDetected = false;
let _prevLatestOtp = '------';
let _prevLatestOtpEmailId = '';

// React to prop changes: formDetected change → autofill front; new OTP → otp front.
// "Last changed wins" - visiting a site always overrides a prior OTP.
$effect(() => {
  // Read reactive props (tracked by Svelte)
  const fd = formDetected;
  const otp = latestOtp;
  const otpEmailId = latestLiveOtp?.email?.id || '';

  untrack(() => {
    // Read prev-values (NOT tracked - plain let)
    const formJustDetected = fd && !_prevFormDetected;
    const newOtpArrived =
      otp !== '------' &&
      (otp !== _prevLatestOtp || (otpEmailId && otpEmailId !== _prevLatestOtpEmailId));

    if (formJustDetected) {
      // Visiting a site always brings autofill to front, regardless of OTP
      frontStrip = 'autofill';
    } else if (newOtpArrived) {
      // New OTP arrived (and no simultaneous form detection)
      frontStrip = 'otp';
    }

    untrack(() => {
      // Update prev values (not $state - no reactivity triggered)
      _prevFormDetected = fd;
      _prevLatestOtp = otp;
      _prevLatestOtpEmailId = otpEmailId;
    });
  });
});

// Load all providers dynamically from config
let allProviders = $derived.by(() => loadAllProviderConfigs());

async function loadOtpHistory() {
  try {
    const { storedEmails = {}, inboxes = [] } = (await browser.storage.local.get([
      'storedEmails',
      'inboxes',
    ])) as {
      storedEmails?: Record<string, Email[]>;
      inboxes?: Account[];
    };
    const current: OtpHistoryItem[] = [];
    const other: OtpHistoryItem[] = [];
    // Normalize selection (domain display alias + case) so OTPs never land in wrong section
    const selectedNorm = (selectedEmail || '').toLowerCase();
    const displayedNorm = (displayedEmail || '').toLowerCase();
    const currentLocal = selectedNorm.split('@')[0] || '';
    // Restrict multi-domain alias match to same provider (avoid cross-provider local-part bleed)
    const currentProvider =
      currentAccount?.provider ||
      inboxes.find((i) => (i.address || '').toLowerCase() === selectedNorm)?.provider ||
      '';
    const providerByAddress = new Map(
      inboxes.map((i) => [(i.address || '').toLowerCase(), i.provider || ''] as const)
    );
    for (const [addr, msgs] of Object.entries(storedEmails)) {
      const addrNorm = (addr || '').toLowerCase();
      const addrProvider = providerByAddress.get(addrNorm) || '';
      for (const m of msgs.slice(0, 15)) {
        if (!m.otp) continue;
        const item: OtpHistoryItem = {
          otp: m.otp,
          from:
            (m as Email & { from_address?: string }).from_address || m.from || m.from_name || '',
          from_name: m.from_name || '',
          received_at: m.received_at,
          inboxAddress: addr,
        };
        const orig = (
          (m as Email & { original_inbox?: string }).original_inbox || ''
        ).toLowerCase();
        const sameExact =
          addrNorm === selectedNorm ||
          addrNorm === displayedNorm ||
          (!!orig && (orig === selectedNorm || orig === displayedNorm));
        // Multi-domain alias only when same provider (abc@x.com vs abc@y.com on one provider)
        const sameProviderAlias =
          !!currentLocal &&
          addrNorm.startsWith(`${currentLocal}@`) &&
          !!currentProvider &&
          addrProvider === currentProvider;
        const isCurrent = sameExact || sameProviderAlias;
        if (isCurrent) {
          current.push(item);
        } else {
          other.push(item);
        }
      }
    }
    current.sort((a, b) => b.received_at - a.received_at);
    other.sort((a, b) => b.received_at - a.received_at);
    otpHistoryCurrent = current.slice(0, 50);
    otpHistoryOther = other.slice(0, 50);
  } catch (error: unknown) {
    logError(
      'Failed to load OTP history:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

function toggleOtpDropup() {
  otpDropupOpen = !otpDropupOpen;
  if (otpDropupOpen) loadOtpHistory();
}

async function clearAllOtps() {
  if (!showConfirm) {
    await doClearAllOtps();
    return;
  }
  showConfirm($t('inbox.confirmClearAllOtps'), doClearAllOtps);
}

async function doClearAllOtps() {
  try {
    const response = await browser.runtime.sendMessage({ type: 'clearAllOtps' });
    if (response && !response.success) {
      throw new Error(response.error || 'Failed to clear OTPs');
    }
    otpHistoryCurrent = [];
    otpHistoryOther = [];
    showToast($t('inbox.otpsCleared'));
  } catch (error: unknown) {
    logError(
      'Failed to clear OTPs:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

async function loadIdentitiesData() {
  try {
    const { identities: storedIdentities = [], selectedIdentityId: storedSelectedId } =
      (await browser.storage.local.get(['identities', 'selectedIdentityId'])) as {
        identities?: Identity[];
        selectedIdentityId?: string;
      };

    identities = storedIdentities;
    selectedIdentityId = storedSelectedId || storedIdentities[0]?.id || null;
  } catch (error: unknown) {
    logError(
      'Failed to load identities:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
    // Set defaults to prevent UI crashes
    identities = [];
    selectedIdentityId = null;
  }
}

async function handleIdentityChange() {
  if (selectedIdentityId) {
    await browser.storage.local.set({ selectedIdentityId });
  }
}

// Load identities on mount
loadIdentitiesData();

// Get current tab domain
async function getCurrentTabDomain() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const url = new URL(tab.url);
      currentDomain = url.hostname;
    }
  } catch (error: unknown) {
    logError(
      'Failed to get current tab domain:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

let otpOptInList = $state<string[]>([]);
let isOtpOptedIn = $derived(
  currentDomain
    ? otpOptInList.some(
        (d) =>
          typeof d === 'string' &&
          d.toLowerCase() === currentDomain.replace(/^www\./, '').toLowerCase()
      )
    : false
);

async function loadOtpOptInList() {
  try {
    const res = await browser.storage.local.get(['otpOptInList']);
    otpOptInList = Array.isArray(res.otpOptInList) ? res.otpOptInList : [];
  } catch (error) {
    logError('Failed to load OTP opt-in list', error);
  }
}

async function toggleOtpOptIn() {
  if (!currentDomain) return;
  const domainKey = currentDomain.replace(/^www\./, '').toLowerCase();
  let updated: string[];
  if (isOtpOptedIn) {
    updated = otpOptInList.filter((d) => typeof d === 'string' && d.toLowerCase() !== domainKey);
  } else {
    updated = [...otpOptInList, domainKey];
  }
  otpOptInList = updated;
  await browser.storage.local.set({ otpOptInList: updated });
  showToast(
    $t(isOtpOptedIn ? 'toasts.otpAutofillEnabled' : 'toasts.otpAutofillDisabled'),
    'success'
  );
}

onMount(() => {
  loadOtpOptInList();

  const handleStorageChange = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>
  ) => {
    if (changes.otpOptInList) {
      const newValue = changes.otpOptInList.newValue;
      otpOptInList = Array.isArray(newValue) ? (newValue as string[]) : [];
    }
  };
  browser.storage.onChanged.addListener(handleStorageChange);

  return () => {
    browser.storage.onChanged.removeListener(handleStorageChange);
  };
});

getCurrentTabDomain();

// Auto-suggest identity based on domain hints
let domainHintApplied = false;

$effect(() => {
  if (domainHintApplied || !currentDomain || identities.length === 0) return;
  const rootDomain = getRootDomain(currentDomain);
  const match = identities.find((i) =>
    i.domainHints?.some((h) => h === rootDomain || h === currentDomain)
  );
  if (match && match.id !== selectedIdentityId) {
    selectedIdentityId = match.id;
    handleIdentityChange();
  }
  domainHintApplied = true;
});

function domainMatchesHost(loginDomain: string, host: string): boolean {
  const a = (loginDomain || '').toLowerCase().replace(/^www\./, '');
  const b = (host || '').toLowerCase().replace(/^www\./, '');
  if (!a || !b) return false;
  return a === b || b.endsWith(`.${a}`) || a.endsWith(`.${b}`);
}

function formatOtp(otp: string): string {
  const clean = otp.replace(/\s/g, '');
  if (clean.length === 6) return `${clean.slice(0, 3)} ${clean.slice(3)}`;
  if (clean.length === 8) return `${clean.slice(0, 4)} ${clean.slice(4)}`;
  return otp;
}

/** Email list filter tab (Inbox / Archived / Deleted / Saved Offline / All mails) */
type EmailListTab = 'inbox' | 'archived' | 'deleted' | 'storedLocally' | 'all';

let {
  context = 'popup',
  selectedEmail = '',
  displayedEmail = $bindable(''),
  accounts = [],
  allAccounts = [],
  loading = false,
  searchQuery = '',
  sortBy = 'newest',
  otpOnly = false,
  hasAttachment = false,
  senderDomain = '',
  senderEmail = '',
  recipient = '',
  subject = '',
  notSenderDomain = '',
  notSenderEmail = '',
  notRecipient = '',
  notSubject = '',
  selectedSenders = [] as string[],
  dateFrom = '',
  dateTo = '',
  notificationsEnabled = false,
  activeThreadMessageId = '',
  filteredEmails = [],
  emails = [],
  /** Folder tabs + label filter (bindable for sidebar control) */
  emailListTab = $bindable('inbox' as EmailListTab),
  activeLabelFilter = $bindable(null as string | null),
  /** When true, status chips only show while searching (sidebar owns them when wide) */
  hideListTabsUnlessSearch = false,
  /** All mailbox bags for cross-address search */
  allStoredEmails = {} as Record<string, Email[]>,
  latestOtp = '------',
  latestOtpSender = '',
  latestOtpSenderName = '',
  otpContext = '',
  formDetected = false,
  providerFailoverHint = null as null | {
    show: boolean;
    otherProvidersOk: boolean;
    nextRetryAt: number;
    failCount: number;
  },
  savedSearchFilters = [],
  savedLogins = [] as import('@/utils/types.js').CredentialsHistoryItem[],
  onSelectAccount = () => {},
  onCopyEmail = () => {},
  onOpenQrDialog = () => {},
  onCreateInbox = () => {},
  onAutofillForm = () => {},
  onRefreshInbox = async () => {},
  onToggleNotifications = () => {},
  onRefillSavedLogin = (_login: import('@/utils/types.js').CredentialsHistoryItem) => {},
  onSaveFilterQuick = () => {},
  onOpenMagicLink = (_url: string) => {},
  onArchiveAccount = () => {},
  onUnarchiveAccount = () => {},
  onRemoveAccount = () => {},
  onRestoreAccount = () => {},
  onReloadAccounts = async () => {},
  onEditAccount = () => {},
  onToggleAutoExtend = () => {},
  onExtendAccount = () => {},
  onOpenMessageDetail = () => {},
  onClearFilters = () => {},
  onCopyOtp = () => {},
  onCopyOtpFromMessage = () => {},
  onOpenArchivedEmails = () => {},
  onOpenExpiredEmails = () => {},
  onSearchChange = (_v: string) => {},
  onSortChange = (_v: string) => {},
  onOtpOnlyChange = () => {},
  onHasAttachmentChange = () => {},
  onSenderDomainChange = () => {},
  onSelectedSendersChange = (_v: string[]) => {},
  onDateFromChange = () => {},
  onDateToChange = () => {},
  onSaveFilter = (
    _name: string,
    _searchQuery: string,
    _hasOTP: boolean,
    _hasAttachment: boolean,
    _senderDomain: string,
    _dateFrom: string,
    _dateTo: string,
    _selectedSenders: string[],
    _sortBy: string
  ) => {},
  onLoadFilter = (_filter: SavedSearchFilter) => {},
  onRenameFilter = (_id: string, _name: string) => {},
  onDeleteFilter = (_id: string) => {},
  onNavigateToSettings = () => {},
  onNavigateToManage = () => {},
  onArchiveEmails = (_emails: Email[]) => {},
  onDeleteEmails = (_emails: Email[]) => {},
  onRestoreEmails = (_emails: Email[]) => {},
  autoRenew = false,
  onToggleAutoRenew = () => {},
  defaultDomain = '',
  dropdownOpen = undefined,
  openSection = undefined,
  onDropdownOpenChange = (_open: boolean) => {},
  onCreateInboxWithProvider = () => {},
  showToast = (_message: string, _type?: string, _undo?: (() => void | Promise<void>) | null) => {},
  showConfirm = (_message: string, _onConfirm: () => void) => {},
  selectedProviderInstance = null as string | null,
  emailPreviewEnabled = true,
  highlightedEmailId = '',
  onSelectionChange = (_state: {
    mode: boolean;
    count: number;
    canArchive: boolean;
    canDelete: boolean;
    canRestore: boolean;
  }) => {},
  selectionApi = $bindable({
    cancel: () => {},
    archive: () => {},
    delete: () => {},
    restore: () => {},
    star: () => {},
    label: () => {},
    selectAll: () => {},
    deselectAll: () => {},
    applyLabel: async (_lab: string) => {},
  }),
  externalSelectionBar = false,
  gesturesEnabled = true,
  onScrollDirection = (_dir: 'up' | 'down') => {},
  loadMoreEmails: externalLoadMoreEmails = () => {},
}: {
  context?: 'popup' | 'sidepanel' | 'app';
  selectedEmail?: string;
  displayedEmail?: string;
  dropdownOpen?: boolean;
  accounts?: Account[];
  allAccounts?: Account[];
  loading?: boolean;
  searchQuery?: string;
  sortBy?: string;
  otpOnly?: boolean;
  hasAttachment?: boolean;
  senderDomain?: string;
  senderEmail?: string;
  recipient?: string;
  subject?: string;
  notSenderDomain?: string;
  notSenderEmail?: string;
  notRecipient?: string;
  notSubject?: string;
  selectedSenders?: string[];
  dateFrom?: string;
  dateTo?: string;
  notificationsEnabled?: boolean;
  activeThreadMessageId?: string;
  filteredEmails?: Email[];
  emails?: Email[];
  emailListTab?: EmailListTab;
  activeLabelFilter?: string | null;
  hideListTabsUnlessSearch?: boolean;
  allStoredEmails?: Record<string, Email[]>;
  latestOtp?: string;
  latestOtpSender?: string;
  latestOtpSenderName?: string;
  otpContext?: string;
  formDetected?: boolean;
  providerFailoverHint?: null | {
    show: boolean;
    otherProvidersOk: boolean;
    nextRetryAt: number;
    failCount: number;
  };
  savedSearchFilters?: SavedSearchFilter[];
  savedLogins?: import('@/utils/types.js').CredentialsHistoryItem[];
  onSelectAccount?: (email: string) => void;
  onCopyEmail?: () => void;
  onOpenQrDialog?: () => void;
  onCreateInbox?: (provider?: string, instanceId?: string) => void;
  onAutofillForm?: () => void;
  onRefreshInbox?: () => Promise<void>;
  onToggleNotifications?: () => void;
  onRefillSavedLogin?: (login: import('@/utils/types.js').CredentialsHistoryItem) => void;
  onSaveFilterQuick?: () => void;
  onOpenMagicLink?: (url: string) => void;
  onArchiveAccount?: (account: Account) => void;
  onUnarchiveAccount?: (account: Account) => void;
  onRemoveAccount?: (address: string) => void;
  onRestoreAccount?: (address: string) => void;
  onReloadAccounts?: (skipEmailSelection?: boolean) => Promise<void>;
  onEditAccount?: (account: Account) => void;
  onToggleAutoExtend?: (account: Account) => void | Promise<void>;
  onExtendAccount?: (account: Account) => void | Promise<void>;
  onOpenMessageDetail?: (thread: Email[]) => void;
  onSearchText?: (query: string) => void;
  onClearFilters?: () => void | Promise<void>;
  onCopyOtp?: () => void;
  onCopyOtpFromMessage?: (otp: string) => void;
  onOpenArchivedEmails?: () => void;
  onOpenExpiredEmails?: () => void;
  onSearchChange?: (v: string) => void;
  onSortChange?: (v: string) => void;
  onOtpOnlyChange?: (v: boolean) => void;
  onHasAttachmentChange?: (v: boolean) => void;
  onSenderDomainChange?: (v: string) => void;
  onSelectedSendersChange?: (v: string[]) => void;
  onDateFromChange?: (v: string) => void;
  showToast?: (message: string, type?: string, undo?: (() => void | Promise<void>) | null) => void;
  showConfirm?: (message: string, onConfirm: () => void) => void;
  onDateToChange?: (v: string) => void;
  onSaveFilter?: (
    name: string,
    searchQuery: string,
    hasOTP: boolean,
    hasAttachment: boolean,
    senderDomain: string,
    dateFrom: string,
    dateTo: string,
    selectedSenders: string[],
    sortBy: string,
    recipient: string,
    subject: string
  ) => void;
  onLoadFilter?: (filter: SavedSearchFilter) => void;
  onRenameFilter?: (id: string, name: string) => void;
  onDeleteFilter?: (id: string) => void;
  onNavigateToSettings?: () => void | Promise<void>;
  onNavigateToManage?: () => void | Promise<void>;
  onArchiveEmails?: (emails: Email[]) => void | Promise<void>;
  onDeleteEmails?: (emails: Email[]) => void | Promise<void>;
  onRestoreEmails?: (emails: Email[]) => void | Promise<void>;
  autoRenew?: boolean;
  onToggleAutoRenew?: () => void;
  defaultDomain?: string;
  openSection?: 'active' | 'archived' | 'expired' | null;
  onDropdownOpenChange?: (open: boolean) => void;
  onCreateInboxWithProvider?: (providerId: string, instanceId?: string) => void;
  selectedProviderInstance?: string | null;
  emailPreviewEnabled?: boolean;
  highlightedEmailId?: string;
  onSelectionChange?: (state: {
    mode: boolean;
    count: number;
    canArchive: boolean;
    canDelete: boolean;
    canRestore: boolean;
  }) => void;
  selectionApi?: {
    cancel: () => void;
    archive: () => void;
    delete: () => void;
    restore: () => void;
    star: () => void;
    label: () => void;
    selectAll: () => void;
    deselectAll: () => void;
    applyLabel: (lab: string) => Promise<void>;
  };
  externalSelectionBar?: boolean;
  gesturesEnabled?: boolean;
  onScrollDirection?: (dir: 'up' | 'down') => void;
  loadMoreEmails?: () => void;
} = $props();

/** Best matching saved login for the active tab domain */
let matchingSavedLogin = $derived.by(() => {
  if (!currentDomain || !Array.isArray(savedLogins) || savedLogins.length === 0) return null;
  const matches = savedLogins.filter((l) =>
    domainMatchesHost(String(l.domain || l.website || ''), currentDomain)
  );
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
});

/** Live (non-archived, non-deleted) emails only — strips must not use archived/deleted messages */
let liveEmails = $derived.by(() =>
  (Array.isArray(emails) ? emails : []).filter((e) => !e.local_archived && !e.local_deleted)
);

/** Latest magic link across live mailbox emails */
let latestMagicLink = $derived.by(() => {
  for (const e of liveEmails) {
    const links = e.magicLinks;
    if (Array.isArray(links) && links.length) {
      const link = links[0];
      return {
        url: link.url,
        host: link.host || '',
        email: e,
        expiresAt: (link as { expiresAt?: number }).expiresAt || e.otpExpiresAt || null,
      };
    }
  }
  return null;
});

/** Latest live OTP from current mailbox emails (ignores archived/deleted) */
let latestLiveOtp = $derived.by(() => {
  const latest = liveEmails.reduce(
    (max, e) => {
      if (e.otp && String(e.otp).trim() && e.otp !== '------') {
        if (!max || (e.received_at || 0) > (max.received_at || 0)) return e;
      }
      return max;
    },
    null as Email | null
  );

  if (!latest) return null;
  return {
    otp: String(latest.otp),
    sender: latest.from || '',
    senderName: latest.from_name || '',
    email: latest,
    expiresAt: latest.otpExpiresAt || null,
  };
});

let hasActiveListFilters = $derived(
  sortBy !== 'newest' ||
    otpOnly ||
    !!dateFrom ||
    !!dateTo ||
    (selectedSenders && selectedSenders.length > 0) ||
    !!senderDomain ||
    !!senderEmail ||
    !!searchQuery?.trim()
);

// Promote front strip only when the "winner" changes (avoid thrashing writes).
// Compare frontStrip via untrack so the write does not re-subscribe this effect.
$effect(() => {
  let next: typeof frontStrip | null = null;
  if (hasActiveListFilters) next = 'filter';
  else if (matchingSavedLogin) next = 'savedLogin';
  else if (latestMagicLink) next = 'magic';
  if (next) {
    const current = untrack(() => frontStrip);
    if (current !== next) frontStrip = next;
  }
  if (next === 'filter') {
    const showing = untrack(() => showFilterAppliedStrip);
    if (!showing) {
      untrack(() => {
        showFilterAppliedStrip = true;
        filterQuickSaved = false;
      });
    }
  }
});

// Lifecycle intelligence: recompute when accounts change
$effect(() => {
  const list = (allAccounts?.length ? allAccounts : accounts) || [];
  void list.length;
  void (async () => {
    try {
      const { suggestLifecycleActions, recomputeLifecycleFromStorage } = await import(
        '@/features/intelligence/inbox-lifecycle.js'
      );
      await recomputeLifecycleFromStorage(list as import('@/utils/types.js').Account[]);
      lifecycleHints = await suggestLifecycleActions(list as import('@/utils/types.js').Account[]);
    } catch {
      /* ignore */
      lifecycleHints = [];
    }
  })();
});

let otpSenderEmail = $derived(latestLiveOtp?.sender || latestOtpSender);

let latestOtpEmail = $derived(latestLiveOtp?.email ?? null);

/** OTP code shown in strip — never from archived/deleted messages */
let stripOtpCode = $derived(latestLiveOtp?.otp || '------');

let stripClockTick = $state(Date.now());
$effect(() => {
  const id = setInterval(() => {
    stripClockTick = Date.now();
  }, 30_000);
  return () => clearInterval(id);
});

let stripOtpRemaining = $derived.by(() => {
  void stripClockTick;
  const exp = latestLiveOtp?.expiresAt;
  if (!exp) return '';
  return formatRemaining(exp, stripClockTick);
});

let stripMagicRemaining = $derived.by(() => {
  void stripClockTick;
  const exp = latestMagicLink?.expiresAt;
  if (!exp) return '';
  return formatRemaining(exp, stripClockTick);
});

// Tag editing state
let tagDialogOpen = $state(false);
let actionRowCollapsed = $state(false);
let actionRowCollapsedInitialized = $state(false);
let accountSelectorHovered = $state(false);
let actionRowHovered = $state(false);
let searchBarFocused = $state(false);
/** Email count when search focus began — only count arrivals while focused */
let searchFocusEmailBaseline = $state(0);
let searchFocusNewMailCount = $state(0);
let tagTargetAccount = $state<Account | null>(null);

// Load actionRowCollapsed state from storage
async function loadActionRowCollapsedState() {
  try {
    const result = (await browser.storage.local.get(['actionRowCollapsed'])) as {
      actionRowCollapsed?: boolean;
    };
    if (result.actionRowCollapsed !== undefined) {
      actionRowCollapsed = result.actionRowCollapsed;
    }
  } catch (error) {
    logError(
      'Failed to load actionRowCollapsed state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  } finally {
    actionRowCollapsedInitialized = true;
  }
}

// Save actionRowCollapsed state to storage
async function saveActionRowCollapsedState() {
  try {
    await browser.storage.local.set({ actionRowCollapsed });
  } catch (error) {
    logError(
      'Failed to save actionRowCollapsed state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

// Load state on mount
loadActionRowCollapsedState();

// Persist collapse preference after init. Track only the boolean we care about;
// skip first run after load so load→save cannot thrash with storage listeners.
let actionRowPersistReady = false;
$effect(() => {
  void actionRowCollapsed;
  if (!actionRowCollapsedInitialized) return;
  if (!actionRowPersistReady) {
    actionRowPersistReady = true;
    return;
  }
  void saveActionRowCollapsedState();
});

// View mode: whether to show favicons in the email list rows
let showFavicons = $state(true);
let viewDropdownOpen = $state(false);
let viewSortSubOpen = $state(false);
let viewShowSubOpen = $state(false);
let showFaviconsInitialized = $state(false);

// View mode: whether to hide per-email labels (Local, custom tags) and OTP badges
let hideLabels = $state(false);
let hideLabelsInitialized = $state(false);
let hideOtpLabels = $state(false);
let hideOtpLabelsInitialized = $state(false);
let hideAttachmentBadges = $state(false);
let hideAttachmentBadgesInitialized = $state(false);

async function loadShowFaviconsState() {
  try {
    const result = (await browser.storage.local.get([
      'showFavicons',
      'gesturesEnabled',
      'preferHideOtpStrip',
      'preferHideAutofillStrip',
      'preferHideMagicStrip',
    ])) as {
      showFavicons?: boolean;
      gesturesEnabled?: boolean;
      preferHideOtpStrip?: boolean;
      preferHideAutofillStrip?: boolean;
      preferHideMagicStrip?: boolean;
    };
    // Default ON when unset
    if (result.showFavicons !== undefined) {
      showFavicons = result.showFavicons;
    } else {
      showFavicons = true;
      void browser.storage.local.set({ showFavicons: true });
    }
    if (result.gesturesEnabled === false) gesturesEnabled = false;
    preferHideOtpStrip = !!result.preferHideOtpStrip;
    preferHideAutofillStrip = !!result.preferHideAutofillStrip;
    preferHideMagicStrip = !!result.preferHideMagicStrip;
  } catch (error) {
    logError(
      'Failed to load showFavicons state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  } finally {
    showFaviconsInitialized = true;
  }
}

async function saveShowFaviconsState() {
  try {
    await browser.storage.local.set({ showFavicons });
  } catch (error) {
    logError(
      'Failed to save showFavicons state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

async function loadHideLabelsState() {
  try {
    const result = (await browser.storage.local.get(['hideLabels'])) as {
      hideLabels?: boolean;
    };
    if (result.hideLabels !== undefined) {
      hideLabels = result.hideLabels;
    }
  } catch (error) {
    logError(
      'Failed to load hideLabels state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  } finally {
    hideLabelsInitialized = true;
  }
}

async function saveHideLabelsState() {
  try {
    await browser.storage.local.set({ hideLabels });
  } catch (error) {
    logError(
      'Failed to save hideLabels state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

async function loadHideOtpLabelsState() {
  try {
    const result = (await browser.storage.local.get(['hideOtpLabels'])) as {
      hideOtpLabels?: boolean;
    };
    if (result.hideOtpLabels !== undefined) {
      hideOtpLabels = result.hideOtpLabels;
    }
  } catch (error) {
    logError(
      'Failed to load hideOtpLabels state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  } finally {
    hideOtpLabelsInitialized = true;
  }
}

async function saveHideOtpLabelsState() {
  try {
    await browser.storage.local.set({ hideOtpLabels });
  } catch (error) {
    logError(
      'Failed to save hideOtpLabels state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

async function loadHideAttachmentBadgesState() {
  try {
    const result = (await browser.storage.local.get(['hideAttachmentBadges'])) as {
      hideAttachmentBadges?: boolean;
    };
    if (result.hideAttachmentBadges !== undefined) {
      hideAttachmentBadges = result.hideAttachmentBadges;
    }
  } catch (error) {
    logError(
      'Failed to load hideAttachmentBadges state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  } finally {
    hideAttachmentBadgesInitialized = true;
  }
}

async function saveHideAttachmentBadgesState() {
  try {
    await browser.storage.local.set({ hideAttachmentBadges });
  } catch (error) {
    logError(
      'Failed to save hideAttachmentBadges state:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

/** Map a filename to a friendly file-type emoji for the list badge. */
function attachmentTypeMeta(filename: string): { emoji: string } {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'm4v'].includes(ext)) {
    return { emoji: '🎬' };
  }
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'].includes(ext)) {
    return { emoji: '🎵' };
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'heic', 'bmp', 'ico'].includes(ext)) {
    return { emoji: '🖼️' };
  }
  if (ext === 'pdf') return { emoji: '📄' };
  if (['doc', 'docx', 'rtf', 'odt', 'txt', 'md'].includes(ext)) {
    return { emoji: '📝' };
  }
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return { emoji: '📊' };
  if (['ppt', 'pptx', 'odp'].includes(ext)) return { emoji: '📽️' };
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) return { emoji: '📦' };
  if (['eml', 'msg'].includes(ext)) return { emoji: '📧' };
  return { emoji: '📎' };
}

loadShowFaviconsState();
loadHideLabelsState();
loadHideOtpLabelsState();
loadHideAttachmentBadgesState();

// Persist view toggles when they change (after initial load). Skip the first
// run after init so load→save cannot form a loop with storage listeners.
let faviconsPersistReady = false;
let hideLabelsPersistReady = false;
let hideOtpLabelsPersistReady = false;
$effect(() => {
  void showFavicons;
  if (!showFaviconsInitialized) return;
  if (!faviconsPersistReady) {
    faviconsPersistReady = true;
    return;
  }
  void saveShowFaviconsState();
});
$effect(() => {
  void hideLabels;
  if (!hideLabelsInitialized) return;
  if (!hideLabelsPersistReady) {
    hideLabelsPersistReady = true;
    return;
  }
  void saveHideLabelsState();
});
$effect(() => {
  void hideOtpLabels;
  if (!hideOtpLabelsInitialized) return;
  if (!hideOtpLabelsPersistReady) {
    hideOtpLabelsPersistReady = true;
    return;
  }
  void saveHideOtpLabelsState();
});
let hideAttachmentBadgesPersistReady = false;
$effect(() => {
  void hideAttachmentBadges;
  if (!hideAttachmentBadgesInitialized) return;
  if (!hideAttachmentBadgesPersistReady) {
    hideAttachmentBadgesPersistReady = true;
    return;
  }
  void saveHideAttachmentBadgesState();
});

// Lazy loading state - page size is user-configurable (persisted)
const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100] as const;
let pageSize = $state(20);
let displayedEmailCount = $state(20);

// Thread grouping & view option states - persisted to storage
let threadGrouping = $state(false);
let expandedThreadIds = $state<Set<string>>(new Set());
let starredEmailIds = $state<Set<string>>(new Set());
let showStarredOnly = $state(false);
/** True while a renew-once / always-renew action is in progress (renewal strip). */
let isRenewing = $state(false);

// Selection toolbar preference
let selectionToolbarEnabled = $state(true);

// Load persisted prefs once on mount
onMount(() => {
  void browser.storage.local.get(['selectionToolbarEnabled']).then((r) => {
    selectionToolbarEnabled =
      (r as { selectionToolbarEnabled?: boolean }).selectionToolbarEnabled !== false;
  });
  const onSelectionToolbarChanged = (
    changes: Record<string, { newValue?: unknown }>,
    area: string
  ) => {
    if (area !== 'local' || !changes.selectionToolbarEnabled) return;
    selectionToolbarEnabled = changes.selectionToolbarEnabled.newValue !== false;
  };
  try {
    browser.storage.onChanged.addListener(onSelectionToolbarChanged);
  } catch {
    /* ignore */
  }

  void (async () => {
    try {
      const result = (await browser.storage.local.get([
        'threadGrouping',
        'starredEmails',
        'emailListPageSize',
        'stripsEdgeCollapsed',
      ])) as {
        threadGrouping?: boolean;
        starredEmails?: string[];
        emailListPageSize?: number;
        stripsEdgeCollapsed?: boolean;
      };
      if (result.threadGrouping !== undefined) threadGrouping = result.threadGrouping;
      if (result.starredEmails) starredEmailIds = new Set(result.starredEmails);
      if (result.stripsEdgeCollapsed !== undefined) {
        stripsEdgeCollapsed = !!result.stripsEdgeCollapsed;
      }
      if (
        typeof result.emailListPageSize === 'number' &&
        (PAGE_SIZE_OPTIONS as readonly number[]).includes(result.emailListPageSize)
      ) {
        pageSize = result.emailListPageSize;
        displayedEmailCount = result.emailListPageSize;
      }
    } catch {
      // Storage read failed - keep defaults
    }
  })();

  return () => {
    try {
      browser.storage.onChanged.removeListener(onSelectionToolbarChanged);
    } catch {
      /* ignore */
    }
  };
});

async function setPageSize(n: number) {
  pageSize = n;
  displayedEmailCount = n;
  try {
    await browser.storage.local.set({ emailListPageSize: n });
  } catch {
    /* ignore */
  }
}

// Multi-select strip (hosted here so it matches OTP strip size/placement)
let emailSelection = $state({
  mode: false,
  count: 0,
  canArchive: false,
  canDelete: false,
  canRestore: false,
});
let emailSelectionApi = $state({
  cancel: () => {},
  archive: () => {},
  delete: () => {},
  restore: () => {},
  star: () => {},
  label: () => {},
  selectAll: () => {},
  deselectAll: () => {},
  applyLabel: async (_lab: string) => {},
});
/** Hide Search FAB while scrolling down the list */
let fabHidden = $state(false);

// Label filter chips (alongside Inbox/Archived/…)
let emailTagsMap = $state<Record<string, string[]>>({});
let labelOverflowOpen = $state(false);

$effect(() => {
  return emailTagsStore.subscribe((map) => {
    emailTagsMap = map;
  });
});

// Reset visible window when sort / filters change so order is obvious.
// Do not read displayedEmailCount here (would reset "load more" on its own write).
$effect(() => {
  void sortBy;
  void searchQuery;
  void otpOnly;
  void emailListTab;
  void activeLabelFilter;
  void senderDomain;
  void selectedSenders;
  void dateFrom;
  void dateTo;

  const next = pageSize;
  untrack(() => {
    if (displayedEmailCount !== next) displayedEmailCount = next;
  });
});

// When switching mailbox (prev/next), drop label/star/tab filters that would hide all mails
// Plain let — must NOT be $state (read+write in same effect → infinite loop)
let lastFilterMailbox = '';
$effect(() => {
  const addr = selectedEmail || '';
  if (!addr) return;
  if (lastFilterMailbox && lastFilterMailbox !== addr) {
    activeLabelFilter = null;
    labelOverflowOpen = false;
    showStarredOnly = false;
    emailListTab = 'inbox';
    displayedEmailCount = pageSize;
    expandedThreadIds = new Set();
    emailSelectionApi.cancel?.();
    emailSelectionApi.deselectAll?.();
    untrack(() => {
      onSearchChange?.('');
      onOtpOnlyChange?.(false);
      onHasAttachmentChange?.(false);
      onSenderDomainChange?.('');
      onSelectedSendersChange?.([]);
      onDateFromChange?.('');
      onDateToChange?.('');
    });
  }
  lastFilterMailbox = addr;
});

let lastFilterTab = '';
$effect(() => {
  if (lastFilterTab && lastFilterTab !== emailListTab) {
    untrack(() => {
      expandedThreadIds = new Set();
      deselectAll();
    });
  }
  lastFilterTab = emailListTab;
});

let tabCounts = $derived.by(
  (): Record<EmailListTab, number> => ({
    inbox: filteredEmails.filter((e: Email) => !e.local_archived && !e.local_deleted).length,
    archived: filteredEmails.filter((e: Email) => e.local_archived && !e.local_deleted).length,
    deleted: filteredEmails.filter((e: Email) => !!e.local_deleted).length,
    storedLocally: filteredEmails.filter(
      (e: Email) => (!!e.local_only || !!e.local_archived) && !e.local_deleted
    ).length,
    all: filteredEmails.length,
  })
);

/** Base list for current status tab (before label / starred filters) */
let statusTabEmails = $derived.by((): Email[] => {
  switch (emailListTab) {
    case 'archived':
      return filteredEmails.filter((e: Email) => e.local_archived && !e.local_deleted);
    case 'deleted':
      return filteredEmails.filter((e: Email) => !!e.local_deleted);
    case 'storedLocally':
      return filteredEmails.filter(
        (e: Email) => (!!e.local_only || !!e.local_archived) && !e.local_deleted
      );
    case 'all':
      return filteredEmails;
    default:
      return filteredEmails.filter((e: Email) => !e.local_archived && !e.local_deleted);
  }
});

/** Cross-mailbox search groups when query is active */
type CrossMailboxGroup = {
  address: string;
  isCurrent: boolean;
  emails: Email[];
  collapsed: boolean;
};
let crossMailboxSearchActive = $derived(!!searchQuery?.trim());
let collapsedCrossMailboxes = $state<Set<string>>(new Set());
/** Free-text portion of searchQuery (shortcut tokens stripped) for cross-mailbox filtering */
let searchQueryFreeText = $derived(parseSearchShortcuts(searchQuery || '').searchQuery);
let crossMailboxGroups = $derived.by((): CrossMailboxGroup[] => {
  if (!crossMailboxSearchActive) return [];
  const current = (selectedEmail || '').toLowerCase();
  const criteria = {
    searchQuery: searchQueryFreeText,
    otpOnly,
    hasAttachment,
    senderDomain,
    senderEmail,
    recipient,
    subject,
    notSenderDomain,
    notSenderEmail,
    notRecipient,
    notSubject,
    selectedSenders,
    dateFrom,
    dateTo,
    sortBy,
    emailTagsById: emailTagsMap,
  };
  const addrs = new Set<string>([
    ...Object.keys(allStoredEmails || {}),
    ...(allAccounts || []).map((a: Account) => a.address).filter(Boolean),
  ]);
  const groups: CrossMailboxGroup[] = [];
  for (const address of addrs) {
    const rawBag = allStoredEmails[address];
    const bag = (Array.isArray(rawBag) ? rawBag : []).map((e) => ({
      ...e,
      original_inbox: e.original_inbox || address,
    }));
    let list = filterEmails(bag, criteria);
    switch (emailListTab) {
      case 'archived':
        list = list.filter((e) => e.local_archived && !e.local_deleted);
        break;
      case 'deleted':
        list = list.filter((e) => !!e.local_deleted);
        break;
      case 'all':
        break;
      default:
        list = list.filter((e) => !e.local_archived && !e.local_deleted);
    }
    const isCurrent = address.toLowerCase() === current;
    // Always include current mailbox; others only if they have matches
    if (!isCurrent && list.length === 0) continue;
    groups.push({
      address,
      isCurrent,
      emails: list,
      collapsed: collapsedCrossMailboxes.has(address.toLowerCase()),
    });
  }
  // Current first, then by match count
  groups.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return b.emails.length - a.emails.length;
  });
  return groups;
});

/** Unique labels present on emails in the current status tab */
let availableLabels = $derived.by((): string[] => {
  const set = new Set<string>();
  for (const e of statusTabEmails) {
    const tags = emailTagsMap[e.id];
    if (!tags) continue;
    for (const t of tags) set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
});

function labelCountInStatusTab(lab: string): number {
  return statusTabEmails.filter((e) => (emailTagsMap[e.id] || []).includes(lab)).length;
}

let tabFilteredEmails = $derived.by((): Email[] => {
  let list = statusTabEmails;
  const labelFilter = activeLabelFilter;
  if (labelFilter) {
    list = list.filter((e: Email) => (emailTagsMap[e.id] || []).includes(labelFilter));
  }
  if (showStarredOnly) {
    return list.filter((e: Email) => {
      const addr = (e.original_inbox || selectedEmail || '').toLowerCase();
      const key = addr ? `${addr}_${e.id}` : e.id;
      return starredEmailIds.has(key) || starredEmailIds.has(e.id);
    });
  }
  return list;
});

// While search is focused, toast only for emails that arrived after focus.
// Use plain counters for "already toasted" so we never read+write $state in one effect.
let searchFocusToastedCount = 0;
let searchFocusToastPending = false;
$effect(() => {
  if (!searchBarFocused) {
    searchFocusToastedCount = 0;
    return;
  }
  const n = emails.length;
  const baseline = searchFocusEmailBaseline;
  const delta = n - baseline - searchFocusToastedCount;
  if (delta <= 0) return;
  searchFocusToastedCount += delta;
  const total = searchFocusToastedCount;
  if (searchFocusToastPending) return;
  searchFocusToastPending = true;
  queueMicrotask(() => {
    searchFocusToastPending = false;
    showToast(
      total === 1
        ? $t('inbox.searchFocusNewMailOne')
        : $t('inbox.searchFocusNewMailMany', { values: { n: total } }),
      'info'
    );
  });
});

let emailThreads = $derived.by((): EmailThread[] => {
  if (!threadGrouping) return [];
  return groupEmailsByThread(tabFilteredEmails);
});

function toggleThread(threadId: string) {
  const next = new Set(expandedThreadIds);
  if (next.has(threadId)) next.delete(threadId);
  else next.add(threadId);
  expandedThreadIds = next;
}

// Displayed emails for lazy loading (flattened from threads when grouping is on)
let displayedEmails = $derived.by(() => {
  if (threadGrouping) {
    // When thread grouping is on, show only thread header emails (latest per thread)
    // The full thread is expanded inline
    return emailThreads
      .flatMap(
        (t) =>
          expandedThreadIds.has(t.id)
            ? t.emails // expanded: show all emails in thread
            : [t.latestEmail] // collapsed: show only the latest
      )
      .slice(0, displayedEmailCount);
  }
  return tabFilteredEmails.slice(0, displayedEmailCount);
});

// Load more emails when scrolling near bottom / button
function loadMoreEmails() {
  if (displayedEmailCount < tabFilteredEmails.length) {
    displayedEmailCount = Math.min(displayedEmailCount + pageSize, tabFilteredEmails.length);
  }
}

function handleSortChange(value: string) {
  onSortChange(value);
  displayedEmailCount = pageSize;
}

function fitActionButtonFonts() {
  const row = actionRowEl;
  if (!row) return;
  const buttons = Array.from(row.querySelectorAll<HTMLElement>('button'));
  if (!buttons.length) return;
  const items = buttons.map((btn) => {
    const el = btn.querySelector('span.leading-tight, span.whitespace-nowrap, .btn-label');
    const text = (el?.textContent || btn.textContent || '').trim();
    return { text };
  });
  const res = fitActionButtonsLayout(items, row.clientWidth, {
    basePx: 12,
    minPx: 8.5,
    weight: 700,
    reservedPx: 36,
    gapPx: 6,
  });
  actionBtnFontPx = res.fontPx;
  actionBtnEqualWidth = res.equalWidth;
}

let currentAccount = $derived.by(() => {
  if (!selectedEmail) return null;
  const exact =
    allAccounts.find((a: Account) => a.address === selectedEmail) ||
    accounts.find((a: Account) => a.address === selectedEmail);
  if (exact) return exact;
  // Case-insensitive fallback (provider domain rewrites can change casing)
  const lower = selectedEmail.toLowerCase();
  return (
    allAccounts.find((a: Account) => (a.address || '').toLowerCase() === lower) ||
    accounts.find((a: Account) => (a.address || '').toLowerCase() === lower) ||
    null
  );
});

// Container background class based on account status
let containerBgClass = $derived.by(() => {
  if (!currentAccount) return 'bg-md-surface-container-highest';
  if (currentAccount.accountStatus === 'deleted') return 'bg-md-error-container';
  if (currentAccount.accountStatus === 'archived') return 'bg-md-tertiary-container';
  return 'bg-md-surface-container-highest';
});

$effect(() => {
  void $t;
  void currentAccount;
  void actionRowCollapsed;
  void tick().then(() => {
    fitActionButtonFonts();
    requestAnimationFrame(fitActionButtonFonts);
  });
});

// Button text based on collapse state and temporary expansion
let buttonText = $derived.by(() => {
  const isTemporarilyExpanded = actionRowCollapsed && (accountSelectorHovered || actionRowHovered);
  const isTemporarilyHidden = !actionRowCollapsed && (searchBarFocused || emailSelection.mode);
  if (isTemporarilyExpanded) return 'Always Show';
  if (isTemporarilyHidden) return 'Temporary Hidden';
  return actionRowCollapsed ? 'Show' : 'Hide';
});

/** Dialog after user chooses Hide — explains hover + Always Show */
let hideHintDialogOpen = $state(false);
let hideHintDontShow = $state(false);
let hideHintOverlayEl = $state<HTMLElement | null>(null);

// Portal the hide-hint blocking dialog to document.body so it sits above
// every transformed ancestor and uses the documented dialog z-layer
// (PORTAL_Z.dialog = 10000), per AGENTS §4.
$effect(() => {
  if (hideHintDialogOpen && hideHintOverlayEl) {
    return portalToBody(hideHintOverlayEl);
  }
});

function handleActionRowToggle() {
  if (!actionRowCollapsed) {
    actionRowCollapsed = true;
    void browser.storage.local.get(['hideActionRowHintDismissed']).then((r) => {
      if (!(r as { hideActionRowHintDismissed?: boolean }).hideActionRowHintDismissed) {
        hideHintDialogOpen = true;
      }
    });
  } else {
    actionRowCollapsed = false;
    hideHintDialogOpen = false;
  }
}

async function dismissHideHint(forever: boolean) {
  hideHintDialogOpen = false;
  if (forever || hideHintDontShow) {
    await browser.storage.local.set({ hideActionRowHintDismissed: true });
  }
}

// Use shared time store
const timeStore = useCurrentTime();
let currentTime = $state(timeStore.currentTime);

// Subscribe to time updates
$effect(() => {
  const unsubscribe = timeStore.subscribe(() => {
    currentTime = timeStore.currentTime;
  });
  return unsubscribe;
});

// Calculate expiry progress percentage
let expiryProgress = $derived.by(() => {
  if (!currentAccount?.expiresAt || !currentAccount.createdAt) return 0;
  const now = currentTime;
  const totalDuration = currentAccount.expiresAt - currentAccount.createdAt;
  const remaining = currentAccount.expiresAt - now;
  if (totalDuration <= 0) return 0;
  const percentage = Math.max(0, Math.min(100, (remaining / totalDuration) * 100));
  return percentage;
});

// Check if current account's provider supports auto-renew
const supportsAutoRenew = $derived.by(() => {
  if (!currentAccount?.provider) return false;
  try {
    const config = loadProviderConfig(currentAccount.provider);
    return config.expiry?.renewable || false;
  } catch {
    /* ignore */
    return false;
  }
});

// Check if current account is expired
const isCurrentAccountExpired = $derived.by(() => {
  void stripClockTick;
  if (!currentAccount?.expiresAt) return false;
  return Date.now() > currentAccount.expiresAt;
});

// Renewal strip is eligible when: provider supports auto-renew AND
// account is currently expired AND auto-renew is NOT enabled AND not archived.
// (If auto-renew were enabled, the address would not have expired.)
const isCurrentAccountArchived = $derived(
  currentAccount?.accountStatus === 'archived' || currentAccount?.status === 'archived'
);
const canUnarchiveCurrent = $derived(!!currentAccount && canUnarchive(currentAccount as Account));
const renewalStripEligible = $derived(
  supportsAutoRenew &&
    isCurrentAccountExpired &&
    !(currentAccount?.autoExtend ?? false) &&
    !isCurrentAccountArchived
);

// Reset dismissal when the account changes (so a different expired inbox shows the strip again).
// Plain let — NOT $state (read+write in same effect → effect_update_depth_exceeded).
let _lastRenewalAddress: string | null = null;
$effect(() => {
  const addr = currentAccount?.address ?? null;
  if (addr !== _lastRenewalAddress) {
    _lastRenewalAddress = addr;
    untrack(() => {
      renewalStripDismissed = false;
    });
  }
});

// Final show flag = eligible AND not dismissed (still show while renew request in flight)
const showRenewalStrip = $derived((renewalStripEligible && !renewalStripDismissed) || isRenewing);

/** Edge handle: collapse OTP / Magic / Autofill (and related) strips to a thin tab */
let stripsEdgeCollapsed = $state(false);

async function setStripsEdgeCollapsed(next: boolean) {
  if (stripsEdgeCollapsed === next) return;
  stripsEdgeCollapsed = next;
  try {
    await browser.storage.local.set({ stripsEdgeCollapsed: next });
  } catch {
    /* ignore */
  }
}

// New OTP / magic mail auto-expands the strip stack (only when collapsed → expand once)
let _prevHadStripAlert = false;
$effect(() => {
  const hasAlert = !!(latestLiveOtp || latestMagicLink);
  // Read collapsed flag without re-subscribing on every expand/collapse write
  const collapsed = untrack(() => stripsEdgeCollapsed);
  if (hasAlert && !_prevHadStripAlert && collapsed) {
    void setStripsEdgeCollapsed(false);
  }
  _prevHadStripAlert = hasAlert;
});

let hasCollapsibleStrips = $derived.by(() => {
  if (emailSelection.mode) return false;
  return !!(
    (latestMagicLink && showMagicLinkStrip && !preferHideMagicStrip) ||
    (matchingSavedLogin && showSavedLoginStrip) ||
    (formDetected && showAutofillStrip && !preferHideAutofillStrip) ||
    (latestLiveOtp && !preferHideOtpStrip) ||
    showRenewalStrip ||
    (hasActiveListFilters && showFilterAppliedStrip)
  );
});

/** Reserve space under email list for absolute strip stack so rows aren't covered */
let stripReservePx = $derived.by(() => {
  if (emailSelection.mode) return 88;
  if (stripsEdgeCollapsed && hasCollapsibleStrips) return 36;
  let n = 0;
  if (hasActiveListFilters && showFilterAppliedStrip) n += 1;
  if (latestMagicLink && showMagicLinkStrip && !preferHideMagicStrip) n += 1;
  if (matchingSavedLogin && showSavedLoginStrip) n += 1;
  if (formDetected && showAutofillStrip && !preferHideAutofillStrip) n += 1;
  // Only live (non-archived/deleted) OTPs keep the strip visible
  if (latestLiveOtp && !preferHideOtpStrip) n += 1;
  if (showRenewalStrip) n += 1;
  return Math.max(8, n * 36 + (n > 0 ? 12 : 0));
});

let bottomStripsWrapperEl = $state<HTMLElement | null>(null);
let bottomStripsHeightPx = $state(0);

$effect(() => {
  const el = bottomStripsWrapperEl;
  if (!el || typeof ResizeObserver === 'undefined') {
    bottomStripsHeightPx = 0;
    return;
  }
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const rect = entry.target.getBoundingClientRect();
      bottomStripsHeightPx = Math.ceil(rect.height);
    }
  });
  ro.observe(el);
  return () => ro.disconnect();
});

/** Pure dynamic measurement of strip stack — zero hardcoded numbers or fallbacks */
let totalBottomSpacerHeightPx = $derived(bottomStripsHeightPx);

// Auto-renew is now enabled → strip should disappear (the address will renew itself)
$effect(() => {
  if (currentAccount?.autoExtend && renewalStripEligible === false && !isRenewing) {
    untrack(() => {
      if (!renewalStripDismissed) renewalStripDismissed = true;
    });
  }
});

/** Renew once or always-renew: show loading feedback so UI is not stuck on “expired”. */
async function handleRenewOnce() {
  if (!currentAccount || isRenewing) return;
  isRenewing = true;
  try {
    await onExtendAccount(currentAccount);
  } catch (e) {
    logError('handleRenewOnce failed', undefined, e as Error);
  } finally {
    isRenewing = false;
  }
}

async function handleRenewAlways() {
  if (!currentAccount || isRenewing) return;
  isRenewing = true;
  try {
    // Enable auto-extend first, then immediately renew so status leaves “expired”
    if (!currentAccount.autoExtend) {
      await onToggleAutoExtend(currentAccount);
    }
    await onExtendAccount(currentAccount);
  } catch (e) {
    logError('handleRenewAlways failed', undefined, e as Error);
  } finally {
    isRenewing = false;
  }
}

// Tag functions
async function updateTag(accountId: string, tag: string, color: string | undefined = undefined) {
  try {
    await browser.runtime.sendMessage({ type: 'updateInboxTag', inboxId: accountId, tag, color });
    await onReloadAccounts();
  } catch (e) {
    logError('Failed to update tag:', e);
  }
}

function openTagDialog() {
  if (!currentAccount) return;
  tagTargetAccount = currentAccount;
  tagDialogOpen = true;
}

function closeTagDialog() {
  tagDialogOpen = false;
  tagTargetAccount = null;
}

function saveTag(tag: string, color: string) {
  if (!tagTargetAccount) return;
  updateTag(tagTargetAccount.id, tag, color);
  closeTagDialog();
}

// Extract existing tags from all accounts (supports both legacy a.tag and new a.tags[])
let existingTags = $derived.by(() => {
  const tags = new Set<string>();
  allAccounts.forEach((a: Account) => {
    if (a.tag) tags.add(a.tag);
    if (Array.isArray(a.tags) && a.tags.length) {
      for (const t of a.tags) if (t?.name) tags.add(t.name);
    }
  });
  return Array.from(tags);
});

// Extract tag colors from all accounts (supports both legacy a.tag/a.tagColor and new a.tags[])
let tagColors = $derived.by(() => {
  const colors: Record<string, string> = {};
  allAccounts.forEach((a: Account) => {
    if (a.tag && a.tagColor) colors[a.tag] = a.tagColor;
    if (Array.isArray(a.tags) && a.tags.length) {
      for (const t of a.tags) if (t?.name && t.color) colors[t.name] = t.color;
    }
  });
  return colors;
});
// --- Merged Email List State & Logic ---
let pullDistance = $state(0);
let startY = $state(0);
let isPulling = $state(false);
let pullRefreshing = $state(false);
let refreshRotation = $derived(Math.min(pullDistance * 4.5, 360));

let listRootEl = $state<HTMLElement | null>(null);
let marqueeActive = $state(false);
let marqueeStart = $state<{ x: number; y: number } | null>(null);
let marqueeRect = $state<{ left: number; top: number; right: number; bottom: number } | null>(null);
let marqueePrefEnabled = $state(true);

let rowLabelMenuId = $state<string | null>(null);
let exitingEmailIds = $state<Set<string>>(new Set());
let starPopId = $state<string | null>(null);
let prefersReducedMotion = $state(false);

let renderLimit = $state(50);
let renderedEmails = $derived(displayedEmails.slice(0, renderLimit));

// ── Offline-gap labels ──────────────────────────────────────────────────────
// Connectivity log (online/offline transitions, UTC) used to label time ranges
// between emails where the user was offline and no mail could have arrived.
let connectivityEvents = $state<ConnectivityEvent[]>([]);

async function loadConnectivityLog() {
  try {
    connectivityEvents = await getConnectivityLog();
  } catch {
    /* ignore */
  }
}

type RenderedRow =
  | { kind: 'email'; email: Email }
  | { kind: 'offlineGap'; fromTs: number; toTs: number };

/** Format a UTC timestamp for the offline-gap label: e.g. "14:30 UTC". */
function formatGapTime(ts: number): string {
  try {
    const d = new Date(ts);
    return `${d.getUTCHours().toString().padStart(2, '0')}:${d
      .getUTCMinutes()
      .toString()
      .padStart(2, '0')} UTC`;
  } catch {
    return '';
  }
}

const emailsWithGaps = $derived.by((): RenderedRow[] => {
  const rows: RenderedRow[] = [];
  if (connectivityEvents.length === 0) {
    return renderedEmails.map((e) => ({ kind: 'email' as const, email: e }));
  }
  let prevTs: number | null = null;
  for (const mail of renderedEmails) {
    const ts = toMs(mail.received_at) || Date.now();
    if (
      prevTs !== null &&
      ts - prevTs > 5 * 60 * 1000 && // only label meaningful gaps (≥5 min)
      isRangeFullyOffline(connectivityEvents, prevTs, ts)
    ) {
      rows.push({ kind: 'offlineGap', fromTs: prevTs, toTs: ts });
    }
    rows.push({ kind: 'email', email: mail });
    prevTs = ts;
  }
  return rows;
});

let hoveredEmail = $state<Email | null>(null);
let previewPosition = $state({ x: 0, y: 0, above: false });
let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let windowWidth = $state(0);
let windowHeight = $state(0);

function isStarredMail(email: Email): boolean {
  return isEmailStarred(starredEmailIds, email.id, email.original_inbox || selectedEmail);
}

async function loadStarredEmails() {
  try {
    const result = (await browser.storage.local.get(['starredEmails'])) as {
      starredEmails?: string[];
    };
    starredEmailIds = new Set(result.starredEmails || []);
  } catch {
    /* ignore */
  }
}

let starToggleBusy = $state(false);
async function toggleStar(email: Email | string) {
  const mail = typeof email === 'string' ? ({ id: email } as Email) : email;
  if (!mail?.id || starToggleBusy) return;
  starToggleBusy = true;
  try {
    const result = (await browser.storage.local.get(['starredEmails'])) as {
      starredEmails?: string[];
    };
    const addr = mail.original_inbox || selectedEmail;
    const updated = toggleStarInSet(result.starredEmails || [], mail.id, addr);
    starredEmailIds = updated;
    if (!prefersReducedMotion) {
      starPopId = mail.id;
      setTimeout(() => {
        if (starPopId === mail.id) starPopId = null;
      }, 180);
    }
    await browser.storage.local.set({ starredEmails: Array.from(updated) });
  } catch (e) {
    logError('toggleStar failed', undefined, e as Error);
    await loadStarredEmails();
  } finally {
    starToggleBusy = false;
  }
}

let highlightTerms = $derived.by(() => {
  const parsed = parseSearchShortcuts(searchQuery);
  return parsed.highlightTerms.filter((t) => !t.includes(':'));
});

function getDisplayName(email: string, name: string | undefined = undefined): string {
  if (name?.trim()) {
    if (name.includes('@')) {
      const localPart = name.split('@')[0];
      return localPart.replace(/[._]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
    }
    return name.trim();
  }
  if (!email) return 'Unknown';
  if (email.includes('@')) {
    const localPart = email.split('@')[0];
    return localPart.replace(/[._]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
  }
  return email;
}

function handleMouseEnter(email: Email, e: MouseEvent) {
  if (hoverTimer) clearTimeout(hoverTimer);
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  hoverTimer = setTimeout(() => {
    const rowHeight = rect.height;
    const previewHeight = rowHeight * 2; // 2x email item height, programmatic not hardcoded
    const viewportHeight = windowHeight || window.innerHeight;
    const above = rect.bottom + previewHeight > viewportHeight;
    const y = above ? rect.top - previewHeight - 4 : rect.bottom + 4;
    // Center the tooltip horizontally on the email row
    const previewWidth = 288;
    const x = Math.max(8, rect.left + rect.width / 2 - previewWidth / 2);
    previewPosition = { x, y, above };
    hoveredEmail = email;
  }, 250);
}

function handleMouseLeave() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  hoveredEmail = null;
}

// --- Swipe, Marquee, Long Press & Tag Dialog Feature Logic ---
let swipeStartX = $state(0);
let swipeDistance = $state(0);
let swipeDirection = $state<'left' | 'right' | null>(null);
let swipingEmail = $state<Email | null>(null);
let swipeActionTriggered = $state(false);
let pullToRefresh = $state(false);

let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressEmail = $state<Email | null>(null);
// Long-press context menu — dead state: the long-press flow now routes to the
// selection toolbar (externalSelectionBar), so nothing renders from this flag.
let contextMenuOpen = $state(false);
let contextMenuPosition = $state({ x: 0, y: 0 });
let suppressClickUntil = 0;
let lastMailboxForSelection: string | null = null;
$effect(() => {
  const addr = selectedEmail || '';
  if (lastMailboxForSelection === null) {
    lastMailboxForSelection = addr;
    return;
  }
  if (lastMailboxForSelection !== addr) {
    lastMailboxForSelection = addr;
    deselectAll();
    contextMenuOpen = false;
    longPressEmail = null;
  }
});
let marqueeDidSelect = false;
let selectedEmailIds = $state<Set<string>>(new Set());
let lastScrollTop = 0;

let tagDialogEmailId = $state<string | null>(null);
let tagDialogInput = $state('');
let emailTagDialogOpen = $state(false);
let tagDialogMultiIds = $state<string[] | null>(null);

let listSentinelEl = $state<HTMLElement | null>(null);

function expandRenderWindow() {
  if (renderLimit >= displayedEmails.length) return;
  renderLimit = Math.min(displayedEmails.length, renderLimit + 50);
}

$effect(() => {
  const el = listSentinelEl;
  if (!el || typeof IntersectionObserver === 'undefined') return;
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) expandRenderWindow();
    },
    { root: null, rootMargin: '200px', threshold: 0 }
  );
  io.observe(el);
  return () => io.disconnect();
});

// Reset window when underlying list shrinks or filter changes
$effect(() => {
  void displayedEmails.length;
  if (renderLimit > displayedEmails.length + 50) {
    renderLimit = Math.max(50, displayedEmails.length);
  }
});

function onMarqueePointerDown(e: PointerEvent) {
  if (!gesturesEnabled || !marqueePrefEnabled || e.button !== 0) return;
  if ((displayedEmails?.length || 0) === 0) return;
  if (isInteractiveTarget(e.target)) return;
  marqueeStart = { x: e.clientX, y: e.clientY };
  marqueeActive = false;
  marqueeRect = null;
  const onMove = (ev: PointerEvent) => {
    if (!marqueeStart) return;
    const dx = Math.abs(ev.clientX - marqueeStart.x);
    const dy = Math.abs(ev.clientY - marqueeStart.y);
    if (!marqueeActive && dx < MARQUEE_THRESHOLD && dy < MARQUEE_THRESHOLD) return;
    marqueeActive = true;
    marqueeRect = normalizeMarquee(marqueeStart, { x: ev.clientX, y: ev.clientY });
    if (listRootEl) {
      const ids = collectIntersectingIds(listRootEl, '[data-marquee-id]', marqueeRect);
      emailSelection.mode = ids.length > 0;
      emailSelection.count = ids.length;
      selectedEmailIds = new Set(ids);
      emitSelectionChange();
    }
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    window.removeEventListener('blur', onUp);
    if (marqueeActive) {
      marqueeDidSelect = true;
      suppressClickUntil = Date.now() + 500;
    }
    marqueeStart = null;
    marqueeActive = false;
    marqueeRect = null;
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  // If the pointer leaves the window / the window loses focus (e.g. alt-tab),
  // pointerup may never fire — release the drag state so the UI never sticks.
  window.addEventListener('blur', onUp);
}

function handleSwipeStart(email: Email, e: TouchEvent | MouseEvent) {
  if (!gesturesEnabled) return;
  const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  swipeStartX = clientX;
  swipingEmail = email;
  swipeDistance = 0;
  swipeDirection = null;
  swipeActionTriggered = false;
}

function handleSwipeMove(e: TouchEvent | MouseEvent) {
  if (!swipingEmail) return;
  const currentX = 'touches' in e ? e.touches[0].clientX : e.clientX;
  const diff = currentX - swipeStartX;
  if (Math.abs(diff) > 10) {
    swipeDistance = Math.max(Math.min(diff, 120), -120);
    swipeDirection = diff > 0 ? 'right' : 'left';
  }
}

function handleSwipeEnd() {
  if (!swipingEmail) return;
  if (Math.abs(swipeDistance) > 80) {
    const direction = swipeDistance < 0 ? 'left' : 'right';
    const target = swipingEmail;
    performSwipeAction(direction, target);
  } else {
    swipeDistance = 0;
    swipeDirection = null;
    swipingEmail = null;
  }
}

function isDocumentRtl(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.documentElement.dir === 'rtl' ||
    getComputedStyle(document.documentElement).direction === 'rtl'
  );
}

function performSwipeAction(direction: 'left' | 'right', email: Email) {
  const run = () => {
    if (emailListTab === 'archived' || emailListTab === 'deleted') {
      void onRestoreEmails([email]);
      return;
    }
    const rtl = isDocumentRtl();
    const isDelete = (!rtl && direction === 'left') || (rtl && direction === 'right');
    if (isDelete) {
      void onDeleteEmails([email]);
    } else {
      void onArchiveEmails([email]);
    }
  };

  swipeActionTriggered = true;
  const delay = prefersReducedMotion ? 0 : 240;
  if (!prefersReducedMotion) {
    const next = new Set(exitingEmailIds);
    next.add(email.id);
    exitingEmailIds = next;
  }
  setTimeout(() => {
    run();
    swipeDistance = 0;
    swipeDirection = null;
    swipingEmail = null;
    swipeActionTriggered = false;
    if (exitingEmailIds.has(email.id)) {
      const cleared = new Set(exitingEmailIds);
      cleared.delete(email.id);
      exitingEmailIds = cleared;
    }
  }, delay);
}

function handleLongPressStart(email: Email, e: TouchEvent | MouseEvent) {
  if (!gesturesEnabled) return;
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    longPressEmail = email;
    emailSelection.mode = true;
    const next = new Set(selectedEmailIds);
    next.add(email.id);
    selectedEmailIds = next;
    emailSelection.count = next.size;
    suppressClickUntil = Date.now() + 500;
    if (!externalSelectionBar) {
      contextMenuOpen = true;
      const touch = 'touches' in e ? e.touches[0] : e;
      contextMenuPosition = { x: touch.clientX, y: touch.clientY };
    } else {
      contextMenuOpen = false;
    }
    emitSelectionChange();
  }, 500);
}

function handleLongPressEnd() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function emitSelectionChange() {
  const count = selectedEmailIds.size;
  onSelectionChange({
    mode: emailSelection.mode && count > 0,
    count,
    canArchive: emailListTab === 'inbox' || emailListTab === 'all',
    canDelete: emailListTab !== 'deleted',
    canRestore: emailListTab === 'archived' || emailListTab === 'deleted',
  });
}

function toggleEmailSelection(id: string) {
  const next = new Set(selectedEmailIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedEmailIds = next;
  emailSelection.count = next.size;
  if (next.size === 0) {
    emailSelection.mode = false;
    contextMenuOpen = false;
  }
  emitSelectionChange();
}

function filterByLabel(tag: string) {
  activeLabelFilter = tag;
}

let allEmailTags = $derived.by(() => {
  const set = new Set<string>();
  for (const tags of Object.values(emailTagsMap)) {
    if (!Array.isArray(tags)) continue;
    for (const t of tags) set.add(t);
  }
  return Array.from(set).sort();
});

function openEmailTagDialog(emailId: string) {
  tagDialogEmailId = emailId;
  tagDialogMultiIds = null;
  const tags = emailTagsMap[emailId];
  tagDialogInput = (Array.isArray(tags) ? tags : []).join(', ');
  emailTagDialogOpen = true;
}

function closeEmailTagDialog() {
  emailTagDialogOpen = false;
  tagDialogEmailId = null;
  tagDialogMultiIds = null;
  tagDialogInput = '';
}

function selectAllVisible() {
  emailSelection.mode = true;
  const ids = new Set<string>((tabFilteredEmails || []).map((m: Email) => m.id));
  selectedEmailIds = ids;
  emailSelection.count = ids.size;
  emitSelectionChange();
}

/** How many emails match the current tab + filters (the selection universe). */
let selectionMatchingTotal = $derived((tabFilteredEmails || []).length);
// During cross-mailbox search the rendered universe spans multiple mailboxes,
// so tabFilteredEmails isn't the right total — fall back to the plain label.
let selectionUniverseCounted = $derived(!crossMailboxSearchActive);
let selectionAllMatched = $derived(
  selectionUniverseCounted &&
    selectionMatchingTotal > 0 &&
    emailSelection.count >= selectionMatchingTotal
);

// ── No-results recovery ─────────────────────────────────────────────────────
// When a query with pills (is:otp / has:attachment / !from:… / from:…) matches
// nothing, offer "did you mean" — drop the last pill and show the resulting
// count. Pills are first-class tokens, so this is pure derived computation.
let queryPills = $derived(
  (searchQuery || '')
    .trim()
    .split(/\s+/)
    .filter((t: string) => SHORTCUT_REGEX.test(t))
);

let noResultsRecovery = $derived.by(() => {
  if ((filteredEmails || []).length > 0 || queryPills.length === 0) return null;
  const lastPill = queryPills[queryPills.length - 1];
  const withoutLast = (searchQuery || '')
    .trim()
    .split(/\s+/)
    .filter((t) => t !== lastPill)
    .join(' ')
    .trim();
  if (!withoutLast) return null;
  // The 'after removing the pill' criteria: every query-driven field comes from
  // the REMAINING query (the current props still carry the dropped pill's
  // value — passing them would re-apply the filter we're suggesting to drop).
  // Booleans reset to false once their pill is gone (mirrors FilterList's
  // removePill chip-flip). Non-query filters (multi-sender picker, date range,
  // sort, tags) keep their current values.
  const p = parseSearchShortcuts(withoutLast);
  const count = filterEmails(emails || [], {
    searchQuery: p.searchQuery,
    otpOnly: p.otpOnlySet ? p.otpOnly : false,
    hasAttachment: p.hasAttachmentSet ? p.hasAttachment : false,
    senderDomain: p.senderDomain,
    senderEmail: p.senderEmail,
    recipient: p.recipient,
    subject: p.subject,
    notSenderDomain: p.notSenderDomain,
    notSenderEmail: p.notSenderEmail,
    notRecipient: p.notRecipient,
    notSubject: p.notSubject,
    selectedSenders,
    dateFrom,
    dateTo,
    sortBy,
    emailTagsById: emailTagsMap,
  }).length;
  // A genuinely empty account (or a query whose remaining terms still match
  // nothing) isn't a recovery opportunity — hide the hint.
  if (count === 0) return null;
  return { lastPill, withoutLast, count };
});

function deselectAll() {
  selectedEmailIds = new Set();
  emailSelection.mode = false;
  emailSelection.count = 0;
  contextMenuOpen = false;
  longPressEmail = null;
  emitSelectionChange();
}

function resolveSelectedEmails(): Email[] {
  const fromTab = (tabFilteredEmails || []).filter((e: Email) => selectedEmailIds.has(e.id));
  if (fromTab.length > 0) return fromTab;
  return (emails || []).filter((e: Email) => selectedEmailIds.has(e.id));
}

function performArchive() {
  const targets = resolveSelectedEmails();
  if (targets.length === 0) return;
  void onArchiveEmails(targets);
  deselectAll();
}

/** Snapshot the tags of the given ids, apply `next`, and offer an undo toast. */
async function commitTagsWithUndo(next: Record<string, string[]>, affectedIds: Iterable<string>) {
  const snapshot: Record<string, string[]> = {};
  for (const id of affectedIds) {
    snapshot[id] = Array.isArray(emailTagsMap[id]) ? [...emailTagsMap[id]] : [];
  }
  emailTagsMap = next;
  try {
    await emailTagsStore.replaceMap(next);
    showToast($t('toasts.tagsUpdated'), 'tag', () => {
      void undoTagChange(snapshot);
    });
  } catch {
    /* ignore */
  }
}

/** Restore a tag snapshot (undo), merging into whatever tags changed meanwhile. */
async function undoTagChange(snapshot: Record<string, string[]>) {
  const next: Record<string, string[]> = { ...emailTagsStore.getSnapshot() };
  for (const [id, tags] of Object.entries(snapshot)) {
    if (tags.length === 0) delete next[id];
    else next[id] = tags;
  }
  emailTagsMap = next;
  await emailTagsStore.replaceMap(next);
  showToast($t('toasts.tagsUndone'), 'tag');
}

async function applyLabelToSelected(lab: string) {
  const targets = resolveSelectedEmails();
  if (targets.length === 0 || !lab) return;
  const next: Record<string, string[]> = { ...emailTagsMap };
  for (const mail of targets) {
    const existing = Array.isArray(next[mail.id]) ? next[mail.id] : [];
    next[mail.id] = [...new Set([...existing, lab])];
  }
  await commitTagsWithUndo(
    next,
    targets.map((m) => m.id)
  );
}

function performDelete() {
  const targets = resolveSelectedEmails();
  if (targets.length === 0) return;
  void onDeleteEmails(targets);
  deselectAll();
}

function performRestore() {
  const targets = resolveSelectedEmails();
  if (targets.length === 0) return;
  void onRestoreEmails(targets);
  deselectAll();
}

async function performStarSelected() {
  const targets = tabFilteredEmails.filter((e: Email) => selectedEmailIds.has(e.id));
  if (targets.length === 0) return;
  const anyUnstarred = targets.some((e: Email) => !isStarredMail(e));
  const updated = new Set(starredEmailIds);
  for (const e of targets) {
    const addr = e.original_inbox || selectedEmail;
    const key = starKeyForEmail(e, addr);
    updated.delete(e.id);
    if (anyUnstarred) updated.add(key);
    else updated.delete(key);
  }
  starredEmailIds = updated;
  await browser.storage.local.set({ starredEmails: Array.from(updated) });
  emitSelectionChange();
}

function closeContextMenuOnly() {
  contextMenuOpen = false;
  longPressEmail = null;
}

function wireSelectionApi() {
  const syncApi = {
    cancel: () => deselectAll(),
    archive: () => performArchive(),
    delete: () => performDelete(),
    restore: () => performRestore(),
    star: () => void performStarSelected(),
    label: () => openTagDialogForSelected(),
    selectAll: () => selectAllVisible(),
    deselectAll: () => deselectAll(),
    applyLabel: (lab: string) => applyLabelToSelected(lab),
  };
  Object.assign(emailSelectionApi, syncApi);
  Object.assign(selectionApi, syncApi);
}

function openTagDialogForSelected() {
  const ids = Array.from(selectedEmailIds);
  if (ids.length === 0) return;
  tagDialogEmailId = ids[0] ?? null;
  tagDialogMultiIds = [...ids];
  tagDialogInput = '';
  emailTagDialogOpen = true;
}

async function saveEmailTags() {
  const tags = Array.from(
    new Set(
      tagDialogInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );
  const ids = tagDialogMultiIds?.length
    ? [...tagDialogMultiIds]
    : tagDialogEmailId
      ? [tagDialogEmailId]
      : [];
  if (ids.length === 0) return;
  const next: Record<string, string[]> = { ...emailTagsMap };
  for (const id of ids) {
    if (tags.length === 0) {
      delete next[id];
    } else if (tagDialogMultiIds?.length) {
      const existing = Array.isArray(next[id]) ? next[id] : [];
      next[id] = [...new Set([...existing, ...tags])];
    } else {
      next[id] = tags;
    }
  }
  await commitTagsWithUndo(next, ids);
  closeEmailTagDialog();
  if (emailSelection.mode) closeContextMenuOnly();
}

let motionMqCleanup: (() => void) | null = null;
let scrollRaf = 0;

onMount(() => {
  wireSelectionApi();
  loadStarredEmails();
  void loadConnectivityLog();
  void isMarqueeSelectionEnabled().then((v) => {
    marqueePrefEnabled = v;
  });
  const handleStorageChange = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string
  ) => {
    if (areaName !== 'local') return;
    if (changes.starredEmails) loadStarredEmails();
    if (changes.connectivityLog) void loadConnectivityLog();
    if (changes.marqueeSelectionEnabled) {
      marqueePrefEnabled = changes.marqueeSelectionEnabled.newValue !== false;
    }
  };
  try {
    browser.storage.onChanged.addListener(handleStorageChange);
  } catch {
    /* ignore */
  }

  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    prefersReducedMotion = mq.matches;
    const onMq = () => {
      prefersReducedMotion = mq.matches;
    };
    mq.addEventListener?.('change', onMq);
    motionMqCleanup = () => mq.removeEventListener?.('change', onMq);
  }
  return () => {
    try {
      browser.storage.onChanged.removeListener(handleStorageChange);
    } catch {
      /* ignore */
    }
    motionMqCleanup?.();
  };
});

onDestroy(() => {
  if (hoverTimer) clearTimeout(hoverTimer);
  if (longPressTimer) clearTimeout(longPressTimer);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
});
</script>

<svelte:window bind:innerWidth={windowWidth} bind:innerHeight={windowHeight} />

<div class="relative flex flex-col flex-1 min-h-0 h-full w-full" style="--strips-reserve: {stripReservePx}px;">
<div
  class="account-selector-container relative shrink-0 {containerBgClass} rounded-2xl {buttonText === 'Show' || buttonText === 'Always Show' ? 'rounded-ee-none' : ''} p-2 mt-[7.5px] mb-[7.5px] overflow-visible"
  role="none"
>
<div
  role="none"
  onmouseenter={() => { accountSelectorHovered = true; }}
  onmouseleave={() => { accountSelectorHovered = false; }}
>
<AccountSelector
  {selectedEmail}
  bind:displayedEmail
  {accounts}
  {defaultDomain}
  {allAccounts}
  {dropdownOpen}
  {onDropdownOpenChange}
  onSelectAccount={onSelectAccount}
  onEditAccount={onEditAccount}
  onToggleAutoExtend={onToggleAutoExtend}
  onArchiveAccount={onArchiveAccount}
  onUnarchiveAccount={onUnarchiveAccount}
  onRemoveAccount={onRemoveAccount}
  onRestoreAccount={onRestoreAccount}
  onCreateInbox={onCreateInbox}
  onNavigateToManage={onNavigateToManage}
  onReloadAccounts={onReloadAccounts}
  onNavigateToSettings={onNavigateToSettings}
  onCreateInboxWithProvider={onCreateInboxWithProvider}
  onMarkAllRead={async (account) => {
    try {
      const { readEmails = {}, storedEmails = {} } = (await browser.storage.local.get([
        'readEmails',
        'storedEmails',
      ])) as { readEmails?: Record<string, boolean>; storedEmails?: Record<string, Email[]> };
      const bag = storedEmails[account.address] || [];
      for (const e of bag) {
        readEmails[`${account.address}_${e.id}`] = true;
        readEmails[e.id] = true;
      }
      await browser.storage.local.set({ readEmails });
      showToast($t('addressView.markAllRead'));
      await onReloadAccounts();
    } catch {
      /* ignore */
    }
  }}
  onMarkAllUnread={async (account) => {
    try {
      const { readEmails = {}, storedEmails = {} } = (await browser.storage.local.get([
        'readEmails',
        'storedEmails',
      ])) as { readEmails?: Record<string, boolean>; storedEmails?: Record<string, Email[]> };
      const bag = storedEmails[account.address] || [];
      for (const e of bag) {
        delete readEmails[`${account.address}_${e.id}`];
        delete readEmails[e.id];
      }
      await browser.storage.local.set({ readEmails });
      showToast($t('addressView.markAllUnread'));
      await onReloadAccounts();
    } catch {
      /* ignore */
    }
  }}
  {showToast}
  {selectedProviderInstance}
  notificationsEnabled={notificationsEnabled}
  onToggleNotifications={onToggleNotifications}
  gesturesEnabled={gesturesEnabled}
/>
</div>

<!-- Action row: Copy Email, QR, New Address, Refresh, Notifications -->
{#if !searchBarFocused && !emailSelection.mode && (!actionRowCollapsed || accountSelectorHovered || actionRowHovered)}
<div
  class="mailbox-action-row w-full flex items-center justify-between gap-1.5 pt-2 pb-2 transition-all duration-300 ease-in-out"
  style="opacity: {actionRowCollapsed && !accountSelectorHovered && !actionRowHovered ? '0' : '1'}; transform: {actionRowCollapsed && !accountSelectorHovered && !actionRowHovered ? 'translateY(-10px)' : 'translateY(0)'}; --action-btn-font: {actionBtnFontPx}px;"
  bind:this={actionRowEl}
  onmouseenter={() => { actionRowHovered = true; }}
  onmouseleave={() => { actionRowHovered = false; }}
  role="none"
>
  <!-- Copy Email -->
  <button
    id="button-copy-email"
    class="btn-primary {actionBtnEqualWidth ? 'flex-1' : 'flex-auto'} flex items-center justify-center gap-1.5 px-2.5 h-8.5 rounded-xl font-bold tracking-wide transition-colors shadow-sm min-w-0"
    style="font-size: var(--action-btn-font, 0.75rem);"
    aria-label={$t('inbox.copyEmailAria')}
    title={$t('inbox.copyEmailAria')}
    onclick={(e) => { e.stopPropagation(); onCopyEmail(); }}
  >
    <span class="btn-icon flex items-center justify-center w-5 h-5 rounded-full shrink-0">
      <Icon name="copy" class="w-3.5 h-3.5" />
    </span>
    <span class="leading-tight self-center whitespace-nowrap overflow-visible">{$t('common.copy')}</span>
  </button>

  <!-- QR Code -->
  <button
    id="button-qr-code"
    class="btn-secondary {actionBtnEqualWidth ? 'flex-1' : 'flex-auto'} flex items-center justify-center gap-1.5 px-2.5 h-8.5 rounded-xl font-bold tracking-wide transition-colors shadow-sm min-w-0"
    style="font-size: var(--action-btn-font, 0.75rem);"
    aria-label={$t('inbox.showQrAria')}
    title={$t('inbox.showQrAria')}
    onclick={(e) => { e.stopPropagation(); onOpenQrDialog(); }}
  >
    <span class="btn-icon flex items-center justify-center w-5 h-5 rounded-full shrink-0">
      <Icon name="qr" class="w-3.5 h-3.5" />
    </span>
    <span class="leading-tight self-center whitespace-nowrap overflow-visible">QR</span>
  </button>

  <!-- Archive/Unarchive -->
  {#if currentAccount}
    {#if currentAccount.accountStatus === 'archived'}
      <button
        id="button-unarchive"
        class="btn-tertiary {actionBtnEqualWidth ? 'flex-1' : 'flex-auto'} flex items-center justify-center gap-1.5 px-2.5 h-8.5 rounded-xl font-bold tracking-wide transition-colors shadow-sm min-w-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
        style="font-size: var(--action-btn-font, 0.75rem);"
        aria-label={$t('inbox.unarchiveEmailAria')}
        title={canUnarchiveCurrent
          ? $t('inbox.unarchiveEmailAria')
          : $t('account.unarchiveNotAvailable')}
        disabled={!canUnarchiveCurrent}
        aria-disabled={!canUnarchiveCurrent}
        onclick={(e) => {
          e.stopPropagation();
          if (!canUnarchiveCurrent || !currentAccount) return;
          onUnarchiveAccount(currentAccount);
        }}
      >
        <span class="btn-icon flex items-center justify-center w-5 h-5 rounded-full shrink-0">
          <Icon name="archive" class="w-3.5 h-3.5" />
        </span>
        <span class="leading-tight self-center whitespace-nowrap overflow-visible">{$t('common.unarchive')}</span>
      </button>
    {:else}
      <button
        id="button-archive"
        class="btn-tertiary {actionBtnEqualWidth ? 'flex-1' : 'flex-auto'} flex items-center justify-center gap-1.5 px-2.5 h-8.5 rounded-xl font-bold tracking-wide transition-colors shadow-sm min-w-0"
        style="font-size: var(--action-btn-font, 0.75rem);"
        aria-label={$t('inbox.archiveEmailAria')}
        title={$t('inbox.archiveEmailAria')}
        onclick={(e) => { e.stopPropagation(); onArchiveAccount(currentAccount); }}
      >
        <span class="btn-icon flex items-center justify-center w-5 h-5 rounded-full shrink-0">
          <Icon name="archive" class="w-3.5 h-3.5" />
        </span>
        <span class="leading-tight self-center whitespace-nowrap overflow-visible">{$t('common.archive')}</span>
      </button>
    {/if}

    <!-- Forget Me / Restore -->
    {#if currentAccount.accountStatus === 'deleted'}
      <button
        id="button-restore"
        class="btn-error {actionBtnEqualWidth ? 'flex-1' : 'flex-auto'} flex items-center justify-center gap-1.5 px-2.5 h-8.5 rounded-xl font-bold tracking-wide transition-colors shadow-sm min-w-0"
        style="font-size: var(--action-btn-font, 0.75rem);"
        aria-label={$t('inbox.restoreEmailAria')}
        title={$t('inbox.restoreEmailAria')}
        onclick={(e) => { e.stopPropagation(); onRestoreAccount(currentAccount.address); }}
      >
        <span class="btn-icon flex items-center justify-center w-5 h-5 rounded-full shrink-0">
          <Icon name="back" class="w-3.5 h-3.5" />
        </span>
        <span class="leading-tight self-center whitespace-nowrap overflow-visible">{$t('common.restore')}</span>
      </button>
    {:else}
      <button
        id="button-delete"
        class="btn-error {actionBtnEqualWidth ? 'flex-1' : 'flex-auto'} flex items-center justify-center gap-1.5 px-2.5 h-8.5 rounded-xl font-bold tracking-wide transition-colors shadow-sm min-w-0"
        style="font-size: var(--action-btn-font, 0.75rem);"
        aria-label={$t('inbox.deleteEmailAria')}
        title={$t('inbox.deleteEmailAria')}
        onclick={(e) => { e.stopPropagation(); onRemoveAccount(currentAccount.address); }}
      >
        <span class="btn-icon flex items-center justify-center w-5 h-5 rounded-full shrink-0">
          <Icon name="trash" class="w-3.5 h-3.5" />
        </span>
        <span class="leading-tight self-center whitespace-nowrap overflow-visible">{$t('common.delete')}</span>
      </button>
    {/if}
  {/if}

</div>
{/if}

    <!-- Collapsible action row (auto-renew toggle + tag pill) -->
    {#if currentAccount && !searchBarFocused && !emailSelection.mode && (!actionRowCollapsed || accountSelectorHovered || actionRowHovered)}
      <div
        class="transition-all duration-300 ease-in-out"
        style="opacity: {actionRowCollapsed && !accountSelectorHovered && !actionRowHovered ? '0' : '1'}; transform: {actionRowCollapsed && !accountSelectorHovered && !actionRowHovered ? 'translateY(-10px)' : 'translateY(0)'};"
        onmouseenter={() => { actionRowHovered = true; }}
        onmouseleave={() => { actionRowHovered = false; }}
        role="none"
      >
        <div class="flex items-center gap-2">
          <!-- Auto-renew pill toggle (hidden for archived mailboxes) -->
          {#if supportsAutoRenew && currentAccount.expiresAt && !isCurrentAccountArchived}
            <AutoRenewToggle
              autoRenew={currentAccount.autoExtend || false}
              onToggle={() => onToggleAutoExtend(currentAccount)}
            />
          {/if}

          <!-- Tag pill -->
          <TagPill
            tag={currentAccount.tag}
            tagColor={currentAccount.tagColor}
            onClick={openTagDialog}
            showIcon={true}
          />
        </div>
      </div>
    {/if}

    <!-- Hide / Always Show: pill, flush bottom-end of account container (no chevron) -->
    {#if !actionRowCollapsed || accountSelectorHovered || actionRowHovered}
    <button
      id="button-collapse-toggle"
      type="button"
      class="reveal-toggle absolute end-0 bottom-0 z-10 m-0 px-3 py-0.5 cursor-pointer rounded-ss-full rounded-ee-none rounded-se-none rounded-es-none text-xs font-bold tracking-wide leading-none h-5 min-w-[3.5rem] border border-md-outline-variant/50 shadow-sm transition-colors
        {actionRowCollapsed
          ? 'bg-md-primary text-md-on-primary hover:bg-md-primary/90'
          : 'bg-md-secondary-container text-md-on-secondary-container hover:brightness-95'}"
      style="margin: 0; inset-inline-end: 0; bottom: 0;"
      onclick={(e) => { e.stopPropagation(); handleActionRowToggle(); }}
      onmouseenter={() => { actionRowHovered = true; }}
      onmouseleave={() => { actionRowHovered = false; }}
      aria-label={!actionRowCollapsed ? $t('inbox.hideActionRow') : $t('inbox.alwaysShowActionRow')}
      title={!actionRowCollapsed ? $t('inbox.hideActionRow') : $t('inbox.alwaysShowActionRow')}
    >
      {#if !actionRowCollapsed}
        {$t('inbox.hideActionRow')}
      {:else}
        {$t('inbox.alwaysShowActionRow')}
      {/if}
    </button>
    {/if}
</div>

{#if hideHintDialogOpen}
  <div
    bind:this={hideHintOverlayEl}
    class="fixed inset-0 z-[10000] flex items-center justify-center p-4"
    data-portal-layer="dialog"
    role="dialog"
    aria-modal="true"
  >
    <button type="button" class="absolute inset-0 bg-md-scrim/40" aria-label={$t('common.close')} onclick={() => void dismissHideHint(false)}></button>
    <div class="relative z-10 w-full max-w-[300px] rounded-2xl bg-md-surface border border-md-outline-variant/40 shadow-2xl p-4 space-y-3 animate-in">
      <h3 class="text-sm font-bold text-md-on-surface">{$t('inbox.hideActionRowTitle')}</h3>
      <p class="text-xs text-md-on-surface/70 leading-relaxed">{$t('inbox.hideActionRowBody')}</p>
      <label class="flex items-center gap-2 text-label-sm text-md-on-surface/70 cursor-pointer select-none">
        <Checkbox bind:checked={hideHintDontShow} />
        {$t('inbox.dontShowAgain')}
      </label>
      <button
        type="button"
        class="w-full py-2 rounded-xl text-xs font-semibold bg-md-primary text-md-on-primary"
        onclick={() => void dismissHideHint(hideHintDontShow)}
      >{$t('common.confirm')}</button>
    </div>
  </div>
{/if}


<!-- Search + Filter row -->
<div class="shrink-0" data-tour="search-filter">
{#snippet layoutMenu()}
    <div class="relative shrink-0">
      <button
        type="button"
        id="button-tab-view"
        aria-haspopup="menu"
        aria-expanded={viewDropdownOpen}
        aria-label={$t('inbox.layoutMenu')}
        title={$t('inbox.layoutMenu')}
        class="w-8 h-8 flex items-center justify-center rounded-xl transition-colors mt-0 {viewDropdownOpen || threadGrouping || showStarredOnly ? 'bg-md-primary/15 text-md-primary' : 'bg-md-surface hover:bg-md-surface-variant text-md-on-surface/50'}"
        onclick={(e) => {
          e.stopPropagation();
          viewDropdownOpen = !viewDropdownOpen;
          labelOverflowOpen = false;
        }}
      >
        <Icon name="grid" class="w-4 h-4" />
      </button>
      {#if viewDropdownOpen}
        <button
          type="button"
          class="fixed inset-0 {PORTAL_Z_CLASS.navMenu} cursor-default bg-transparent"
          aria-label={$t('common.close')}
          onclick={() => {
            viewDropdownOpen = false;
            viewSortSubOpen = false;
            viewShowSubOpen = false;
          }}
        ></button>
        <div
          class="menu-list absolute top-full end-0 mt-1 bg-md-surface-container-low border border-md-outline-variant/50 rounded-xl shadow-xl {PORTAL_Z_CLASS.accountMenu} overflow-visible min-w-[210px]"
          role="menu"
          tabindex="-1"
          onmouseleave={() => { viewSortSubOpen = false; viewShowSubOpen = false; }}
        >
          <div
            class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface"
            data-menu-item
          >
            <Icon name="globe" class="w-3.5 h-3.5 shrink-0 text-md-on-surface-variant" />
            <span class="flex-1">{$t('inbox.viewOptions.showFavicons')}</span>
            <Toggle
              size="sm"
              checked={showFavicons}
              ariaLabel={$t('inbox.viewOptions.showFavicons')}
              onChange={(v) => (showFavicons = v)}
            />
          </div>
          <div class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface" data-menu-item>
            <Icon name="tag" class="w-3.5 h-3.5 shrink-0 text-md-on-surface-variant" />
            <span class="flex-1">{$t('inbox.viewOptions.showLabels')}</span>
            <Toggle
              size="sm"
              checked={!hideLabels}
              ariaLabel={$t('inbox.viewOptions.showLabels')}
              onChange={(v) => (hideLabels = !v)}
            />
          </div>
          <div class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface" data-menu-item>
            <Icon name="lock" class="w-3.5 h-3.5 shrink-0 text-md-on-surface-variant" />
            <span class="flex-1">{$t('inbox.viewOptions.showOtpLabels')}</span>
            <Toggle
              size="sm"
              checked={!hideOtpLabels}
              ariaLabel={$t('inbox.viewOptions.showOtpLabels')}
              onChange={(v) => (hideOtpLabels = !v)}
            />
          </div>
          <div class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface" data-menu-item>
            <Icon name="download" class="w-3.5 h-3.5 shrink-0 text-md-on-surface-variant" />
            <span class="flex-1">{$t('inbox.viewOptions.showAttachmentBadges')}</span>
            <Toggle
              size="sm"
              checked={!hideAttachmentBadges}
              ariaLabel={$t('inbox.viewOptions.showAttachmentBadges')}
              onChange={(v) => (hideAttachmentBadges = !v)}
            />
          </div>
          <div class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface" data-menu-item>
            <Icon name="threads" class="w-3.5 h-3.5 shrink-0 text-md-on-surface-variant" />
            <span class="flex-1">{$t('inbox.viewOptions.groupThreads')}</span>
            <Toggle
              size="sm"
              checked={threadGrouping}
              ariaLabel={$t('inbox.viewOptions.groupThreads')}
              onChange={(v) => {
                threadGrouping = v;
                expandedThreadIds = new Set();
                void browser.storage.local.set({ threadGrouping });
              }}
            />
          </div>
          <div class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface" data-menu-item>
            <Icon name="star" class="w-3.5 h-3.5 shrink-0 text-md-tertiary" />
            <span class="flex-1">{$t('inbox.viewOptions.starredOnly')}</span>
            <Toggle
              size="sm"
              checked={showStarredOnly}
              ariaLabel={$t('inbox.viewOptions.starredOnly')}
              onChange={(v) => (showStarredOnly = v)}
            />
          </div>

          <div class="border-t border-md-outline-variant/40 my-1"></div>
          <div class="px-3 py-1 text-xs font-bold text-md-on-surface/40">{$t('inbox.viewOptions.stripsSection')}</div>
          <div class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface" data-menu-item>
            <Icon name="lock" class="w-3.5 h-3.5 shrink-0 text-md-on-surface-variant" />
            <span class="flex-1">{$t('inbox.viewOptions.showOtpStrip')}</span>
            <Toggle
              size="sm"
              checked={!preferHideOtpStrip}
              ariaLabel={$t('inbox.viewOptions.showOtpStrip')}
              onChange={(v) => {
                preferHideOtpStrip = !v;
                void browser.storage.local.set({ preferHideOtpStrip });
              }}
            />
          </div>
          <div class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface" data-menu-item>
            <Icon name="edit" class="w-3.5 h-3.5 shrink-0 text-md-on-surface-variant" />
            <span class="flex-1">{$t('inbox.viewOptions.showAutofillStrip')}</span>
            <Toggle
              size="sm"
              checked={!preferHideAutofillStrip}
              ariaLabel={$t('inbox.viewOptions.showAutofillStrip')}
              onChange={(v) => {
                preferHideAutofillStrip = !v;
                void browser.storage.local.set({ preferHideAutofillStrip });
              }}
            />
          </div>
          <div class="w-full flex items-center gap-3 px-3 min-h-12 text-sm text-md-on-surface" data-menu-item>
            <Icon name="globe" class="w-3.5 h-3.5 shrink-0 text-md-on-surface-variant" />
            <span class="flex-1">{$t('inbox.viewOptions.showMagicLinkStrip')}</span>
            <Toggle
              size="sm"
              checked={!preferHideMagicStrip}
              ariaLabel={$t('inbox.viewOptions.showMagicLinkStrip')}
              onChange={(v) => {
                preferHideMagicStrip = !v;
                void browser.storage.local.set({ preferHideMagicStrip });
              }}
            />
          </div>

          <div class="border-t border-md-outline-variant/40 my-1"></div>

          <div
            class="relative"
            role="none"
            onmouseenter={() => { viewShowSubOpen = true; viewSortSubOpen = false; }}
            onmouseleave={() => { viewShowSubOpen = false; }}
          >
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 min-h-12 text-sm text-start hover:bg-md-surface-variant transition-colors text-md-on-surface"
              onclick={() => { viewShowSubOpen = !viewShowSubOpen; viewSortSubOpen = false; }}
            >
              <Icon name="chevronLeft" class="w-3.5 h-3.5 shrink-0 opacity-50 rtl-flip" />
              <Icon name="inbox" class="w-3.5 h-3.5 shrink-0" />
              <span class="flex-1">{$t('inbox.pageSize')}</span>
              <span class="text-xs text-md-on-surface/50 tabular-nums">{pageSize}</span>
            </button>
            {#if viewShowSubOpen}
              <div
                class="absolute top-0 end-full me-1 bg-md-surface-container border border-md-outline-variant rounded-xl shadow-lg {PORTAL_Z_CLASS.accountMenu} min-w-[140px] overflow-hidden"
                role="menu"
              >
                {#each PAGE_SIZE_OPTIONS as n (n)}
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 min-h-12 text-sm text-start hover:bg-md-surface-variant {pageSize === n ? 'text-md-primary font-medium' : 'text-md-on-surface'}"
                    onclick={() => { void setPageSize(n); viewDropdownOpen = false; viewShowSubOpen = false; }}
                  >
                    <span class="flex-1">{$t('inbox.pageSizeOption', { values: { n } })}</span>
                    {#if pageSize === n}<Icon name="check" class="w-3.5 h-3.5 shrink-0" />{/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          <div
            class="relative"
            role="none"
            onmouseenter={() => { viewSortSubOpen = true; viewShowSubOpen = false; }}
            onmouseleave={() => { viewSortSubOpen = false; }}
          >
            <button
              type="button"
              class="w-full flex items-center gap-2 px-3 min-h-12 text-sm text-start hover:bg-md-surface-variant transition-colors text-md-on-surface"
              onclick={() => { viewSortSubOpen = !viewSortSubOpen; viewShowSubOpen = false; }}
            >
              <Icon name="chevronLeft" class="w-3.5 h-3.5 shrink-0 opacity-50 rtl-flip" />
              <Icon name="clock" class="w-3.5 h-3.5 shrink-0" />
              <span class="flex-1">{$t('inbox.viewOptions.sortSection')}</span>
            </button>
            {#if viewSortSubOpen}
              <div
                class="absolute top-0 end-full me-1 bg-md-surface-container border border-md-outline-variant rounded-xl shadow-lg {PORTAL_Z_CLASS.accountMenu} min-w-[240px] overflow-hidden p-1.5 space-y-1"
                role="menu"
              >
                <div class="flex items-center gap-2 px-1.5 py-1 rounded-lg">
                  <Icon name="clock" class="w-3.5 h-3.5 shrink-0 text-md-on-surface/50" />
                  <span class="flex-1 min-w-0 text-xs font-semibold text-md-on-surface truncate">{$t('inbox.viewOptions.sortByDate')}</span>
                  <div class="flex items-stretch rounded-md border border-md-outline-variant/50 overflow-hidden shrink-0">
                    <button
                      type="button"
                      class="px-2 py-1 text-label-sm font-bold transition-colors {sortBy === 'newest' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
                      onclick={() => { handleSortChange('newest'); viewDropdownOpen = false; viewSortSubOpen = false; }}
                    >{$t('inbox.viewOptions.sortNewestShort')}</button>
                    <span class="w-px bg-md-outline-variant/60 shrink-0" aria-hidden="true"></span>
                    <button
                      type="button"
                      class="px-2 py-1 text-label-sm font-bold transition-colors {sortBy === 'oldest' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
                      onclick={() => { handleSortChange('oldest'); viewDropdownOpen = false; viewSortSubOpen = false; }}
                    >{$t('inbox.viewOptions.sortOldestShort')}</button>
                  </div>
                </div>
                <div class="flex items-center gap-2 px-1.5 py-1 rounded-lg">
                  <Icon name="user" class="w-3.5 h-3.5 shrink-0 text-md-on-surface/50" />
                  <span class="flex-1 min-w-0 text-xs font-semibold text-md-on-surface truncate">{$t('inbox.viewOptions.sortBySenderName')}</span>
                  <div class="flex items-stretch rounded-md border border-md-outline-variant/50 overflow-hidden shrink-0">
                    <button
                      type="button"
                      class="px-2 py-1 text-label-sm font-bold transition-colors {sortBy === 'senderNameAsc' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
                      onclick={() => { handleSortChange('senderNameAsc'); viewDropdownOpen = false; viewSortSubOpen = false; }}
                    >{$t('inbox.viewOptions.sortAscShort')}</button>
                    <span class="w-px bg-md-outline-variant/60 shrink-0" aria-hidden="true"></span>
                    <button
                      type="button"
                      class="px-2 py-1 text-label-sm font-bold transition-colors {sortBy === 'senderNameDesc' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
                      onclick={() => { handleSortChange('senderNameDesc'); viewDropdownOpen = false; viewSortSubOpen = false; }}
                    >{$t('inbox.viewOptions.sortDescShort')}</button>
                  </div>
                </div>
                <div class="flex items-center gap-2 px-1.5 py-1 rounded-lg">
                  <Icon name="envelope" class="w-3.5 h-3.5 shrink-0 text-md-on-surface/50" />
                  <span class="flex-1 min-w-0 text-xs font-semibold text-md-on-surface truncate">{$t('inbox.viewOptions.sortBySenderEmail')}</span>
                  <div class="flex items-stretch rounded-md border border-md-outline-variant/50 overflow-hidden shrink-0">
                    <button
                      type="button"
                      class="px-2 py-1 text-label-sm font-bold transition-colors {sortBy === 'senderEmailAsc' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
                      onclick={() => { handleSortChange('senderEmailAsc'); viewDropdownOpen = false; viewSortSubOpen = false; }}
                    >{$t('inbox.viewOptions.sortAscShort')}</button>
                    <span class="w-px bg-md-outline-variant/60 shrink-0" aria-hidden="true"></span>
                    <button
                      type="button"
                      class="px-2 py-1 text-label-sm font-bold transition-colors {sortBy === 'senderEmailDesc' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
                      onclick={() => { handleSortChange('senderEmailDesc'); viewDropdownOpen = false; viewSortSubOpen = false; }}
                    >{$t('inbox.viewOptions.sortDescShort')}</button>
                  </div>
                </div>
                <div class="flex items-center gap-2 px-1.5 py-1 rounded-lg">
                  <Icon name="mail" class="w-3.5 h-3.5 shrink-0 text-md-on-surface/50" />
                  <span class="flex-1 min-w-0 text-xs font-semibold text-md-on-surface truncate">{$t('inbox.viewOptions.sortBySubject')}</span>
                  <div class="flex items-stretch rounded-md border border-md-outline-variant/50 overflow-hidden shrink-0">
                    <button
                      type="button"
                      class="px-2 py-1 text-label-sm font-bold transition-colors {sortBy === 'subjectAsc' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
                      onclick={() => { handleSortChange('subjectAsc'); viewDropdownOpen = false; viewSortSubOpen = false; }}
                    >{$t('inbox.viewOptions.sortAscShort')}</button>
                    <span class="w-px bg-md-outline-variant/60 shrink-0" aria-hidden="true"></span>
                    <button
                      type="button"
                      class="px-2 py-1 text-label-sm font-bold transition-colors {sortBy === 'subjectDesc' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
                      onclick={() => { handleSortChange('subjectDesc'); viewDropdownOpen = false; viewSortSubOpen = false; }}
                    >{$t('inbox.viewOptions.sortDescShort')}</button>
                  </div>
                </div>
              </div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
{/snippet}
<FilterList
  searchQuery={searchQuery}
  sortBy={sortBy}
  otpOnly={otpOnly}
  hasAttachment={hasAttachment}
  senderDomain={senderDomain}
  senderEmail={senderEmail}
  recipient={recipient}
  subject={subject}
  notSenderDomain={notSenderDomain}
  notSenderEmail={notSenderEmail}
  notRecipient={notRecipient}
  notSubject={notSubject}
  selectedSenders={selectedSenders}
  emails={emails}
  dateFrom={dateFrom}
  dateTo={dateTo}
  savedSearchFilters={savedSearchFilters}
  onSearchChange={(value: string) => onSearchChange(value)}
  onSortChange={(value: string) => { handleSortChange(value); }}
  onOtpOnlyChange={(value: boolean) => { onOtpOnlyChange(value); }}
  onHasAttachmentChange={(value: boolean) => { onHasAttachmentChange(value); }}
  onSenderDomainChange={(value: string) => { onSenderDomainChange(value); }}
  onSelectedSendersChange={(value: string[]) => { onSelectedSendersChange(value); }}
  onDateFromChange={(value: string) => { onDateFromChange(value); }}
  onDateToChange={(value: string) => { onDateToChange(value); }}
  onClearFilters={onClearFilters}
  onSaveFilter={async (name: string, sq: string, otp: boolean, att: boolean, sd: string, df: string, dt: string, senders: string[], sort: string, rec: string, subj: string) => {
    await onSaveFilter(name, sq, otp, att, sd, df, dt, senders, sort, rec, subj);
  }}
  onLoadFilter={onLoadFilter}
  onRenameFilter={onRenameFilter}
  onDeleteFilter={onDeleteFilter}
  onSearchFocus={() => {
    searchBarFocused = true;
    searchFocusEmailBaseline = emails.length;
    searchFocusNewMailCount = 0;
  }}
  onSearchBlur={() => {
    searchBarFocused = false;
    searchFocusNewMailCount = 0;
  }}
  onFilterClick={() => { /* filter menu only — do not focus search */ }}
  onRefreshInbox={onRefreshInbox}
  emailsLoading={loading}
  onToggleNotifications={onToggleNotifications}
  notificationsEnabled={notificationsEnabled}
  currentAddress={currentAccount?.address || selectedEmail || ''}
  {layoutMenu}
/>
</div>

<!-- Status tabs + labels: hidden when sidebar owns them (except during search) -->
{#if !hideListTabsUnlessSearch || !!(searchQuery && searchQuery.trim())}
<div class="shrink-0 px-0 py-1" data-tour="email-list-tabs">
  {#if true}
    {@const chip =
      'text-xs px-2.5 py-1 rounded-full whitespace-nowrap shrink-0 transition-colors'}
    {@const tabOn = 'bg-md-secondary-container text-md-on-secondary-container'}
    {@const tabOff =
      'border border-md-outline-variant text-md-on-surface-variant bg-md-surface-container-low hover:bg-md-secondary-container hover:text-md-on-secondary-container'}
    {@const maxInlineLabels = 6}
    {@const inlineLabels = availableLabels.slice(0, maxInlineLabels)}
    {@const overflowLabels = availableLabels.slice(maxInlineLabels)}
    <div class="relative flex flex-wrap gap-1 items-center content-start" role="tablist" aria-label={$t('inbox.listTabs.tabAria')}>
      <button
        id="button-tab-all"
        role="tab"
        aria-selected={emailListTab === 'all'}
        aria-label={$t('inbox.listTabs.allMails', { values: { count: tabCounts.all } })}
        class="{chip} {emailListTab === 'all' ? tabOn : tabOff}"
        onclick={() => { emailListTab = 'all'; activeLabelFilter = null; }}
        ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
        ondrop={(e) => {
          e.preventDefault();
          if (!emailSelection.mode && selectedEmailIds.size === 0) return;
          emailListTab = 'all';
          activeLabelFilter = null;
        }}
      >
        {$t('inbox.listTabs.allMails', { values: { count: tabCounts.all } })}
      </button>
      <button
        id="button-tab-inbox"
        role="tab"
        aria-selected={emailListTab === 'inbox'}
        aria-label={$t('inbox.listTabs.inbox', { values: { count: tabCounts.inbox } })}
        class="{chip} {emailListTab === 'inbox' ? tabOn : tabOff}"
        onclick={() => { emailListTab = 'inbox'; activeLabelFilter = null; }}
        ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
        ondrop={(e) => {
          e.preventDefault();
          if (!emailSelection.mode && selectedEmailIds.size === 0) return;
          if (emailListTab === 'archived' || emailListTab === 'deleted') performRestore();
          emailListTab = 'inbox';
          activeLabelFilter = null;
        }}
      >
        {$t('inbox.listTabs.inbox', { values: { count: tabCounts.inbox } })}
      </button>
      <button
        id="button-tab-archived"
        role="tab"
        aria-selected={emailListTab === 'archived'}
        aria-label={$t('inbox.listTabs.archived', { values: { count: tabCounts.archived } })}
        class="{chip} {emailListTab === 'archived' ? tabOn : tabOff}"
        onclick={() => { emailListTab = 'archived'; activeLabelFilter = null; }}
        ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
        ondrop={(e) => {
          e.preventDefault();
          if (!emailSelection.mode && selectedEmailIds.size === 0) return;
          if (emailListTab !== 'archived') performArchive();
          emailListTab = 'archived';
          activeLabelFilter = null;
        }}
      >
        {$t('inbox.listTabs.archived', { values: { count: tabCounts.archived } })}
      </button>
      <button
        id="button-tab-deleted"
        role="tab"
        aria-selected={emailListTab === 'deleted'}
        aria-label={$t('inbox.listTabs.deleted', { values: { count: tabCounts.deleted } })}
        class="{chip} {emailListTab === 'deleted' ? tabOn : tabOff}"
        onclick={() => { emailListTab = 'deleted'; activeLabelFilter = null; }}
        ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
        ondrop={(e) => {
          e.preventDefault();
          if (!emailSelection.mode && selectedEmailIds.size === 0) return;
          if (emailListTab !== 'deleted') performDelete();
          emailListTab = 'deleted';
          activeLabelFilter = null;
        }}
      >
        {$t('inbox.listTabs.deleted', { values: { count: tabCounts.deleted } })}
      </button>

      {#if tabCounts.storedLocally > 0}
        <button
          id="button-tab-stored-locally"
          role="tab"
          aria-selected={emailListTab === 'storedLocally'}
          aria-label={$t('inbox.listTabs.storedLocally', { values: { count: tabCounts.storedLocally } })}
          class="{chip} {emailListTab === 'storedLocally' ? tabOn : tabOff}"
          onclick={() => { emailListTab = 'storedLocally'; activeLabelFilter = null; }}
        >
          {$t('inbox.listTabs.storedLocally', { values: { count: tabCounts.storedLocally } })}
        </button>
      {/if}

      {#each inlineLabels as lab (lab)}
        {@const labCount = labelCountInStatusTab(lab)}
        <button
          type="button"
          class="text-xs px-2 py-1 rounded-full max-w-[120px] truncate whitespace-nowrap shrink-0 {activeLabelFilter === lab ? 'bg-md-tertiary text-md-on-tertiary' : 'bg-md-tertiary-container text-md-on-tertiary-container'} hover:opacity-90 transition-colors"
          title={`${lab} (${labCount})`}
          onclick={() => { activeLabelFilter = activeLabelFilter === lab ? null : lab; }}
          ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }}
          ondrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void applyLabelToSelected(lab);
            activeLabelFilter = lab;
          }}
        >{lab} ({labCount})</button>
      {/each}

      {#if overflowLabels.length > 0}
        <div class="relative shrink-0">
          <button
            type="button"
            class="text-xs px-2 py-1 rounded-full whitespace-nowrap font-semibold {overflowLabels.includes(activeLabelFilter || '') ? 'bg-md-tertiary text-md-on-tertiary' : 'bg-md-tertiary-container text-md-on-tertiary-container'} hover:opacity-90"
            aria-expanded={labelOverflowOpen}
            aria-label={$t('inbox.moreLabels', { values: { n: overflowLabels.length } })}
            onclick={(e) => {
              e.stopPropagation();
              labelOverflowOpen = !labelOverflowOpen;
            }}
          >{$t('common.plusN', { values: { n: overflowLabels.length } })}</button>
          {#if labelOverflowOpen}
            <button
              type="button"
              class="fixed inset-0 {PORTAL_Z_CLASS.navMenu} bg-transparent cursor-default"
              aria-label={$t('common.close')}
              onclick={() => (labelOverflowOpen = false)}
            ></button>
            <div class="absolute start-0 top-full mt-1 {PORTAL_Z_CLASS.accountMenu} min-w-[120px] max-h-48 overflow-y-auto rounded-xl border border-md-outline-variant bg-md-surface shadow-xl p-1">
              {#each overflowLabels as lab (lab)}
                {@const labCount = labelCountInStatusTab(lab)}
                <button
                  type="button"
                  class="w-full text-start px-2.5 py-1.5 text-label-sm rounded-lg truncate {activeLabelFilter === lab ? 'bg-md-tertiary/15 text-md-tertiary font-semibold' : 'text-md-on-surface hover:bg-md-surface-variant'}"
                  title={`${lab} (${labCount})`}
                  onclick={() => {
                    activeLabelFilter = activeLabelFilter === lab ? null : lab;
                    labelOverflowOpen = false;
                  }}
                  ondragover={(e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }}
                  ondrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void applyLabelToSelected(lab);
                    activeLabelFilter = lab;
                    labelOverflowOpen = false;
                  }}
                >{lab} ({labCount})</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      {#if activeLabelFilter}
        <button
          type="button"
          class="text-xs text-md-on-surface/50 hover:text-md-primary px-0.5 shrink-0"
          aria-label={$t('inbox.clearLabelFilter')}
          title={$t('inbox.clearLabelFilter')}
          onclick={() => { activeLabelFilter = null; }}
        >×</button>
      {/if}
    </div>
  {/if}
</div>
{/if}

<!-- Email list: flex-1, full height — strips and nav float over it. End-of-list spacer inside EmailList handles clearance. -->
<div class="flex-1 min-h-0 h-full w-full flex flex-col relative">
{#if crossMailboxSearchActive}
  <div class="flex-1 min-h-0 overflow-y-auto px-0.5 space-y-2 pb-2">
    {#each crossMailboxGroups as group (group.address)}
      <div class="rounded-xl border border-md-outline-variant/40 overflow-hidden bg-md-surface-container-low">
        <button
          type="button"
          class="w-full flex items-center gap-2 px-3 py-2 text-start hover:bg-md-surface-variant/50 transition-colors"
          onclick={() => {
            const key = group.address.toLowerCase();
            const next = new Set(collapsedCrossMailboxes);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            collapsedCrossMailboxes = next;
          }}
        >
          <Icon
            name="chevronDown"
            class="w-4 h-4 shrink-0 transition-transform {group.collapsed ? '-rotate-90' : ''}"
          />
          <span class="text-sm font-semibold text-md-on-surface truncate flex-1">
            {group.address}
            {#if group.isCurrent}
              <span class="text-xs font-medium text-md-primary ms-1">({$t('inbox.currentMailbox')})</span>
            {/if}
          </span>
          <span class="text-xs text-md-on-surface/50 tabular-nums">{group.emails.length}</span>
        </button>
        {#if !group.collapsed}
          {#if group.emails.length === 0}
            <p class="px-3 pb-2.5 text-xs text-md-on-surface/50">{$t('inbox.noMatchingResultsMailbox')}</p>
          {:else}
            <div class="max-h-[40vh] overflow-y-auto border-t border-md-outline-variant/30">
              <div class="space-y-1 p-1">
                {#each group.emails.slice(0, 50) as mail, i (mail.id)}
                  <div
                    data-marquee-id={mail.id}
                    class="mailbox-row-enter flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-md-surface-variant/40 cursor-pointer transition-colors {selectedEmailIds.has(mail.id) ? 'ring-2 ring-md-secondary bg-md-primary/10' : ''}"
                    style="animation-delay: {Math.min(i * 15, 300)}ms"
                    role="button"
                    tabindex="0"
                    onclick={(e) => {
                      if (emailSelection.mode) {
                        e.stopPropagation();
                        toggleEmailSelection(mail.id);
                      } else {
                        onOpenMessageDetail([mail]);
                      }
                    }}
                    oncontextmenu={(e) => {
                      e.preventDefault();
                      emailSelection.mode = true;
                      const next = new Set(selectedEmailIds);
                      next.add(mail.id);
                      selectedEmailIds = next;
                      emailSelection.count = next.size;
                      emitSelectionChange();
                    }}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (emailSelection.mode) toggleEmailSelection(mail.id);
                        else onOpenMessageDetail([mail]);
                      }
                    }}
                  >
                    <div class="w-7 h-7 rounded-full flex items-center justify-center font-bold text-sm shrink-0 {avatarColor(mail.from_name || mail.from || '')}">
                      {(mail.from_name || mail.from || '?')[0]?.toUpperCase()}
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-xs font-bold text-md-on-surface truncate">{@html highlightMatches(getDisplayName(mail.from || '', mail.from_name), highlightTerms)}</span>
                        <span class="text-xs text-md-on-surface/50 shrink-0">{mail.time}</span>
                      </div>
                      <p class="text-xs text-md-on-surface/60 truncate leading-tight mt-0.5">{@html highlightMatches(mail.subject || '(no subject)', highlightTerms)}</p>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {/if}
      </div>
    {:else}
      <p class="text-center text-sm text-md-on-surface/50 py-8">{$t('inbox.noMatchingResults')}</p>
    {/each}
    <div
      class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
      style="height: calc(var(--bottom-safe-area, 0px) + {totalBottomSpacerHeightPx}px + 12px);"
      aria-hidden="true"
    ></div>
  </div>
{:else}
  <div class="relative flex flex-col flex-1 min-h-0">
    {#if pullDistance > 0 || pullRefreshing}
      {@const ready = pullDistance > 60 || pullRefreshing}
      <div
        class="pull-refresh-band absolute top-0 inset-x-0 flex items-center justify-center py-2 z-10 pointer-events-none"
        style="opacity: {pullRefreshing ? 1 : Math.min(pullDistance / 60, 1)}; transform: translateY({pullRefreshing ? 28 : Math.min(pullDistance * 0.55, 48)}px);"
      >
        <span
          class="pull-refresh-icon {ready && !pullRefreshing ? 'is-ready' : ''} {pullRefreshing ? 'animate-spin' : ''}"
          style={pullRefreshing ? '' : `transform: rotate(${refreshRotation}deg);`}
        >
          {#if ready && !pullRefreshing}
            <Icon name="checkCircle" class="w-5 h-5 text-md-success" />
          {:else}
            <Icon name="refresh" class="w-5 h-5 text-md-primary" />
          {/if}
        </span>
        <span class="text-xs font-semibold ms-2 {ready ? 'text-md-success' : 'text-md-primary'}">
          {pullRefreshing
            ? ($t('common.loading') || 'Refreshing…')
            : ready
              ? ($t('emailList.releaseToRefresh') || 'Release to refresh')
              : ($t('emailList.pullToRefresh') || 'Pull to refresh')}
        </span>
      </div>
    {/if}

    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={listRootEl}
      class="flex-1 min-h-0 h-full w-full px-0 border-t border-md-outline-variant/30 relative flex flex-col {displayedEmails.length === 0 && !loading ? 'overflow-hidden' : 'overflow-y-auto'}"
      onpointerdown={onMarqueePointerDown}
      role="region"
      aria-label={$t('common.emailList')}
      ontouchstart={(e) => {
        startY = e.touches[0].clientY;
        isPulling = true;
        pullDistance = 0;
      }}
      ontouchmove={(e) => {
        if (!isPulling || pullRefreshing) return;
        const container = e.currentTarget as HTMLElement | null;
        if (!container || container.scrollTop > 0) return;
        const currentY = e.touches[0].clientY;
        const raw = Math.max(0, currentY - startY);
        const dist = Math.min(raw * 0.55, 88);
        if (dist > 0) {
          pullDistance = dist;
          pullToRefresh = pullDistance > 60;
          e.preventDefault();
        }
      }}
      ontouchend={async (e) => {
        const container = e.currentTarget as HTMLElement | null;
        const atTop = !container || container.scrollTop === 0;
        if (pullToRefresh && atTop) {
          pullRefreshing = true;
          try {
            await onRefreshInbox();
          } finally {
            pullRefreshing = false;
          }
        }
        pullToRefresh = false;
        pullDistance = 0;
        isPulling = false;
        startY = 0;
      }}
      onmousedown={(e) => {
        startY = e.clientY;
        isPulling = true;
        pullDistance = 0;
      }}
      onmousemove={(e) => {
        if (!isPulling || e.buttons !== 1 || pullRefreshing) return;
        const container = e.currentTarget as HTMLElement | null;
        if (!container || container.scrollTop > 0) return;
        const raw = Math.max(0, e.clientY - startY);
        const dist = Math.min(raw * 0.55, 88);
        if (dist > 12) {
          pullDistance = dist;
          pullToRefresh = pullDistance > 60;
          e.preventDefault();
        }
      }}
      onmouseup={async (e) => {
        const container = e.currentTarget as HTMLElement | null;
        const atTop = !container || container.scrollTop === 0;
        if (pullToRefresh && atTop) {
          pullRefreshing = true;
          try {
            await onRefreshInbox();
          } finally {
            pullRefreshing = false;
          }
        }
        pullToRefresh = false;
        pullDistance = 0;
        isPulling = false;
        startY = 0;
      }}
      onmouseleave={() => {
        if (pullRefreshing) return;
        pullToRefresh = false;
        pullDistance = 0;
        isPulling = false;
        startY = 0;
      }}
      onscroll={(e) => {
        const container = e.currentTarget as HTMLElement | null;
        if (!container) return;
        const scrollBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
        if (scrollBottom < 100 && displayedEmailCount < tabFilteredEmails.length) {
          loadMoreEmails();
        }
        if (scrollRaf) cancelAnimationFrame(scrollRaf);
        scrollRaf = requestAnimationFrame(() => {
          const top = container.scrollTop;
          const delta = top - lastScrollTop;
          if (Math.abs(delta) > 8) {
            const dir = delta > 0 && top > 24 ? 'down' : 'up';
            fabHidden = dir === 'down';
            onScrollDirection(dir);
            lastScrollTop = top;
          }
        });
      }}
    >
      {#if loading && displayedEmails.length === 0}
        <div class="py-2 space-y-2">
          {#each [1, 2, 3] as _}
            <div class="py-2 border-b border-md-outline-variant/30 px-3">
              <div class="flex justify-between mb-1">
                <Skeleton width="6rem" height="0.75rem" />
                <Skeleton width="3rem" height="0.75rem" />
              </div>
              <Skeleton width="75%" height="1rem" />
            </div>
          {/each}
        </div>
      {:else if displayedEmails.length === 0}
        {#if noResultsRecovery}
          <div class="flex items-center justify-center gap-2 px-3 py-2.5 text-xs" role="note">
            <span class="text-md-on-surface/60">
              {$t('inbox.noResultsTryWithout', {
                values: { n: noResultsRecovery.count, pill: noResultsRecovery.lastPill },
              })}
            </span>
            <button
              type="button"
              class="inline-flex items-center gap-1 px-2 py-1 rounded-lg font-semibold bg-md-error/15 text-md-error hover:bg-md-error/25 transition-colors shrink-0"
              onclick={() => {
                // Keep chips in lockstep with the pill we're dropping (same
                // rule as FilterList.removePill) so the filter actually clears.
                const pill = noResultsRecovery.lastPill.toLowerCase();
                if (pill === 'is:otp' || pill === '!is:otp') onOtpOnlyChange(false);
                else if (pill === 'has:attachment' || pill === '!has:attachment')
                  onHasAttachmentChange(false);
                onSearchChange(noResultsRecovery.withoutLast);
              }}
            >
              <Icon name="x" class="w-3 h-3" />
              {$t('inbox.noResultsRemovePill', { values: { pill: noResultsRecovery.lastPill } })}
            </button>
          </div>
        {/if}
        <EmptyState
          fillParent
          iconName={emailListTab === 'archived' ? 'archive' : emailListTab === 'deleted' ? 'trash' : 'mail'}
          title={emailListTab === 'archived' ? $t('emailList.noArchived') : emailListTab === 'deleted' ? $t('emailList.noDeleted') : emailListTab === 'inbox' ? $t('emailList.inboxEmpty') : $t('emailList.noEmailsFound')}
          description={emailListTab === 'archived' ? $t('emailList.swipeArchiveHint') : emailListTab === 'deleted' ? $t('emailList.swipeDeleteHint') : searchQuery || otpOnly || hasAttachment ? $t('emailList.adjustFiltersHint') : emailListTab === 'inbox' ? $t('emailList.emptyInboxHint') : $t('emailList.emptyInboxAllHint')}
          actionLabel={(emailListTab === 'inbox' || emailListTab === 'all') && (searchQuery || otpOnly || hasAttachment) ? $t('emailList.clearFilters') : ''}
          onAction={(emailListTab === 'inbox' || emailListTab === 'all') && (searchQuery || otpOnly || hasAttachment) ? onClearFilters : undefined}
        />
      {:else}
        {#each emailsWithGaps as row, index (row.kind === 'email' ? row.email.id : `gap-${index}`)}
          {#if row.kind === 'offlineGap'}
            <div
              class="shrink-0 flex items-center justify-center gap-2 px-2 py-1.5 text-label-sm text-md-on-surface-variant/70 bg-md-surface-variant/30 border-b border-md-outline-variant/30"
              role="note"
              aria-label={$t('inbox.offlineGapLabel', { values: { from: formatGapTime(row.fromTs), to: formatGapTime(row.toTs) } })}
            >
              <Icon name="wifiOff" class="w-3.5 h-3.5 shrink-0" />
              <span class="truncate">
                {$t('inbox.offlineGapLabel', {
                  values: { from: formatGapTime(row.fromTs), to: formatGapTime(row.toTs) },
                })}
              </span>
            </div>
          {:else}
          {@const mail = row.email}
          {#if threadGrouping}
            {@const thread = emailThreads.find((t: EmailThread) => t.latestEmail.id === mail.id)}
            {#if thread && thread.emails.length > 1}
              <div class="flex items-center justify-between px-2 py-1 bg-md-secondary-container/40 border-b border-md-outline-variant/30">
                <span class="text-xs font-semibold text-md-primary/80 truncate max-w-[65%]">
                  {thread.normalizedSubject || '(no subject)'}
                </span>
                <button
                  class="flex items-center gap-1 text-xs text-md-on-surface/60 hover:text-md-primary transition-colors flex-shrink-0"
                  onclick={(e) => { e.stopPropagation(); toggleThread(thread.id); }}
                  aria-label={$t('common.toggleThread')}
                >
                  <span class="bg-md-primary/15 text-md-primary font-semibold px-1.5 py-0.5 rounded-full">{thread.emails.length}</span>
                  {#if expandedThreadIds.has(thread.id)}
                    <Icon name="chevronUp" class="w-3 h-3" />
                  {:else}
                    <Icon name="chevronDown" class="w-3 h-3" />
                  {/if}
                </button>
              </div>
            {/if}
          {/if}
          <div
            class="relative shrink-0 min-h-[60px] overflow-hidden border-b border-md-outline-variant/50 density-row {exitingEmailIds.has(row.email.id) ? 'email-row-exit' : ''} {threadGrouping && emailThreads.find((t: EmailThread) => t.latestEmail.id !== row.email.id && t.emails.some((e: Email) => e.id === row.email.id)) ? 'ps-3 bg-md-surface-variant/20' : ''}"
            id="email-item-{row.email.id}"
          >
            {#if swipingEmail === mail && swipeDirection}
              {@const isRestoreTab = emailListTab === 'archived' || emailListTab === 'deleted'}
              {@const rtl = isDocumentRtl()}
              {@const isDeleteSwipe = !isRestoreTab && ((!rtl && swipeDirection === 'left') || (rtl && swipeDirection === 'right'))}
              {@const isArchiveSwipe = !isRestoreTab && !isDeleteSwipe}
              <div
                class="absolute inset-0 flex items-center gap-2 px-4 transition-colors duration-200 {isDeleteSwipe ? 'justify-end bg-md-error' : ''} {isArchiveSwipe ? 'justify-start bg-md-tertiary' : ''} {isRestoreTab ? (swipeDirection === 'left' ? 'justify-end' : 'justify-start') + ' bg-md-primary' : ''}"
                style="opacity: {Math.abs(swipeDistance) / 120};"
              >
                {#if isRestoreTab}
                  <Icon name="refresh" class="w-6 h-6 text-white" />
                  <span class="text-white font-medium text-sm">{$t('inbox.emailActions.restore')}</span>
                {:else if isDeleteSwipe}
                  <Icon name="trash" class="w-6 h-6 text-white" />
                  <span class="text-white font-medium text-sm">{$t('inbox.emailActions.delete')}</span>
                {:else}
                  <Icon name="archive" class="w-6 h-6 text-white" />
                  <span class="text-white font-medium text-sm">{$t('inbox.emailActions.archive')}</span>
                {/if}
              </div>
            {/if}

            <div
              id="email-button-{mail.id}"
              data-marquee-id={mail.id}
              role="button"
              tabindex="0"
              aria-label={$t('common.emailFromSubject', { values: { from: mail.from, subject: mail.subject } })}
              class="w-full shrink-0 min-h-[60px] text-start border-0 focus:outline-none hover:bg-md-surface-variant/40 duration-150 {mail.id === activeThreadMessageId ? 'bg-md-secondary-container/60 font-semibold text-md-on-secondary-container shadow-sm' : mail.id === highlightedEmailId ? 'bg-md-primary/5' : mail.unread ? 'bg-md-primary/5' : 'bg-transparent'} py-2 px-2.5 flex items-center gap-2 {selectedEmailIds.has(mail.id) ? 'ring-2 ring-md-secondary rounded-lg' : ''}"
              style="transform: translateX({swipingEmail === mail ? swipeDistance : 0}px); transition: {swipeActionTriggered ? 'transform 0.3s' : 'none'}; user-select: none;"
              onmouseenter={(e) => handleMouseEnter(mail, e)}
              onmouseleave={() => {
                handleMouseLeave();
                handleLongPressEnd();
                handleSwipeEnd();
              }}
              onclick={(e) => {
                if ((e.target as HTMLElement)?.closest?.('[data-star-btn]')) return;
                if (marqueeActive || marqueeDidSelect) {
                  marqueeDidSelect = false;
                  return;
                }
                if (Date.now() < suppressClickUntil) return;
                e.stopPropagation();
                if (Math.abs(swipeDistance) > 5) return;
                if (emailSelection.mode) {
                  toggleEmailSelection(mail.id);
                } else {
                  const thread = threadGrouping
                    ? emailThreads.find((t: EmailThread) => t.emails.some((em: Email) => em.id === mail.id))
                    : null;
                  onOpenMessageDetail(thread ? thread.emails : [mail]);
                }
              }}
              ontouchstart={(e) => {
                handleLongPressStart(mail, e);
                handleSwipeStart(mail, e);
              }}
              ontouchend={() => {
                handleLongPressEnd();
                handleSwipeEnd();
              }}
              ontouchmove={(e) => {
                handleLongPressEnd();
                handleSwipeMove(e);
              }}
              onmousedown={(e) => {
                if ((e.target as HTMLElement)?.closest?.('[data-star-btn]')) return;
                handleLongPressStart(mail, e);
                handleSwipeStart(mail, e);
              }}
              onmouseup={() => {
                handleLongPressEnd();
                handleSwipeEnd();
              }}
              onmousemove={(e) => {
                if (e.buttons === 1) handleSwipeMove(e);
              }}
              draggable={true}
              ondragstart={(e) => {
                if (!selectedEmailIds.has(mail.id)) {
                  selectedEmailIds = new Set([mail.id]);
                  emailSelection.mode = true;
                  emailSelection.count = 1;
                  emitSelectionChange();
                }
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'copyMove';
                  const selectedIds = Array.from(selectedEmailIds);
                  e.dataTransfer.setData('text/plain', selectedIds.join(','));
                  e.dataTransfer.setData('application/x-1click-mail-ids', JSON.stringify(selectedIds));
                  try {
                    const firstSubject = mail.subject || $t('emailList.noSubject');
                    const extra = Math.max(0, selectedIds.length - 1);
                    const label = extra > 0 ? `${firstSubject} +${extra}` : firstSubject;
                    const preview = document.createElement('div');
                    preview.className = 'drag-mail-preview';
                    preview.style.cssText = 'position:fixed;top:-9999px;left:-9999px;max-width:220px;padding:6px 10px;border-radius:10px;background:var(--md-surface-container-high,#2b2930);color:var(--md-on-surface,#e6e1e5);font:12px/1.3 system-ui,sans-serif;font-weight:600;box-shadow:0 6px 16px rgba(0,0,0,.25);pointer-events:none;z-index:99999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                    preview.textContent = label;
                    document.body.appendChild(preview);
                    e.dataTransfer.setDragImage(preview, 16, 12);
                    setTimeout(() => preview.remove(), 0);
                  } catch { /* ignore */ }
                }
              }}
              oncontextmenu={(e) => {
                e.preventDefault();
                emailSelection.mode = true;
                const next = new Set(selectedEmailIds);
                next.add(mail.id);
                selectedEmailIds = next;
                emailSelection.count = next.size;
                emitSelectionChange();
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (emailSelection.mode) toggleEmailSelection(mail.id);
                  else {
                    const thread = threadGrouping
                      ? emailThreads.find((t: EmailThread) => t.emails.some((em: Email) => em.id === mail.id))
                      : null;
                    onOpenMessageDetail(thread ? thread.emails : [mail]);
                  }
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  (e.currentTarget.nextElementSibling as HTMLElement)?.focus();
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  (e.currentTarget.previousElementSibling as HTMLElement)?.focus();
                }
              }}
            >
              <div class="flex items-center gap-2 px-0 py-0.5 flex-1 min-w-0">
                {#if mail.from}
                  {@const isSelected = selectedEmailIds.has(mail.id)}
                  {@const letter = (mail.from_name || mail.from || '?').trim().charAt(0).toUpperCase() || '?'}
                  {@const letterBg = mail.unread ? avatarColor(mail.from) : AVATAR_MUTED}
                  <div class="flex-shrink-0 w-[35px] h-[35px] rounded-full {isSelected ? 'ring-2 ring-md-primary' : ''} {letterBg} overflow-hidden flex items-center justify-center relative">
                    {#if showFavicons || isSelected}
                      <!-- FaviconImage renders the letter itself until the favicon
                           loads; once loaded, it swaps in the icon (same z-index,
                           same rounded-full radius). No duplicate letter layer. -->
                      <FaviconImage
                        email={mail.from}
                        size={32}
                        enabled={showFavicons || isSelected}
                        class="absolute inset-0 w-full h-full"
                        fallbackLetter={letter}
                        fallbackColor={letterBg}
                      />
                    {:else}
                      <span class="absolute inset-0 flex items-center justify-center text-base font-bold text-white select-none pointer-events-none">{letter}</span>
                    {/if}
                    {#if isSelected}
                      <span class="absolute bottom-0 end-0 z-[3] w-3.5 h-3.5 rounded-full bg-md-primary text-md-on-primary flex items-center justify-center">
                        <Icon name="check" class="w-2.5 h-2.5" />
                      </span>
                    {/if}
                  </div>
                {/if}

                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-1 mb-0.5">
                    <span class="text-sm font-bold {mail.unread ? 'text-md-on-surface' : 'text-md-on-surface/70'} truncate leading-tight">
                      {@html highlightMatches(getDisplayName(mail.from || '', mail.from_name), highlightTerms)}
                    </span>
                    <span
                      class="text-xs font-medium cursor-help {mail.unread ? 'text-md-on-surface/60' : 'text-md-on-surface/40'} flex-shrink-0"
                      title={formatFullDateTime(mail.received_at)}
                    >
                      {mail.time || timeAgo(mail.received_at ? toMs(mail.received_at) : Date.now())}
                    </span>
                  </div>
                  <p class="text-xs {mail.unread ? 'font-semibold text-md-on-surface' : 'text-md-on-surface/50'} truncate leading-tight">
                    {@html highlightMatches(mail.subject || '(no subject)', highlightTerms)}
                  </p>
                  {#if true}
                    {@const bodyPreview = (mail.body_plain || (mail.body_html || mail.body || '').replace(/<[^>]*>/g, '') || '').replace(/\s+/g, ' ').trim()}
                    {@const showOtpPill = !hideOtpLabels && mail.isOtp && !!mail.otp}
                    {@const showAttachmentPill =
                      !hideAttachmentBadges &&
                      ((Array.isArray(mail.attachments) && mail.attachments.length > 0) ||
                        mail.hasAttachment)}
                    {@const showMagicPill = !!(mail.hasMagicLink || (mail.magicLinks && mail.magicLinks.length > 0))}
                    {@const showLocalPill = !!mail.local_only}
                    {@const tagList = !hideLabels ? (emailTagsMap[mail.id] || []) : []}
                    {@const maxRowTags = 1}
                    {@const visibleTags = tagList.slice(0, maxRowTags)}
                    {@const overflowTags = tagList.slice(maxRowTags)}
                    {@const hasPills =
                      showOtpPill || showMagicPill || showLocalPill || showAttachmentPill || tagList.length > 0}
                    {#if bodyPreview || hasPills}
                      <div class="flex items-center gap-1 mt-0.5 min-w-0 w-full">
                        {#if bodyPreview}
                          <p class="text-xs text-md-on-surface/60 truncate leading-tight min-w-0 flex-1">{bodyPreview}</p>
                        {/if}
                        {#if hasPills}
                          <div class="flex items-center gap-0.5 shrink-0 max-w-[48%] min-w-0">
                            {#if showLocalPill}
                              {@const deletedWhen = (() => {
                                const ts =
                                  (mail as Email & { local_only_since?: number }).local_only_since ||
                                  mail.local_deleted_at ||
                                  mail.stored_at ||
                                  toMs(mail.received_at);
                                return ts ? timeAgo(ts) : '';
                              })()}
                              <span
                                id="local-badge-{mail.id}"
                                class="px-1.5 py-0 text-xs rounded-full bg-md-tertiary-container text-md-on-tertiary-container shrink-0 cursor-help"
                                title={deletedWhen
                                  ? $t('inbox.deletedFromServerAgo', { values: { when: deletedWhen } })
                                  : $t('inbox.localOnlyTooltip')}
                              >{$t('inbox.localOnlyBadge')}</span>
                            {/if}
                            {#if showOtpPill}
                              <span
                                id="otp-badge-{mail.id}"
                                role="button"
                                tabindex="0"
                                class="px-2 py-0.5 text-xs rounded-full bg-md-primary/20 text-md-primary cursor-pointer hover:bg-md-primary/30 transition-colors shrink-0 max-w-[5.5rem] truncate min-h-[24px] inline-flex items-center"
                                onmousedown={(e) => { e.stopPropagation(); e.preventDefault(); onCopyOtpFromMessage(mail.otp || ''); }}
                                onmouseup={(e) => { e.stopPropagation(); }}
                                onclick={(e) => { e.stopPropagation(); e.preventDefault(); onCopyOtpFromMessage(mail.otp || ''); }}
                                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onCopyOtpFromMessage(mail.otp || ''); } }}
                                aria-label={$t('inbox.copyOtpAria')}
                                title={$t('common.otpValue', { values: { otp: mail.otp } })}
                              >OTP: {mail.otp}</span>
                            {/if}
                            {#if showAttachmentPill}
                              {@const attList = mail.attachments || []}
                              {@const attFirst = attList[0]}
                              {@const attMeta = attachmentTypeMeta(attFirst?.filename || '')}              <span
                id="attachment-badge-{mail.id}"
                data-tour="attachment-badge"
                class="px-1.5 py-0 text-xs rounded-full bg-md-tertiary-container text-md-on-tertiary-container shrink-0 cursor-help max-w-[6.5rem] truncate"
                                title={attFirst?.filename
                                  ? attList.length > 1
                                    ? `${attFirst.filename} · ${$t('inbox.attachmentMore', { values: { n: attList.length - 1 } })}`
                                    : `${attFirst.filename}${attFirst.mimeType ? ` · ${attFirst.mimeType}` : ''}`
                                  : $t('inbox.attachments')}
                                aria-label={$t('inbox.attachments')}
                              >{attMeta.emoji} {attFirst?.filename || $t('inbox.attachments')}{attList.length > 1 ? ` +${attList.length - 1}` : ''}</span>
                            {/if}
                            {#if showMagicPill}
                              <span
                                id="magic-link-badge-{mail.id}"
                                class="px-1.5 py-0 text-xs rounded-full bg-md-tertiary/20 text-md-tertiary shrink-0 max-w-[4rem] truncate"
                                title={mail.magicLinks?.[0]?.host || mail.magicLinks?.[0]?.url || $t('inbox.magicLinkDetected')}
                              >{$t('inbox.magicLinkPill')}</span>
                            {/if}
                            {#each visibleTags as tag (tag)}
                              <span
                                role="button"
                                tabindex="0"
                                class="px-1.5 py-0 text-xs rounded-full bg-md-primary/20 text-md-primary cursor-pointer hover:bg-md-primary/30 transition-colors shrink-0 max-w-[4rem] truncate"
                                onmousedown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                                onclick={(e) => { e.stopPropagation(); filterByLabel(tag); }}
                                title={$t('inbox.filterByLabel', { values: { label: tag } })}
                                onkeydown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); filterByLabel(tag); } }}
                                aria-label={$t('inbox.filterByLabel', { values: { label: tag } })}
                              >{tag}</span>
                            {/each}
                            {#if overflowTags.length > 0}
                              <div class="relative shrink-0">
                                <button
                                  type="button"
                                  class="px-1.5 py-0 text-xs rounded-full bg-md-surface-variant text-md-on-surface/70 font-semibold hover:bg-md-primary/15 hover:text-md-primary transition-colors"
                                  aria-label={$t('inbox.moreLabels', { values: { n: overflowTags.length } })}
                                  title={overflowTags.join(', ')}
                                  onmousedown={(e) => { e.stopPropagation(); e.preventDefault(); }}
                                  onclick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    rowLabelMenuId = rowLabelMenuId === mail.id ? null : mail.id;
                                  }}
                                >+{overflowTags.length}</button>
                                {#if rowLabelMenuId === mail.id}
                                  <button
                                    type="button"
                                    class="fixed inset-0 {PORTAL_Z_CLASS.navMenu} bg-transparent cursor-default"
                                    aria-label={$t('common.close')}
                                    onmousedown={(e) => e.stopPropagation()}
                                    onclick={(e) => { e.stopPropagation(); rowLabelMenuId = null; }}
                                  ></button>
                                  <div
                                    class="absolute end-0 top-full mt-1 {PORTAL_Z_CLASS.accountMenu} min-w-[100px] max-w-[160px] max-h-36 overflow-y-auto rounded-lg border border-md-outline-variant bg-md-surface shadow-xl p-1"
                                    role="menu"
                                  >
                                    {#each overflowTags as tag (tag)}
                                      <button
                                        type="button"
                                        role="menuitem"
                                        class="w-full text-start px-2 py-1 text-xs rounded-md truncate text-md-on-surface hover:bg-md-primary/10 hover:text-md-primary"
                                        onmousedown={(e) => e.stopPropagation()}
                                        onclick={(e) => {
                                          e.stopPropagation();
                                          filterByLabel(tag);
                                          rowLabelMenuId = null;
                                        }}
                                      >{tag}</button>
                                    {/each}
                                  </div>
                                {/if}
                              </div>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    {/if}
                  {/if}
                </div>
              </div>

              <button
                type="button"
                data-star-btn
                id="star-button-{mail.id}"
                class="flex-shrink-0 self-center p-1 me-0.5 rounded transition-colors hover:bg-md-surface-variant/40 cursor-pointer border-0 bg-transparent {isStarredMail(mail) ? 'text-md-tertiary' : 'text-md-on-surface/25'} {starPopId === mail.id ? 'star-pop' : ''}"
                onclick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  void toggleStar(mail);
                }}
                onpointerdown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                onmousedown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                }}
                onmouseup={(e) => e.stopPropagation()}
                aria-pressed={isStarredMail(mail)}
                aria-label={$t('inbox.emailActions.star')}
                title={$t('inbox.emailActions.star')}
              >
                <Icon name="star" class="w-5 h-5 transition-colors duration-150 pointer-events-none" filled={isStarredMail(mail)} />
              </button>
            </div>
          </div>
          {/if}
        {/each}
        {#if renderLimit < displayedEmails.length}
          <div bind:this={listSentinelEl} class="h-8" aria-hidden="true"></div>
          <div class="py-3 text-center">
            <button
              type="button"
              class="px-4 py-1.5 bg-md-surface-variant text-md-on-surface-variant text-xs font-medium rounded-full hover:bg-md-primary hover:text-md-on-primary transition-colors shadow-sm"
              onclick={() => expandRenderWindow()}
            >
              {$t('emailList.loadMore') || 'Load more'} ({displayedEmails.length - renderLimit})
            </button>
          </div>
        {:else if displayedEmailCount < tabFilteredEmails.length}
          <div class="py-3 text-center">
            <button
              type="button"
              class="px-4 py-1.5 bg-md-surface-variant text-md-on-surface-variant text-xs font-medium rounded-full hover:bg-md-primary hover:text-md-on-primary transition-colors shadow-sm"
              onclick={() => loadMoreEmails()}
            >
              {$t('emailList.loadMore') || 'Load more'} ({tabFilteredEmails.length - displayedEmailCount})
            </button>
          </div>
        {/if}
        <!-- Dynamic End-of-List Spacer: allows content to flow behind floating nav & strips while ensuring the final item can scroll cleanly above controls -->
        <div
          class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
          style="height: calc(var(--bottom-safe-area, 0px) + {totalBottomSpacerHeightPx}px + 12px);"
          aria-hidden="true"
        ></div>
      {/if}
    </div>
  </div>
{/if}

{#if marqueeActive && marqueeRect}
  <div
    class="fixed pointer-events-none z-[500] border border-md-primary/70 bg-md-primary/15 rounded-sm"
    style="left:{marqueeRect.left}px;top:{marqueeRect.top}px;width:{marqueeRect.right - marqueeRect.left}px;height:{marqueeRect.bottom - marqueeRect.top}px;"
    aria-hidden="true"
  ></div>
{/if}

</div>

<!-- Bottom strips stacked wrapper -->
<!-- autofill is always first in DOM, OTP always second, renewal always third. -->
<!-- CSS `order` swaps them visually: front strip gets order:2 (goes to bottom = screen bottom), -->
<!-- back strip gets order:1 (goes to top = peeks above). Matches example's stacking exactly. -->
<!-- When `has-renewal` is set, the renewal strip is locked to order:3 (always front). -->
<!-- Selection strip replaces other strips while multi-select is active. -->
{#if hasCollapsibleStrips && !emailSelection.mode}
  <!--
    Android-style edge handle on the LEFT of the strip stack.
    Height matches visible strip stack. Drag right (toward center) → expand; drag left (away) → collapse.
  -->
  {@const handleH = stripsEdgeCollapsed
    ? 40
    : Math.max(36, Math.min(stripReservePx, 180))}
  <button
    type="button"
    class="strips-edge-handle absolute z-30 touch-none"
    style="
      left: max(0px, calc(50% - min(175px, 50%) - 2px));
      bottom: {stripsEdgeCollapsed
        ? 'calc(var(--bottom-safe-area, 44px) + 8px)'
        : 'var(--bottom-safe-area, 44px)'};
      height: {handleH}px;
    "
    aria-label={stripsEdgeCollapsed ? $t('inbox.expandStrips') : $t('inbox.collapseStrips')}
    aria-expanded={!stripsEdgeCollapsed}
    onpointerdown={(e) => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startCollapsed = stripsEdgeCollapsed;
      const pointerId = e.pointerId;
      const target = e.currentTarget as HTMLButtonElement;
      try {
        target.setPointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      let dragged = false;
      const onMove = (ev: PointerEvent) => {
        // Handle on LEFT edge: drag right (toward center) = expand; drag left (away) = collapse
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 6) dragged = true;
        target.style.transform = `translateX(${Math.max(-12, Math.min(40, dx * 0.35))}px)`;
        if (dx > 24 && startCollapsed) void setStripsEdgeCollapsed(false);
        if (dx < -24 && !startCollapsed) void setStripsEdgeCollapsed(true);
      };
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        target.style.transform = '';
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
        if (!dragged && Math.abs(startX - ev.clientX) < 8) {
          void setStripsEdgeCollapsed(!startCollapsed);
        }
      };
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }}
  >
    <span
      class="strips-edge-handle-pill"
      style="height: {Math.max(24, handleH - 8)}px;"
      aria-hidden="true"
    ></span>
  </button>
{/if}

{#if !stripsEdgeCollapsed || emailSelection.mode}
<div bind:this={bottomStripsWrapperEl} class="bottom-strips-wrapper absolute z-20 front-{frontStrip}{showRenewalStrip ? ' has-renewal' : ''}{emailSelection.mode ? ' has-selection' : ''}" role="none">
{#if emailSelection.mode}
<div
  id="button-selection-strip"
  class="bottom-strip-item bottom-strip-selection rounded-xl selection-slide-up"
  style="--i: 1; overflow: hidden;"
  role="toolbar"
  aria-label={$t('mailManagement.selectedCount', { values: { n: emailSelection.count } })}
>
  <div class="flex items-center gap-1 px-2 py-2 bg-md-secondary-container rounded-xl w-full overflow-x-auto">
    <button
      type="button"
      class="h-8 px-2.5 rounded-lg text-xs font-bold shrink-0 whitespace-nowrap {selectionAllMatched ? 'bg-md-primary/15 text-md-primary' : 'bg-md-surface/80 hover:bg-md-surface'}"
      onclick={(e) => { e.stopPropagation(); selectAllVisible(); }}
    >
      {selectionAllMatched
        ? $t('inbox.emailActions.allSelected', { values: { n: selectionMatchingTotal } })
        : emailSelection.count > 0 && selectionUniverseCounted && selectionMatchingTotal > emailSelection.count
          ? $t('inbox.emailActions.selectAllMatching', { values: { n: selectionMatchingTotal } })
          : $t('inbox.emailActions.selectAll')}
    </button>
    <button
      type="button"
      class="h-8 px-2.5 rounded-lg text-xs font-bold bg-transparent hover:bg-md-surface-variant/60 shrink-0 tabular-nums whitespace-nowrap"
      aria-label={$t('inbox.emailActions.deselectAll')}
      onclick={(e) => { e.stopPropagation(); deselectAll(); }}
    >{$t('inbox.emailActions.deselectAll')} ({emailSelection.count})</button>

    <div class="w-px h-5 bg-md-outline-variant/40 shrink-0 mx-0.5"></div>

    <button
      type="button"
      class="btn-secondary h-8 px-2.5 rounded-lg font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap"
      title={$t('inbox.emailActions.starSelected')}
      data-drop-action="star"
      ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
      ondragenter={(e) => { e.preventDefault(); }}
      ondrop={(e) => { e.preventDefault(); e.stopPropagation(); void performStarSelected(); }}
      onclick={(e) => { e.stopPropagation(); e.preventDefault(); void performStarSelected(); }}
    >
      <Icon name="star" class="w-3.5 h-3.5" />
      <span>{$t('inbox.emailActions.star')}</span>
    </button>

    <button
      type="button"
      class="btn-primary h-8 px-2.5 rounded-lg font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap"
      title={$t('inbox.emailActions.labelSelected')}
      data-drop-action="label"
      ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
      ondragenter={(e) => { e.preventDefault(); }}
      ondrop={(e) => { e.preventDefault(); e.stopPropagation(); openTagDialogForSelected(); }}
      onclick={(e) => { e.stopPropagation(); e.preventDefault(); openTagDialogForSelected(); }}
    >
      <Icon name="tag" class="w-3.5 h-3.5" />
      <span>{$t('inbox.emailActions.label')}</span>
    </button>

    {#if emailListTab === 'archived' || emailListTab === 'deleted'}
      <button
        type="button"
        class="btn-tertiary h-8 px-2.5 rounded-lg font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap"
        data-drop-action="restore"
        ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
        ondragenter={(e) => { e.preventDefault(); }}
        ondrop={(e) => { e.preventDefault(); e.stopPropagation(); performRestore(); }}
        onclick={(e) => { e.stopPropagation(); performRestore(); }}
      >
        <Icon name="refresh" class="w-3.5 h-3.5" />
        <span>{$t('inbox.emailActions.restore')}</span>
      </button>
    {/if}

    {#if emailListTab === 'inbox' || emailListTab === 'all'}
      <button
        type="button"
        class="btn-tertiary h-8 px-2.5 rounded-lg font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap"
        data-drop-action="archive"
        ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
        ondragenter={(e) => { e.preventDefault(); }}
        ondrop={(e) => { e.preventDefault(); e.stopPropagation(); performArchive(); }}
        onclick={(e) => { e.stopPropagation(); performArchive(); }}
      >
        <Icon name="archive" class="w-3.5 h-3.5" />
        <span>{$t('inbox.emailActions.archive')}</span>
      </button>
    {/if}

    {#if emailListTab !== 'deleted'}
      <button
        type="button"
        class="btn-error h-8 px-2.5 rounded-lg font-bold text-xs flex items-center gap-1 shrink-0 whitespace-nowrap"
        data-drop-action="delete"
        ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; }}
        ondragenter={(e) => { e.preventDefault(); }}
        ondrop={(e) => { e.preventDefault(); e.stopPropagation(); performDelete(); }}
        onclick={(e) => { e.stopPropagation(); performDelete(); }}
      >
        <Icon name="trash" class="w-3.5 h-3.5" />
        <span>{$t('inbox.emailActions.delete')}</span>
      </button>
    {/if}
  </div>
</div>
{:else}
<!-- Lifecycle intelligence hint.
     When high-value renew applies to the *current* expired inbox and the renewal strip is
     already showing, merge into renewal (no duplicate strip). Standalone high-value only
     for a *different* address. -->
{#if !lifecycleHintDismissed && lifecycleHints.length > 0 && !emailSelection.mode}
  {@const hint = lifecycleHints[0]}
  {@const mergeHighValueIntoRenewal =
    hint.kind === 'renew_high_value' &&
    !!currentAccount &&
    currentAccount.id === hint.inboxId &&
    showRenewalStrip}
  {#if !mergeHighValueIntoRenewal}
    <div class="h-[40px] flex items-center box-border px-3 bg-md-tertiary-container bottom-strip-item rounded-xl mb-1 motion-strip-up" style="--i: 0;">
      <div class="flex items-center gap-2 w-full min-w-0">
        <Icon name="infoCircle" class="w-4 h-4 text-md-primary shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="text-label-sm font-semibold text-md-on-surface truncate">
            {$t(hint.reasonKey, { values: { address: hint.address } })}
          </div>
        </div>
        {#if hint.kind === 'renew_high_value'}
          <button
            type="button"
            class="px-2 py-1 rounded-lg text-xs font-bold bg-md-primary text-md-on-primary shrink-0"
            onclick={(e) => {
              e.stopPropagation();
              const acc = (allAccounts || accounts).find((a) => a.id === hint.inboxId);
              if (acc) {
                onSelectAccount?.(acc.address);
                void onExtendAccount(acc);
              }
            }}
          >{$t('intelligence.renewAction')}</button>
        {:else if hint.kind === 'archive_idle'}
          <button
            type="button"
            class="px-2 py-1 rounded-lg text-xs font-bold bg-md-secondary-container text-md-on-surface shrink-0"
            onclick={(e) => {
              e.stopPropagation();
              const acc = (allAccounts || accounts).find((a) => a.id === hint.inboxId);
              if (acc) onArchiveAccount(acc);
            }}
          >{$t('common.archive')}</button>
        {:else if hint.kind === 'create_fresh_for_risk'}
          <button
            type="button"
            class="px-2 py-1 rounded-lg text-xs font-bold bg-md-primary text-md-on-primary shrink-0"
            onclick={(e) => {
              e.stopPropagation();
              onCreateInbox();
            }}
          >{$t('account.newMailAddress')}</button>
        {/if}
        <button
          type="button"
          class="w-5 h-5 flex items-center justify-center rounded-lg shrink-0"
          aria-label={$t('common.close')}
          onclick={() => (lifecycleHintDismissed = true)}
        ><Icon name="x" class="w-3 h-3" /></button>
      </div>
    </div>
  {/if}
{/if}

<!-- Filters applied strip -->
{#if hasActiveListFilters && showFilterAppliedStrip}
<div class="h-[40px] flex items-center box-border px-3 bg-md-tertiary-container bottom-strip-item bottom-strip-filter rounded-xl" style="--i: 0;">
  <div class="flex items-center gap-2 w-full min-w-0">
    <Icon name="filter" class="w-4 h-4 text-md-primary shrink-0" />
    <div class="min-w-0 flex-1">
      <div class="text-xs font-bold text-md-on-surface truncate">{$t('inbox.filtersApplied')}</div>
      <div class="text-xs text-md-on-surface/50 truncate">{$t('inbox.filtersAppliedHint')}</div>
    </div>
    {#if !filterQuickSaved}
      <button type="button" class="px-2 py-1 rounded-lg text-xs font-bold bg-md-primary text-md-on-primary shrink-0" onclick={(e) => {
        e.stopPropagation();
        onSaveFilterQuick();
        filterQuickSaved = true;
      }}>{$t('inbox.saveAsFilter')}</button>
    {/if}
    <button type="button" class="px-2 py-1 rounded-lg text-xs font-bold bg-md-surface-variant text-md-on-surface shrink-0" onclick={(e) => { e.stopPropagation(); void onClearFilters(); }}>{$t('inbox.removeFilters')}</button>
    <button type="button" class="w-5 h-5 flex items-center justify-center rounded-lg shrink-0" aria-label={$t('common.close')} onclick={() => (showFilterAppliedStrip = false)}><Icon name="x" class="w-3 h-3" /></button>
  </div>
</div>
{/if}

<!-- Magic link strip -->
{#if latestMagicLink && showMagicLinkStrip && !preferHideMagicStrip}
<div class="h-[40px] flex items-center box-border px-3 bg-md-secondary-container bottom-strip-item bottom-strip-magic rounded-xl" style="--i: 0.5;">
  <div class="flex items-center gap-2 w-full min-w-0">
    <Icon name="globe" class="w-4 h-4 text-md-primary shrink-0" />
    <div class="min-w-0 flex-1">
      <div class="text-xs font-bold text-md-on-surface truncate">{$t('inbox.magicLinkDetected')}</div>
      <div class="text-xs text-md-on-surface/50 truncate">
        {latestMagicLink.host || latestMagicLink.url}
        {#if stripMagicRemaining && stripMagicRemaining !== 'expired'}
          · {$t('inbox.expiresIn', { values: { t: stripMagicRemaining } })}
        {:else if stripMagicRemaining === 'expired'}
          · {$t('inbox.expiredLabel')}
        {/if}
      </div>
    </div>
    <button type="button" class="px-2.5 py-1 rounded-lg text-xs font-bold bg-md-primary text-md-on-primary shrink-0" onclick={(e) => { e.stopPropagation(); onOpenMagicLink(latestMagicLink!.url); }}>{$t('inbox.openMagicLink')}</button>
    <button type="button" class="w-5 h-5 flex items-center justify-center rounded-lg shrink-0" aria-label={$t('common.close')} onclick={() => (showMagicLinkStrip = false)}><Icon name="x" class="w-3 h-3" /></button>
  </div>
</div>
{/if}

<!-- Saved login refill strip -->
{#if matchingSavedLogin && showSavedLoginStrip && currentDomain}
<div class="h-[40px] flex items-center box-border px-3 bg-md-primary-container bottom-strip-item bottom-strip-savedlogin rounded-xl" style="--i: 0.75;">
  <div class="flex items-center gap-2 w-full min-w-0">
    <FaviconImage domain={currentDomain} size={24} class="w-4 h-4 shrink-0" fallbackLetter={currentDomain[0]?.toUpperCase() || '?'} />
    <div class="min-w-0 flex-1">
      <div class="text-xs font-bold text-md-on-surface truncate">{$t('inbox.savedLoginRefill')}</div>
      <div class="text-xs text-md-on-surface/50 truncate" style="direction:ltr;unicode-bidi:isolate;">{matchingSavedLogin.email || matchingSavedLogin.username || currentDomain}</div>
    </div>
    <button type="button" class="px-2.5 py-1 rounded-lg text-xs font-bold bg-md-primary text-md-on-primary shrink-0" onclick={(e) => { e.stopPropagation(); onRefillSavedLogin(matchingSavedLogin!); }}>{$t('inbox.refillAction')}</button>
    <button type="button" class="w-5 h-5 flex items-center justify-center rounded-lg shrink-0" aria-label={$t('common.close')} onclick={() => (showSavedLoginStrip = false)}><Icon name="x" class="w-3 h-3" /></button>
  </div>
</div>
{/if}

{#if formDetected && showAutofillStrip && !preferHideAutofillStrip}
<div class="h-[40px] flex items-center box-border px-3 bg-md-primary-container bottom-strip-item bottom-strip-autofill rounded-xl" style="--i: 1;">  
  <div class="flex items-center gap-2 w-full">
    <!-- Favicon + Domain -->
    <div class="flex items-center gap-2 min-w-0">
      <div class="flex-shrink-0 w-7 h-7 rounded-lg bg-md-secondary-container flex items-center justify-center overflow-hidden">
        {#if currentDomain}
          <FaviconImage domain={currentDomain} size={24} class="w-4 h-4" fallbackLetter={currentDomain[0].toUpperCase()} />
        {:else}
          <Icon name="globe" class="w-4 h-4 opacity-40" />
        {/if}
      </div>
      <div class="min-w-0">
        <div class="text-xs font-bold text-md-secondary leading-tight truncate max-w-[80px]">{currentDomain || $t('common.unknown')}</div>
        <div class="text-xs font-semibold text-md-tertiary leading-tight">{$t('inbox.detectedForm')}</div>
      </div>
    </div>

    <!-- Divider -->
    <div class="w-px h-6 bg-md-secondary-container flex-shrink-0 mx-1"></div>

    <!-- Identity Selector -->
    <div class="relative flex-1 min-w-0">
      <div 
        id="button-identity-selector"
        class="flex items-center gap-1 bg-md-secondary-container/70 rounded-full px-2.5 py-1 cursor-pointer relative" 
        role="button"
        tabindex="0"
        onclick={() => showIdentityDropdown = !showIdentityDropdown}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            showIdentityDropdown = !showIdentityDropdown;
          }
        }}
      >
        <Icon name="shield" class="w-3 h-3 text-md-secondary flex-shrink-0" />
        <div class="flex-1 min-w-0 text-label-sm font-medium text-md-on-surface pe-2 truncate">
          {identities.find(i => i.id === selectedIdentityId)?.name || $t('identities.select')}
        </div>
        <Icon name="chevronDown" class="w-2.5 h-2.5 text-md-on-surface/40 flex-shrink-0 transition-transform {showIdentityDropdown ? 'rotate-180' : ''}" />
        
        <!-- Dropup Menu -->
        {#if showIdentityDropdown}
          <div class="absolute bottom-full inset-x-0 mb-1 bg-md-primary-container border border-md-secondary-container rounded-xl shadow-lg z-50 max-h-48 overflow-y-auto">
            {#each identities as identity}
              <button
                id="button-identity-{identity.id}"
                class="w-full text-start px-3 py-2 text-label-sm font-medium text-md-on-surface hover:bg-md-secondary-container transition-colors first:rounded-t-xl last:rounded-b-xl"
                onclick={(e) => { e.stopPropagation(); selectedIdentityId = identity.id; handleIdentityChange(); showIdentityDropdown = false; }}
              >
                {identity.name}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <!-- Autofill Button -->
    <button id="button-autofill" class="px-3 py-1 rounded-full text-label-sm font-semibold rounded-lg bg-md-primary text-md-on-primary hover:bg-md-primary/90 flex-shrink-0 transition-colors" onclick={onAutofillForm}>
      {$t('inbox.autofillAction')}
    </button>

    <!-- Close Button -->
    <button id="button-close-autofill" class="w-5 h-5 flex items-center justify-center rounded-lg bg-transparent hover:bg-md-secondary-container flex-shrink-0 ms-0.5 transition-colors" onclick={() => showAutofillStrip = false} aria-label={$t('inbox.closeAutofillStrip')}>
      <Icon name="x" class="w-3 h-3" />
    </button>
  </div>
</div>
{/if}
{#if stripOtpCode !== '------' && latestLiveOtp && !preferHideOtpStrip}
<div
  id="button-otp-strip"
  class="bottom-strip-item bottom-strip-otp rounded-xl cursor-pointer"
  style="--i: 2; overflow: hidden;"
  role="button"
  tabindex="0"
  aria-label={$t('inbox.openOtpMessage')}
  onclick={() => { if (latestOtpEmail) { const thread = threadGrouping ? emailThreads.find((t: EmailThread) => t.emails.some((e: Email) => e.id === latestOtpEmail.id)) : null; onOpenMessageDetail(thread ? thread.emails : [latestOtpEmail]); } }}
  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { if (latestOtpEmail) { const thread = threadGrouping ? emailThreads.find((t: EmailThread) => t.emails.some((e: Email) => e.id === latestOtpEmail.id)) : null; onOpenMessageDetail(thread ? thread.emails : [latestOtpEmail]); } } }}
>  
  {#if !otpCollapsed}
  {#if otpDropupOpen}
  <div class="border-b border-md-primary bg-md-secondary-container">

    <!-- Clear all OTPs and Opt-in toggle -->
    <div class="px-3 pt-3 pb-1.5 flex items-center justify-between border-b border-md-primary/10">
      <div onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()} role="presentation">
        <label class="flex items-center gap-2 cursor-pointer select-none">
          <Checkbox size="sm" checked={isOtpOptedIn} onchange={toggleOtpOptIn} />
          <span class="text-xs font-semibold text-md-on-surface">{$t('inbox.allowOtpAutofill')}</span>
        </label>
      </div>

      <button
        class="text-xs font-semibold text-md-error/70 hover:text-md-error transition-colors flex items-center gap-1"
        onclick={(e) => { e.stopPropagation(); clearAllOtps(); }}
        aria-label={$t('inbox.clearAllOtps')}
      >
        <Icon name="trashBox" class="w-3 h-3" />
        {$t('inbox.clearAllOtps')}
      </button>
    </div>

    <!-- Section: Current email address -->
    <div class="px-3 pt-2.5 pb-1 flex items-center justify-between">
      <span class="text-xs font-bold text-md-primary">{$t('inbox.currentEmail')}</span>
      <Icon name="chevronDown" class="w-3.5 h-3.5 text-md-on-surface/40" />
    </div>
    <div class="overflow-y-auto max-h-[180px]">
      {#if otpHistoryCurrent.length === 0}
        <p class="text-xs text-md-on-surface/40 px-3 pb-2">{$t('inbox.noOtps')}</p>
      {:else}
        {#each otpHistoryCurrent as item}
          <div class="flex items-center gap-3 px-3 py-2 bg-md-surface-container rounded-xl mx-2 mb-2 shadow-sm">
            <div class="w-9 h-9 rounded-lg overflow-hidden flex items-center justify-center flex-shrink-0 bg-md-secondary-container">
              {#if item.from}
                <img
                  src={getSafeDomainFaviconUrl(item.from)}
                  alt=""
                  class="w-6 h-6 object-contain"
                  loading="lazy"
                  onerror={(e) => {
                    const img = e.target as HTMLImageElement;
                    const fb = getSafeRootDomainFaviconUrl(item.from);
                    if (img.src !== fb) { img.src = fb; } else { img.style.display = 'none'; }
                  }}
                />
              {/if}
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-sm font-semibold text-md-on-surface truncate">{item.from_name || item.from}</span>
                <span class="text-xs text-md-on-surface/40">·</span>
                <span class="text-xs text-md-on-surface/40 flex-shrink-0 cursor-help" title={formatFullDateTime(item.received_at)}>{timeAgo(item.received_at)}</span>
              </div>
              <span class="font-bold text-md-primary text-sm tracking-[0.08em]">{item.otp}</span>
            </div>
            <button
              id="button-copy-otp-current-{item.otp}"
              class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-md-secondary-container"
              aria-label={$t('common.copy')}
              title={$t('common.copy')}
              onclick={async (e) => {
                e.stopPropagation();
                try {
                  await copyToClipboardAndSchedulePurge(item.otp, 30000);
                } catch (e) {
                  logError('Failed to copy OTP from current list', undefined, e instanceof Error ? e : new Error(String(e)));
                }
              }}
            >
              <Icon name="copy" class="w-3.5 h-3.5 text-md-primary" />
            </button>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Section: Other email addresses -->
    {#if otpHistoryOther.length > 0}
    <div class="px-3 pt-1 pb-1 flex items-center justify-between border-t border-md-secondary-container">
      <span class="text-xs font-bold text-md-primary">{$t('inbox.otherEmails')}</span>
      <Icon name="chevronDown" class="w-3.5 h-3.5 text-md-on-surface/40" />
    </div>
    <div class="overflow-y-auto max-h-[180px]">
      {#each otpHistoryOther as item}
        <div class="flex items-center gap-3 px-3 py-2 bg-md-surface-container rounded-xl mx-2 mb-2 shadow-sm">
          <div class="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 bg-md-secondary-container">
            {#if item.from}
              <img
                src={getSafeDomainFaviconUrl(item.from)}
                alt=""
                class="w-6 h-6 object-contain"
                loading="lazy"
                onerror={(e) => {
                  const img = e.target as HTMLImageElement;
                  const fb = getSafeRootDomainFaviconUrl(item.from);
                  if (img.src !== fb) { img.src = fb; } else { img.style.display = 'none'; }
                }}
              />
            {/if}
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="text-sm font-semibold text-md-on-surface truncate">{item.from_name || item.from}</span>
              <span class="text-xs text-md-on-surface/40">·</span>
              <span class="text-xs text-md-on-surface/40 flex-shrink-0">{timeAgo(item.received_at)}</span>
            </div>
            <span class="font-bold text-md-primary text-sm tracking-[0.08em]">{item.otp}</span>
          </div>
          <button
            id="button-copy-otp-other-{item.otp}"
            class="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-md-secondary-container"
            aria-label={$t('common.copy')}
            title={$t('common.copy')}
            onclick={async (e) => {
              e.stopPropagation();
              try {
                await copyToClipboardAndSchedulePurge(item.otp, 30000);
              } catch (e) {
                logError('Failed to copy OTP from other list', undefined, e instanceof Error ? e : new Error(String(e)));
              }
            }}
          >
            <Icon name="copy" class="w-3.5 h-3.5 text-md-primary" />
          </button>
        </div>
      {/each}
    </div>
    {/if}

  </div>
  {/if}

  <div
    class="flex items-center gap-2 px-3 py-1.5 bg-md-secondary-container rounded-xl min-h-[48px]"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >

    <!-- Favicon + Domain + Received OTP + expiry -->
    <div class="flex items-center gap-2 min-w-0">
      <div class="flex-shrink-0 w-7 h-7 rounded-lg bg-md-surface flex items-center justify-center overflow-hidden">
        {#if otpSenderEmail}
          <FaviconImage email={otpSenderEmail} size={24} class="w-4 h-4" fallbackLetter={(otpSenderEmail[0] || '?').toUpperCase()} />
        {/if}
      </div>
      <div class="min-w-0">
        <div class="text-xs font-bold text-md-on-surface leading-tight truncate max-w-[120px]">{latestOtpSenderName || otpSenderEmail?.split('@')[0] || $t('inbox.otpLabel')}</div>
        <div class="text-xs font-semibold text-md-on-surface/50 leading-tight">
          {$t('inbox.receivedOtp', { values: { when: otpContext.split(' | ').pop() || $t('activity.timeJustNow') } })}
        </div>
        <div
          class="text-xs font-semibold leading-tight
            {stripOtpRemaining && stripOtpRemaining !== 'expired'
              ? 'text-md-primary'
              : stripOtpRemaining === 'expired'
                ? 'text-md-error'
                : 'text-md-on-surface/40'}"
        >
          {#if stripOtpRemaining && stripOtpRemaining !== 'expired'}
            {$t('inbox.otpExpiresIn', { values: { t: stripOtpRemaining } })}
          {:else if stripOtpRemaining === 'expired'}
            {$t('inbox.expiredLabel')}
          {:else}
            {$t('inbox.otpExpiryUnknown')}
          {/if}
        </div>
      </div>
    </div>

    <!-- Divider -->
    <div class="w-px h-6 bg-md-secondary-container flex-shrink-0 mx-1"></div>

    <!-- Current OTP with Copy -->
    <div class="flex-1 flex items-center justify-center">
      <button
        id="button-copy-current-otp"
        class="px-3 py-1 rounded-full text-label-sm font-semibold rounded-lg bg-md-primary text-md-on-primary hover:bg-md-primary/90 flex-shrink-0 flex items-center gap-1.5 transition-colors"
        aria-label={$t('inbox.copyOtpAria')}
        title={$t('inbox.copyOtpAria')}
        onclick={(e) => { e.stopPropagation(); onCopyOtp(); }}
      >
        <span class="font-bold text-sm tracking-[0.05em]">{stripOtpCode.replace(/\s/g, '')}</span>
        <Icon name="copy" class="w-3 h-3 text-white/80 flex-shrink-0" />
      </button>
    </div>

    <!-- Up/Down Buttons -->
    <div class="flex items-center gap-1 flex-shrink-0 ms-0.5">
      <button
        class="w-5 h-5 flex items-center justify-center rounded-lg bg-transparent hover:bg-md-secondary-container transition-colors"
        aria-label={otpDropupOpen ? "Collapse OTP history" : "Expand OTP history"}
        onclick={(e) => { e.stopPropagation(); toggleOtpDropup(); }}
      >
        {#if otpDropupOpen}
          <Icon name="chevronUp" class="w-3 h-3" />
        {:else}
          <Icon name="chevronDown" class="w-3 h-3" />
        {/if}
      </button>
      <button
        class="w-5 h-5 flex items-center justify-center rounded-lg bg-transparent hover:bg-md-secondary-container transition-colors"
        aria-label={$t('inbox.collapseOtpAria')}
        title={$t('inbox.collapseOtpAria')}
        onclick={(e) => { e.stopPropagation(); otpCollapsed = true; }}
      >
        <Icon name="chevronUp" class="w-3 h-3" />
      </button>
    </div>

  </div>
  {:else}
  <button
    class="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium text-md-primary/70 hover:text-md-primary transition-colors bg-md-secondary-container"
    onclick={(e) => { e.stopPropagation(); otpCollapsed = false; }}
    aria-label={$t('inbox.showOtpBar')}
    title={$t('inbox.showOtpBar')}
  >
    <span>{$t('inbox.otpReady', { values: { code: stripOtpCode } })}</span>
    <Icon name="chevronDown" class="w-3.5 h-3.5" />
  </button>
  {/if}
</div>
{/if}
{#if showRenewalStrip || (providerFailoverHint?.show && currentAccount?.autoExtend && isCurrentAccountExpired)}
<div
  id="button-renewal-strip"
  class="bottom-strip-item bottom-strip-renewal rounded-xl"
  style="--i: 3; overflow: hidden;"
>
  {#if !renewalStripCollapsed}
  <div class="flex flex-col gap-2 px-3 py-2.5 bg-md-primary-container border border-md-warning/40 rounded-xl">
    <!-- Header: icon + title + dismiss -->
    <div class="flex items-center gap-2">
      <div class="flex-shrink-0 w-7 h-7 rounded-lg bg-md-warning/20 flex items-center justify-center">
        <Icon name="refresh" class="w-4 h-4 text-md-warning {isRenewing ? 'animate-spin' : ''}" />
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-bold text-md-on-surface leading-tight">
          {#if providerFailoverHint?.show && currentAccount?.autoExtend}
            {$t('inbox.renewalStrip.retryTitle')}
          {:else if lifecycleHints[0]?.kind === 'renew_high_value' && lifecycleHints[0]?.inboxId === currentAccount?.id}
            {$t(lifecycleHints[0].reasonKey, { values: { address: lifecycleHints[0].address } })}
          {:else}
            {$t('inbox.renewalStrip.title')}
          {/if}
        </div>
        <div class="text-xs text-md-on-surface/60 leading-tight truncate">
          {#if isRenewing}
            {$t('inbox.renewalStrip.renewing')}
          {:else if providerFailoverHint?.show && currentAccount?.autoExtend}
            {$t('inbox.renewalStrip.retryIn', {
              values: {
                min: Math.max(1, Math.ceil((providerFailoverHint.nextRetryAt - Date.now()) / 60000)),
              },
            })}
          {:else}
            {$t('inbox.renewalStrip.prompt')}
          {/if}
        </div>
      </div>
      <button
        id="button-renewal-dismiss"
        class="w-5 h-5 flex items-center justify-center rounded-lg bg-transparent hover:bg-md-secondary-container flex-shrink-0 transition-colors disabled:opacity-40"
        aria-label={$t('inbox.renewalStrip.dismissAria')}
        aria-expanded={!renewalStripCollapsed}
        aria-controls="button-renewal-strip"
        disabled={isRenewing}
        onclick={(e) => { e.stopPropagation(); renewalStripDismissed = true; }}
      >
        <Icon name="x" class="w-3 h-3" />
      </button>
    </div>
    <!-- Action row: renew options -->
    <div class="flex items-center gap-1.5">
      <button
        id="button-renewal-always"
        class="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-label-sm font-semibold bg-md-primary text-md-on-primary hover:bg-md-primary/90 transition-colors disabled:opacity-60"
        title={$t('inbox.renewalStrip.alwaysDescription')}
        disabled={isRenewing}
        onclick={(e) => {
          e.stopPropagation();
          void handleRenewAlways();
        }}
      >
        <Icon name="refresh" class="w-3 h-3 {isRenewing ? 'animate-spin' : ''}" />
        {isRenewing ? $t('inbox.renewalStrip.renewing') : $t('inbox.renewalStrip.always')}
      </button>
      <button
        id="button-renewal-once"
        class="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg text-label-sm font-semibold bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80 transition-colors disabled:opacity-60"
        title={$t('inbox.renewalStrip.onceDescription')}
        disabled={isRenewing}
        onclick={(e) => {
          e.stopPropagation();
          void handleRenewOnce();
        }}
      >
        {isRenewing ? $t('inbox.renewalStrip.renewing') : $t('inbox.renewalStrip.once')}
      </button>
      <button
        id="button-renewal-no"
        class="px-2.5 py-1.5 rounded-lg text-label-sm font-semibold bg-transparent text-md-on-surface/60 hover:bg-md-secondary-container hover:text-md-on-surface transition-colors disabled:opacity-40"
        disabled={isRenewing}
        onclick={(e) => { e.stopPropagation(); renewalStripDismissed = true; }}
      >
        {$t('inbox.renewalStrip.dismiss')}
      </button>
    </div>
    {#if providerFailoverHint?.show && providerFailoverHint.otherProvidersOk}
      <button
        type="button"
        class="w-full py-1.5 rounded-lg text-label-sm font-semibold bg-md-tertiary-container text-md-on-tertiary-container hover:opacity-90 transition-opacity"
        onclick={(e) => {
          e.stopPropagation();
          onCreateInbox();
        }}
      >
        {$t('toasts.createWithOtherProvider')}
      </button>
    {/if}
  </div>
  {:else}
  <button
    class="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium text-md-warning/70 hover:text-md-warning transition-colors bg-md-primary-container"
    onclick={(e) => { e.stopPropagation(); renewalStripCollapsed = false; }}
    aria-label={$t('inbox.showRenewalBar')}
    title={$t('inbox.showRenewalBar')}
    aria-expanded={!renewalStripCollapsed}
    aria-controls="button-renewal-strip"
  >
    <span>{$t('inbox.renewalStrip.title')} · {$t('inbox.renewalStrip.prompt')}</span>
    <Icon name="chevronDown" class="w-3.5 h-3.5" />
  </button>
  {/if}
</div>
{/if}
{/if}
</div>
<!-- end bottom-strips-wrapper -->
{/if}

<!-- Tag Dialog -->
<TagDialog
  open={tagDialogOpen}
  currentTag={tagTargetAccount?.tag || null}
  currentTagColor={tagTargetAccount?.tagColor || null}
  existingTags={existingTags}
  tagColors={tagColors}
  onClose={closeTagDialog}
  onSave={saveTag}
/>

<!-- Hover Preview Tooltip -->
{#if hoveredEmail && emailPreviewEnabled}
  <div
    class="fixed z-[100000] w-72 bg-md-surface-container-high text-md-on-surface p-3 rounded-xl shadow-2xl border border-md-outline-variant/60 pointer-events-none transition-opacity duration-150"
    style="top: {previewPosition.y}px; left: {previewPosition.x}px;"
  >
    <div class="flex items-center justify-between gap-2 mb-1 border-b border-md-outline-variant/30 pb-1.5">
      <span class="text-xs font-bold text-md-primary truncate">
        {hoveredEmail.subject || $t('emailList.noSubject')}
      </span>
      <span class="text-xs text-md-on-surface/50 flex-shrink-0">{hoveredEmail.time}</span>
    </div>
    {#if hoveredEmail.isOtp}
      <div class="mb-1 text-xs font-semibold text-md-tertiary">
        OTP: {hoveredEmail.otp}
      </div>
    {/if}
    <div class="text-xs text-md-on-surface/80 line-clamp-6 leading-relaxed">
      {#if hoveredEmail.body_plain}
        {hoveredEmail.body_plain.trim().slice(0, 400)}
      {:else if hoveredEmail.body_html}
        {hoveredEmail.body_html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)}
      {:else}
        <span class="italic text-md-on-surface/40">{$t('emailList.noPreview')}</span>
      {/if}
    </div>
  </div>
{/if}

<!-- Email Tag / Label Modal Dialog Overlay -->
{#if emailTagDialogOpen}
  <div class="absolute inset-0 z-[9999] flex items-center justify-center p-4" role="dialog" aria-modal="true">
    <div
      class="absolute inset-0 bg-black/40 backdrop-blur-sm"
      role="button"
      tabindex="-1"
      onclick={(e) => { e.stopPropagation(); closeEmailTagDialog(); }}
      onkeydown={(e) => e.key === 'Escape' && closeEmailTagDialog()}
    ></div>
    <div class="relative bg-md-surface rounded-2xl shadow-2xl p-4 w-72 z-10 border border-md-outline-variant/30">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-bold text-md-on-surface">
          {tagDialogMultiIds?.length
            ? $t('inbox.emailActions.labelSelected')
            : $t('inbox.emailActions.tag')}
          {#if tagDialogMultiIds?.length}
            <span class="text-md-on-surface/50 font-medium">({tagDialogMultiIds.length})</span>
          {/if}
        </h3>
        <button
          type="button"
          class="w-7 h-7 flex items-center justify-center rounded-full hover:bg-md-surface-variant transition-colors"
          onclick={(e) => { e.stopPropagation(); closeEmailTagDialog(); }}
          aria-label={$t('common.close')}
        >
          <Icon name="x" class="w-4 h-4 text-md-on-surface/60" />
        </button>
      </div>
      <p class="text-xs text-md-on-surface/60 mb-2">{$t('inbox.labelDialogHint')}</p>
      <input
        type="text"
        class="w-full px-3 py-2 text-sm rounded-lg border border-md-outline-variant bg-md-surface-container-low focus:outline-none focus:border-md-primary focus:ring-1 focus:ring-md-primary"
        placeholder={$t('inbox.labelDialogPlaceholder')}
        bind:value={tagDialogInput}
        onkeydown={(e) => { if (e.key === 'Enter') void saveEmailTags(); else if (e.key === 'Escape') closeEmailTagDialog(); }}
      />
      {#if allEmailTags.length > 0}
        <div class="flex flex-wrap gap-1.5 mt-2">
          {#each allEmailTags as existingTag (existingTag)}
            <button
              type="button"
              class="px-2 py-0.5 text-xs rounded-full bg-md-primary/20 text-md-primary hover:bg-md-primary/30 transition-colors"
              onclick={(e) => {
                e.stopPropagation();
                const parts = tagDialogInput.split(',').map((s) => s.trim()).filter(Boolean);
                if (!parts.includes(existingTag)) {
                  tagDialogInput = parts.length ? `${parts.join(', ')}, ${existingTag}` : existingTag;
                }
              }}
            >{existingTag}</button>
          {/each}
        </div>
      {/if}
      <div class="flex gap-2 mt-3">
        <button
          type="button"
          class="flex-1 py-1.5 text-sm rounded-xl bg-md-secondary-container text-md-on-secondary-container hover:bg-md-secondary-container/80 transition-colors"
          onclick={(e) => { e.stopPropagation(); closeEmailTagDialog(); }}
        >{$t('common.cancel')}</button>
        <button
          type="button"
          class="flex-1 py-1.5 text-sm rounded-xl bg-md-primary text-md-on-primary hover:bg-md-primary/90 transition-colors"
          onclick={(e) => { e.stopPropagation(); void saveEmailTags(); }}
        >{$t('common.save')}</button>
      </div>
    </div>
  </div>
{/if}
</div>

<style>
  /*
   * Matches example exactly (ul/li pattern).
   * DOM: autofill=1st child (top), otp=2nd child (middle), renewal=3rd child (bottom).
   * CSS `order` swaps visually: front strip → highest order (bottom=screen bottom, in front).
   *                              back strip  → lower order (peeks above front).
   *
    * When `has-renewal` is set on the wrapper, the renewal strip is LOCKED to order:3
    * (always front) regardless of frontStrip. autofill and otp shift down one slot.
    */

  /* Android-style vertical edge handle (LEFT of strip stack) — horizontal drag only */
  .strips-edge-handle {
    width: 18px;
    min-height: 32px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: ew-resize;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    touch-action: pan-x;
    transition: transform 120ms cubic-bezier(0.2, 0, 0, 1);
  }
  .strips-edge-handle:active {
    cursor: grabbing;
  }
  .strips-edge-handle-pill {
    width: 5px;
    min-height: 24px;
    border-radius: 0 999px 999px 0;
    background: color-mix(in srgb, var(--md-on-surface) 35%, transparent);
    border: 1px solid color-mix(in srgb, var(--md-outline-variant) 60%, transparent);
    border-inline-start: none;
    box-shadow: 2px 0 8px color-mix(in srgb, var(--md-shadow, #000) 18%, transparent);
    transition: background 0.15s ease, width 0.15s ease;
  }
  .strips-edge-handle:hover .strips-edge-handle-pill,
  .strips-edge-handle:focus-visible .strips-edge-handle-pill {
    background: var(--md-primary);
    width: 6px;
  }
  .strips-edge-handle:focus-visible {
    outline: none;
  }

  :global(.bottom-strips-wrapper) {
    position: absolute;
    /* Float ABOVE the floating nav — bottom equals the nav height so strips stack on top of it */
    bottom: var(--bottom-safe-area, 44px);
    left: 50%;
    transform: translateX(-50%);
    width: min(350px, 100%);
    display: flex;
    flex-direction: column;
    gap: 0;
    perspective: 500px;
    transform-style: preserve-3d;
    transition: gap 500ms;
    margin-bottom: 4px;
    /* Transparent gaps must NOT block clicks on content below */
    pointer-events: none;
  }

  :global(.bottom-strips-wrapper:hover) {
    gap: 5px;
  }

  :global(.bottom-strip-item) {
    position: relative;
    list-style: none;
    transition: transform 500ms, opacity 500ms, width 500ms;
    transition-delay: calc(var(--i, 1) * 50ms);
    /* Wrapper is pointer-events:none — restore auto on each strip so they are clickable */
    pointer-events: auto;
  }

  /* ── No renewal: existing 2-strip swap rules ── */
  /* autofill front: autofill→order:2, otp→order:1 */
  :global(.bottom-strips-wrapper.front-autofill:not(.has-renewal) .bottom-strip-autofill) {
    order: 2;
    transform: translateZ(0) translateY(0);
    opacity: 1;
    width: 350px;
  }
  :global(.bottom-strips-wrapper.front-autofill:not(.has-renewal) .bottom-strip-otp) {
    order: 1;
    transform: translateZ(0) translateY(5px);
    opacity: 0.95;
    width: 340px;
    margin: 0 auto;
  }

  /* otp front: otp→order:2, autofill→order:1 */
  :global(.bottom-strips-wrapper.front-otp:not(.has-renewal) .bottom-strip-otp) {
    order: 2;
    transform: translateZ(0) translateY(0);
    opacity: 1;
    width: 350px;
  }
  :global(.bottom-strips-wrapper.front-otp:not(.has-renewal) .bottom-strip-autofill) {
    order: 1;
    transform: translateZ(0) translateY(5px);
    opacity: 0.95;
    width: 340px;
    margin: 0 auto;
  }

  /* ── Renewal present: renewal LOCKED to order:3 (always front) ── */
  :global(.bottom-strips-wrapper.has-renewal .bottom-strip-renewal) {
    order: 3;
    transform: translateZ(0) translateY(0);
    opacity: 1;
    width: 350px;
  }
  :global(.bottom-strips-wrapper.has-renewal .bottom-strip-autofill) {
    order: 2;
    transform: translateZ(0) translateY(5px);
    opacity: 0.95;
    width: 340px;
    margin: 0 auto;
  }
  :global(.bottom-strips-wrapper.has-renewal .bottom-strip-otp) {
    order: 1;
    transform: translateZ(0) translateY(5px);
    opacity: 0.95;
    width: 340px;
    margin: 0 auto;
  }

  /* ── hover: fan out all strips flat, full opacity, natural positions ── */
  :global(.bottom-strips-wrapper:hover .bottom-strip-item) {
    opacity: 1;
    transform: translateZ(0) translateY(0);
    width: 350px;
    margin: 0 auto;
  }

  /* Selection strip: 2× height, front strip — retains bottom-safe-area positioning */
  :global(.bottom-strips-wrapper.has-selection .bottom-strip-selection) {
    order: 2;
    transform: translateZ(0) translateY(0);
    opacity: 1;
    width: 350px;
  }
</style>
