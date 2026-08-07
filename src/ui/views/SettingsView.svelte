<script lang="ts">
import { onMount } from 'svelte';
import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import {
  acceptBlockSuggestion,
  dismissBlockSuggestion,
  getBlockSuggestions,
} from '@/features/intelligence/blocklist-learn.js';
import {
  DEFAULT_SMART_AUTOFILL,
  loadSmartAutofillSettings,
  type SmartAutofillSettings,
  saveSmartAutofillSettings,
} from '@/features/intelligence/smart-settings.js';
import {
  loadNotificationIntelligence,
  saveNotificationIntelligence,
} from '@/features/intelligence/storage.js';
import { getLastBackupExportAt } from '@/features/settings/backup-actions.js';
import ConfirmDialog from '@/ui/blocks/dialogs/ConfirmDialog.svelte';
import MasterPasswordModal from '@/ui/blocks/dialogs/MasterPasswordModal.svelte';
import ToastContainer from '@/ui/blocks/feedback/ToastContainer.svelte';
import ErrorBoundary from '@/ui/blocks/layout/ErrorBoundary.svelte';
import ColorPicker from '@/ui/components/composites/ColorPicker.svelte';
import LanguageSwitcher from '@/ui/components/composites/LanguageSwitcher.svelte';
import ScrollSpy from '@/ui/components/composites/ScrollSpy.svelte';
import SearchBar from '@/ui/components/composites/SearchBar.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Btn, Dropdown, Toggle } from '@/ui/components/primitives';
import Skeleton from '@/ui/components/primitives/Skeleton.svelte';
import { loadClipboardPrivacy, saveClipboardPrivacy } from '@/utils/clipboard-settings.js';
import { setupFocusTrap } from '@/utils/focusTrap.js';
import { logError } from '@/utils/logger.js';
import { setMarqueeSelectionEnabled } from '@/utils/marquee-selection.js';
import {
  getNotificationPermissionStatus,
  openNotificationSettingsPage,
} from '@/utils/notification-permission.js';
import {
  getSearchHistory,
  getSearchHistoryLimit,
  pushSearchHistory,
  removeSearchHistoryItem,
  setSearchHistoryLimit,
} from '@/utils/search-history.js';
import { formatBytes, getStorageUsage } from '@/utils/storageMonitor.js';
import { toastStore } from '@/utils/toastStore.js';
import type { Account, Identity, Keybindings, ProviderInstance } from '@/utils/types.js';
import { DEFAULT_KEYBINDINGS } from '@/utils/types.js';
import {
  disableVaultLock,
  getVaultConfig,
  isBiometricSupported,
  setupBiometricVault,
  setupMasterPassword,
  type VaultSecurityMode,
} from '@/utils/vault-lock.js';
import AddressesView from './addresses/AddressesView.svelte';
import IdentitiesView from './autofill/IdentitiesView.svelte';
import ConstantsSettingsView from './settings/ConstantsSettingsView.svelte';
import HtmlRenderingSettingsView from './settings/HtmlRenderingSettingsView.svelte';
import KeyboardShortcutsView from './settings/KeyboardShortcutsView.svelte';
import MailProviderView from './settings/MailProviderView.svelte';
import NavbarOrderSettingsView from './settings/NavbarOrderSettingsView.svelte';
import StoragePerformanceView from './settings/StoragePerformanceView.svelte';
import ToolbarSettingsView from './settings/ToolbarSettingsView.svelte';

let vaultMode = $state<VaultSecurityMode>('standard');
let biometricSupported = $state(false);
let isPasswordModalOpen = $state(false);
let smartSettings = $state<SmartAutofillSettings>({ ...DEFAULT_SMART_AUTOFILL });
let blockSuggestions = $state<string[]>([]);
let activeSettingsSubpage = $state<string | null>(null);

$effect(() => {
  if (initialSubpage) {
    activeSettingsSubpage = initialSubpage;
  }
});

async function updateSmartSetting(partial: Partial<SmartAutofillSettings>) {
  smartSettings = await saveSmartAutofillSettings(partial);
}

let processingDomain = $state('');

async function acceptBlockSug(domain: string) {
  processingDomain = domain;
  try {
    await acceptBlockSuggestion(domain);
    blockSuggestions = await getBlockSuggestions();
    toastStore.success(
      get(t)('settings.blockSuggestionsAccepted', { values: { domain } }) as string
    );
  } finally {
    processingDomain = '';
  }
}

async function dismissBlockSug(domain: string) {
  processingDomain = domain;
  try {
    await dismissBlockSuggestion(domain);
    blockSuggestions = await getBlockSuggestions();
  } finally {
    processingDomain = '';
  }
}
let lastBackupAt = $state<number | null>(null);
let autofillLoginPreference = $state<'recent' | 'listOrder'>('recent');
let demoMode = $state(false);
let voiceSearchEnabled = $state(true);
/** After address expires (and not auto-renewed): archive (default) or permanent delete */
let expiryAction = $state<'archive' | 'delete'>('archive');
let densityLocal = $state<'comfortable' | 'compact'>('comfortable');
let otpDetectionMode = $state<'numeric' | 'alphanumeric' | 'balanced'>('balanced');
let gesturesEnabled = $state(true);
let marqueeSelectionEnabled = $state(true);
/** Master switch for content-script autofill (default ON) */
let autofillFeatureEnabled = $state(true);
/** Show “/” operators button on search bars (default ON); /commands always work */
let showSearchSlashIcon = $state(true);
/** Show images in email body (default ON) */
let showImages = $state(true);
/** Always-visible Select toolbar row (default ON) */
let selectionToolbarEnabled = $state(true);
/** Notification intelligence (quiet hours, OTP-only, digest) */
let notifIntel = $state({
  otpAndMagicOnly: false,
  quietHoursEnabled: false,
  quietHoursStart: 22,
  quietHoursEnd: 8,
  mutedSenderDomains: [] as string[],
  groupDigest: true,
});
let mutedDomainsText = $state('');

/** Clipboard privacy (auto-purge after copy) */
let clipboardPrivacy = $state({
  autoPurgeEnabled: true,
  purgeAfterSeconds: 30,
});

/** Master switch for in-app toast notifications (default ON). */
let toastsEnabled = $state(true);

/** Scrollspy section tabs (mirrors Activity view navigation) */
type SettingsSpySection =
  | 'general'
  | 'identity'
  | 'mail'
  | 'notifications'
  | 'autofill'
  | 'inputNav'
  | 'appearance'
  | 'developer'
  | 'search'
  | 'diagnostics'
  | 'data';

const SETTINGS_SPY_SECTIONS: { id: SettingsSpySection; labelKey: string; icon: string }[] = [
  { id: 'general', labelKey: 'preferences.sectionGeneral', icon: 'settings' },
  { id: 'appearance', labelKey: 'preferences.sectionAppearance', icon: 'sun' },
  { id: 'mail', labelKey: 'preferences.sectionMail', icon: 'mail' },
  { id: 'notifications', labelKey: 'preferences.sectionNotifications', icon: 'bell' },
  { id: 'autofill', labelKey: 'preferences.sectionAutofill', icon: 'lock' },
  { id: 'inputNav', labelKey: 'preferences.inputAndNavigation', icon: 'grip' },
  { id: 'search', labelKey: 'preferences.sectionSearch', icon: 'search' },
  { id: 'developer', labelKey: 'preferences.sectionDeveloper', icon: 'monitor' },
  { id: 'diagnostics', labelKey: 'preferences.sectionDiagnostics', icon: 'barChart' },
  { id: 'data', labelKey: 'preferences.sectionData', icon: 'database' },
];

let settingsSpyActive = $state<string>('general');

function formatBackupDate(ts: number): string {
  try {
    const ms = ts < 1e11 ? ts * 1000 : ts;
    return new Date(ms).toLocaleString(undefined, {
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

onMount(() => {
  (async () => {
    const config = await getVaultConfig();
    vaultMode = config.mode;
    biometricSupported = await isBiometricSupported();
    lastBackupAt = await getLastBackupExportAt(browser);
    const stored = (await browser.storage.local.get([
      'autofillLoginPreference',
      'demoMode',
      'otpDetectionMode',
      'gesturesEnabled',
      'marqueeSelectionEnabled',
      'voiceSearchEnabled',
      'uiDensity',
      'expiryAction',
      'autofillFeatureEnabled',
      'showSearchSlashIcon',
      'selectionToolbarEnabled',
      'showImages',
      'toastsEnabled',
    ])) as {
      autofillLoginPreference?: 'recent' | 'listOrder';
      demoMode?: boolean;
      otpDetectionMode?: 'numeric' | 'alphanumeric' | 'balanced';
      gesturesEnabled?: boolean;
      marqueeSelectionEnabled?: boolean;
      voiceSearchEnabled?: boolean;
      uiDensity?: 'comfortable' | 'compact';
      expiryAction?: 'archive' | 'delete';
      autofillFeatureEnabled?: boolean;
      showSearchSlashIcon?: boolean;
      selectionToolbarEnabled?: boolean;
      showImages?: boolean;
      toastsEnabled?: boolean;
    };
    if (
      stored.autofillLoginPreference === 'listOrder' ||
      stored.autofillLoginPreference === 'recent'
    )
      autofillLoginPreference = stored.autofillLoginPreference;
    demoMode = !!stored.demoMode;
    if (stored.gesturesEnabled === false) gesturesEnabled = false;
    if (stored.marqueeSelectionEnabled === false) marqueeSelectionEnabled = false;
    autofillFeatureEnabled = stored.autofillFeatureEnabled !== false;
    showSearchSlashIcon = stored.showSearchSlashIcon !== false;
    selectionToolbarEnabled = stored.selectionToolbarEnabled !== false;
    showImages = stored.showImages !== false;
    toastsEnabled = stored.toastsEnabled !== false;
    toastStore.setEnabled(toastsEnabled);
    voiceSearchEnabled = stored.voiceSearchEnabled !== false;
    if (stored.expiryAction === 'delete' || stored.expiryAction === 'archive') {
      expiryAction = stored.expiryAction;
    }
    if (stored.uiDensity === 'compact' || stored.uiDensity === 'comfortable') {
      densityLocal = stored.uiDensity;
    }
    if (
      stored.otpDetectionMode === 'numeric' ||
      stored.otpDetectionMode === 'alphanumeric' ||
      stored.otpDetectionMode === 'balanced'
    ) {
      otpDetectionMode = stored.otpDetectionMode;
    }
    try {
      const ni = await loadNotificationIntelligence();
      notifIntel = { ...ni };
      mutedDomainsText = (ni.mutedSenderDomains || []).join(', ');
    } catch {
      /* optional */
    }
    try {
      clipboardPrivacy = await loadClipboardPrivacy();
    } catch {
      /* optional */
    }
    try {
      smartSettings = await loadSmartAutofillSettings();
      blockSuggestions = await getBlockSuggestions();
    } catch {
      /* optional */
    }
  })().catch((err) => {
    logError('Failed to initialize extension settings in onMount', undefined, err);
  });

  void loadStorageSnapshot();

  const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && changes.lastBackupExportAt) {
      const v = changes.lastBackupExportAt.newValue;
      lastBackupAt = typeof v === 'number' ? v : null;
    }
    if (area === 'local' && changes.autofillLoginPreference) {
      const v = changes.autofillLoginPreference.newValue;
      if (v === 'listOrder' || v === 'recent') autofillLoginPreference = v;
    }
    if (area === 'local' && changes.demoMode) {
      demoMode = !!changes.demoMode.newValue;
    }
    if (area === 'local' && changes.voiceSearchEnabled) {
      voiceSearchEnabled = changes.voiceSearchEnabled.newValue !== false;
    }
    if (area === 'local' && changes.otpDetectionMode) {
      const v = changes.otpDetectionMode.newValue;
      if (v === 'numeric' || v === 'alphanumeric' || v === 'balanced') otpDetectionMode = v;
    }
    if (area === 'local' && changes.toastsEnabled) {
      const next = changes.toastsEnabled.newValue !== false;
      toastsEnabled = next;
      toastStore.setEnabled(next);
    }
    // Keep the Data-section storage snapshot fresh when mail arrives/cleans up.
    if (area === 'local' && (changes.storedEmails || changes.archivedEmails)) {
      void loadStorageSnapshot();
    }
  };
  browser.storage.onChanged.addListener(onStorage);
  return () => browser.storage.onChanged.removeListener(onStorage);
});

async function persistNotifIntel() {
  try {
    const muted = mutedDomainsText
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    notifIntel = { ...notifIntel, mutedSenderDomains: muted };
    await saveNotificationIntelligence(notifIntel);
  } catch (e) {
    logError(
      'Failed to save notification intelligence',
      undefined,
      e instanceof Error ? e : new Error(String(e))
    );
  }
}

async function persistClipboardPrivacy() {
  try {
    await saveClipboardPrivacy(clipboardPrivacy);
  } catch (e) {
    logError(
      'Failed to save clipboard privacy',
      undefined,
      e instanceof Error ? e : new Error(String(e))
    );
  }
}

async function handleSetVaultMode(targetMode: VaultSecurityMode) {
  if (targetMode === 'standard') {
    const ok = await disableVaultLock();
    if (ok) {
      vaultMode = 'standard';
      toastStore.success($t('preferences.vaultSetStandard'));
    }
  } else if (targetMode === 'password') {
    isPasswordModalOpen = true;
  } else if (targetMode === 'biometrics') {
    const ok = await setupBiometricVault();
    if (ok) {
      vaultMode = 'biometrics';
      toastStore.success($t('preferences.biometricVaultEnabled'));
    } else {
      toastStore.error($t('preferences.biometricSetupFailed'));
    }
  }
}

async function handleSaveMasterPassword(password: string) {
  const ok = await setupMasterPassword(password);
  if (ok) {
    vaultMode = 'password';
    toastStore.success($t('preferences.masterPasswordVaultEnabled'));
  } else {
    toastStore.error($t('preferences.masterPasswordFailed'));
  }
}

let {
  context = 'popup',
  onBack = () => {},

  autoCopy = false,
  autoRenew = true,
  selectedProvider = '',
  savingSettings = false,
  loading = false,
  onSaveSettings = () => {},

  onSetAutoCopy = undefined,
  onSetAutoRenew = undefined,
  onHardReset = () => {},
  providerInstances = [],
  selectedProviderInstance = null,
  onSetProviderInstance = () => {},
  onExportData = () => {},
  onExportCategory = undefined,
  onImportData = () => {},
  onStartProductTour = () => {},
  onProviderChange = () => {},
  onAddCustomInstance = () => {},
  onLoadProviderInstances = () => {},
  customColor = '',
  onColorChange = () => {},
  inboxColorThemeEnabled = false,
  onToggleInboxColorTheme = () => {},
  showDeveloperSettings = false,
  enableLogging = false,
  onToggleDeveloperSettings = () => {},
  onOpenPlayground = () => {},
  onToggleEnableLogging = () => {},
  onNavigateToConstantsSettings = () => {},
  contrastLevel = 'standard',
  onContrastLevelChange = () => {},
  emailRetentionDays = 30,
  onSetEmailRetentionDays = undefined,
  faviconCaching = 'direct',
  onSetFaviconCaching = undefined,
  identities = [],
  selectedIdentityId = null,
  onSetSelectedIdentityId = undefined,
  onNavigateToIdentities = () => {},
  notificationsEnabled = false,
  soundEnabled = false,
  expiryWarningThreshold = 60 * 60 * 1000, // Default 1 hour
  onSetNotificationsEnabled = undefined,
  onSetSoundEnabled = undefined,
  onSetExpiryWarningThreshold = undefined,
  keybindings = DEFAULT_KEYBINDINGS,
  onSetKeybindings = undefined,
  onNavigateToKeybindings = () => {},
  onNavigateToTagManagement = () => {},
  onNavigateToFiltersManagement = () => {},
  onNavigateToMailProvider = () => {},
  onNavigateToStoragePerformance = () => {},
  onNavigateToLabelManagement = () => {},
  onNavigateToAddresses = () => {},
  onNavigateToDiagnostics = () => {},
  autoRefreshInterval = 30000,
  onSetAutoRefreshInterval = undefined,
  emailPreviewEnabled = true,
  onSetEmailPreviewEnabled = undefined,
  defaultDomain = '',
  onSetDefaultDomain = undefined,
  allInboxes = [] as Account[],
  autofillBlocklist = [] as string[],
  onRemoveFromBlocklist = undefined,
  onAddToBlocklist = undefined,
  initialSubpage = null as string | null,
  onSubpageBack = undefined as (() => void) | undefined,
}: {
  context?: 'popup' | 'sidepanel' | 'app';
  onBack?: () => void;

  autoCopy?: boolean;
  autoRenew?: boolean;
  selectedProvider?: string;
  savingSettings?: boolean;
  loading?: boolean;
  onSaveSettings?: () => void;

  onSetAutoCopy?: (value: boolean) => void;
  onSetAutoRenew?: (value: boolean) => void;
  onHardReset?: () => void;
  providerInstances?: ProviderInstance[];
  selectedProviderInstance?: string | null;
  onSetProviderInstance?: (instanceId: string) => void;
  onExportData?: () => void;
  onExportCategory?: (
    category: 'settings' | 'identities' | 'savedLogins' | 'inboxes' | 'all'
  ) => void;
  onImportData?: () => void;
  onStartProductTour?: () => void;
  onProviderChange?: (provider: string) => void;
  onAddCustomInstance?: (name: string, url: string) => void;
  onLoadProviderInstances?: () => void | Promise<void>;
  customColor?: string;
  onColorChange?: (color: string) => void;
  inboxColorThemeEnabled?: boolean;
  onToggleInboxColorTheme?: () => void;
  showDeveloperSettings?: boolean;
  enableLogging?: boolean;
  onToggleDeveloperSettings?: () => void;
  onToggleEnableLogging?: () => void;
  onNavigateToConstantsSettings?: () => void;
  onOpenPlayground?: () => void;
  contrastLevel?: 'standard' | 'medium' | 'high';
  onContrastLevelChange?: (level: 'standard' | 'medium' | 'high') => void;
  emailRetentionDays?: number;
  onSetEmailRetentionDays?: (value: number) => void;
  faviconCaching?: 'direct' | 'local';
  onSetFaviconCaching?: (value: 'direct' | 'local') => void;
  identities?: Identity[];
  selectedIdentityId?: string | null;
  onSetSelectedIdentityId?: (id: string | null) => void;
  onNavigateToIdentities?: () => void;
  notificationsEnabled?: boolean;
  soundEnabled?: boolean;
  expiryWarningThreshold?: number;
  onSetNotificationsEnabled?: (value: boolean) => void;
  onSetSoundEnabled?: (value: boolean) => void;
  onSetExpiryWarningThreshold?: (value: number) => void;
  keybindings?: Keybindings;
  onSetKeybindings?: (value: Keybindings) => void;
  onNavigateToKeybindings?: () => void;
  onNavigateToTagManagement?: () => void;
  onNavigateToFiltersManagement?: () => void;
  onNavigateToMailProvider?: () => void;
  onNavigateToStoragePerformance?: () => void;
  onNavigateToLabelManagement?: () => void;
  onNavigateToAddresses?: () => void;
  onNavigateToDiagnostics?: () => void;
  autoRefreshInterval?: number;
  onSetAutoRefreshInterval?: (value: number) => void;
  emailPreviewEnabled?: boolean;
  onSetEmailPreviewEnabled?: (value: boolean) => void;
  defaultDomain?: string;
  onSetDefaultDomain?: (value: string) => void;
  allInboxes?: Account[];
  initialSubpage?: string | null;
  onSubpageBack?: () => void;
  autofillBlocklist?: string[];
  onRemoveFromBlocklist?: (domain: string) => void;
  onAddToBlocklist?: (domain: string) => void | Promise<void>;
} = $props();

// Storage snapshot for the Data section summary (counts stay live via $derived).
let storageBytes = $state(0);
let storedEmailCount = $state(0);
let storageSnapshot = $derived({
  inboxes: allInboxes.length,
  emails: storedEmailCount,
  identities: identities.length,
  bytes: storageBytes,
});

async function loadStorageSnapshot() {
  try {
    const res = (await browser.storage.local.get(['storedEmails', 'archivedEmails'])) as {
      storedEmails?: Record<string, { id: string }[]>;
      archivedEmails?: Record<string, { id: string }[]>;
    };
    let emailCount = 0;
    for (const list of Object.values(res.storedEmails || {})) emailCount += list.length;
    for (const list of Object.values(res.archivedEmails || {})) emailCount += list.length;
    storedEmailCount = emailCount;
    storageBytes = await getStorageUsage();
  } catch {
    /* ignore */
  }
}

/** Send a real OS notification so users can verify sound + permission instantly. */
let testNotifyBusy = $state(false);
let testNotifyResult = $state('');
/** True when the browser blocked notifications — result renders as a clickable warning. */
let notificationsBlocked = $state(false);

async function sendTestNotification() {
  testNotifyBusy = true;
  testNotifyResult = '';
  notificationsBlocked = false;
  try {
    // Check the browser/OS permission level first — when the user blocked
    // notifications for this extension, creating one would silently no-op.
    const permission = await getNotificationPermissionStatus();
    if (permission === 'denied') {
      notificationsBlocked = true;
      testNotifyResult = $t('diagnostics.testNotificationBlocked');
      return;
    }
    const id = `settings_test_notif_${Date.now()}`;
    const runtime = browser.runtime as { getURL?: (path: string) => string };
    await browser.notifications.create(id, {
      type: 'basic',
      iconUrl:
        typeof runtime.getURL === 'function'
          ? runtime.getURL('/icons/icon128.png')
          : 'icons/icon128.png',
      title: $t('diagnostics.testNotificationTitle'),
      message: $t('diagnostics.testNotificationBody'),
      // Mirror real behavior: mute the OS chime when sound is disabled.
      silent: !soundEnabled,
    });
    testNotifyResult = $t('diagnostics.testNotificationOk');
    setTimeout(() => {
      void browser.notifications.clear(id).catch(() => {});
    }, 8000);
  } catch (e) {
    testNotifyResult = e instanceof Error ? e.message : $t('diagnostics.testNotificationFail');
  } finally {
    testNotifyBusy = false;
  }
}

async function handleOpenNotificationSettings() {
  const opened = await openNotificationSettingsPage();
  if (!opened) {
    // Browser blocked the chrome:// / about: navigation — give manual steps.
    testNotifyResult = $t('diagnostics.testNotificationSettingsManual');
  }
}

let confirmDialog = $state<{ message: string; onConfirm: () => void } | null>(null);
let confirmDialogRef = $state<HTMLElement | null>(null);

export interface SearchResultItem {
  id: string;
  section: string;
  title: string;
  desc: string;
  element: HTMLElement;
  /** Inline control affordance for the result row (toggle state or select). */
  control?: { kind: 'toggle'; checked: boolean } | null;
}

let settingsSearchQuery = $state('');
let selectedSearchIndex = $state(-1);
let settingsContainer = $state<HTMLElement | null>(null);
let newBlocklistDomain = $state('');
/** Hostname of the active browser tab (when available) for blocklist quick-add */
let currentTabDomain = $state('');
let searchHistoryLimit = $state(5);
let settingsRecentSearches = $state<string[]>([]);
let settingsSearchFocused = $state(false);

async function loadSearchHistorySettings() {
  searchHistoryLimit = await getSearchHistoryLimit();
  settingsRecentSearches = await getSearchHistory('settings');
}

$effect(() => {
  void loadSearchHistorySettings();
});

async function loadCurrentTabDomain() {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      currentTabDomain = '';
      return;
    }
    currentTabDomain = new URL(url).hostname.toLowerCase();
  } catch {
    /* ignore */
    currentTabDomain = '';
  }
}

$effect(() => {
  void loadCurrentTabDomain();
});

// Reset highlight index when query updates
$effect(() => {
  void settingsSearchQuery;
  selectedSearchIndex = -1;
});

const filteredSettings = $derived.by(() => {
  if (!settingsSearchQuery.trim() || !settingsContainer) return [];
  if (typeof document === 'undefined') return [];

  const query = settingsSearchQuery.trim().toLowerCase();
  const results: SearchResultItem[] = [];
  const processedElements = new Set<HTMLElement>();
  let autoIdCounter = 0;

  // Query all sections in settings view
  const sections = settingsContainer.querySelectorAll('section');

  for (const section of sections) {
    // Find the category header (first child element containing text)
    let categoryName = 'Settings';
    const firstTextChild = section.querySelector('span, h1, h2, h3, div');
    if (firstTextChild) {
      categoryName = firstTextChild.textContent?.trim() || 'Settings';
    }

    // All other children of the section are individual settings items
    const children = Array.from(section.children);

    // Skip the first child (which is the header container)
    for (let i = 1; i < children.length; i++) {
      const el = children[i] as HTMLElement;
      if (processedElements.has(el)) continue;

      // Extract title and description dynamically using leaf text nodes
      const leafTexts: string[] = [];
      function walk(node: Node) {
        // Skip hidden elements, search inputs, and dropdown selectors
        if (node instanceof Element) {
          const tagName = node.tagName.toLowerCase();
          if (
            tagName === 'select' ||
            tagName === 'option' ||
            node.classList.contains('sr-only') ||
            node.classList.contains('fixed') ||
            node.getAttribute('type') === 'checkbox'
          ) {
            return;
          }
        }
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent?.trim();
          if (text) {
            leafTexts.push(text);
          }
        } else {
          for (const child of node.childNodes) {
            walk(child);
          }
        }
      }

      walk(el);

      const titleText = leafTexts[0] || '';
      const descText = leafTexts.slice(1).join(' ') || '';

      if (!titleText || titleText.length < 2) continue;

      const aliasText = el.getAttribute('data-search-alias')?.toLowerCase() || '';
      const searchableText = `${categoryName} ${titleText} ${descText} ${aliasText}`.toLowerCase();
      if (searchableText.includes(query)) {
        if (!el.id) {
          autoIdCounter++;
          el.id = `dynamic-setting-item-${autoIdCounter}`;
        }

        results.push({
          id: el.id,
          section: categoryName,
          title: titleText,
          desc: descText,
          element: el,
          control: detectSettingControl(el),
        });
        processedElements.add(el);
      }
    }
  }

  // Deduplicate results
  const uniqueResults: SearchResultItem[] = [];
  const seenKeys = new Set<string>();
  for (const item of results) {
    const key = `${item.section}:::${item.title}`.toLowerCase();
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueResults.push(item);
    }
  }

  return uniqueResults;
});

/** Detect a quick-action control inside a setting card for the search dropdown. */
function detectSettingControl(el: HTMLElement): SearchResultItem['control'] {
  // Svelte <Toggle> renders as <button role="switch"> — expose its on/off state.
  const toggle = el.querySelector('button[role="switch"]');
  if (toggle) {
    const checked =
      toggle.getAttribute('aria-checked') === 'true' || toggle.hasAttribute('data-checked');
    return { kind: 'toggle', checked };
  }
  return null;
}

function handleSearchKeydown(event: KeyboardEvent) {
  if (filteredSettings.length === 0) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectedSearchIndex = (selectedSearchIndex + 1) % filteredSettings.length;
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectedSearchIndex =
      (selectedSearchIndex - 1 + filteredSettings.length) % filteredSettings.length;
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (selectedSearchIndex >= 0 && selectedSearchIndex < filteredSettings.length) {
      handleNavigateToElement(filteredSettings[selectedSearchIndex]);
    } else if (filteredSettings.length > 0) {
      handleNavigateToElement(filteredSettings[0]);
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    settingsSearchQuery = '';
  }
}

function handleNavigateToElement(item: SearchResultItem) {
  settingsSearchQuery = '';

  const subpageWrapper = item.element.closest('[data-settings-subpage]');
  if (subpageWrapper) {
    const subpage = subpageWrapper.getAttribute('data-settings-subpage');

    // Switch routing view
    if (subpage === 'keybindings' && onNavigateToKeybindings) {
      onNavigateToKeybindings();
    } else if (
      (subpage === 'tagManagement' ||
        subpage === 'filtersManagement' ||
        subpage === 'labelManagement' ||
        subpage === 'organize') &&
      (onNavigateToTagManagement || onNavigateToFiltersManagement || onNavigateToLabelManagement)
    ) {
      // All organize sections live on the unified Organize page
      if (subpage === 'filtersManagement' && onNavigateToFiltersManagement) {
        onNavigateToFiltersManagement();
      } else if (subpage === 'labelManagement' && onNavigateToLabelManagement) {
        onNavigateToLabelManagement();
      } else if (onNavigateToTagManagement) {
        onNavigateToTagManagement();
      }
    } else if (subpage === 'mailProvider' && onNavigateToMailProvider) {
      onNavigateToMailProvider();
    } else if (subpage === 'storagePerformance' && onNavigateToStoragePerformance) {
      onNavigateToStoragePerformance();
    } else if (subpage === 'addresses' && onNavigateToAddresses) {
      onNavigateToAddresses();
    } else if (subpage === 'constantsSettings' && onNavigateToConstantsSettings) {
      onNavigateToConstantsSettings();
    } else if (subpage === 'identities' && onNavigateToIdentities) {
      onNavigateToIdentities();
    } else if (subpage === 'toolbarButtons') {
      activeSettingsSubpage = 'toolbarButtons';
    } else if (subpage === 'htmlRendering') {
      activeSettingsSubpage = 'htmlRendering';
    } else if (subpage === 'navbarOrder') {
      activeSettingsSubpage = 'navbarOrder';
    }

    // Wait for view transition and highlight specific leaf target
    setTimeout(() => {
      const activeContainer = document.querySelector('.flex-1.overflow-y-auto');
      if (activeContainer) {
        const allElements = Array.from(activeContainer.querySelectorAll('*'));
        const matches = allElements.filter((el) => el.textContent?.trim().includes(item.title));
        if (matches.length > 0) {
          matches.sort((a, b) => (a.textContent?.length || 0) - (b.textContent?.length || 0));
          const el = matches[0] as HTMLElement;
          const highlightTarget =
            el.closest(
              '.bg-md-primary-container, .bg-md-secondary-container, button, label, tr, li'
            ) || el;

          highlightTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
          highlightTarget.classList.add('animate-pulse-highlight', 'rounded-xl');

          const focusable = el.matches('button, input, select')
            ? el
            : (el.querySelector('button, input, select') as HTMLElement | null);
          focusable?.focus();

          setTimeout(() => {
            highlightTarget.classList.remove('animate-pulse-highlight', 'rounded-xl');
          }, 1800);
        }
      }
    }, 300);
  } else {
    // Normal scroll highlight in main container
    const element = item.element || document.getElementById(item.id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.classList.add('animate-pulse-highlight', 'rounded-xl');

      const focusable = element.matches('button, input, select')
        ? element
        : (element.querySelector('button, input, select') as HTMLElement | null);
      focusable?.focus();

      setTimeout(() => {
        element.classList.remove('animate-pulse-highlight', 'rounded-xl');
      }, 1800);
    }
  }
}

// Keybinding editing state
let editingKeybinding = $state<string | null>(null);
let recordingKeybinding = $state(false);
let recordedKeys = $state<string>('');

// Helper function to format keybinding for display
function formatKeybinding(binding: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): string {
  const tr = get(t);
  const parts: string[] = [];
  if (binding.ctrlKey || binding.metaKey) parts.push(tr('keyboardShortcuts.ctrlCmd'));
  if (binding.shiftKey) parts.push(tr('keyboardShortcuts.shift'));
  if (binding.altKey) parts.push(tr('keyboardShortcuts.alt'));
  parts.push(binding.key.toUpperCase());
  return parts.join(' + ');
}

// Start recording a new keybinding
function startRecording(action: string) {
  editingKeybinding = action;
  recordingKeybinding = true;
  recordedKeys = '';
}

// Handle keydown during recording
function handleRecordingKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelRecording();
    return;
  }

  if (event.key === 'Tab') {
    cancelRecording();
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const tr = get(t);
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push(tr('keyboardShortcuts.ctrlCmd'));
  if (event.shiftKey) parts.push(tr('keyboardShortcuts.shift'));
  if (event.altKey) parts.push(tr('keyboardShortcuts.alt'));
  parts.push(event.key.toUpperCase());

  recordedKeys = parts.join(' + ');

  // Save the new keybinding
  if (editingKeybinding && onSetKeybindings) {
    const newKeybindings = { ...keybindings };
    newKeybindings[editingKeybinding as keyof Keybindings] = {
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
    };
    onSetKeybindings(newKeybindings);
    onSaveSettings();
  }

  recordingKeybinding = false;
  editingKeybinding = null;
  recordedKeys = '';
}

// Cancel recording
function cancelRecording() {
  recordingKeybinding = false;
  editingKeybinding = null;
  recordedKeys = '';
}

// Reset keybinding to default
function resetKeybinding(action: string) {
  if (onSetKeybindings) {
    const newKeybindings = { ...keybindings };
    newKeybindings[action as keyof Keybindings] = DEFAULT_KEYBINDINGS[action as keyof Keybindings];
    onSetKeybindings(newKeybindings);
    onSaveSettings();
  }
}

// Count customized keybindings
let customKeybindingCount = $derived(
  (['refreshInbox', 'createInbox', 'copyEmail', 'copyOtp', 'closeDialogs'] as const).filter(
    (k) => formatKeybinding(keybindings[k]) !== formatKeybinding(DEFAULT_KEYBINDINGS[k])
  ).length
);

function showConfirmDialog(message: string, onConfirm: () => void) {
  confirmDialog = { message, onConfirm };
  if (confirmDialogRef) {
    confirmDialogRef.focus();
  }
}

function closeConfirmDialog() {
  confirmDialog = null;
}

// Identity select moved to the shared <Dropdown> primitive.
</script>

{#if loading}
  <div class="flex-1 overflow-y-auto px-2 py-2 space-y-3">
    {#each [1,2,3,4,5] as _}
      <div class="rounded-xl bg-md-surface-container-low p-4 space-y-2">
        <Skeleton width="6rem" height="0.75rem" />
        <Skeleton width="100%" height="2rem" />
      </div>
    {/each}
  </div>
{:else}
<ErrorBoundary fallback={$t('preferences.failedToLoadSettings')}>
  {#snippet children()}
    <div class="flex flex-col h-full min-h-0">
      {#if activeSettingsSubpage === 'toolbarButtons'}
        <ToolbarSettingsView
          onBack={() => {
            activeSettingsSubpage = null;
            if (onSubpageBack) onSubpageBack();
          }}
          showToast={(msg) => toastStore.info(msg)}
        />
      {:else if activeSettingsSubpage === 'htmlRendering'}
        <HtmlRenderingSettingsView
          onBack={() => {
            activeSettingsSubpage = null;
            if (onSubpageBack) onSubpageBack();
          }}
          showToast={(msg) => toastStore.info(msg)}
        />
      {:else if activeSettingsSubpage === 'navbarOrder'}
        <NavbarOrderSettingsView
          onBack={() => {
            activeSettingsSubpage = null;
            if (onSubpageBack) onSubpageBack();
          }}
          showToast={(msg) => toastStore.info(msg)}
        />
      {:else}
        <!-- Sticky header: title + search -->
  <div class="shrink-0 px-2 pt-2 pb-1.5 space-y-2 bg-md-surface/95 backdrop-blur-sm border-b border-md-outline-variant/15 z-30">

    <!-- Sticky Search Bar - shared SearchBar (voice + history) -->
    <div class="relative" data-tour="settings-search">
      <SearchBar
        scope="settings"
        bind:value={settingsSearchQuery}
        placeholder={$t('preferences.searchSettings') || 'Search settings...'}
        ariaLabel={$t('preferences.searchSettings') || 'Search settings...'}
        settingsStyle={true}
        showVoiceSearch={true}
        onChange={(v) => {
          settingsSearchQuery = v;
        }}
        onFocus={() => {
          settingsSearchFocused = true;
        }}
        onBlur={() => {
          setTimeout(() => {
            settingsSearchFocused = false;
          }, 150);
        }}
        onSubmit={(v) => {
          if (v.trim() && filteredSettings.length > 0) {
            void pushSearchHistory('settings', v.trim());
            handleNavigateToElement(filteredSettings[0]);
          }
        }}
      />

      {#if settingsSearchQuery.trim()}
        <div class="absolute z-40 inset-x-0 mt-1 max-h-64 overflow-y-auto bg-md-surface-container-high rounded-xl border border-md-outline-variant/40 shadow-lg p-1.5 space-y-1">
          {#each filteredSettings as item, idx}
            <div
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors cursor-pointer border-0 {selectedSearchIndex === idx ? 'bg-md-surface-variant' : 'hover:bg-md-surface-variant/50'}"
              role="button"
              tabindex="0"
              onclick={() => {
                void pushSearchHistory('settings', settingsSearchQuery.trim());
                handleNavigateToElement(item);
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  void pushSearchHistory('settings', settingsSearchQuery.trim());
                  handleNavigateToElement(item);
                }
              }}
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-semibold text-md-primary bg-md-primary/10 px-1.5 py-0.5 rounded">
                    {item.section}
                  </span>
                  <span class="text-xs font-medium text-md-on-surface truncate">{item.title}</span>
                </div>
                {#if item.desc && item.desc !== item.title}
                  <div class="text-xs text-md-on-surface/60 truncate ps-0.5 mt-0.5">{item.desc}</div>
                {/if}
              </div>
              {#if item.control?.kind === 'toggle'}
                <div class="shrink-0" role="presentation" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
                  <Toggle
                    checked={item.control.checked}
                    size="sm"
                    ariaLabel={item.title}
                    onChange={async (next) => {
                      // Drive the underlying setting card's own toggle by
                      // dispatching a click on its switch control.
                      const orig = item.element.querySelector('button[role="switch"]') as HTMLElement | null;
                      if (orig) {
                        try {
                          orig.click();
                        } catch {
                          /* ignore */
                        }
                      }
                    }}
                  />
                </div>
              {/if}
            </div>
          {/each}
          {#if filteredSettings.length === 0}
            <div class="text-label-sm text-md-on-surface/50 py-3 text-center">
              <div>{$t('preferences.noMatchingSettings') || 'No matching settings found'}</div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <ScrollSpy
    sections={SETTINGS_SPY_SECTIONS}
    bind:activeId={settingsSpyActive}
    scrollRoot={settingsContainer}
    sectionAttr="data-settings-section"
    sectionIdPrefix="settings-section-"
    ariaLabel={$t('preferences.navAria')}
  />

  <!-- Scrollable settings; section cards go multi-column when host is wide -->
  <div
    bind:this={settingsContainer}
    class="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-3 settings-scroll settings-wide-cols"
  >

  <!-- ── General ── -->
  <section id="settings-section-general" data-settings-section="general" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="settings" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('preferences.general')}</span>
    </div>
    <!-- Language Switcher -->
    <div id="setting-language" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.language')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.languageDescription')}</div>
      </div>
      <LanguageSwitcher />
    </div>

    <!-- Selection toolbar (always-visible Select row) -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.selectionToolbar')}</div>
          <p class="text-label-sm text-md-on-surface/50">{$t('preferences.selectionToolbarHint')}</p>
        </div>
        <Toggle
          checked={selectionToolbarEnabled}
          ariaLabel={$t('preferences.selectionToolbar')}
          onChange={async (next) => {
            selectionToolbarEnabled = next;
            await browser.storage.local.set({ selectionToolbarEnabled: next });
          }}
        />
      </div>
    </div>

    <!-- Clipboard auto-purge (visible privacy control) -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="text-sm font-medium text-md-on-surface">{$t('privacy.clipboardTitle')}</div>
      <p class="text-label-sm text-md-on-surface/50">{$t('privacy.clipboardHint')}</p>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-md-on-surface">{$t('privacy.clipboardAutoPurge')}</span>
        <Toggle
          checked={clipboardPrivacy.autoPurgeEnabled}
          ariaLabel={$t('privacy.clipboardAutoPurge')}
          onChange={(next) => {
            clipboardPrivacy = { ...clipboardPrivacy, autoPurgeEnabled: next };
            void persistClipboardPrivacy();
          }}
        />
      </div>
      {#if clipboardPrivacy.autoPurgeEnabled}
        <label class="flex items-center gap-2 text-xs text-md-on-surface">
          {$t('privacy.clipboardPurgeAfter')}
          <input
            type="number"
            min="5"
            max="300"
            class="w-16 px-1.5 py-1 rounded-lg bg-md-surface border border-md-outline-variant/40"
            value={clipboardPrivacy.purgeAfterSeconds}
            onchange={(e) => {
              const n = Math.max(5, Math.min(300, Number((e.target as HTMLInputElement).value) || 30));
              clipboardPrivacy = { ...clipboardPrivacy, purgeAfterSeconds: n };
              void persistClipboardPrivacy();
            }}
          />
          <span class="text-md-on-surface/50">{$t('privacy.clipboardSeconds')}</span>
        </label>
      {/if}
    </div>

  </section>




  <!-- ── Appearance ── -->
  <section id="settings-section-appearance" data-settings-section="appearance" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="sun" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('settings.appearance')}</span>
    </div>

    <div id="setting-select-theme" class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.selectTheme')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.selectThemeDescription')}</div>
      </div>
      <div class="flex flex-col gap-1.5">
        <button
          type="button"
          class="w-full flex items-center justify-between px-3 py-2 rounded-xl text-start transition-colors bg-md-primary text-md-on-primary"
          aria-pressed="true"
        >
          <span class="text-xs font-medium">{$t('preferences.themeMaterial')}</span>
          <Icon name="check" class="w-3.5 h-3.5 shrink-0" />
        </button>
        <div
          class="w-full flex items-center justify-between px-3 py-2 rounded-xl text-start bg-md-surface-variant/50 text-md-on-surface/45 cursor-not-allowed"
          aria-disabled="true"
        >
          <span class="text-xs font-medium">{$t('preferences.themeComingSoon')}</span>
        </div>
      </div>
    </div>

    <div id="setting-theme" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.themeAccent')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.themeAccentDescription')}</div>
      </div>
      <ColorPicker
        value={customColor || ''}
        ariaLabel={$t('preferences.chooseThemeColor')}
        allowClear={true}
        onChange={(hex) => onColorChange(hex)}
      />
    </div>

    <!-- Per-Inbox Accent Theme Toggle -->
    <div id="setting-per-inbox-theme" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.perInboxAccent')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.perInboxAccentDescription')}</div>
      </div>
      <Toggle
        checked={inboxColorThemeEnabled}
        ariaLabel={$t('preferences.perInboxAccent')}
        onChange={() => onToggleInboxColorTheme()}
      />
    </div>

    <div id="setting-contrast" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.contrastLevel')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.contrastLevelDescription')}</div>
      </div>
      <div class="flex items-center gap-1">
        <button
          class="px-3 py-1.5 text-xs rounded-lg transition-colors {contrastLevel === 'standard' ? 'bg-md-primary text-md-on-primary' : 'bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80'}"
          onclick={() => onContrastLevelChange('standard')}
          aria-label={$t('preferences.standardContrast')}
        >
          {$t('preferences.contrastStandard')}
        </button>
        <button
          class="px-3 py-1.5 text-xs rounded-lg transition-colors {contrastLevel === 'medium' ? 'bg-md-primary text-md-on-primary' : 'bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80'}"
          onclick={() => onContrastLevelChange('medium')}
          aria-label={$t('preferences.mediumContrast')}
        >
          {$t('preferences.contrastMedium')}
        </button>
        <button
          class="px-3 py-1.5 text-xs rounded-lg transition-colors {contrastLevel === 'high' ? 'bg-md-primary text-md-on-primary' : 'bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80'}"
          onclick={() => onContrastLevelChange('high')}
          aria-label={$t('preferences.highContrast')}
        >
          {$t('preferences.contrastHigh')}
        </button>
      </div>
    </div>

    <div id="setting-density" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.density')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.densityDescription')}</div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button
          type="button"
          class="px-3 py-2 text-xs rounded-lg font-semibold transition-colors {densityLocal === 'comfortable'
            ? 'bg-md-primary text-md-on-primary'
            : 'bg-md-secondary-container text-md-on-surface'}"
          onclick={async () => {
            densityLocal = 'comfortable';
            await browser.storage.local.set({ uiDensity: 'comfortable' });
          }}
        >{$t('preferences.densityComfortable')}</button>
        <button
          type="button"
          class="px-3 py-2 text-xs rounded-lg font-semibold transition-colors {densityLocal === 'compact'
            ? 'bg-md-primary text-md-on-primary'
            : 'bg-md-secondary-container text-md-on-surface'}"
          onclick={async () => {
            densityLocal = 'compact';
            await browser.storage.local.set({ uiDensity: 'compact' });
          }}
        >{$t('preferences.densityCompact')}</button>
      </div>
    </div>
  </section>

  <!-- ── Mail Provider ── -->
  <section id="settings-section-mail" data-settings-section="mail" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="mail" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('preferences.sectionMailbox')}</span>
    </div>

    <!-- Mail Provider nav card -->
    <button
      id="setting-providers"
      class="bg-md-primary-container rounded-xl px-3 py-3 w-full text-start hover:bg-md-primary-container/80 transition-colors border-0"
      onclick={onNavigateToMailProvider}
    >
      <div class="flex items-center justify-between">
        <div>
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.mailProviderSettings')}</div>
          <div class="text-xs text-md-on-surface/50 mt-0.5">{$t('preferences.mailProviderDescription')}</div>
        </div>
        <Icon name="chevronRight" class="w-4 h-4 text-md-primary/70 rtl-flip" />
      </div>
    </button>

    <!-- Auto-Copy (moved from General) -->
    <div id="setting-autocopy" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('settings.autoCopy')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('settings.autoCopyDescription')}</div>
      </div>
      <Toggle
        checked={autoCopy}
        ariaLabel={$t('preferences.toggleAutoCopy')}
        onChange={(next) => {
          onSetAutoCopy?.(next);
          onSaveSettings();
        }}
      />
    </div>

    <!-- Inbox behaviour (moved from Mail Provider page) -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-3">
      <div class="text-xs font-medium text-md-on-surface/60">{$t('mailProvider.inboxBehaviour')}</div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('mailProvider.autoRenew')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('mailProvider.autoRenewDescription')}</div>
        </div>
        <Toggle
          checked={autoRenew}
          ariaLabel={$t('mailProvider.autoRenew')}
          onChange={(next) => {
            onSetAutoRenew?.(next);
            onSaveSettings();
          }}
        />
      </div>
      <div class="h-px bg-md-secondary-container"></div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.expiryAction')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('preferences.expiryActionDescription')}</div>
        </div>
        <Dropdown
          class="shrink-0 max-w-[48%]"
          variant="outlined"
          size="xs"
          ariaLabel={$t('preferences.expiryAction')}
          value={expiryAction}
          onchange={(v) => {
            const next = v === 'delete' ? 'delete' : 'archive';
            expiryAction = next;
            void browser.storage.local.set({ expiryAction: next });
          }}
          options={[
            { value: 'archive', label: $t('preferences.expiryActionArchive') },
            { value: 'delete', label: $t('preferences.expiryActionDelete') },
          ]}
        />
      </div>
      <div class="h-px bg-md-secondary-container"></div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('mailProvider.autoRefreshInterval')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('mailProvider.autoRefreshDescription')}</div>
        </div>
        <Dropdown
          class="shrink-0"
          variant="outlined"
          size="xs"
          ariaLabel={$t('mailProvider.autoRefreshInterval')}
          value={autoRefreshInterval}
          onchange={(v) => {
            onSetAutoRefreshInterval?.(Number(v));
            onSaveSettings();
          }}
          options={[
            { value: 0, label: $t('mailProvider.manualOnly') },
            { value: 10000, label: $t('mailProvider.tenSeconds') },
            { value: 30000, label: $t('mailProvider.thirtySeconds') },
            { value: 60000, label: $t('mailProvider.oneMinute') },
            { value: 120000, label: $t('mailProvider.twoMinutes') },
            { value: 300000, label: $t('mailProvider.fiveMinutes') },
            { value: 600000, label: $t('mailProvider.tenMinutes') },
          ]}
        />
      </div>
      <div class="h-px bg-md-secondary-container"></div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('mailProvider.emailPreviewTooltip')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('mailProvider.emailPreviewTooltipDescription')}</div>
        </div>
        <Toggle
          checked={emailPreviewEnabled}
          ariaLabel={$t('mailProvider.emailPreviewTooltip')}
          onChange={(next) => {
            onSetEmailPreviewEnabled?.(next);
            onSaveSettings();
          }}
        />
      </div>
    </div>

    <!-- HTML Element Rendering (moved from General) -->
    <div id="setting-subpage-html" data-search-alias="html element rendering tags img style table svg audio video iframe object form sanitize" class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <button
        type="button"
        class="w-full flex items-center justify-between text-start"
        onclick={() => { activeSettingsSubpage = 'htmlRendering'; }}
      >
        <div>
          <div class="text-sm font-medium text-md-on-surface">{$t('settings.htmlRenderingTitle') || 'HTML Element Rendering'}</div>
          <p class="text-label-sm text-md-on-surface/50">{$t('settings.htmlRenderingSubtitle') || 'Control allowed HTML tags inside email bodies'}</p>
        </div>
        <Icon name="chevronRight" class="w-4 h-4 text-md-on-surface/50 shrink-0" />
      </button>
    </div>

    <!-- Show Images in Email Body (moved from General) -->
    <div id="setting-show-images" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.showImages')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.showImagesDescription')}</div>
      </div>
      <Toggle
        checked={showImages}
        ariaLabel={$t('preferences.showImages')}
        onChange={async (next) => {
          showImages = next;
          await browser.storage.local.set({ showImages: next });
          onSaveSettings();
        }}
      />
    </div>

    <!-- Tag / Labels / Filters / Mailbox management live under More nav (not Settings) -->
  </section>

  <!-- ── Notification & Feedback ── -->
  <section id="settings-section-notifications" data-settings-section="notifications" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="bell" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('preferences.sectionNotifications')}</span>
    </div>

    <!-- Toast notifications master switch -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.toastsEnabled')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.toastsEnabledDescription')}</div>
      </div>
      <Toggle
        checked={toastsEnabled}
        ariaLabel={$t('preferences.toastsEnabled')}
        onChange={async (next) => {
          toastsEnabled = next;
          toastStore.setEnabled(next);
          await browser.storage.local.set({ toastsEnabled: next });
        }}
      />
    </div>

    <!-- OS notifications (moved from Mailbox) -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-3">
      <div class="text-xs font-medium text-md-on-surface/60">{$t('mailProvider.notifications')}</div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm text-md-on-surface">{$t('mailProvider.enableNotifications')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('mailProvider.enableNotificationsDescription')}</div>
        </div>
        <Toggle
          checked={notificationsEnabled}
          ariaLabel={$t('mailProvider.enableNotifications')}
          onChange={(next) => {
            onSetNotificationsEnabled?.(next);
            onSaveSettings();
          }}
        />
      </div>
      <div class="h-px bg-md-secondary-container"></div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm text-md-on-surface">{$t('mailProvider.notificationSound')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('mailProvider.notificationSoundDescription')}</div>
        </div>
        <Toggle
          checked={soundEnabled}
          ariaLabel={$t('mailProvider.notificationSound')}
          onChange={(next) => {
            onSetSoundEnabled?.(next);
            onSaveSettings();
          }}
        />
      </div>
      <div class="h-px bg-md-secondary-container"></div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm text-md-on-surface">{$t('mailProvider.expiryWarning')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('mailProvider.expiryWarningDescription')}</div>
        </div>
        <Dropdown
          class="shrink-0"
          variant="secondary"
          size="xs"
          ariaLabel={$t('mailProvider.expiryWarning')}
          value={expiryWarningThreshold}
          onchange={(v) => {
            onSetExpiryWarningThreshold?.(Number(v));
            onSaveSettings();
          }}
          options={[
            { value: 15 * 60 * 1000, label: $t('mailProvider.fifteenMinutes') },
            { value: 5 * 60 * 1000, label: $t('mailProvider.fiveMinutesShort') },
            { value: 60 * 1000, label: $t('mailProvider.oneMinuteShort') },
            { value: 60 * 60 * 1000, label: $t('mailProvider.oneHour') },
          ]}
        />
      </div>
      <div class="h-px bg-md-secondary-container"></div>
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm text-md-on-surface">{$t('preferences.testNotificationTitle')}</div>
          {#if notificationsBlocked && testNotifyResult}
            <button
              type="button"
              aria-live="polite"
              class="text-xs font-semibold text-md-error underline underline-offset-2 hover:text-md-error/80 transition-colors"
              onclick={() => void handleOpenNotificationSettings()}
            >
              {testNotifyResult}
            </button>
          {:else}
            <div class="text-xs text-md-on-surface/50" aria-live="polite">
              {testNotifyResult || $t('preferences.testNotificationHint')}
            </div>
          {/if}
        </div>
        <button
          type="button"
          class="shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onclick={() => void sendTestNotification()}
          disabled={testNotifyBusy}
        >
          {testNotifyBusy ? $t('common.loading') : $t('preferences.sendTestNotification')}
        </button>
      </div>
    </div>

    <!-- Smart notifications (moved from General) -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="text-sm font-medium text-md-on-surface">{$t('intelligence.notificationsTitle')}</div>
      <p class="text-label-sm text-md-on-surface/50">{$t('intelligence.notificationsHint')}</p>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-md-on-surface">{$t('intelligence.otpAndMagicOnly')}</span>
        <Toggle
          checked={notifIntel.otpAndMagicOnly}
          ariaLabel={$t('intelligence.otpAndMagicOnly')}
          onChange={(next) => {
            notifIntel = { ...notifIntel, otpAndMagicOnly: next };
            void persistNotifIntel();
          }}
        />
      </div>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-md-on-surface">{$t('intelligence.groupDigest')}</span>
        <Toggle
          checked={notifIntel.groupDigest}
          ariaLabel={$t('intelligence.groupDigest')}
          onChange={(next) => {
            notifIntel = { ...notifIntel, groupDigest: next };
            void persistNotifIntel();
          }}
        />
      </div>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-md-on-surface">{$t('intelligence.quietHours')}</span>
        <Toggle
          checked={notifIntel.quietHoursEnabled}
          ariaLabel={$t('intelligence.quietHours')}
          onChange={(next) => {
            notifIntel = { ...notifIntel, quietHoursEnabled: next };
            void persistNotifIntel();
          }}
        />
      </div>
      {#if notifIntel.quietHoursEnabled}
        <div class="flex items-center gap-2 text-xs">
          <label class="flex items-center gap-1">
            {$t('intelligence.quietFrom')}
            <input
              type="number"
              min="0"
              max="23"
              class="w-12 px-1 py-0.5 rounded-lg bg-md-surface border border-md-outline-variant/40"
              value={notifIntel.quietHoursStart}
              onchange={(e) => {
                notifIntel = {
                  ...notifIntel,
                  quietHoursStart: Math.max(
                    0,
                    Math.min(23, Number((e.target as HTMLInputElement).value) || 0)
                  ),
                };
                void persistNotifIntel();
              }}
            />
          </label>
          <label class="flex items-center gap-1">
            {$t('intelligence.quietTo')}
            <input
              type="number"
              min="0"
              max="23"
              class="w-12 px-1 py-0.5 rounded-lg bg-md-surface border border-md-outline-variant/40"
              value={notifIntel.quietHoursEnd}
              onchange={(e) => {
                notifIntel = {
                  ...notifIntel,
                  quietHoursEnd: Math.max(
                    0,
                    Math.min(23, Number((e.target as HTMLInputElement).value) || 0)
                  ),
                };
                void persistNotifIntel();
              }}
            />
          </label>
        </div>
      {/if}
      <div>
        <label class="text-label-sm text-md-on-surface/60" for="muted-sender-domains">
          {$t('intelligence.mutedSenders')}
        </label>
        <input
          id="muted-sender-domains"
          type="text"
          class="w-full mt-0.5 px-2 py-1.5 text-xs rounded-lg bg-md-surface border border-md-outline-variant/40"
          placeholder="newsletter.com, marketing.io"
          bind:value={mutedDomainsText}
          onchange={() => void persistNotifIntel()}
        />
      </div>
    </div>
  </section>

  <!-- ── Autofill ── -->
  <section id="settings-section-autofill" data-settings-section="autofill" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="lock" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('preferences.sectionAutofill')}</span>
    </div>

    <!-- Default Identity for Autofill -->
    <div id="setting-identities" class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="text-sm font-medium text-md-on-surface">{$t('preferences.defaultForAutofill')}</div>
      <Dropdown
        variant="outlined"
        value={selectedIdentityId ?? ''}
        placeholder={$t('preferences.noIdentities')}
        ariaLabel={$t('preferences.selectDefaultIdentity')}
        disabled={identities.length === 0}
        options={[
          { value: '', label: $t('preferences.none') },
          ...identities.map((i) => ({ value: i.id, label: i.name })),
        ]}
        onchange={(v) => onSetSelectedIdentityId?.(v === '' ? null : (v as string))}
      />
    </div>

    <!-- View All Identities Button -->
    <button
      class="w-full bg-md-secondary-container hover:bg-md-secondary-container/80 text-sm font-medium text-md-on-surface rounded-xl px-3 py-3 transition-colors mb-2"
      onclick={onNavigateToIdentities}
    >
      {$t('preferences.viewAllIdentities')}
    </button>

    <!-- Product boundary: temp-mail autofill, not a password manager -->
    <div class="rounded-xl px-3 py-3 bg-md-secondary-container/40 border border-md-outline-variant/20">
      <div class="text-xs font-medium text-md-on-surface">{$t('privacy.notPasswordManagerTitle')}</div>
      <p class="text-label-sm text-md-on-surface/60 mt-0.5">{$t('privacy.notPasswordManagerBody')}</p>
    </div>

    <!-- Saved-login pick preference for autofill (per domain) -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="text-sm font-medium text-md-on-surface">{$t('preferences.autofillLoginPreference')}</div>
      <p class="text-label-sm text-md-on-surface/50">{$t('preferences.autofillLoginPreferenceHint')}</p>
      <div class="flex items-stretch rounded-xl border border-md-outline-variant/40 overflow-hidden">
        <button
          type="button"
          class="flex-1 px-2 py-2 text-label-sm font-semibold transition-colors {autofillLoginPreference === 'recent' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
          onclick={() => {
            autofillLoginPreference = 'recent';
            void browser.storage.local.set({ autofillLoginPreference: 'recent' });
          }}
        >{$t('preferences.autofillLoginRecent')}</button>
        <span class="w-px bg-md-outline-variant/50 shrink-0" aria-hidden="true"></span>
        <button
          type="button"
          class="flex-1 px-2 py-2 text-label-sm font-semibold transition-colors {autofillLoginPreference === 'listOrder' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface text-md-on-surface hover:bg-md-surface-variant'}"
          onclick={() => {
            autofillLoginPreference = 'listOrder';
            void browser.storage.local.set({ autofillLoginPreference: 'listOrder' });
          }}
        >{$t('preferences.autofillLoginListOrder')}</button>
      </div>
    </div>

    <!-- OTP detection mode -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="text-sm font-medium text-md-on-surface">{$t('preferences.otpDetectionMode')}</div>
      <p class="text-label-sm text-md-on-surface/50">{$t('preferences.otpDetectionModeHint')}</p>
      <div class="flex flex-col gap-1">
        {#each [
          ['numeric', 'preferences.otpModeNumeric', 'preferences.otpModeNumericHint'],
          ['balanced', 'preferences.otpModeBalanced', 'preferences.otpModeBalancedHint'],
          ['alphanumeric', 'preferences.otpModeAlphanumeric', 'preferences.otpModeAlphanumericHint'],
        ] as [mode, labelKey, hintKey] (mode)}
          <button
            type="button"
            class="w-full text-start px-3 py-2 rounded-xl border transition-colors {otpDetectionMode === mode ? 'border-md-primary bg-md-primary/10' : 'border-md-outline-variant/40 bg-md-surface hover:bg-md-surface-variant'}"
            onclick={() => {
              otpDetectionMode = mode as typeof otpDetectionMode;
              void browser.storage.local.set({ otpDetectionMode: mode });
            }}
          >
            <div class="text-xs font-medium text-md-on-surface">{$t(labelKey)}</div>
            <div class="text-xs text-md-on-surface/50">{$t(hintKey)}</div>
          </button>
        {/each}
      </div>
    </div>

    <!-- Master autofill on/off -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.autofillFeature')}</div>
          <p class="text-label-sm text-md-on-surface/50">{$t('preferences.autofillFeatureHint')}</p>
        </div>
        <Toggle
          checked={autofillFeatureEnabled}
          ariaLabel={$t('preferences.autofillFeature')}
          onChange={async (next) => {
            autofillFeatureEnabled = next;
            await browser.storage.local.set({ autofillFeatureEnabled: next });
            toastStore.info(
              next
                ? $t('preferences.autofillFeatureEnabled')
                : $t('preferences.autofillFeatureDisabled')
            );
          }}
        />
      </div>
    </div>

    <!-- Autofill options (disabled when master feature is off) -->
    <div class="space-y-2 {autofillFeatureEnabled ? '' : 'opacity-50 select-none'}" inert={!autofillFeatureEnabled}>

    <!-- Smart autofill intelligence -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2.5">
      <div>
        <div class="text-sm font-medium text-md-on-surface mb-0.5">{$t('settings.smartAutofillTitle')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('settings.smartAutofillDescription')}</div>
      </div>
      <label class="flex items-center justify-between gap-3">
        <div>
          <span class="text-xs font-medium text-md-on-surface/80 block">{$t('settings.humanLikeFilling')}</span>
          <span class="text-label-sm text-md-on-surface/50 leading-tight block">{$t('settings.humanLikeFillingDescription')}</span>
        </div>
        <Toggle
          checked={smartSettings.humanLikeFilling}
          size="sm"
          ariaLabel={$t('settings.humanLikeFilling')}
          onChange={(v) => void updateSmartSetting({ humanLikeFilling: v, humanLikeTiming: v })}
        />
      </label>
      <label class="flex items-center justify-between gap-3">
        <div>
          <span class="text-xs font-medium text-md-on-surface/80 block">{$t('settings.autoClickSubmit')}</span>
          <span class="text-label-sm text-md-on-surface/50 leading-tight block">{$t('settings.autoClickSubmitDesc')}</span>
        </div>
        <Toggle
          checked={smartSettings.autoClickSubmitButtons}
          size="sm"
          ariaLabel={$t('settings.autoClickSubmit')}
          onChange={(v) => void updateSmartSetting({ autoClickSubmitButtons: v })}
        />
      </label>
      <label class="flex items-center justify-between gap-3">
        <span class="text-xs text-md-on-surface/80">{$t('settings.humanLikeTiming')}</span>
        <Toggle
          checked={smartSettings.humanLikeTiming}
          size="sm"
          ariaLabel={$t('settings.humanLikeTiming')}
          onChange={(v) => void updateSmartSetting({ humanLikeTiming: v })}
        />
      </label>
      <label class="flex items-center justify-between gap-3">
        <span class="text-xs text-md-on-surface/80">{$t('settings.dryRunPreview')}</span>
        <Toggle
          checked={smartSettings.dryRunPreview}
          size="sm"
          ariaLabel={$t('settings.dryRunPreview')}
          onChange={(v) => void updateSmartSetting({ dryRunPreview: v })}
        />
      </label>
      <label class="flex items-center justify-between gap-3">
        <span class="text-xs text-md-on-surface/80">{$t('settings.smartOtpAttach')}</span>
        <Toggle
          checked={smartSettings.smartOtpAttach}
          size="sm"
          ariaLabel={$t('settings.smartOtpAttach')}
          onChange={(v) => void updateSmartSetting({ smartOtpAttach: v })}
        />
      </label>
      <label class="flex items-center justify-between gap-3">
        <span class="text-xs text-md-on-surface/80">{$t('settings.localeAwareData')}</span>
        <Toggle
          checked={smartSettings.localeAwareData}
          size="sm"
          ariaLabel={$t('settings.localeAwareData')}
          onChange={(v) => void updateSmartSetting({ localeAwareData: v })}
        />
      </label>
      {#if blockSuggestions.length > 0}
        <div class="pt-1 border-t border-md-outline-variant/30 space-y-1.5">
          <div class="text-xs font-medium text-md-on-surface/60">{$t('settings.blockSuggestionsTitle')}</div>
          {#each blockSuggestions as domain (domain)}
            <div class="flex items-center gap-2 text-xs">
              <span class="flex-1 truncate font-medium">{domain}</span>
              <div class="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  class="px-2 py-1 bg-md-primary/10 text-md-primary hover:bg-md-primary/20 rounded-md text-label-sm font-bold disabled:opacity-50"
                  disabled={processingDomain === domain}
                  onclick={() => { processingDomain = domain; void acceptBlockSug(domain); }}
                >{$t('settings.blockSuggestionsAccept')}</button>
                <button
                  type="button"
                  class="px-2 py-1 bg-md-surface-variant/40 text-md-on-surface hover:bg-md-surface-variant rounded-md text-label-sm font-bold disabled:opacity-50"
                  disabled={processingDomain === domain}
                  onclick={() => { processingDomain = domain; void dismissBlockSug(domain); }}
                >{$t('settings.blockSuggestionsDismiss')}</button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="bg-md-primary-container rounded-xl px-3 py-3">
      <div class="text-sm font-medium text-md-on-surface mb-1">{$t('settings.autofillBlocklist')}</div>
      <div class="text-xs text-md-on-surface/50 mb-2">{$t('settings.autofillBlocklistDescription')}</div>
      {#if onAddToBlocklist}
        <form
          class="flex gap-2 mb-2"
          onsubmit={(e) => {
            e.preventDefault();
            const domain = newBlocklistDomain
              .trim()
              .toLowerCase()
              .replace(/^https?:\/\//, '')
              .replace(/^www\./, '')
              .split('/')[0];
            if (!domain) return;
            void onAddToBlocklist(domain);
            newBlocklistDomain = '';
          }}
        >
          <input
            type="text"
            class="flex-1 min-w-0 px-3 py-1.5 text-xs rounded-lg border border-md-outline-variant/40 bg-md-surface text-md-on-surface"
            placeholder={$t('settings.blocklistDomainPlaceholder')}
            bind:value={newBlocklistDomain}
            aria-label={$t('settings.blocklistDomainPlaceholder')}
            list="blocklist-domain-suggestions"
          />
          <datalist id="blocklist-domain-suggestions">
            {#if currentTabDomain}
              <option value={currentTabDomain}></option>
            {/if}
          </datalist>
          <button
            type="submit"
            class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-md-primary text-md-on-primary hover:bg-md-primary/90 shrink-0"
          >
            {$t('settings.addToBlocklist')}
          </button>
        </form>
        {#if currentTabDomain && !autofillBlocklist.includes(currentTabDomain)}
          <button
            type="button"
            class="mb-3 w-full text-start px-3 py-2 rounded-lg bg-md-secondary-container/60 hover:bg-md-secondary-container text-label-sm text-md-on-surface flex items-center justify-between gap-2 transition-colors"
            onclick={() => {
              void onAddToBlocklist(currentTabDomain);
              newBlocklistDomain = '';
            }}
          >
            <span class="truncate">
              {$t('settings.blocklistSuggestCurrent', { values: { domain: currentTabDomain } })}
            </span>
            <span class="text-md-primary font-semibold shrink-0">{$t('settings.addToBlocklist')}</span>
          </button>
        {:else if currentTabDomain && autofillBlocklist.includes(currentTabDomain)}
          <div class="mb-3 text-xs text-md-on-surface/45 px-1">
            {$t('settings.blocklistCurrentAlreadyAdded', { values: { domain: currentTabDomain } })}
          </div>
        {/if}
      {/if}
      {#if autofillBlocklist.length === 0}
        <div class="text-sm text-md-on-surface/40 py-2">{$t('settings.autofillBlocklistEmpty')}</div>
        <div class="text-xs text-md-on-surface/30">{$t('settings.autofillBlocklistEmptyDescription')}</div>
      {:else}
        <div class="space-y-1">
          {#each autofillBlocklist as domain (domain)}
            <div class="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-md-secondary-container/50 transition-colors">
              <span class="text-sm text-md-on-surface font-mono">{domain}</span>
              {#if onRemoveFromBlocklist}
                <button
                  class="text-xs text-md-error hover:text-md-error/80 px-2 py-0.5 rounded hover:bg-md-error-container/30 transition-colors"
                  onclick={() => onRemoveFromBlocklist(domain)}
                >
                  {$t('settings.removeFromBlocklist')}
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Vault Protection & Security (autofill-related) -->
    <div id="setting-vault-lock" class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.vaultProtection')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.vaultProtectionDescription')}</div>
      </div>
      <div class="flex items-center gap-1.5 pt-1 flex-wrap">
        <button
          class="px-3 py-1.5 text-xs rounded-lg transition-colors {vaultMode === 'standard' ? 'bg-md-primary text-md-on-primary font-semibold' : 'bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80'}"
          onclick={() => handleSetVaultMode('standard')}
        >
          {$t('preferences.vaultStandard')}
        </button>
        <button
          class="px-3 py-1.5 text-xs rounded-lg transition-colors {vaultMode === 'password' ? 'bg-md-primary text-md-on-primary font-semibold' : 'bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80'}"
          onclick={() => handleSetVaultMode('password')}
        >
          {$t('preferences.vaultMasterPassword')}
        </button>
        {#if biometricSupported}
          <button
            class="px-3 py-1.5 text-xs rounded-lg transition-colors {vaultMode === 'biometrics' ? 'bg-md-primary text-md-on-primary font-semibold' : 'bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80'}"
            onclick={() => handleSetVaultMode('biometrics')}
          >
            {$t('preferences.vaultBiometrics')}
          </button>
        {/if}
      </div>
    </div>
    </div><!-- /autofill options wrapper -->
  </section>

  <!-- ── Input & Navigation ── -->
  <section id="settings-section-inputNav" data-settings-section="inputNav" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="navigation" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('preferences.inputAndNavigation')}</span>
    </div>

    <!-- Gestures (hold-to-select, swipes) -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.gesturesEnabled')}</div>
          <p class="text-label-sm text-md-on-surface/50">{$t('preferences.gesturesEnabledHint')}</p>
        </div>
        <Toggle
          checked={gesturesEnabled}
          ariaLabel={$t('preferences.gesturesEnabled')}
          onChange={async (next) => {
            gesturesEnabled = next;
            await browser.storage.local.set({ gesturesEnabled });
          }}
        />
      </div>
    </div>

    <!-- Marquee (rubber-band) multi-select -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.marqueeSelection')}</div>
          <p class="text-label-sm text-md-on-surface/50">{$t('preferences.marqueeSelectionHint')}</p>
        </div>
        <Toggle
          checked={marqueeSelectionEnabled}
          ariaLabel={$t('preferences.marqueeSelection')}
          onChange={async (next) => {
            marqueeSelectionEnabled = next;
            await setMarqueeSelectionEnabled(marqueeSelectionEnabled);
          }}
        />
      </div>
    </div>

    <!-- Keyboard Shortcuts nav card -->
    <button
      id="setting-keybindings"
      class="bg-md-primary-container rounded-xl px-3 py-3 w-full text-start hover:bg-md-primary-container/80 transition-colors border-0"
      onclick={onNavigateToKeybindings}
    >
      <div class="flex items-center justify-between mb-2">
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.keyboardShortcuts')}</div>
        <div class="flex items-center gap-1 text-md-primary/70">
          {#if customKeybindingCount > 0}
            <span class="text-xs font-semibold text-md-primary bg-md-primary/15 px-1.5 py-0.5 rounded-full me-1">{$t('keyboardShortcuts.customCount', { values: { n: customKeybindingCount } })}</span>
          {/if}
          <Icon name="chevronRight" class="w-4 h-4 rtl-flip" />
        </div>
      </div>
      <div class="space-y-1 mb-1">
        {#each [{ k: 'refreshInbox', label: $t('keyboardShortcuts.refreshInbox') }, { k: 'createInbox', label: $t('keyboardShortcuts.createInbox') }, { k: 'copyEmail', label: $t('keyboardShortcuts.copyEmail') }] as row}
          <div class="flex items-center justify-between text-xs text-md-on-surface/60">
            <span>{row.label}</span>
            <span class="font-mono bg-md-secondary-container px-1.5 py-0.5 rounded text-md-on-surface">{formatKeybinding(keybindings[row.k as keyof typeof keybindings])}</span>
          </div>
        {/each}
      </div>
    </button>

    <!-- Navigational Reorder Keyboard Shortcuts button -->
    <button
      id="setting-subpage-navbar"
      data-search-alias="navbar order navigation reorder items re-order shortcuts primary navigation"
      type="button"
      class="w-full bg-md-primary-container hover:bg-md-surface-variant/70 rounded-xl px-3 py-3 text-start transition-colors space-y-1.5"
      onclick={() => { activeSettingsSubpage = 'navbarOrder'; }}
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <Icon name="arrowUpDown" class="w-4 h-4 text-md-primary shrink-0" />
          <span class="text-sm font-medium text-md-on-surface truncate">{$t('navbarOrder.title') || 'Navigational Reorder'}</span>
        </div>
        <Icon name="chevronRight" class="w-4 h-4 rtl-flip" />
      </div>
      <p class="text-xs text-md-on-surface/50">{$t('navbarOrder.hint') || 'Customize navigation bar item order and shortcuts'}</p>
    </button>
  </section>

  <!-- ── Search ── -->
  <section id="settings-section-search" data-settings-section="search" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="search" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('searchHistory.settingsTitle')}</span>
    </div>
    <div class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="text-sm font-medium text-md-on-surface">{$t('searchHistory.limitLabel')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('searchHistory.limitHint')}</div>
      </div>
      <Dropdown
        class="shrink-0"
        variant="outlined"
        size="xs"
        ariaLabel={$t('searchHistory.limitLabel')}
        value={searchHistoryLimit}
        onchange={async (v) => {
          searchHistoryLimit = await setSearchHistoryLimit(Number(v));
        }}
        options={[3, 5, 8, 10, 15, 20].map((n) => ({ value: n, label: String(n) }))}
      />
    </div>
    <!-- Search slash icon visibility -->
    <div id="setting-search-slash-icon" data-search-alias="slash operators shortcut search syntax button" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.showSearchSlashIcon')}</div>
        <p class="text-label-sm text-md-on-surface/50">{$t('preferences.showSearchSlashIconHint')}</p>
      </div>
      <Toggle
        checked={showSearchSlashIcon}
        ariaLabel={$t('preferences.showSearchSlashIcon')}
        onChange={async (next) => {
          showSearchSlashIcon = next;
          await browser.storage.local.set({ showSearchSlashIcon: next });
        }}
      />
    </div>

    <!-- Voice search button visibility -->
    <div id="setting-search-voice" data-search-alias="voice search microphone speech button" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.voiceSearch')}</div>
        <p class="text-label-sm text-md-on-surface/50">{$t('preferences.voiceSearchDescription')}</p>
      </div>
      <Toggle
        checked={voiceSearchEnabled}
        ariaLabel={$t('preferences.voiceSearch')}
        onChange={async (next) => {
          voiceSearchEnabled = next;
          await browser.storage.local.set({ voiceSearchEnabled: next });
        }}
      />
    </div>

    <button
      id="setting-subpage-toolbar"
      data-search-alias="toolbar buttons action star archive delete download forward tag print mark unread show hide"
      type="button"
      class="w-full bg-md-primary-container hover:bg-md-surface-variant/70 rounded-xl px-3 py-3 text-start transition-colors space-y-1"
      onclick={() => { activeSettingsSubpage = 'toolbarButtons'; }}
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <Icon name="layout" class="w-4 h-4 text-md-primary shrink-0" />
          <span class="text-sm font-medium text-md-on-surface truncate">{$t('settings.toolbarButtonsTitle') || 'Toolbar Buttons'}</span>
        </div>
        <Icon name="chevronRight" class="w-4 h-4 rtl-flip" />
      </div>
      <p class="text-xs text-md-on-surface/50">{$t('settings.toolbarButtonsHint') || 'Choose which action buttons appear in the email toolbar'}</p>
    </button>
  </section>

  <!-- ── Developer Settings ── -->
  <section id="settings-section-developer" data-settings-section="developer" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="monitor" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('settings.developer')}</span>
    </div>

    <div id="setting-developer" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between">
      <div>
        <div class="text-sm font-medium text-md-on-surface">{$t('preferences.showDeveloperOptions')}</div>
        <div class="text-xs text-md-on-surface/50">{$t('preferences.showDeveloperOptionsDescription')}</div>
      </div>
      <Toggle
        checked={showDeveloperSettings}
        ariaLabel={$t('preferences.toggleDeveloperSettings')}
        onChange={() => onToggleDeveloperSettings()}
      />
    </div>

    {#if showDeveloperSettings}
      <div id="setting-logging" class="bg-md-primary-container rounded-xl px-3 py-3 flex items-center justify-between">
        <div>
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.enableLogging')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('preferences.enableLoggingDescription')}</div>
        </div>
        <Toggle
          checked={enableLogging}
          ariaLabel={$t('preferences.toggleLogging')}
          onChange={() => onToggleEnableLogging()}
        />
      </div>

      <button
        id="setting-constants"
        type="button"
        class="w-full flex items-center justify-between px-3 py-3 bg-md-surface-container rounded-xl hover:bg-md-surface-variant/40 transition-colors border border-md-outline-variant/30"
        onclick={onNavigateToConstantsSettings}
      >
        <div class="text-start">
          <div class="text-sm font-medium text-md-on-surface">{$t('settings.manageConstantOverrides')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('settings.manageConstantOverridesDescription')}</div>
        </div>
        <Icon name="chevronRight" class="w-4 h-4 text-md-on-surface/60 rtl-flip" />
      </button>

      <button
        id="setting-playground"
        type="button"
        class="w-full flex items-center justify-between px-3 py-3 bg-md-surface-container rounded-xl hover:bg-md-surface-variant/40 transition-colors border border-md-outline-variant/30"
        onclick={onOpenPlayground}
      >
        <div class="text-start">
          <div class="text-sm font-medium text-md-on-surface">{$t('playground.title')}</div>
          <div class="text-xs text-md-on-surface/50">{$t('playground.subtitle')}</div>
        </div>
        <Icon name="chevronRight" class="w-4 h-4 text-md-on-surface/60 rtl-flip" />
      </button>
    {/if}

    <!-- Demo mode -->
    <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.demoMode')}</div>
          <p class="text-label-sm text-md-on-surface/50">{$t('preferences.demoModeHint')}</p>
        </div>
        <Toggle
          checked={demoMode}
          ariaLabel={$t('preferences.demoMode')}
          onChange={async (on) => {
            demoMode = on;
            const { setDemoMode } = await import('@/features/demo/demo-mode.js');
            await setDemoMode(browser, on);
            try {
              await browser.storage.local.set({ demoMode: on });
            } catch {
              /* ignore */
            }
            if (on) {
              toastStore.success($t('preferences.demoModeEnabled'));
              // Product tour after demo loads (AppLayout listens for pendingProductTour)
              try {
                await browser.storage.local.set({
                  pendingProductTour: true,
                  pendingProductTourAt: Date.now(),
                });
              } catch {
                /* ignore */
              }
            } else {
              toastStore.info($t('preferences.demoModeDisabled'));
            }
          }}
        />
      </div>
      {#if demoMode}
        <p class="text-label-sm text-md-on-surface/55">{$t('preferences.demoTourHint')}</p>
        <button
          type="button"
          class="w-full py-2 rounded-xl text-xs font-semibold bg-md-secondary-container text-md-on-surface"
          onclick={async () => {
            try {
              await browser.storage.local.set({
                pendingProductTour: true,
                pendingProductTourAt: Date.now(),
              });
              toastStore.info($t('preferences.demoTourStarting'));
            } catch {
              /* ignore */
            }
          }}
        >{$t('preferences.demoStartTour')}</button>
        <button
          type="button"
          class="w-full py-2 rounded-xl text-xs font-semibold bg-md-primary text-md-on-primary"
          onclick={async () => {
            const { simulateDemoReceive } = await import('@/features/demo/demo-mode.js');
            await simulateDemoReceive(browser);
            toastStore.success($t('preferences.demoSimulatedReceive'));
          }}
        >{$t('preferences.demoSimulateReceive')}</button>
      {/if}
    </div>
  </section>

  <!-- ── Diagnostics ── -->
  <section id="settings-section-diagnostics" data-settings-section="diagnostics" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="info" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('diagnostics.title')}</span>
    </div>
    <button
      type="button"
      class="w-full flex items-center justify-between px-3 py-3 bg-md-surface-container rounded-xl hover:bg-md-surface-variant/40 transition-colors border border-md-outline-variant/30"
      onclick={() => onNavigateToDiagnostics()}
    >
      <div class="text-start">
        <div class="text-sm font-medium text-md-on-surface">{$t('diagnostics.menuTitle')}</div>
        <div class="text-xs text-md-on-surface/50 mt-0.5">{$t('diagnostics.menuDescription')}</div>
      </div>
      <Icon name="chevronRight" class="w-4 h-4 text-md-on-surface/60 rtl-flip" />
    </button>
  </section>

  <!-- ── Data, Storage & Performance ── -->
  <section id="settings-section-data" data-settings-section="data" class="space-y-2 scroll-mt-2">
    <div class="flex items-center gap-2 mb-1">
      <Icon name="database" class="w-4 h-4 text-md-primary" />
      <span class="text-sm font-medium text-md-on-surface">{$t('preferences.sectionData')}</span>
    </div>
    <div
      class="w-full px-3 py-2 rounded-lg bg-md-surface-variant/50 border border-md-outline-variant/30 text-label-sm text-md-on-surface/70 flex items-center gap-1.5"
      role="status"
    >
      <Icon name="download" class="w-3.5 h-3.5 text-md-primary shrink-0" />
      <span class="truncate">
        {#if lastBackupAt}
          {$t('preferences.lastBackupAt', { values: { date: formatBackupDate(lastBackupAt) } })}
        {:else}
          {$t('preferences.lastBackupNever')}
        {/if}
      </span>
    </div>
    <div class="flex gap-2">
      <Btn
        variant="primaryOutline"
        size="md"
        class="flex-1"
        aria-label={$t('preferences.exportDataAria')}
        onclick={onExportData}
      >{$t('preferences.exportData')}</Btn>
      <Btn
        variant="primaryOutline"
        size="md"
        class="flex-1"
        aria-label={$t('preferences.importDataAria')}
        onclick={onImportData}
      >{$t('preferences.importData')}</Btn>
    </div>
    {#if onStartProductTour}
      <Btn
        variant="outline"
        size="md"
        class="w-full mt-2"
        onclick={() => onStartProductTour()}
      >
        <Icon name="info" class="w-4 h-4 text-md-primary" />
        {$t('productTour.replay')}
      </Btn>
    {/if}
    {#if onExportCategory}
      <div class="flex flex-wrap gap-1.5">
        <span class="text-xs text-md-on-surface/50 w-full">{$t('settings.exportCategory')}</span>
        <Btn variant="outline" size="sm" onclick={() => onExportCategory('settings')}>{$t('settings.exportCategorySettings')}</Btn>
        <Btn variant="outline" size="sm" onclick={() => onExportCategory('identities')}>{$t('settings.exportCategoryIdentities')}</Btn>
        <Btn variant="outline" size="sm" onclick={() => onExportCategory('savedLogins')}>{$t('settings.exportCategorySavedLogins')}</Btn>
        <Btn variant="outline" size="sm" onclick={() => onExportCategory('inboxes')}>{$t('settings.exportCategoryInboxes')}</Btn>
      </div>
    {/if}

    <!-- Storage snapshot summary -->
    <div class="bg-md-surface-container-low rounded-xl px-3 py-3">
      <div class="flex items-center gap-1.5 mb-2">
        <Icon name="database" class="w-3.5 h-3.5 text-md-primary shrink-0" />
        <span class="text-xs font-medium text-md-on-surface/60">{$t('preferences.storageSnapshotTitle')}</span>
      </div>
      <div class="grid grid-cols-2 gap-x-3 gap-y-1.5">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="text-md-on-surface/60">{$t('preferences.storageInboxes')}</span>
          <span class="font-medium text-md-on-surface tabular-nums">{storageSnapshot.inboxes}</span>
        </div>
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="text-md-on-surface/60">{$t('preferences.storageEmails')}</span>
          <span class="font-medium text-md-on-surface tabular-nums">{storageSnapshot.emails}</span>
        </div>
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="text-md-on-surface/60">{$t('preferences.storageIdentities')}</span>
          <span class="font-medium text-md-on-surface tabular-nums">{storageSnapshot.identities}</span>
        </div>
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="text-md-on-surface/60">{$t('preferences.storageUsed')}</span>
          <span class="font-medium text-md-on-surface tabular-nums">{formatBytes(storageSnapshot.bytes)}</span>
        </div>
      </div>
    </div>

    <!-- Storage & Performance sub-page nav card -->
    <button
      id="setting-storage"
      class="bg-md-primary-container rounded-xl px-3 py-3 w-full text-start hover:bg-md-primary-container/80 transition-colors border-0"
      onclick={onNavigateToStoragePerformance}
    >
      <div class="flex items-center justify-between">
        <div>
          <div class="text-sm font-medium text-md-on-surface">{$t('preferences.storageAndPerformance')}</div>
          <div class="text-xs text-md-on-surface/50 mt-0.5">{$t('preferences.storageAndPerformanceDescription')}</div>
        </div>
        <Icon name="chevronRight" class="w-4 h-4 text-md-primary/70 rtl-flip" />
      </div>
    </button>

    <!-- Hard reset (moved from the removed Danger Zone section) -->
    <div class="rounded-xl border border-md-error/40 bg-md-error-container/60 px-3 py-3 space-y-2">
      <div class="text-sm font-semibold text-md-on-error-container">{$t('preferences.dangerZone')}</div>
      <div class="text-xs text-md-on-error-container/70">{$t('preferences.dangerZoneDescription')}</div>
      <Btn
        variant="dangerOutline"
        size="md"
        class="w-full mt-1"
        aria-label={$t('preferences.performHardReset')}
        onclick={() => showConfirmDialog($t('preferences.hardResetConfirm'), onHardReset)}
      >{$t('preferences.hardReset')}</Btn>
    </div>
  </section>

  <!-- Dynamic End-of-List Spacer: allows content to flow behind floating nav & strips while ensuring the final card can scroll cleanly above controls -->
  <div
    class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
    style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
    aria-hidden="true"
  ></div>

  </div>
  {/if}

  {#if settingsSearchQuery || activeSettingsSubpage}
    <div style="display: none;" class="hidden-search-sandbox hidden">
      <div data-settings-subpage="keybindings">
        <KeyboardShortcutsView keybindings={keybindings || DEFAULT_KEYBINDINGS} />
      </div>
      <div data-settings-subpage="organize">
        <div class="text-sm font-medium">{$t('nav.organize')}</div>
        <div class="text-xs">{$t('organize.subtitle')}</div>
        <div>{$t('nav.tagManagement')} · {$t('preferences.tagManagement')}</div>
        <div>{$t('nav.labelManagement')} · {$t('preferences.emailLabelManagement')}</div>
        <div>{$t('nav.filtersManagement')} · {$t('preferences.filtersManagement')}</div>
      </div>
      <div data-settings-subpage="tagManagement">
        <div>{$t('preferences.tagManagement')}</div>
        <div>{$t('preferences.tagManagementDescription')}</div>
      </div>
      <div data-settings-subpage="filtersManagement">
        <div>{$t('preferences.filtersManagement')}</div>
        <div>{$t('preferences.filtersManagementDescription')}</div>
      </div>
      <div data-settings-subpage="labelManagement">
        <div>{$t('preferences.emailLabelManagement')}</div>
        <div>{$t('preferences.emailLabelManagementDescription')}</div>
      </div>
      <div data-settings-subpage="mailProvider">
        <MailProviderView
          selectedProvider={selectedProvider}
          autoRenew={autoRenew}
          notificationsEnabled={notificationsEnabled}
          soundEnabled={soundEnabled}
          expiryWarningThreshold={expiryWarningThreshold}
          autoRefreshInterval={autoRefreshInterval}
          emailPreviewEnabled={emailPreviewEnabled}
          providerInstances={providerInstances || []}
          selectedProviderInstance={selectedProviderInstance}
          defaultDomain={defaultDomain}
          allInboxes={allInboxes || []}
          onProviderChange={onProviderChange}
          onSetAutoRenew={onSetAutoRenew}
          onSetNotificationsEnabled={onSetNotificationsEnabled}
          onSetSoundEnabled={onSetSoundEnabled}
          onSetExpiryWarningThreshold={onSetExpiryWarningThreshold}
          onSetAutoRefreshInterval={onSetAutoRefreshInterval}
          onSetEmailPreviewEnabled={onSetEmailPreviewEnabled}
          onSetProviderInstance={onSetProviderInstance}
          onAddCustomInstance={onAddCustomInstance}
          onLoadProviderInstances={onLoadProviderInstances}
          onSetDefaultDomain={onSetDefaultDomain}
          onSaveSettings={onSaveSettings}
        />
      </div>
      <div data-settings-subpage="storagePerformance">
        <StoragePerformanceView
          faviconCaching={faviconCaching}
          emailRetentionDays={emailRetentionDays}
        />
      </div>
      <div data-settings-subpage="addresses">
        <AddressesView />
      </div>
      <div data-settings-subpage="constantsSettings">
        <ConstantsSettingsView />
      </div>
      <div data-settings-subpage="identities">
        <IdentitiesView
          {context}
          savedLogins={[]}
          mailboxAddresses={allInboxes.map((a) => a.address).filter(Boolean)}
          activeMailboxAddress={allInboxes.find((a) => a.accountStatus === 'active' || !a.accountStatus)?.address || allInboxes[0]?.address || ''}
        />
      </div>
      <div data-settings-subpage="toolbarButtons">
        <ToolbarSettingsView onBack={() => { activeSettingsSubpage = null; }} showToast={(msg) => toastStore.info(msg)} />
      </div>
      <div data-settings-subpage="htmlRendering">
        <HtmlRenderingSettingsView onBack={() => { activeSettingsSubpage = null; }} showToast={(msg) => toastStore.info(msg)} />
      </div>
      <div data-settings-subpage="navbarOrder">
        <NavbarOrderSettingsView onBack={() => { activeSettingsSubpage = null; }} showToast={(msg) => toastStore.info(msg)} />
      </div>
    </div>
  {/if}
  </div>

  {/snippet}
</ErrorBoundary>
{/if}

<ConfirmDialog {confirmDialog} confirmDialogRef={confirmDialogRef} onClose={closeConfirmDialog} />

<MasterPasswordModal
  isOpen={isPasswordModalOpen}
  onClose={() => isPasswordModalOpen = false}
  onSave={handleSaveMasterPassword}
/>

<ToastContainer />

<style>
  :global(.animate-pulse-highlight) {
    animation: pulse-highlight 1.8s cubic-bezier(0.4, 0, 0.2, 1) 1;
  }

  @keyframes pulse-highlight {
    0%, 100% {
      box-shadow: 0 0 0 2px var(--md-sys-color-primary, #6750A4), 0 0 0 4px rgba(103, 80, 164, 0.4);
    }
    50% {
      box-shadow: 0 0 0 4px var(--md-sys-color-primary, #6750A4), 0 0 0 8px rgba(103, 80, 164, 0.1);
    }
  }

  /* Multi-column setting cards when the settings pane is wide enough */
  .settings-wide-cols :global(section[data-settings-section]) {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.5rem;
  }
  .settings-wide-cols :global(section[data-settings-section] > .flex.items-center.gap-2.mb-1),
  .settings-wide-cols :global(section[data-settings-section] > .flex.items-center.gap-2) {
    grid-column: 1 / -1;
  }
  @media (min-width: 720px) {
    .settings-wide-cols :global(section[data-settings-section]:not([data-settings-section='danger'])) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (min-width: 1100px) {
    .settings-wide-cols :global(section[data-settings-section]:not([data-settings-section='danger'])) {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
</style>
