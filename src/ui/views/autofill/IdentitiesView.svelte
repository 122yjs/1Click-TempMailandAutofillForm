
<script lang="ts">
import { onDestroy } from 'svelte';
import { get } from 'svelte/store';
import { locale, t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import {
  deleteIdentity,
  loadIdentities,
  reorderIdentities,
  saveIdentity,
  selectIdentity,
} from '@/features/identities/identity-actions.js';
import SelectionToolbar from '@/ui/blocks/mail/SelectionToolbar.svelte';
import SearchBar from '@/ui/components/composites/SearchBar.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Checkbox, Dropdown, InputField, Toggle } from '@/ui/components/primitives';
import {
  isRandomActivePreferredEmail,
  PREFERRED_EMAIL_RANDOM_ACTIVE,
} from '@/utils/blocked-temp-mail-sites.js';
import { decrypt, encrypt } from '@/utils/crypto.js';
import { generateDefaultAvatarDataUrl } from '@/utils/default-avatar.js';
import { getErrorMessage } from '@/utils/errors.js';
import {
  detectCountryLocally,
  maxAdultDobDate,
  randomAdultDob,
  randomCity,
  randomDobInYearRange,
  randomPostalCode,
} from '@/utils/locale-profile.js';
import { logError } from '@/utils/logger.js';
import { PORTAL_Z, portalDialogAction } from '@/utils/portal-layers.js';
import type { CredentialsHistoryItem, Identity } from '@/utils/types.js';
import { getRandomUserAgentConfig, USER_AGENT_PRESETS } from '@/utils/user-agent.js';
import {
  validateOTP,
  validatePassword,
  validatePhoneNumber,
  validateTextInput,
} from '@/utils/validation.js';

/** Localized sample names for suggestions (fields start empty; user can pick/apply) */
const LOCALIZED_NAME_SUGGESTIONS: Record<
  string,
  { first: string[]; last: string[]; country: string }
> = {
  en: {
    first: ['James', 'Emma', 'Michael', 'Olivia', 'William', 'Sophia'],
    last: ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller'],
    country: 'US',
  },
  de: {
    first: ['Lukas', 'Anna', 'Maximilian', 'Sophie', 'Felix', 'Marie'],
    last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer'],
    country: 'DE',
  },
  fr: {
    first: ['Lucas', 'Camille', 'Hugo', 'Léa', 'Louis', 'Chloé'],
    last: ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard'],
    country: 'FR',
  },
  es: {
    first: ['Santiago', 'Sofía', 'Mateo', 'Valentina', 'Sebastián', 'Isabella'],
    last: ['García', 'Rodríguez', 'Martínez', 'López', 'Hernández', 'González'],
    country: 'ES',
  },
  ar: {
    first: ['محمد', 'فاطمة', 'أحمد', 'نور', 'علي', 'مريم'],
    last: ['أحمد', 'حسن', 'علي', 'إبراهيم', 'خالد', 'محمود'],
    country: 'AE',
  },
  ja: {
    first: ['太郎', '花子', '翔', '美咲', '蓮', '結衣'],
    last: ['佐藤', '鈴木', '高橋', '田中', '伊藤', '渡辺'],
    country: 'JP',
  },
  zh: {
    first: ['伟', '芳', '娜', '敏', '静', '强'],
    last: ['王', '李', '张', '刘', '陈', '杨'],
    country: 'CN',
  },
};

function currentLangCode(): string {
  try {
    const loc = get(locale) || 'en';
    return String(loc).split('-')[0].toLowerCase();
  } catch {
    /* ignore */
    return 'en';
  }
}

function nameSuggestionsForLocale() {
  const code = currentLangCode();
  return LOCALIZED_NAME_SUGGESTIONS[code] || LOCALIZED_NAME_SUGGESTIONS.en;
}

function nextIdentityName(existing: Identity[]): string {
  const used = new Set(existing.map((i) => i.name.toLowerCase().replace(/\s+/g, '')));
  let n = 1;
  while (used.has(`identity${n}`)) n++;
  return `Identity${n}`;
}

function formatIdentityTime(ts: number): string {
  if (!ts || Number.isNaN(Number(ts))) return '';
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    /* ignore */
    return new Date(ts).toISOString();
  }
}

let {
  context = 'popup',
  onBack = () => {},
  savedLogins = [] as CredentialsHistoryItem[],
  mailboxAddresses = [] as string[],
  activeMailboxAddress = '' as string,
  showConfirm = (_message: string, _onConfirm: () => void) => {},
  /** Pre-applied preferred-email filter (e.g. from message detail) */
  initialEmailFilter = '',
  /** Footer FAB: increment to open create dialog */
  createSignal = 0,
  /** Content-script handoff: identity id to open in editor */
  editIdSignal = '',
  /**
   * ≥1280 layoutSplit: mount create/edit into AppLayout's data-splitview host
   * (third column) — never merge editor into the list mainview.
   */
  useSplitEditor = false,
  splitHostId = 'autofill-split-host',
  splitHostRef = null as HTMLElement | null,
} = $props<{
  context?: 'popup' | 'sidepanel' | 'app';
  onBack?: () => void;
  savedLogins?: CredentialsHistoryItem[];
  /** Existing inbox addresses for preferred-email picker */
  mailboxAddresses?: string[];
  /** Currently selected mailbox address (default option) */
  activeMailboxAddress?: string;
  /** Shared confirm dialog (no browser confirm()) */
  showConfirm?: (message: string, onConfirm: () => void) => void;
  initialEmailFilter?: string;
  createSignal?: number;
  editIdSignal?: string;
  useSplitEditor?: boolean;
  splitHostId?: string;
  splitHostRef?: HTMLElement | null;
}>();

// React to createSignal increments. Also honor a non-zero value on first mount
// (content-script handoff sets the signal before IdentitiesView mounts).
let lastIdentityCreateSignal = -1;
let honoredInitialCreate = false;
$effect(() => {
  const n = createSignal;
  if (lastIdentityCreateSignal < 0) {
    lastIdentityCreateSignal = n;
    if (n > 0 && !honoredInitialCreate) {
      honoredInitialCreate = true;
      // Defer so form state is ready
      queueMicrotask(() => openCreateDialog());
    }
    return;
  }
  if (n > 0 && n !== lastIdentityCreateSignal) {
    lastIdentityCreateSignal = n;
    openCreateDialog();
  }
});

let lastIdentityEditId = '';
$effect(() => {
  const id = editIdSignal;
  const list = identities;
  // Parent clears signal to '' between handoffs; allow same id again after clear
  if (!id) {
    lastIdentityEditId = '';
    return;
  }
  if (id === lastIdentityEditId) return;
  // Wait for identities list to load, then open editor
  if (list.length === 0) return;
  const found = list.find((i) => i.id === id);
  if (found) {
    lastIdentityEditId = id;
    void openIdentityEditor(found);
  }
});

function restoreSplitPlaceholder() {
  try {
    const host = splitHostRef || (splitHostId ? document.getElementById(splitHostId) : null);
    const ph = host?.querySelector('[data-autofill-split-placeholder]') as HTMLElement | null;
    if (ph) {
      ph.style.display = '';
      ph.classList.remove('hidden');
    }
    // Remove any orphaned identity overlays left in the split host
    host?.querySelectorAll('.identity-overlay').forEach((n: Element) => {
      try {
        n.remove();
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

function hideSplitPlaceholder() {
  try {
    const host = splitHostRef || (splitHostId ? document.getElementById(splitHostId) : null);
    const ph = host?.querySelector('[data-autofill-split-placeholder]') as HTMLElement | null;
    if (ph) ph.style.display = 'none';
  } catch {
    /* ignore */
  }
}

// Overlay portal state handled directly in template using Svelte 5 state

onDestroy(() => {
  restoreSplitPlaceholder();
});

let identities = $state<Identity[]>([]);
let selectedIdentityId = $state<string | null>(null);
let editingIdentity = $state<Identity | null>(null);
let isDirty = $state(false);
let showCreateDialog = $state(false);
let showIdentityDropdown = $state(false);
let identityStripEl = $state<HTMLElement | null>(null);
let identityStripHeightPx = $state(0);

$effect(() => {
  const el = identityStripEl;
  if (!el || typeof ResizeObserver === 'undefined') {
    identityStripHeightPx = 0;
    return;
  }
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const rect = entry.target.getBoundingClientRect();
      identityStripHeightPx = Math.ceil(rect.height);
    }
  });
  ro.observe(el);
  return () => ro.disconnect();
});
/**
 * Preferred email select value:
 * - PREFERRED_EMAIL_RANDOM_ACTIVE = random any live mailbox at fill time (default for new/built-in)
 * - '' = currently selected mailbox at fill time
 * - address string = pin that mailbox
 */
let newIdentityPreferredEmail = $state<string>(PREFERRED_EMAIL_RANDOM_ACTIVE);
let localMailboxAddresses = $state<string[]>([]);
/** address → status for preferred-email health warnings */
let inboxStatusByAddress = $state<
  Record<string, { status?: string; accountStatus?: string; expiresAt?: number }>
>({});

const emailOptions = $derived.by(() => {
  const fromProp = mailboxAddresses.filter(Boolean);
  const merged = [...new Set([...fromProp, ...localMailboxAddresses].filter(Boolean))];
  return merged.sort((a, b) => a.localeCompare(b));
});

type PrefEmailIssue = 'expired' | 'archived' | 'deleted' | 'missing' | null;

function preferredEmailIssue(pref: string | null | undefined): PrefEmailIssue {
  if (!pref?.trim() || isRandomActivePreferredEmail(pref)) return null;
  const addr = pref.trim().toLowerCase();
  const meta = inboxStatusByAddress[addr];
  if (!meta) {
    // Not in live list — may be archived/deleted or never existed
    const listed = emailOptions.some((a) => a.toLowerCase() === addr);
    if (!listed) return 'missing';
    return null;
  }
  const st = (meta?.accountStatus || meta?.status || '').toLowerCase();
  if (st === 'deleted') return 'deleted';
  if (st === 'archived') return 'archived';
  if (st === 'expired') return 'expired';
  if (meta.expiresAt && meta.expiresAt > 0 && meta.expiresAt <= Date.now()) return 'expired';
  return null;
}

async function refreshInboxStatusMap() {
  try {
    const { inboxes = [], archivedEmails = {} } = (await browser.storage.local.get([
      'inboxes',
      'archivedEmails',
    ])) as {
      inboxes?: Array<{
        address?: string;
        status?: string;
        accountStatus?: string;
        expiresAt?: number;
      }>;
      archivedEmails?: Record<string, unknown>;
    };
    const map: Record<string, { status?: string; accountStatus?: string; expiresAt?: number }> = {};
    for (const i of inboxes) {
      if (!i.address) continue;
      map[i.address.toLowerCase()] = {
        status: i.status,
        accountStatus: i.accountStatus,
        expiresAt: i.expiresAt,
      };
    }
    // Addresses only in archived bag
    for (const addr of Object.keys(archivedEmails || {})) {
      const key = addr.toLowerCase();
      if (!map[key]) map[key] = { status: 'archived', accountStatus: 'archived' };
    }
    inboxStatusByAddress = map;
  } catch {
    /* ignore */
  }
}

// Search + filter state
let searchQuery = $state('');
let filterCountry = $state('');
let filterDobFrom = $state('');
let filterDobTo = $state('');
let filterEmail = $state('');
let showIdentityFilters = $state(false);

$effect(() => {
  const initial = initialEmailFilter || '';
  if (initial) {
    filterEmail = initial;
    showIdentityFilters = true;
  }
});

const identityCountries = $derived.by(() => {
  const set = new Set<string>();
  for (const i of identities) {
    if (i.country?.trim()) set.add(i.country.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
});

const identityEmails = $derived.by(() => {
  const set = new Set<string>();
  for (const i of identities) {
    if (i.preferredEmail?.trim()) set.add(i.preferredEmail.trim());
  }
  for (const addr of emailOptions) {
    if (addr?.trim()) set.add(addr.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
});

const hasActiveIdentityFilters = $derived(
  !!filterCountry || !!filterDobFrom || !!filterDobTo || !!filterEmail
);

// Multi-select state
let selectionMode = $state(false);
let selectedIds = $state<Set<string>>(new Set());
let holdTimers = new Map<string, ReturnType<typeof setTimeout>>();
let identityFabHidden = $state(false);
let identityLastScrollTop = 0;

const filteredIdentities = $derived.by(() => {
  const query = searchQuery.toLowerCase().trim();
  const emailQ = filterEmail.toLowerCase().trim();
  return identities.filter((i: Identity) => {
    if (query) {
      const hay = [i.name, i.firstNames, i.lastNames, i.phone, i.country, i.preferredEmail]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (filterCountry && (i.country || '') !== filterCountry) return false;
    if (emailQ) {
      const pref = (i.preferredEmail || '').toLowerCase();
      // Match preferred email, or identities that use "active mailbox" when filter is active address
      if (pref) {
        if (!pref.includes(emailQ) && emailQ !== pref) return false;
      } else {
        // No preferred pin - match only when filter equals active mailbox (would use it at fill)
        const active = (activeMailboxAddress || '').toLowerCase();
        if (!active || (!active.includes(emailQ) && emailQ !== active)) return false;
      }
    }
    const dob = (i.dateOfBirth || '').trim();
    if (filterDobFrom && (!dob || dob < filterDobFrom)) return false;
    if (filterDobTo && (!dob || dob > filterDobTo)) return false;
    return true;
  });
});

const reorderBlocked = $derived(!!searchQuery.trim() || hasActiveIdentityFilters || selectionMode);

// Drag-and-drop state
let draggedIdentityId = $state<string | null>(null);
let dropTargetIdentityId = $state<string | null>(null);

function handleIdentityDragStart(e: DragEvent, identityId: string) {
  if (reorderBlocked) {
    e.preventDefault();
    return;
  }
  draggedIdentityId = identityId;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', identityId);
  }
}

function handleIdentityDragOver(e: DragEvent, identityId: string) {
  if (reorderBlocked) return;
  if (!draggedIdentityId || draggedIdentityId === identityId) return;
  e.preventDefault();
  dropTargetIdentityId = identityId;
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
}

function handleIdentityDragLeave(identityId: string) {
  if (dropTargetIdentityId === identityId) {
    dropTargetIdentityId = null;
  }
}

async function handleIdentityDrop(e: DragEvent, targetId: string) {
  if (reorderBlocked) return;
  e.preventDefault();
  const sourceId = draggedIdentityId;
  draggedIdentityId = null;
  dropTargetIdentityId = null;
  if (!sourceId || sourceId === targetId) return;
  const fromIndex = identities.findIndex((i: Identity) => i.id === sourceId);
  const toIndex = identities.findIndex((i: Identity) => i.id === targetId);
  if (fromIndex === -1 || toIndex === -1) return;
  await reorderIdentities(browser, identitySetters, fromIndex, toIndex);
}

function clearIdentityFilters() {
  filterCountry = '';
  filterDobFrom = '';
  filterDobTo = '';
  filterEmail = '';
}

function handleIdentityDragEnd() {
  draggedIdentityId = null;
  dropTargetIdentityId = null;
}

let newIdentityFirstNames = $state('');
let newIdentityLastNames = $state('');
let newIdentityName = $state('');
let newIdentityUsername = $state('');
let newIdentityUseRandomPassword = $state(true);
let newIdentityCustomPassword = $state('');
let newIdentityPhone = $state('');
let newIdentityPin = $state('');
let newIdentityDomainHints = $state<string[]>([]);
let newDomainHintInput = $state('');
let newIdentityGender = $state<'' | 'male' | 'female' | 'other' | 'prefer_not'>('');
let newIdentityDob = $state('');
let newIdentityCountry = $state('');
let newIdentityCity = $state('');
let newIdentityState = $state('');
let newIdentityAddress = $state('');
let newIdentityProfilePicture = $state<string | null>(null);
let newIdentityUserAgent = $state<string | null>(null);
let userAgentPresetMode = $state<string>('default');

// Per-domain field overrides
type DomainFieldOverride = {
  domain: string;
  firstNames: string;
  lastNames: string;
  username: string;
  phone: string;
  preferredEmail: string;
};
let newIdentityDomainFieldOverrides = $state<DomainFieldOverride[]>([]);
let newDomainOverrideInput = $state<Partial<DomainFieldOverride>>({});

function onUAPresetChange() {
  if (userAgentPresetMode === 'default') {
    newIdentityUserAgent = null;
  } else if (userAgentPresetMode in USER_AGENT_PRESETS) {
    newIdentityUserAgent = USER_AGENT_PRESETS[userAgentPresetMode].userAgent;
  }
}

function generateRandomUA() {
  const config = getRandomUserAgentConfig();
  newIdentityUserAgent = config.userAgent;
  userAgentPresetMode = 'custom';
}

function onCustomUAInput() {
  userAgentPresetMode = 'custom';
}
/** User must opt in — new identities are never default by default */
let newIdentitySetAsDefault = $state(false);
/** DOB helper: fixed date vs random within year range (always adult ≥18) */
let dobHelperMode = $state<'date' | 'range'>('date');
let dobRangeFromYear = $state(1970);
let dobRangeToYear = $state(Math.max(1970, new Date().getFullYear() - 18));
let validationError = $state('');

const adultDobMax = maxAdultDobDate(18);

/** Common country list for signup forms (ISO code + English name) */
const COUNTRY_OPTIONS: { code: string; name: string }[] = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'BE', name: 'Belgium' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'AT', name: 'Austria' },
  { code: 'SE', name: 'Sweden' },
  { code: 'NO', name: 'Norway' },
  { code: 'DK', name: 'Denmark' },
  { code: 'FI', name: 'Finland' },
  { code: 'IE', name: 'Ireland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'PL', name: 'Poland' },
  { code: 'IN', name: 'India' },
  { code: 'JP', name: 'Japan' },
  { code: 'KR', name: 'South Korea' },
  { code: 'CN', name: 'China' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'AR', name: 'Argentina' },
  { code: 'ZA', name: 'South Africa' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'SG', name: 'Singapore' },
  { code: 'AE', name: 'United Arab Emirates' },
];

$effect(() => {
  return () => {
    for (const timer of holdTimers.values()) {
      clearTimeout(timer);
    }
    holdTimers.clear();
  };
});

const identitySetters = {
  setIdentities: (ids: Identity[]) => {
    identities = ids;
  },
  setSelectedIdentityId: (id: string | null) => {
    selectedIdentityId = id;
  },
};

async function loadIdentitiesData() {
  void refreshInboxStatusMap();
  await loadIdentities(browser, identitySetters);
  honoredInitialCreate = false;
  try {
    const res = (await browser.storage.local.get(['inboxes'])) as {
      inboxes?: Array<{ address?: string }>;
    };
    localMailboxAddresses = (res.inboxes || []).map((i) => i.address || '').filter(Boolean);
  } catch {
    /* ignore */
    localMailboxAddresses = [];
  }
}

async function tryDecryptPassword(value: string | undefined): Promise<string> {
  if (!value) return '';
  try {
    return await decrypt(value);
  } catch {
    /* ignore */
    return value;
  }
}

async function encryptOptionalPassword(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  return encrypt(value);
}

async function openIdentityEditor(identity: Identity) {
  editingIdentity = identity;
  newIdentitySetAsDefault = !!identity.isDefault;
  newIdentityName = identity.name;
  newIdentityFirstNames = identity.firstNames || '';
  newIdentityLastNames = identity.lastNames || '';
  newIdentityUsername = identity.username || '';
  newIdentityUseRandomPassword = identity.useRandomPassword;
  newIdentityCustomPassword = await tryDecryptPassword(identity.customPassword);
  newIdentityPhone = identity.phone || '';
  newIdentityPin = identity.pin || '';
  newIdentityDomainHints = identity.domainHints ? [...identity.domainHints] : [];
  newIdentityPreferredEmail = identity.preferredEmail || '';
  newIdentityGender = (identity.gender as typeof newIdentityGender) || '';
  newIdentityDob = identity.dateOfBirth || '';
  newIdentityCountry = identity.country || '';
  newIdentityCity = identity.city || '';
  newIdentityState = identity.state || '';
  newIdentityAddress = identity.address || '';
  newIdentityProfilePicture = identity.profilePicture || null;
  newIdentityUserAgent = identity.userAgent || null;
  newIdentityDomainFieldOverrides = identity.domainFieldOverrides
    ? Object.entries(identity.domainFieldOverrides).map(([domain, fields]) => ({
        domain,
        firstNames: fields.firstNames || '',
        lastNames: fields.lastNames || '',
        username: fields.username || '',
        phone: fields.phone || '',
        preferredEmail: fields.preferredEmail || '',
      }))
    : [];
  if (!identity.userAgent) {
    userAgentPresetMode = 'default';
  } else {
    const presetKey = Object.keys(USER_AGENT_PRESETS).find(
      (k) => USER_AGENT_PRESETS[k].userAgent === identity.userAgent
    );
    userAgentPresetMode = presetKey || 'custom';
  }
  newDomainHintInput = '';
  validationError = '';
  isDirty = false;
}

function closeIdentityEditor() {
  editingIdentity = null;
  newIdentityName = '';
  newIdentityFirstNames = '';
  newIdentityLastNames = '';
  newIdentityUsername = '';
  newIdentityUseRandomPassword = true;
  newIdentityCustomPassword = '';
  newIdentityPhone = '';
  newIdentityPin = '';
  newIdentityDomainHints = [];
  newIdentityPreferredEmail = '';
  newIdentityGender = '';
  newIdentityDob = '';
  newIdentityCountry = '';
  newIdentityCity = '';
  newIdentityState = '';
  newIdentityAddress = '';
  newIdentityProfilePicture = null;
  newIdentityUserAgent = null;
  userAgentPresetMode = 'default';
  newIdentityDomainFieldOverrides = [];
  newDomainOverrideInput = {};
  newDomainHintInput = '';
  validationError = '';
  isDirty = false;
}

function closeCreateDialog() {
  showCreateDialog = false;
  newIdentityName = '';
  newIdentityFirstNames = '';
  newIdentityLastNames = '';
  newIdentityUsername = '';
  newIdentityUseRandomPassword = true;
  newIdentityCustomPassword = '';
  newIdentityPhone = '';
  newIdentityPin = '';
  newIdentityDomainHints = [];
  newIdentityPreferredEmail = '';
  newIdentityGender = '';
  newIdentityDob = '';
  newIdentityCountry = '';
  newIdentityCity = '';
  newIdentityState = '';
  newIdentityAddress = '';
  newIdentityProfilePicture = null;
  newIdentityUserAgent = null;
  userAgentPresetMode = 'default';
  newIdentityDomainFieldOverrides = [];
  newDomainOverrideInput = {};
  newDomainHintInput = '';
  validationError = '';
  isDirty = false;
}

function attemptCloseEditor() {
  if (isDirty) {
    showConfirm($t('identities.discardChangesPrompt'), () => {
      isDirty = false;
      closeIdentityEditor();
      closeCreateDialog();
    });
  } else {
    closeIdentityEditor();
    closeCreateDialog();
  }
}

function onProfilePictureSelected(e: Event) {
  const input = e.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    validationError = $t('identities.profilePictureInvalid');
    return;
  }
  // Cap ~500KB for storage safety
  if (file.size > 500 * 1024) {
    validationError = $t('identities.profilePictureTooLarge');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    newIdentityProfilePicture = typeof reader.result === 'string' ? reader.result : null;
    validationError = '';
  };
  reader.onerror = () => {
    validationError = $t('identities.profilePictureInvalid');
  };
  reader.readAsDataURL(file);
}

function clearProfilePicture() {
  newIdentityProfilePicture = null;
}

async function saveIdentityChanges() {
  if (!editingIdentity) return;

  try {
    const trimmedName = validateTextInput(newIdentityName, 'Identity name', 64);

    // Check for duplicate name (excluding the identity being edited)
    const editingId = editingIdentity?.id;
    const isDuplicateName = identities.some(
      (i) => i.id !== editingId && i.name.toLowerCase() === trimmedName.toLowerCase()
    );
    if (isDuplicateName) {
      validationError = $t('identities.duplicateName', { values: { name: trimmedName } });
      return;
    }

    const now = Date.now();
    const prevHistory = editingIdentity.updateHistory || [];
    const nextHistory = [...prevHistory, { at: now, summary: 'edit' }].slice(-20);

    const updatedIdentity: Identity = {
      ...editingIdentity,
      name: trimmedName,
      firstNames: newIdentityFirstNames.trim()
        ? validateTextInput(newIdentityFirstNames, 'First names', 500)
        : '',
      lastNames: newIdentityLastNames.trim()
        ? validateTextInput(newIdentityLastNames, 'Last names', 500)
        : '',
      username: newIdentityUsername.trim() || null,
      useRandomPassword: newIdentityUseRandomPassword,
      customPassword: newIdentityUseRandomPassword
        ? undefined
        : await encryptOptionalPassword(validateOptionalPassword(newIdentityCustomPassword)),
      phone: validateOptionalPhone(newIdentityPhone),
      pin: validateOptionalPin(newIdentityPin),
      domainHints: newIdentityDomainHints.filter((h) => h.trim()),
      preferredEmail: newIdentityPreferredEmail.trim() || null,
      gender: newIdentityGender || null,
      dateOfBirth: newIdentityDob.trim() || null,
      country: newIdentityCountry.trim() || null,
      city: newIdentityCity.trim() || null,
      state: newIdentityState.trim() || null,
      address: newIdentityAddress.trim() || null,
      profilePicture: newIdentityProfilePicture || null,
      userAgent: newIdentityUserAgent || null,
      domainFieldOverrides: newIdentityDomainFieldOverrides.length
        ? Object.fromEntries(
            newIdentityDomainFieldOverrides.map((ov) => [
              ov.domain,
              {
                ...(ov.firstNames ? { firstNames: ov.firstNames } : {}),
                ...(ov.lastNames ? { lastNames: ov.lastNames } : {}),
                ...(ov.username ? { username: ov.username } : {}),
                ...(ov.phone ? { phone: ov.phone } : {}),
                ...(ov.preferredEmail ? { preferredEmail: ov.preferredEmail } : {}),
              },
            ])
          )
        : undefined,
      isDefault: !!newIdentitySetAsDefault,
      updatedAt: now,
      updateHistory: nextHistory,
    };

    await saveIdentity(browser, updatedIdentity, identitySetters);
    if (newIdentitySetAsDefault) {
      try {
        const list = identities.map((i) => ({
          ...i,
          isDefault: i.id === updatedIdentity.id,
        }));
        await browser.storage.local.set({
          identities: list,
          selectedIdentityId: updatedIdentity.id,
        });
        identities = list;
      } catch {
        /* ignore */
      }
    }
    closeIdentityEditor();
  } catch (error) {
    validationError = getErrorMessage(error);
  }
}

async function deleteIdentityHandler(identityId: string) {
  showConfirm($t('identities.deleteConfirm'), () => {
    void deleteIdentity(browser, identityId, identitySetters);
  });
}

let suppressClickUntil = 0;

function startHold(id: string) {
  if (selectionMode || searchQuery) return;
  holdTimers.set(
    id,
    setTimeout(() => {
      selectionMode = true;
      selectedIds = new Set([id]);
      suppressClickUntil = Date.now() + 400;
      holdTimers.delete(id);
    }, 500)
  );
}

function cancelHold(id: string) {
  const t = holdTimers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    holdTimers.delete(id);
  }
}

function toggleSelect(id: string) {
  const next = new Set(selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds = next;
  if (selectedIds.size === 0) selectionMode = false;
}

function exitSelectionMode() {
  selectionMode = false;
  selectedIds = new Set();
}

async function deleteSelected() {
  const ids = [...selectedIds];
  showConfirm($t('identities.deleteSelectedConfirm', { values: { n: ids.length } }), () => {
    void (async () => {
      for (const id of ids) {
        await deleteIdentity(browser, id, identitySetters);
      }
      exitSelectionMode();
    })();
  });
}

async function selectIdentityHandler(identityId: string) {
  await selectIdentity(browser, identityId, identitySetters);
}

function openCreateDialog() {
  showCreateDialog = true;
  const suggest = nameSuggestionsForLocale();
  // Name: Identity1 / Identity2… - first/last left empty; country from locale
  newIdentityName = nextIdentityName(identities);
  newIdentityFirstNames = '';
  newIdentityLastNames = '';
  newIdentityUsername = '';
  newIdentityUseRandomPassword = true;
  newIdentityCustomPassword = '';
  newIdentityPhone = '';
  newIdentityPin = '';
  newIdentityPreferredEmail = PREFERRED_EMAIL_RANDOM_ACTIVE;
  newIdentityGender = '';
  newIdentityDob = '';
  newIdentityState = '';
  newIdentityAddress = '';
  // Default fake avatar so profile-picture form fields can be filled immediately
  newIdentityProfilePicture = generateDefaultAvatarDataUrl(newIdentityName, 'I');
  newIdentitySetAsDefault = false;
  // Local-only country (locale + timezone); sample city/ZIP for convenience
  const localCountry = detectCountryLocally() || suggest.country;
  newIdentityCountry = localCountry;
  newIdentityCity = randomCity(localCountry);
  newIdentityPin = randomPostalCode(localCountry);
  dobHelperMode = 'date';
  dobRangeToYear = Math.max(1970, new Date().getFullYear() - 18);
  validationError = '';
  void loadIdentitiesData();
}

function applyRandomAdultDob() {
  newIdentityDob = randomAdultDob(18, 65);
  dobHelperMode = 'date';
}

function applyDobFromRange() {
  newIdentityDob = randomDobInYearRange(dobRangeFromYear, dobRangeToYear, 18);
}

function applySuggestedNames() {
  const suggest = nameSuggestionsForLocale();
  newIdentityFirstNames = suggest.first.slice(0, 4).join(', ');
  newIdentityLastNames = suggest.last.slice(0, 4).join(', ');
}

async function createNewIdentity() {
  try {
    const trimmedName = validateTextInput(newIdentityName, 'Identity name', 64);

    // Check for duplicate name
    const isDuplicateName = identities.some(
      (i) => i.name.toLowerCase() === trimmedName.toLowerCase()
    );
    if (isDuplicateName) {
      validationError = $t('identities.duplicateName', { values: { name: trimmedName } });
      return;
    }

    const now = Date.now();
    const newIdentity: Identity = {
      id: `identity_${Date.now()}`,
      name: trimmedName,
      firstNames: newIdentityFirstNames.trim()
        ? validateTextInput(newIdentityFirstNames, 'First names', 500)
        : '',
      lastNames: newIdentityLastNames.trim()
        ? validateTextInput(newIdentityLastNames, 'Last names', 500)
        : '',
      username: newIdentityUsername.trim() || null,
      useRandomPassword: newIdentityUseRandomPassword,
      customPassword: newIdentityUseRandomPassword
        ? undefined
        : await encryptOptionalPassword(validateOptionalPassword(newIdentityCustomPassword)),
      phone: validateOptionalPhone(newIdentityPhone),
      pin: validateOptionalPin(newIdentityPin),
      preferredEmail: newIdentityPreferredEmail.trim() || null,
      gender: newIdentityGender || null,
      dateOfBirth: newIdentityDob.trim() || null,
      country: newIdentityCountry.trim() || null,
      city: newIdentityCity.trim() || null,
      state: newIdentityState.trim() || null,
      address: newIdentityAddress.trim() || null,
      profilePicture: newIdentityProfilePicture || null,
      userAgent: newIdentityUserAgent || null,
      domainFieldOverrides: newIdentityDomainFieldOverrides.length
        ? Object.fromEntries(
            newIdentityDomainFieldOverrides.map((ov) => [
              ov.domain,
              {
                ...(ov.firstNames ? { firstNames: ov.firstNames } : {}),
                ...(ov.lastNames ? { lastNames: ov.lastNames } : {}),
                ...(ov.username ? { username: ov.username } : {}),
                ...(ov.phone ? { phone: ov.phone } : {}),
                ...(ov.preferredEmail ? { preferredEmail: ov.preferredEmail } : {}),
              },
            ])
          )
        : undefined,
      isDefault: !!newIdentitySetAsDefault,
      createdAt: now,
      updatedAt: now,
      updateHistory: [{ at: now, summary: 'create' }],
    };

    await saveIdentity(browser, newIdentity, identitySetters);
    // Only promote to default identity when user checked the box
    if (newIdentitySetAsDefault) {
      try {
        const next = identities.map((i) => ({
          ...i,
          isDefault: i.id === newIdentity.id,
        }));
        // Ensure the new one is default
        const idx = next.findIndex((i) => i.id === newIdentity.id);
        if (idx < 0) next.push({ ...newIdentity, isDefault: true });
        else next[idx] = { ...newIdentity, isDefault: true };
        await browser.storage.local.set({
          identities: next.map((i) =>
            i.id === newIdentity.id ? { ...i, isDefault: true } : { ...i, isDefault: false }
          ),
          selectedIdentityId: newIdentity.id,
        });
        identities = next.map((i) =>
          i.id === newIdentity.id ? { ...i, isDefault: true } : { ...i, isDefault: false }
        );
      } catch {
        /* ignore */
      }
    }
    // Do not auto-select as the autofill default unless set as default
    closeCreateDialog();
  } catch (error) {
    validationError = getErrorMessage(error);
  }
}

function validateOptionalPassword(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  validatePassword(trimmed);
  return trimmed;
}

function validateOptionalPhone(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  validatePhoneNumber(trimmed);
  return trimmed;
}

function validateOptionalPin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  validateOTP(trimmed);
  return trimmed;
}

loadIdentitiesData();
</script>

<div class="flex flex-col h-full relative min-h-0">
  <!-- Mainview list only — editor never shares this column when layoutSplit -->
  <div
    class="flex-1 overflow-y-auto min-h-0 min-w-0"
    onscroll={(e) => {
      const el = e.currentTarget as HTMLElement;
      const top = el.scrollTop;
      const delta = top - identityLastScrollTop;
      if (Math.abs(delta) > 8) {
        identityFabHidden = delta > 0 && top > 24;
        identityLastScrollTop = top;
      }
    }}
  >
    <!-- Search + filters -->
      <div class="px-1 pt-3 pb-1 space-y-2">
        <SelectionToolbar
          visible={true}
          itemCount={filteredIdentities?.length ?? identities?.length ?? 0}
          selectedCount={selectedIds.size}
          selectionActive={selectionMode}
          onEnterSelection={() => {
            selectionMode = true;
          }}
          onSelectAll={() => {
            selectionMode = true;
            const list = filteredIdentities?.length ? filteredIdentities : identities;
            selectedIds = new Set((list || []).map((i: { id: string }) => i.id));
          }}
          onClear={() => {
            selectedIds = new Set();
          }}
          onExit={() => {
            selectionMode = false;
            selectedIds = new Set();
          }}
        />
        <div class="flex items-center gap-2">
          <div class="relative flex-1 min-w-0">
            <SearchBar
              scope="identities"
              bind:value={searchQuery}
              placeholder={$t('identities.searchPlaceholder')}
              animatedPlaceholders={[
                $t('identities.searchPlaceholder'),
                $t('identities.namePlaceholder'),
                $t('identities.usernamePlaceholder'),
              ]}
              ariaLabel={$t('identities.searchPlaceholder')}
              settingsStyle={true}
              showSlashButton={true}
              shortcuts={[
                {
                  prefix: 'country:',
                  label: 'country:',
                  description: $t('identities.filterCountry'),
                },
              ]}
            >
              {#snippet filterControl()}
                <button
                  type="button"
                  class="h-9 w-9 flex items-center justify-center rounded-xl border transition-colors {showIdentityFilters || hasActiveIdentityFilters ? 'border-md-primary bg-md-primary/10 text-md-primary' : 'border-md-outline-variant text-md-on-surface/60 hover:bg-md-surface-variant'}"
                  aria-label={$t('identities.filtersToggle')}
                  title={$t('identities.filtersToggle')}
                  aria-pressed={showIdentityFilters}
                  onclick={() => (showIdentityFilters = !showIdentityFilters)}
                >
                  <Icon name="filter" class="w-4 h-4" />
                </button>
              {/snippet}
            </SearchBar>
          </div>
        </div>
        {#if showIdentityFilters}
          <div class="rounded-xl border border-md-outline-variant/40 bg-md-surface-container/40 p-2.5 space-y-2">
            <div>
              <label class="text-xs font-semibold text-md-on-surface/50 mb-1 block" for="id-filter-email">{$t('identities.filterEmail')}</label>
              <Dropdown
                id="id-filter-email"
                size="xs"
                variant="outlined"
                ariaLabel={$t('identities.filterEmail')}
                bind:value={filterEmail}
                options={[
                  { value: '', label: $t('identities.filterEmailAll') },
                  ...identityEmails.map((addr) => ({ value: addr, label: addr })),
                ]}
              />
            </div>
            <div>
              <label class="text-xs font-semibold text-md-on-surface/50 mb-1 block" for="id-filter-country">{$t('identities.filterCountry')}</label>
              <Dropdown
                id="id-filter-country"
                size="xs"
                variant="outlined"
                ariaLabel={$t('identities.filterCountry')}
                bind:value={filterCountry}
                options={[
                  { value: '', label: $t('identities.filterCountryAll') },
                  ...identityCountries.map((code) => ({
                    value: code,
                    label: COUNTRY_OPTIONS.find((c) => c.code === code)?.name || code,
                  })),
                ]}
              />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="text-xs font-semibold text-md-on-surface/50 mb-1 block" for="id-filter-dob-from">{$t('identities.filterDobFrom')}</label>
                <InputField
                  id="id-filter-dob-from"
                  type="date"
                  size="xs"
                  bind:value={filterDobFrom}
                />
              </div>
              <div>
                <label class="text-xs font-semibold text-md-on-surface/50 mb-1 block" for="id-filter-dob-to">{$t('identities.filterDobTo')}</label>
                <InputField
                  id="id-filter-dob-to"
                  type="date"
                  size="xs"
                  bind:value={filterDobTo}
                />
              </div>
            </div>
            {#if hasActiveIdentityFilters}
              <button
                type="button"
                class="text-label-sm font-semibold text-md-primary hover:underline"
                onclick={clearIdentityFilters}
              >
                {$t('identities.filterClear')}
              </button>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Identity List -->
      <div class="px-0 py-3 space-y-3">
        {#if filteredIdentities.length === 0 && identities.length > 0}
          <p class="text-center text-xs text-md-on-surface/45 py-8">{$t('identities.noFilterMatches')}</p>
        {/if}
        {#each filteredIdentities as identity}
          {@const isChecked = selectedIds.has(identity.id)}
          {@const isDragging = draggedIdentityId === identity.id}
          {@const isDropTarget = dropTargetIdentityId === identity.id}
          {@const prefIssue = preferredEmailIssue(identity.preferredEmail)}
          <div
            class="density-row-pad relative bg-md-tertiary-container rounded-xl px-2 flex flex-col transition-all border {prefIssue ? 'border-md-error/40 bg-md-error/5' : selectedIdentityId === identity.id && !selectionMode ? 'border-md-primary/40 bg-md-primary/5' : 'border-transparent'} {selectionMode && isChecked ? 'ring-2 ring-md-secondary' : ''} {isDragging ? 'opacity-50' : ''} {isDropTarget ? 'ring-2 ring-md-primary drop-target-pulse' : ''}"
            role="listitem"
            ondragover={(e) => handleIdentityDragOver(e, identity.id)}
            ondragleave={() => handleIdentityDragLeave(identity.id)}
            ondrop={(e) => handleIdentityDrop(e, identity.id)}
            ondragend={handleIdentityDragEnd}
            aria-label={identity.name}
          >
            <div class="flex items-center justify-between w-full">
            <div
              class="flex items-center gap-3 flex-1 min-w-0"
              onclick={() => {
                if (Date.now() < suppressClickUntil) return;
                if (selectionMode) { toggleSelect(identity.id); }
                else { void openIdentityEditor(identity); }
              }}
              onpointerdown={() => { if (!selectionMode) startHold(identity.id); }}
              onpointerup={() => cancelHold(identity.id)}
              onpointerleave={() => cancelHold(identity.id)}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (selectionMode) toggleSelect(identity.id);
                  else void openIdentityEditor(identity);
                }
              }}
              role="button"
              tabindex="0"
            >
            <div class="flex items-center gap-3">
              <!-- Same avatar size always; selection swaps person → tick -->
              <div
                class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors {selectionMode && isChecked
                  ? 'bg-md-secondary text-md-on-secondary'
                  : selectionMode
                    ? 'bg-md-primary/10 border-2 border-md-outline-variant'
                    : prefIssue
                      ? 'bg-md-error/15'
                      : 'bg-md-primary/10'}"
              >
                {#if selectionMode && isChecked}
                  <Icon name="check" class="w-5 h-5 text-md-on-secondary" />
                {:else if prefIssue}
                  <Icon name="alertTriangle" class="w-5 h-5 text-md-error" />
                {:else}
                  <Icon name="user" class="w-5 h-5 text-md-primary" />
                {/if}
              </div>
              <div class="min-w-0">
                <div class="font-medium text-sm truncate">{identity.name}</div>
                {#if isRandomActivePreferredEmail(identity.preferredEmail)}
                  <div class="text-xs text-md-on-surface/45 truncate">{$t('identities.useRandomActiveMailbox')}</div>
                {:else if identity.preferredEmail}
                  <div class="text-xs truncate {prefIssue ? 'text-md-error' : 'text-md-on-surface/45'}">{identity.preferredEmail}</div>
                {:else}
                  <div class="text-xs text-md-on-surface/45 truncate">{$t('identities.usesActiveMailbox')}</div>
                {/if}
              </div>
            </div>
            </div>
            <div class="flex items-center gap-1.5">
              {#if !selectionMode}
                <button
                  class="w-7 h-7 flex items-center justify-center rounded-lg bg-transparent hover:bg-md-secondary-container text-md-on-surface/70 transition-colors"
                  onclick={(e) => {
                    e.stopPropagation();
                    void openIdentityEditor(identity);
                  }}
                  aria-label={$t('identities.edit')}
                  title={$t('identities.edit')}
                >
                  <Icon name="edit" class="w-4 h-4" />
                </button>
                <button
                  class="w-7 h-7 flex items-center justify-center rounded-lg bg-transparent hover:bg-md-secondary-container text-md-error transition-colors"
                  onclick={(e) => {
                    e.stopPropagation();
                    deleteIdentityHandler(identity.id);
                  }}
                  aria-label={$t('identities.delete')}
                  title={$t('identities.delete')}
                >
                  <Icon name="trash" class="w-4 h-4" />
                </button>
              {/if}
            </div>
            {#if !selectionMode && !reorderBlocked}
              <button
                type="button"
                class="shrink-0 w-7 h-8 me-1 flex items-center justify-center rounded-lg text-md-on-surface/35 hover:text-md-on-surface/70 hover:bg-md-surface-variant/50 cursor-grab active:cursor-grabbing touch-none"
                draggable="true"
                aria-label={$t('identities.dragHandle')}
                title={$t('identities.dragHandle')}
                ondragstart={(e) => handleIdentityDragStart(e, identity.id)}
                onclick={(e) => e.stopPropagation()}
              >
                <Icon name="grip" class="w-4 h-4" />
              </button>
            {/if}
            <!-- Notch-style "Default" like AccountSelector Live / expires label -->
            {#if selectedIdentityId === identity.id && !selectionMode}
              <span
                class="notch absolute z-[2] pointer-events-none whitespace-nowrap bg-md-tertiary-container px-1.5 text-xs font-semibold leading-none text-md-primary"
                style="top: 0; left: 14px; transform: translateY(-50%);"
              >
                <span class="inline-block w-1.5 h-1.5 rounded-full bg-md-primary me-1 shadow-[0_0_0_3px_rgba(76,102,43,0.15)]"></span>
                {$t('identities.defaultBadge')}
              </span>
            {/if}
            </div>
            {#if prefIssue && !selectionMode}
              <div class="px-1 pb-2 pt-0.5 w-full">
                <p class="text-xs text-md-error leading-snug">
                  {#if prefIssue === 'expired'}
                    {$t('identities.preferredEmailExpired')}
                  {:else if prefIssue === 'archived'}
                    {$t('identities.preferredEmailArchived')}
                  {:else if prefIssue === 'deleted'}
                    {$t('identities.preferredEmailDeleted')}
                  {:else}
                    {$t('identities.preferredEmailMissing')}
                  {/if}
                </p>
                <p class="text-label-sm text-md-on-surface/50 mt-0.5 leading-snug">
                  {$t('identities.preferredEmailFixHint')}
                </p>
                <div class="flex flex-wrap gap-1.5 mt-1.5">
                  <button
                    type="button"
                    class="text-label-sm font-semibold px-2 py-0.5 rounded-lg bg-md-primary/15 text-md-primary hover:bg-md-primary/25"
                    onclick={(e) => {
                      e.stopPropagation();
                      void openIdentityEditor(identity);
                    }}
                  >
                    {$t('identities.editPreferredEmail')}
                  </button>
                  <button
                    type="button"
                    class="text-label-sm font-semibold px-2 py-0.5 rounded-lg bg-md-surface-variant text-md-on-surface/70 hover:bg-md-surface-variant/80"
                    onclick={(e) => {
                      e.stopPropagation();
                      openCreateDialog();
                    }}
                  >
                    {$t('identities.createNewInstead')}
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <!-- Dynamic End-of-List Spacer: allows content to flow behind floating nav & strips while ensuring the final item can scroll cleanly above controls -->
      <div
        class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
        style="height: calc(var(--bottom-safe-area, 0px) + {identityStripHeightPx}px + 12px);"
        aria-hidden="true"
      ></div>
  </div>

  <!-- Create identity is triggered from footer contextual FAB -->

  <!-- Bottom strip: selection actions OR default-identity picker (same placement as InboxView) -->
  <div bind:this={identityStripEl} class="absolute inset-x-0 z-10 flex justify-center transition-all duration-200" style="bottom: calc(var(--bottom-safe-area, 0px) + 4px);">
    {#if selectionMode}
      <div
        class="selection-slide-up h-[40px] w-[350px] flex items-center box-border px-2.5 bg-md-secondary-container rounded-xl gap-1"
        role="toolbar"
        aria-label={$t('mailManagement.selectedCount', { values: { n: selectedIds.size } })}
      >
        <button
          type="button"
          class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-md-surface-variant/60 flex-shrink-0 transition-colors"
          aria-label={$t('common.close')}
          onclick={(e) => { e.stopPropagation(); exitSelectionMode(); }}
        >
          <Icon name="x" class="w-3.5 h-3.5 text-md-on-surface/60" />
        </button>
        <span class="text-label-sm font-semibold text-md-on-surface/70 flex-shrink-0 tabular-nums">
          {$t('mailManagement.selectedCount', { values: { n: selectedIds.size } })}
        </span>
        <div class="flex-1 min-w-0"></div>
        <button
          type="button"
          class="h-7 px-2.5 rounded-lg text-label-sm font-semibold text-md-error hover:bg-md-error/10 flex items-center gap-1 flex-shrink-0 transition-colors disabled:opacity-40"
          disabled={selectedIds.size === 0}
          onclick={(e) => { e.stopPropagation(); void deleteSelected(); }}
        >
          <Icon name="trash" class="w-3.5 h-3.5" />
          {$t('common.delete')} ({selectedIds.size})
        </button>
      </div>
    {:else}
      <div class="h-[40px] w-[350px] flex items-center box-border px-3 bg-md-primary-container rounded-xl">
        <div class="flex items-center gap-2 w-full">
          <div class="relative flex-1 min-w-0">
            <div
              class="flex items-center gap-1 bg-md-secondary-container/70 rounded-full px-2 py-1 cursor-pointer relative"
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
              <Icon name="user" class="w-3 h-3 text-md-secondary flex-shrink-0" />
              <div class="flex-1 min-w-0 text-label-sm font-medium text-md-on-surface pe-2 truncate">
                {identities.find(i => i.id === selectedIdentityId)?.name || $t('identities.select')}
              </div>
              <Icon name="chevronDown" class="w-2.5 h-2.5 text-md-on-surface/40 flex-shrink-0 transition-transform {showIdentityDropdown ? 'rotate-180' : ''}" />

              {#if showIdentityDropdown}
                <div class="absolute bottom-full inset-x-0 mb-1 bg-md-primary-container border border-md-secondary-container rounded-xl shadow-lg z-50 max-h-48 overflow-y-auto">
                  {#each identities as identity}
                    <button
                      class="w-full text-start px-3 py-2 text-label-sm font-medium text-md-on-surface hover:bg-md-secondary-container transition-colors first:rounded-t-xl last:rounded-b-xl"
                      onclick={(e) => {
                        e.stopPropagation();
                        selectedIdentityId = identity.id;
                        selectIdentity(browser, identity.id, identitySetters);
                        showIdentityDropdown = false;
                      }}
                    >
                      {identity.name}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>

  {#if showCreateDialog}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      use:portalDialogAction
      data-portal-layer="dialog"
      class="identity-overlay fixed inset-0 z-[10000] flex items-stretch justify-stretch"
      role="presentation"
      onclick={(e) => {
        if (e.target === e.currentTarget) closeCreateDialog();
      }}
      onkeydown={(e) => { if (e.key === 'Escape') closeCreateDialog(); }}
    >
      <button
        type="button"
        class="absolute inset-0 z-0 cursor-default border-0 bg-md-scrim/50 backdrop-blur-sm"
        aria-label={$t('common.close')}
        onclick={closeCreateDialog}
      ></button>
      <div class="relative z-10 flex flex-col w-full h-full min-h-0 p-[25px]">
      <div class="flex justify-end shrink-0 mb-2">
        <button
          type="button"
          class="w-9 h-9 rounded-full bg-md-surface hover:bg-md-surface-variant flex items-center justify-center shadow-md transition-colors border border-md-outline-variant/30"
          onclick={closeCreateDialog}
          aria-label={$t('common.close')}
          title={$t('common.close')}
        >
          <Icon name="x" class="w-4 h-4 text-md-on-surface/70" />
        </button>
      </div>
      <form
        class="dialog-enter bg-md-surface rounded-2xl w-full flex-1 min-h-0 flex flex-col overflow-hidden shadow-2xl border border-md-outline-variant/30"
        onsubmit={(e) => { e.preventDefault(); void createNewIdentity(); }}
      >
        <div class="shrink-0 px-4 pt-4 pb-2">
          <h3 class="font-semibold text-base">{$t('identities.createNew')}</h3>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
          <div class="space-y-3">
            <div>
              <label for="create-name" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.name')}</label>
              <InputField id="create-name" placeholder={$t('identities.namePlaceholder')} bind:value={newIdentityName} />
            </div>
            <div>
              <label for="create-username" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.username')}</label>
              <InputField id="create-username" placeholder={$t('identities.usernamePlaceholder')} bind:value={newIdentityUsername} />
            </div>
          </div>
        </div>
        <div class="shrink-0 p-4 border-t border-md-outline-variant/30 flex justify-end gap-2">
          <button type="button" class="px-4 py-2 rounded-lg text-sm font-semibold text-md-on-surface/70 hover:bg-md-surface-variant" onclick={closeCreateDialog}>{$t('common.cancel')}</button>
          <button type="submit" class="px-4 py-2 rounded-lg text-sm font-semibold bg-md-primary text-md-on-primary hover:bg-md-primary/90">{$t('common.create')}</button>
        </div>
      </form>
      </div>
    </div>
  {/if}

  <!-- Edit identity: full dialog, or mounted into AppLayout splitview host -->
  {#if editingIdentity}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      use:portalDialogAction
      data-portal-layer={useSplitEditor ? undefined : 'dialog'}
      class={useSplitEditor
        ? 'identity-overlay absolute inset-0 z-[50] flex flex-col bg-md-surface min-w-0 min-h-0'
        : 'identity-overlay fixed inset-0 z-[10000] flex items-stretch justify-stretch'}
      role="presentation"
      onclick={(e) => {
        if (!useSplitEditor && e.target === e.currentTarget) attemptCloseEditor();
      }}
      onkeydown={(e) => { if (e.key === 'Escape') attemptCloseEditor(); }}
    >
      {#if !useSplitEditor}
        <button
          type="button"
          class="absolute inset-0 z-0 cursor-default border-0 bg-md-scrim/50 backdrop-blur-sm"
          aria-label={$t('common.close')}
          onclick={attemptCloseEditor}
        ></button>
      {/if}
      <div
        class="relative z-10 flex flex-col w-full h-full min-h-0 {useSplitEditor ? 'p-2' : ''}"
        style={useSplitEditor ? undefined : 'padding: 25px;'}
      >
      <div class="flex justify-end shrink-0 mb-2">
        <button
          type="button"
          class="w-9 h-9 rounded-full bg-md-surface hover:bg-md-surface-variant flex items-center justify-center shadow-md transition-colors border border-md-outline-variant/30"
          onclick={attemptCloseEditor}
          aria-label={$t('common.close')}
          title={$t('common.close')}
        >
          <Icon name="x" class="w-4 h-4 text-md-on-surface/70" />
        </button>
      </div>
      <form
        class="dialog-enter bg-md-surface rounded-2xl w-full flex-1 min-h-0 flex flex-col overflow-hidden {useSplitEditor
          ? 'border border-md-outline-variant/30 shadow-sm'
          : 'shadow-2xl border border-md-outline-variant/30'}"
        onsubmit={(e) => { e.preventDefault(); void saveIdentityChanges(); }}
        oninput={() => { isDirty = true; }}
        onchange={() => { isDirty = true; }}
        aria-labelledby="edit-identity-title"
      >
        <div class="shrink-0 px-4 pt-4 pb-2">
          <h3 id="edit-identity-title" class="font-semibold text-base">{$t('identities.edit')}</h3>
        </div>
        <div class="flex-1 min-h-0 overflow-y-auto px-4 pb-2">
        <div class="mb-3 space-y-0.5 text-label-sm text-md-on-surface/50">
          <p>{$t('identities.createdAt', { values: { time: formatIdentityTime(editingIdentity.createdAt) } })}</p>
          {#if editingIdentity.updatedAt}
            <p>{$t('identities.lastUpdated', { values: { time: formatIdentityTime(editingIdentity.updatedAt) } })}</p>
          {/if}
        </div>
        {#if editingIdentity.updateHistory?.length}
          <div class="mb-3 rounded-xl bg-md-surface-variant/40 px-3 py-2 max-h-24 overflow-y-auto">
            <div class="text-xs font-semibold uppercase text-md-on-surface/45 mb-1">{$t('identities.updateHistory')}</div>
            {#each [...editingIdentity.updateHistory].reverse().slice(0, 8) as entry (entry.at)}
              <p class="text-xs text-md-on-surface/55">{$t('identities.historyEntry', { values: { time: formatIdentityTime(entry.at) } })}</p>
            {/each}
          </div>
        {:else}
          <p class="mb-3 text-xs text-md-on-surface/40">{$t('identities.noUpdateHistory')}</p>
        {/if}
        <div class="space-y-3">
          <div>
            <label for="edit-identity-name" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.name')}</label>
            <InputField id="edit-identity-name" placeholder={$t('identities.namePlaceholder')} bind:value={newIdentityName} />
          </div>
          <div>
            <label for="edit-first-names" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.firstNames')}</label>
            <InputField id="edit-first-names" bind:value={newIdentityFirstNames} />
          </div>
          <div>
            <label for="edit-last-names" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.lastNames')}</label>
            <InputField id="edit-last-names" bind:value={newIdentityLastNames} />
          </div>
          <div>
            <label for="edit-username" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.username')}</label>
            <p class="text-xs text-md-on-surface/40 mb-1">{$t('identities.usernameHint')}</p>
            <InputField id="edit-username" placeholder={$t('identities.usernamePlaceholder')} bind:value={newIdentityUsername} />
          </div>
          <div>
            <label for="edit-country-ov" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.country')}</label>
            <Dropdown
              id="edit-country-ov"
              variant="outlined"
              zIndex={PORTAL_Z.dialogMenu}
              ariaLabel={$t('identities.country')}
              bind:value={newIdentityCountry}
              options={[
                { value: '', label: $t('identities.optional') },
                ...COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: c.name })),
              ]}
            />
          </div>
          <div>
            <label for="edit-gender-ov" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.gender')}</label>
            <Dropdown
              id="edit-gender-ov"
              variant="outlined"
              zIndex={PORTAL_Z.dialogMenu}
              ariaLabel={$t('identities.gender')}
              bind:value={newIdentityGender}
              options={[
                { value: '', label: $t('identities.optional') },
                { value: 'male', label: $t('identities.genderMale') },
                { value: 'female', label: $t('identities.genderFemale') },
                { value: 'other', label: $t('identities.genderOther') },
                { value: 'prefer_not', label: $t('identities.genderPreferNot') },
              ]}
            />
          </div>
          <div>
            <label for="edit-dob-ov" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.dateOfBirth')}</label>
            <InputField id="edit-dob-ov" type="date" bind:value={newIdentityDob} />
          </div>
          <div>
            <label for="edit-city-ov" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.city')}</label>
            <InputField id="edit-city-ov" bind:value={newIdentityCity} />
          </div>
          <div>
            <label for="edit-state-ov" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.state')}</label>
            <InputField id="edit-state-ov" placeholder={$t('identities.optional')} bind:value={newIdentityState} />
          </div>
          <div>
            <label for="edit-address-ov" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.address')}</label>
            <InputField id="edit-address-ov" placeholder={$t('identities.optional')} bind:value={newIdentityAddress} />
          </div>
          <div>
            <label for="edit-avatar-ov" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.profilePicture')}</label>
            <p class="text-xs text-md-on-surface/40 mb-1">{$t('identities.profilePictureHint')}</p>
            <div class="flex items-center gap-3">
              {#if newIdentityProfilePicture}
                <img src={newIdentityProfilePicture} alt="" class="w-12 h-12 rounded-full object-cover border border-md-outline-variant" />
              {/if}
              <input id="edit-avatar-ov" type="file" accept="image/*" class="text-xs max-w-full" onchange={onProfilePictureSelected} />
              {#if newIdentityProfilePicture}
                <button type="button" class="text-xs text-md-error hover:underline" onclick={clearProfilePicture}>{$t('identities.clearProfilePicture')}</button>
              {/if}
            </div>
          </div>
          <div>
            <label for="edit-ua-select" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.userAgentAnonymity')}</label>
            <div class="flex gap-2 mb-2">
              <Dropdown
                id="edit-ua-select"
                class="flex-1"
                variant="outlined"
                zIndex={PORTAL_Z.dialogMenu}
                ariaLabel={$t('identities.userAgentAnonymity')}
                bind:value={userAgentPresetMode}
                onchange={onUAPresetChange}
                options={[
                  { value: 'default', label: $t('identities.defaultBrowser') },
                  { value: 'chrome_windows', label: 'Chrome (Windows)' },
                  { value: 'chrome_mac', label: 'Chrome (macOS)' },
                  { value: 'chrome_linux', label: 'Chrome (Linux)' },
                  { value: 'chrome_android', label: 'Chrome (Android)' },
                  { value: 'custom', label: $t('identities.uaPresetCustom') },
                ]}
              />
              <button type="button" class="px-3 py-2 rounded-lg border border-md-outline text-xs text-md-primary hover:bg-md-primary/10 font-semibold" onclick={generateRandomUA}>
                {$t('identities.generateRandomUa')}
              </button>
            </div>
            {#if userAgentPresetMode === 'custom' || newIdentityUserAgent}
              <textarea
                id="edit-ua-input"
                class="w-full px-3 py-2 rounded-lg border border-md-outline-variant text-sm bg-md-secondary-container outline-none focus:border-md-primary focus:ring-1 focus:ring-md-primary"
                rows="2"
                placeholder="Mozilla/5.0 ..."
                bind:value={newIdentityUserAgent}
                oninput={onCustomUAInput}
              ></textarea>
            {/if}
          </div>
          <!-- Per-Domain Field Overrides -->
          <div class="pt-2">
            <span class="text-xs text-md-on-surface/50 mb-1 block font-semibold">{$t('identities.domainFieldOverrides')}</span>
            <p class="text-xs text-md-on-surface/40 mb-2">{$t('identities.domainFieldOverridesDescription')}</p>

            {#each newIdentityDomainFieldOverrides as override, i (override.domain)}
              <div class="mb-2 p-2 border border-md-outline-variant/30 rounded-lg bg-md-surface-variant/20">
                <div class="flex gap-1.5 mb-1.5">
                  <InputField
                    placeholder={$t('identities.domainPlaceholder')}
                    bind:value={override.domain}
                    class="flex-1"
                  />
                  <button
                    type="button"
                    class="w-7 h-7 rounded-lg bg-md-error/10 text-md-error hover:bg-md-error/20 flex items-center justify-center transition-colors"
                    onclick={(e) => {
                      e.stopPropagation();
                      newIdentityDomainFieldOverrides = newIdentityDomainFieldOverrides.filter((_, j) => j !== i);
                      if (newIdentityDomainFieldOverrides.length === 0) newDomainOverrideInput = {};
                      isDirty = true;
                    }}
                    aria-label={$t('common.remove')}
                  >
                    <Icon name="x" class="w-3.5 h-3.5" />
                  </button>
                </div>
                <div class="grid grid-cols-1 gap-1.5">
                  <InputField placeholder={$t('identities.firstNames')} bind:value={override.firstNames} />
                  <InputField placeholder={$t('identities.lastNames')} bind:value={override.lastNames} />
                  <InputField placeholder={$t('identities.username')} bind:value={override.username} />
                  <InputField placeholder={$t('identities.phoneNumber')} bind:value={override.phone} />
                  <InputField placeholder={$t('identities.preferredEmail')} bind:value={override.preferredEmail} />
                </div>
              </div>
            {/each}

            {#if newDomainOverrideInput.domain}
              <div class="mb-2 p-2 border border-md-outline-variant/30 rounded-lg bg-md-surface-variant/20">
                <div class="grid grid-cols-1 gap-1.5">
                  <InputField placeholder={$t('identities.domainPlaceholder')} bind:value={newDomainOverrideInput.domain} />
                  <InputField placeholder={$t('identities.firstNames')} bind:value={newDomainOverrideInput.firstNames} />
                  <InputField placeholder={$t('identities.lastNames')} bind:value={newDomainOverrideInput.lastNames} />
                  <InputField placeholder={$t('identities.username')} bind:value={newDomainOverrideInput.username} />
                  <InputField placeholder={$t('identities.phoneNumber')} bind:value={newDomainOverrideInput.phone} />
                  <InputField placeholder={$t('identities.preferredEmail')} bind:value={newDomainOverrideInput.preferredEmail} />
                </div>
                <div class="flex gap-1.5 mt-1.5">
                  <button
                    type="button"
                    class="flex-1 h-8 px-3 rounded-lg border border-md-outline text-xs font-semibold text-md-primary hover:bg-md-primary/10"
                    onclick={(e) => {
                      e.stopPropagation();
                      newDomainOverrideInput = {};
                    }}
                  >
                    {$t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    class="flex-1 h-8 px-3 rounded-lg bg-md-primary text-md-on-primary hover:bg-md-primary/90 text-xs font-semibold"
                    onclick={(e) => {
                      e.stopPropagation();
                      const d = (newDomainOverrideInput.domain || '').trim();
                      if (!d) return;
                      newIdentityDomainFieldOverrides = [...newIdentityDomainFieldOverrides, {
                        domain: d,
                        firstNames: newDomainOverrideInput.firstNames || '',
                        lastNames: newDomainOverrideInput.lastNames || '',
                        username: newDomainOverrideInput.username || '',
                        phone: newDomainOverrideInput.phone || '',
                        preferredEmail: newDomainOverrideInput.preferredEmail || '',
                      }];
                      newDomainOverrideInput = {};
                      isDirty = true;
                    }}
                  >
                    {$t('common.add')}
                  </button>
                </div>
              </div>
            {:else}
              <button
                type="button"
                class="w-full h-8 px-3 rounded-lg border border-md-outline-variant border-dashed text-xs text-md-on-surface/50 hover:text-md-on-surface hover:border-md-outline-variant/50"
                onclick={(e) => {
                  e.stopPropagation();
                  newDomainOverrideInput = { domain: '', firstNames: '', lastNames: '', username: '', phone: '', preferredEmail: '' };
                }}
              >
                {$t('identities.addDomainOverride')}
              </button>
            {/if}
          </div>
          {#if validationError}
            <p class="text-xs text-md-error">{validationError}</p>
          {/if}
        </div>
        </div>
        <!-- Sticky save at bottom of popup -->
        <div class="shrink-0 px-4 py-3 border-t border-md-outline-variant/30 bg-md-surface">
          <button type="submit" class="w-full px-4 py-2.5 text-sm font-semibold rounded-xl bg-md-primary text-md-on-primary hover:bg-md-primary/90">
            {$t('identities.save')}
          </button>
        </div>
      </form>
      </div>
    </div>
  {/if}

  <!-- Create: full dialog, or mounted into AppLayout splitview host -->
  {#if showCreateDialog}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class={useSplitEditor
        ? 'identity-overlay absolute inset-0 z-[50] flex flex-col bg-md-surface min-w-0 min-h-0'
        : 'identity-overlay fixed inset-0 z-[100] flex items-stretch justify-stretch'}
      role="presentation"
      onclick={(e) => {
        if (!useSplitEditor && e.target === e.currentTarget) attemptCloseEditor();
      }}
      onkeydown={(e) => { if (e.key === 'Escape') attemptCloseEditor(); }}
    >
      {#if !useSplitEditor}
        <button
          type="button"
          class="absolute inset-0 z-0 cursor-default border-0 bg-md-scrim/50 backdrop-blur-sm"
          aria-label={$t('common.close')}
          onclick={attemptCloseEditor}
        ></button>
      {/if}
      <div
        class="relative z-10 flex flex-col w-full h-full min-h-0 {useSplitEditor ? 'p-2' : ''}"
        style={useSplitEditor ? undefined : 'padding: 25px;'}
      >
      <div class="flex justify-end shrink-0 mb-2">
        <button
          type="button"
          class="w-9 h-9 rounded-full bg-md-surface hover:bg-md-surface-variant flex items-center justify-center shadow-md transition-colors border border-md-outline-variant/30"
          onclick={attemptCloseEditor}
          aria-label={$t('common.close')}
          title={$t('common.close')}
        >
          <Icon name="x" class="w-4 h-4 text-md-on-surface/70" />
        </button>
      </div>
      <div
        class="dialog-enter bg-md-surface rounded-2xl w-full max-w-full flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden shadow-2xl border border-md-outline-variant/30 box-border"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-identity-title"
        tabindex="-1"
        oninput={() => { isDirty = true; }}
        onchange={() => { isDirty = true; }}
      >
        <div class="shrink-0 px-4 pt-4 pb-2">
          <h3 id="create-identity-title" class="font-semibold text-base">{$t('identities.create')}</h3>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto overflow-x-auto px-4 pb-2">
        <div class="space-y-4 min-w-0 max-w-full w-full">
          <!-- Identity Name -->
          <div>
            <label for="create-identity-name" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.name')}</label>
            <InputField
              id="create-identity-name"
              placeholder={$t('identities.namePlaceholder')}
              bind:value={newIdentityName}
            />
          </div>

          <!-- Name Selection (empty by default; suggest localized samples) -->
          <div>
            <div class="flex items-center justify-between mb-1">
              <label for="create-first-names" class="text-xs text-md-on-surface/50">{$t('identities.firstNames')}</label>
              <button type="button" class="text-xs text-md-primary hover:underline" onclick={applySuggestedNames}>
                {$t('identities.suggestedNamesHint')}
              </button>
            </div>
            <InputField
              id="create-first-names"
              placeholder={$t('identities.optional')}
              bind:value={newIdentityFirstNames}
            />
          </div>
          <div>
            <label for="create-last-names" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.lastNames')}</label>
            <InputField
              id="create-last-names"
              placeholder={$t('identities.optional')}
              bind:value={newIdentityLastNames}
            />
          </div>
          <div>
            <label for="create-username" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.username')}</label>
            <p class="text-xs text-md-on-surface/40 mb-1">{$t('identities.usernameHint')}</p>
            <InputField
              id="create-username"
              placeholder={$t('identities.usernamePlaceholder')}
              bind:value={newIdentityUsername}
            />
          </div>

          <!-- Preferred mailbox email -->
          <div>
            <label for="create-preferred-email" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.preferredEmail')}</label>
            <p class="text-xs text-md-on-surface/40 mb-1.5">{$t('identities.preferredEmailHint')}</p>
            <Dropdown
              id="create-preferred-email"
              variant="outlined"
              zIndex={PORTAL_Z.dialogMenu}
              ariaLabel={$t('identities.preferredEmail')}
              bind:value={newIdentityPreferredEmail}
              options={[
                {
                  value: PREFERRED_EMAIL_RANDOM_ACTIVE,
                  label: $t('identities.useRandomActiveMailbox'),
                },
                {
                  value: '',
                  label: activeMailboxAddress
                    ? `${$t('identities.useActiveMailbox')} (${activeMailboxAddress})`
                    : $t('identities.useActiveMailbox'),
                },
                ...emailOptions.map((addr) => ({ value: addr, label: addr })),
              ]}
            />
            {#if preferredEmailIssue(newIdentityPreferredEmail)}
              <p class="text-xs text-md-error mt-1">{$t('identities.preferredEmailBadSelected')}</p>
            {/if}
            {#if emailOptions.length === 0}
              <p class="text-xs text-md-on-surface/40 mt-1">{$t('identities.noMailboxesYet')}</p>
            {/if}
          </div>

          <!-- Password Settings -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <label for="create-password" class="text-xs text-md-on-surface/50">{$t('identities.password')}</label>
              <div class="flex items-center gap-2">
                <Toggle
                  checked={newIdentityUseRandomPassword}
                  ariaLabel={$t('identities.randomPassword')}
                  size="sm"
                  onChange={(v) => (newIdentityUseRandomPassword = v)}
                />
                <span class="text-xs text-md-on-surface/50">{$t('identities.randomPassword')}</span>
              </div>
            </div>
            {#if !newIdentityUseRandomPassword}
              <InputField
                id="create-password"
                type="password"
                showToggle
                placeholder={$t('identities.customPassword')}
                bind:value={newIdentityCustomPassword}
              />
            {/if}
          </div>

          <!-- Gender / DOB / Country -->
          <div class="space-y-2">
            <div>
              <label class="text-xs text-md-on-surface/50 mb-1 block" for="create-gender">{$t('identities.gender')} ({$t('identities.optional')})</label>
              <Dropdown
                id="create-gender"
                variant="outlined"
                zIndex={PORTAL_Z.dialogMenu}
                ariaLabel={$t('identities.gender')}
                bind:value={newIdentityGender}
                options={[
                  { value: '', label: $t('identities.optional') },
                  { value: 'male', label: $t('identities.genderMale') },
                  { value: 'female', label: $t('identities.genderFemale') },
                  { value: 'other', label: $t('identities.genderOther') },
                  { value: 'prefer_not', label: $t('identities.genderPreferNot') },
                ]}
              />
            </div>
            <div>
              <label class="text-xs text-md-on-surface/50 mb-1 block" for="create-dob">{$t('identities.dateOfBirth')} ({$t('identities.optional')})</label>
              <p class="text-xs text-md-on-surface/40 mb-1">{$t('identities.dobAdultHint')}</p>
              <div class="flex gap-1 mb-1.5">
                <button
                  type="button"
                  class="flex-1 px-2 py-1 text-xs font-semibold rounded-lg {dobHelperMode === 'date' ? 'bg-md-primary/15 text-md-primary' : 'bg-md-surface-variant text-md-on-surface/60'}"
                  onclick={() => (dobHelperMode = 'date')}
                >{$t('identities.dobPickDate')}</button>
                <button
                  type="button"
                  class="flex-1 px-2 py-1 text-xs font-semibold rounded-lg {dobHelperMode === 'range' ? 'bg-md-primary/15 text-md-primary' : 'bg-md-surface-variant text-md-on-surface/60'}"
                  onclick={() => (dobHelperMode = 'range')}
                >{$t('identities.dobFromRange')}</button>
              </div>
              {#if dobHelperMode === 'date'}
                <InputField
                  id="create-dob"
                  type="date"
                  bind:value={newIdentityDob}
                />
                <button
                  type="button"
                  class="mt-1 text-xs font-semibold text-md-primary hover:underline"
                  onclick={applyRandomAdultDob}
                >{$t('identities.dobRandomAdult')}</button>
              {:else}
                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label class="text-xs text-md-on-surface/45" for="dob-from-y">{$t('identities.dobFromYear')}</label>
                    <InputField
                      id="dob-from-y"
                      type="number"
                      size="xs"
                      min={1920}
                      max={new Date().getFullYear() - 18}
                      bind:value={dobRangeFromYear}
                    />
                  </div>
                  <div>
                    <label class="text-xs text-md-on-surface/45" for="dob-to-y">{$t('identities.dobToYear')}</label>
                    <InputField
                      id="dob-to-y"
                      type="number"
                      size="xs"
                      min={1920}
                      max={new Date().getFullYear() - 18}
                      bind:value={dobRangeToYear}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  class="mt-1.5 w-full py-1.5 text-label-sm font-semibold rounded-lg bg-md-primary/15 text-md-primary hover:bg-md-primary/25"
                  onclick={applyDobFromRange}
                >{$t('identities.dobGenerateFromRange')}</button>
                {#if newIdentityDob}
                  <p class="text-xs text-md-on-surface/50 mt-1">{$t('identities.dobResult')}: {newIdentityDob}</p>
                {/if}
              {/if}
            </div>
            <div>
              <label class="text-xs text-md-on-surface/50 mb-1 block" for="create-country">{$t('identities.country')} ({$t('identities.optional')})</label>
              <Dropdown
                id="create-country"
                variant="outlined"
                zIndex={PORTAL_Z.dialogMenu}
                ariaLabel={$t('identities.country')}
                bind:value={newIdentityCountry}
                onchange={() => {
                  if (newIdentityCountry) {
                    newIdentityCity = randomCity(newIdentityCountry);
                    newIdentityPin = randomPostalCode(newIdentityCountry);
                  }
                }}
                options={[
                  { value: '', label: $t('identities.optional') },
                  ...COUNTRY_OPTIONS.map((c) => ({ value: c.code, label: c.name })),
                ]}
              />
            </div>
            <div>
              <label class="text-xs text-md-on-surface/50 mb-1 block" for="create-city">{$t('identities.city')} ({$t('identities.optional')})</label>
              <InputField id="create-city" bind:value={newIdentityCity} />
            </div>
            <div>
              <label class="text-xs text-md-on-surface/50 mb-1 block" for="create-state">{$t('identities.state')} ({$t('identities.optional')})</label>
              <InputField
                id="create-state"
                placeholder={$t('identities.optional')}
                bind:value={newIdentityState}
              />
            </div>
            <div>
              <label class="text-xs text-md-on-surface/50 mb-1 block" for="create-address">{$t('identities.address')} ({$t('identities.optional')})</label>
              <InputField
                id="create-address"
                placeholder={$t('identities.optional')}
                bind:value={newIdentityAddress}
              />
            </div>
            <div>
              <label class="text-xs text-md-on-surface/50 mb-1 block" for="create-avatar">{$t('identities.profilePicture')} ({$t('identities.optional')})</label>
              <p class="text-xs text-md-on-surface/40 mb-1">{$t('identities.profilePictureHint')}</p>
              <div class="flex items-center gap-3">
                {#if newIdentityProfilePicture}
                  <img src={newIdentityProfilePicture} alt="" class="w-12 h-12 rounded-full object-cover border border-md-outline-variant" />
                {/if}
                <input id="create-avatar" type="file" accept="image/*" class="text-xs max-w-full" onchange={onProfilePictureSelected} />
                {#if newIdentityProfilePicture}
                  <button type="button" class="text-xs text-md-error hover:underline" onclick={clearProfilePicture}>{$t('identities.clearProfilePicture')}</button>
                {/if}
              </div>
            </div>
            <div>
              <label for="create-ua-select" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.userAgentAnonymity')}</label>
              <div class="flex gap-2 mb-2">
                <Dropdown
                  id="create-ua-select"
                  class="flex-1"
                  variant="outlined"
                  zIndex={PORTAL_Z.dialogMenu}
                  ariaLabel={$t('identities.userAgentAnonymity')}
                  bind:value={userAgentPresetMode}
                  onchange={onUAPresetChange}
                  options={[
                    { value: 'default', label: $t('identities.defaultBrowser') },
                    { value: 'chrome_windows', label: 'Chrome (Windows)' },
                    { value: 'chrome_mac', label: 'Chrome (macOS)' },
                    { value: 'chrome_linux', label: 'Chrome (Linux)' },
                    { value: 'chrome_android', label: 'Chrome (Android)' },
                    { value: 'custom', label: $t('identities.uaPresetCustom') },
                  ]}
                />
                <button type="button" class="px-3 py-2 rounded-lg border border-md-outline text-xs text-md-primary hover:bg-md-primary/10 font-semibold" onclick={generateRandomUA}>
                  {$t('identities.generateRandomUa')}
                </button>
              </div>
              {#if userAgentPresetMode === 'custom' || newIdentityUserAgent}
                <textarea
                  id="create-ua-input"
                  class="w-full px-3 py-2 rounded-lg border border-md-outline-variant text-sm bg-md-secondary-container outline-none focus:border-md-primary focus:ring-1 focus:ring-md-primary"
                  rows="2"
                  placeholder="Mozilla/5.0 ..."
                  bind:value={newIdentityUserAgent}
                  oninput={onCustomUAInput}
                ></textarea>
              {/if}
            </div>
          </div>

          <!-- Phone Number -->
          <div>
            <label for="create-phone" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.phoneNumber')} ({$t('identities.optional')})</label>
            <InputField
              id="create-phone"
              type="tel"
              placeholder={$t('identities.optional')}
              bind:value={newIdentityPhone}
            />
          </div>

          <!-- PIN Code -->
          <div>
            <label for="create-pin" class="text-xs text-md-on-surface/50 mb-1 block">{$t('identities.pinCode')} ({$t('identities.optional')})</label>
            <InputField
              id="create-pin"
              placeholder={$t('identities.optional')}
              bind:value={newIdentityPin}
            />
          </div>

          <label class="flex items-start gap-2.5 cursor-pointer rounded-xl border border-md-outline-variant/40 bg-md-surface-container-low px-3 py-2.5">
            <Checkbox class="mt-0.5" bind:checked={newIdentitySetAsDefault} />
            <span class="min-w-0">
              <span class="text-sm font-semibold text-md-on-surface block">{$t('identities.setAsDefault')}</span>
              <span class="text-xs text-md-on-surface/55">{$t('identities.setAsDefaultHint')}</span>
            </span>
          </label>

          {#if validationError}
            <p class="text-xs text-md-error">{validationError}</p>
          {/if}
        </div>
        </div>
        <!-- Sticky save pinned at bottom of popup -->
        <div class="shrink-0 px-5 py-3 border-t border-md-outline-variant/30 bg-md-surface">
          <button type="button" class="w-full px-4 py-2.5 text-sm font-semibold rounded-xl bg-md-primary text-md-on-primary hover:bg-md-primary/90 transition-colors" onclick={createNewIdentity}>
            {$t('identities.save')}
          </button>
        </div>
      </div>
      </div>
    </div>
  {/if}
</div>
