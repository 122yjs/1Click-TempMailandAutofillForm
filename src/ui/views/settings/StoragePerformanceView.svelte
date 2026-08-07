<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Dropdown } from '@/ui/components/primitives';
import {
  STORAGE_CRITICAL_THRESHOLD,
  STORAGE_LIMIT,
  STORAGE_WARNING_THRESHOLD,
} from '@/utils/constants.js';
import { clearAllFaviconCache, getFaviconCacheStats } from '@/utils/favicon.js';
import { logError } from '@/utils/logger.js';
import {
  formatBytes,
  getStorageUsage,
  hasUnlimitedStoragePermission,
  isFirefox,
  requestUnlimitedStorage,
} from '@/utils/storageMonitor.js';
import { toastStore } from '@/utils/toastStore.js';

let {
  onBack = () => {},
  faviconCaching = 'direct' as 'direct' | 'local',
  emailRetentionDays = 30,
  onSetFaviconCaching = undefined as ((v: 'direct' | 'local') => void) | undefined,
  onSetEmailRetentionDays = undefined as ((v: number) => void) | undefined,
  onSaveSettings = () => {},
  onClearOldEmails = async () => {},
  onNavigateTo = undefined,
} = $props<{
  onBack?: () => void;
  faviconCaching?: 'direct' | 'local';
  emailRetentionDays?: number;
  onSetFaviconCaching?: (v: 'direct' | 'local') => void;
  onSetEmailRetentionDays?: (v: number) => void;
  onSaveSettings?: () => void;
  onClearOldEmails?: () => Promise<void>;
  onNavigateTo?: (view: string) => void;
}>();

let faviconCacheCount = $state(0);
let totalCacheSize = $state(0);
let storageUsageBytes = $state(0);
let quotaPercent = $derived(Math.min(Math.round((storageUsageBytes / STORAGE_LIMIT) * 100), 100));
let hasUnlimitedStorage = $state(false);
let requestingPermission = $state(false);
let clearingFaviconCache = $state(false);
let _isFirefox = $state(false);

// Storage stats
let loadingStorage = $state(false);
let storageUsage = $state<{
  totalMB: number;
  categories: { emails: number; settings: number; cached: number; other: number };
} | null>(null);
// Per-inbox email counts (active + archived) so users see where mail lives.
let perInbox = $state<{ address: string; active: number; archived: number }[] | null>(null);
let clearingEmails = $state(false);
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const retentionOptions = [
  { value: 0, labelKey: 'storagePerformance.neverDelete' },
  { value: 7, labelKey: 'storagePerformance.days7' },
  { value: 14, labelKey: 'storagePerformance.days14' },
  { value: 30, labelKey: 'storagePerformance.days30' },
  { value: 60, labelKey: 'storagePerformance.days60' },
  { value: 90, labelKey: 'storagePerformance.days90' },
  { value: 180, labelKey: 'storagePerformance.months6' },
  { value: 365, labelKey: 'storagePerformance.year1' },
];

onMount(() => {
  const init = async () => {
    storageUsageBytes = await getStorageUsage();
    hasUnlimitedStorage = await hasUnlimitedStoragePermission();
    _isFirefox = isFirefox();
    await updateFaviconCacheCount();
    await loadStorageUsage();
  };
  init().catch((err) => {
    logError('Failed to initialize storage view', undefined, err);
  });

  // Live refresh: mail keeps arriving / being cleaned while this view is open,
  // so re-read the usage + per-inbox counts on any local storage change
  // (debounced — storage.local.get(null) is not free).
  const onChanged = (_changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local') return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      void (async () => {
        storageUsageBytes = await getStorageUsage();
        await updateFaviconCacheCount();
        await loadStorageUsage();
      })();
    }, 250);
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => {
    browser.storage.onChanged.removeListener(onChanged);
    if (refreshTimer) clearTimeout(refreshTimer);
  };
});

async function updateFaviconCacheCount() {
  const stats = await getFaviconCacheStats();
  faviconCacheCount = stats.count;
  totalCacheSize = stats.sizeBytes;
}

async function handleClearFaviconCache() {
  clearingFaviconCache = true;
  try {
    await clearAllFaviconCache();
    await updateFaviconCacheCount();
    storageUsageBytes = await getStorageUsage();
    toastStore.success($t('settings.faviconCacheCleared'));
  } finally {
    clearingFaviconCache = false;
  }
}

async function handleRequestUnlimitedStorage() {
  requestingPermission = true;
  try {
    const granted = await requestUnlimitedStorage();
    hasUnlimitedStorage = granted;
    if (granted) {
      toastStore.success($t('settings.unlimitedStorageGranted'));
    } else {
      toastStore.error($t('settings.unlimitedStorageDenied'));
    }
  } finally {
    requestingPermission = false;
  }
}

async function loadStorageUsage() {
  loadingStorage = true;
  try {
    const allData = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const jsonStr = JSON.stringify(allData);
    const totalBytes = new TextEncoder().encode(jsonStr).length;
    const totalMB = totalBytes / (1024 * 1024);

    // Per-inbox counts from the stored email maps (any message shape).
    const storedMap = (allData.storedEmails || {}) as Record<string, unknown[]>;
    const archivedMap = (allData.archivedEmails || {}) as Record<string, unknown[]>;
    const addresses = new Set([...Object.keys(storedMap), ...Object.keys(archivedMap)]);
    perInbox = [...addresses]
      .map((address) => ({
        address,
        // Guard against malformed legacy shapes — only real arrays count.
        active: Array.isArray(storedMap[address]) ? storedMap[address].length : 0,
        archived: Array.isArray(archivedMap[address]) ? archivedMap[address].length : 0,
      }))
      .sort((a, b) => b.active + b.archived - (a.active + a.archived));

    const emailsStr = JSON.stringify({
      emails: allData.emails,
      storedEmails: allData.storedEmails,
      archivedEmails: allData.archivedEmails,
    });
    const settingsStr = JSON.stringify({
      autoCopy: allData.autoCopy,
      autoRenew: allData.autoRenew,
      selectedProvider: allData.selectedProvider,
      faviconCaching: allData.faviconCaching,
      keybindings: allData.keybindings,
    });
    const cachedStr = JSON.stringify({
      favicon_success_cache: allData.favicon_success_cache,
    });

    const emailsMB = new TextEncoder().encode(emailsStr).length / (1024 * 1024);
    const settingsMB = new TextEncoder().encode(settingsStr).length / (1024 * 1024);
    const cachedMB = new TextEncoder().encode(cachedStr).length / (1024 * 1024);

    storageUsage = {
      totalMB,
      categories: {
        emails: emailsMB,
        settings: settingsMB,
        cached: cachedMB,
        other: Math.max(0, totalMB - emailsMB - settingsMB - cachedMB),
      },
    };
  } catch (e) {
    logError('Failed to load storage usage', e);
  } finally {
    loadingStorage = false;
  }
}

$effect(() => {
  updateFaviconCacheCount();
});
</script>

<div class="flex flex-col h-full">
  <!-- Header -->
  <div class="flex items-center gap-3 px-2 py-3 border-b border-md-outline-variant/30">
    <button
      class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-md-secondary-container transition-colors"
      onclick={onBack}
      aria-label={$t('common.back')}
    >
      <Icon name="chevronLeft" class="w-5 h-5" />
    </button>
    <div>
      <h1 class="text-sm font-semibold text-md-on-surface">{$t('storagePerformance.title')}</h1>
      <p class="text-xs text-md-on-surface/50">{$t('storagePerformance.subtitle')}</p>
    </div>
  </div>

  <div class="flex-1 overflow-y-auto px-2 py-3 space-y-4">

    <!-- Favicon Caching Mode -->
    <section class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="globe" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('storagePerformance.faviconCaching')}</span>
      </div>
      <div class="bg-md-primary-container rounded-xl px-3 py-3">
        <div class="text-sm font-medium text-md-on-surface mb-1">{$t('storagePerformance.cachingMode')}</div>
        <div class="text-xs text-md-on-surface/50 mb-2">{$t('storagePerformance.cachingModeDescription')}</div>
        <div class="flex items-center justify-between gap-3">
          <div class="text-xs text-md-on-surface/60">
            {faviconCaching === 'local' ? $t('storagePerformance.localStorageMode') : $t('storagePerformance.directFromSource')}
          </div>
          <Dropdown
            class="shrink-0"
            variant="secondary"
            size="sm"
            ariaLabel={$t('storagePerformance.selectCachingMode')}
            value={faviconCaching}
            onchange={(v) => {
              onSetFaviconCaching?.(v === 'local' ? 'local' : 'direct');
              onSaveSettings();
            }}
            options={[
              { value: 'direct', label: $t('storagePerformance.direct') },
              { value: 'local', label: $t('storagePerformance.local') },
            ]}
          />
        </div>
      </div>

      <!-- Favicon Cache Stats -->
      <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-3">
        <div class="text-xs text-md-on-surface/60">{$t('storagePerformance.sharedAcrossContexts')}</div>

        <!-- Storage usage bar -->
        <div>
          <div class="flex justify-between text-xs text-md-on-surface/60 mb-1">
            <span>{formatBytes(storageUsageBytes)} / {formatBytes(STORAGE_LIMIT)}</span>
            <span
              class="font-medium {storageUsageBytes >= STORAGE_CRITICAL_THRESHOLD ? 'text-md-error' : storageUsageBytes >= STORAGE_WARNING_THRESHOLD ? 'text-md-warning' : ''}"
            >
              {$t('storagePerformance.percentUsed', { values: { pct: quotaPercent } })}
            </span>
          </div>
          <div class="w-full bg-md-secondary-container rounded-full h-1.5 overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300 w-[var(--progress)] {storageUsageBytes >= STORAGE_CRITICAL_THRESHOLD ? 'bg-md-error' : storageUsageBytes >= STORAGE_WARNING_THRESHOLD ? 'bg-md-warning' : 'bg-md-primary'}"
              style="--progress: {Math.min((storageUsageBytes / STORAGE_LIMIT) * 100, 100)}%"
            ></div>
          </div>
          {#if storageUsageBytes >= STORAGE_CRITICAL_THRESHOLD}
            <div class="text-xs text-md-error mt-1.5">{$t('storagePerformance.quotaCritical')}</div>
          {/if}
        </div>

        {#if !hasUnlimitedStorage && !_isFirefox && storageUsageBytes >= STORAGE_WARNING_THRESHOLD}
          <button
            class="w-full py-1.5 px-3 rounded-lg text-xs font-medium bg-md-warning text-md-on-warning hover:opacity-90 disabled:opacity-50 transition-colors"
            onclick={handleRequestUnlimitedStorage}
            disabled={requestingPermission}
          >
            {requestingPermission ? $t('common.loading') : $t('settings.requestUnlimitedStorage')}
          </button>
        {/if}
        {#if hasUnlimitedStorage}
          <div class="text-xs text-md-success">✓ {$t('settings.unlimitedStorageGranted')}</div>
        {/if}
        {#if _isFirefox && storageUsageBytes >= STORAGE_WARNING_THRESHOLD}
          <div class="text-xs text-md-warning">{$t('storagePerformance.firefoxLimit')}</div>
        {/if}

        <div class="flex items-center justify-between">
          <span class="text-xs text-md-on-surface/50">
            {$t('storagePerformance.faviconsCached', { default: 'storagePerformance.faviconsCachedPlural', values: { n: faviconCacheCount, size: formatBytes(totalCacheSize) } })}
          </span>
          <button
            class="text-xs text-md-error hover:underline disabled:opacity-50"
            onclick={handleClearFaviconCache}
            disabled={clearingFaviconCache || faviconCacheCount === 0}
          >
            {clearingFaviconCache ? $t('common.loading') : $t('settings.clearFaviconCache')}
          </button>
        </div>
      </div>
    </section>

    <!-- Email Retention -->
    <section class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="mail" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('storagePerformance.emailData')}</span>
      </div>
      <div class="bg-md-primary-container rounded-xl px-3 py-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <div class="text-sm font-medium text-md-on-surface">{$t('settings.emailRetention')}</div>
            <div class="text-xs text-md-on-surface/50">{$t('settings.emailRetentionDescription')}</div>
          </div>
          <Dropdown
            class="shrink-0"
            variant="secondary"
            size="sm"
            ariaLabel={$t('storagePerformance.selectRetention')}
            value={emailRetentionDays}
            placeholder={$t('storagePerformance.days30')}
            onchange={(v) => {
              onSetEmailRetentionDays?.(Number(v));
              onSaveSettings();
            }}
            options={retentionOptions.map((o) => ({ value: o.value, label: $t(o.labelKey) }))}
          />
        </div>
      </div>
    </section>

    <!-- Storage Breakdown -->
    <section class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="database" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('storagePerformance.storageUsage')}</span>
      </div>
      <div class="bg-md-primary-container rounded-xl px-3 py-3">
        <div class="text-sm font-medium text-md-on-surface mb-1">{$t('settings.storageUsage')}</div>
        <div class="text-xs text-md-on-surface/50 mb-2">
          {#if loadingStorage}
            {$t('storagePerformance.loading')}
          {:else if storageUsage}
            {$t('storagePerformance.mbUsed', { values: { mb: storageUsage.totalMB.toFixed(2) } })}
          {:else}
            {$t('storagePerformance.unableToLoad')}
          {/if}
        </div>
        {#if storageUsage && !loadingStorage}
          <div class="w-full bg-md-secondary-container rounded-full h-2 overflow-hidden mb-3">
            <div
              class="bg-md-primary h-full transition-all duration-300 w-[var(--progress)]"
              style="--progress: {Math.min((storageUsage.totalMB / 10) * 100, 100)}%"
            ></div>
          </div>
          <div class="text-xs text-md-on-surface/40 mb-3">{$t('storagePerformance.chromeLimit')}</div>
          <div class="space-y-2 mb-3">
            <div class="flex items-center justify-between text-xs">
              <span class="text-md-on-surface/60">{$t('storagePerformance.emails')}</span>
              <span class="text-md-on-surface">{storageUsage.categories.emails.toFixed(2)} MB</span>
            </div>
            <div class="flex items-center justify-between text-xs">
              <span class="text-md-on-surface/60">{$t('storagePerformance.settings')}</span>
              <span class="text-md-on-surface">{storageUsage.categories.settings.toFixed(2)} MB</span>
            </div>
            <div class="flex items-center justify-between text-xs">
              <span class="text-md-on-surface/60">{$t('storagePerformance.cachedData')}</span>
              <span class="text-md-on-surface">{storageUsage.categories.cached.toFixed(2)} MB</span>
            </div>
            <div class="flex items-center justify-between text-xs">
              <span class="text-md-on-surface/60">{$t('storagePerformance.other')}</span>
              <span class="text-md-on-surface">{storageUsage.categories.other.toFixed(2)} MB</span>
            </div>
          </div>
          <!-- Per-inbox message counts -->
          <div class="mb-3 border-t border-md-outline-variant/30 pt-2">
            <div class="text-xs font-medium text-md-on-surface/60 mb-1.5">{$t('storagePerformance.perInboxTitle')}</div>
            {#if !perInbox || perInbox.length === 0}
              <div class="text-xs text-md-on-surface/40">{$t('storagePerformance.noEmails')}</div>
            {:else}
              <div class="space-y-1 max-h-36 overflow-y-auto pr-1 scrollbar-thin">
                {#each perInbox as row (row.address)}
                  <div class="flex items-center justify-between text-xs gap-2">
                    <span class="text-md-on-surface/60 truncate min-w-0" title={row.address}>{row.address}</span>
                    <span class="text-md-on-surface shrink-0 whitespace-nowrap">
                      <span class="count-tick inline-block">{#key row.active}{$t('storagePerformance.messages', {
                        default: 'storagePerformance.messagesPlural',
                        values: { n: row.active },
                      })}{/key}</span>
                      {#if row.archived > 0}
                        <span class="text-md-on-surface/40"> · <span class="count-tick inline-block">{#key row.archived}{$t('storagePerformance.archivedCount', { default: 'storagePerformance.archivedCountPlural', values: { n: row.archived } })}{/key}</span></span>
                      {/if}
                    </span>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
          {#if emailRetentionDays !== 0}
            <button
              class="w-full px-3 py-2 text-xs rounded-xl bg-md-secondary text-md-on-secondary hover:bg-md-secondary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onclick={onClearOldEmails}
              disabled={clearingEmails}
            >
              {clearingEmails ? $t('storagePerformance.clearing') : $t('storagePerformance.clearOldEmails')}
            </button>
          {/if}
        {/if}
      </div>
    </section>
    <!-- Dynamic End-of-Page Spacer: allows content to flow behind floating nav while ensuring the final section can scroll cleanly above controls -->
    <div
      class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
      style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
      aria-hidden="true"
    ></div>
  </div>

</div>
