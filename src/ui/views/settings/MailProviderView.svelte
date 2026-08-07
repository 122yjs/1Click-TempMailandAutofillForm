<script lang="ts">
import { onMount } from 'svelte';
import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import {
  type RankedProvider,
  rankProvidersByHealth,
} from '@/features/intelligence/provider-health.js';
import ToastContainer from '@/ui/blocks/feedback/ToastContainer.svelte';
import ModalDialog from '@/ui/components/composites/ModalDialog.svelte';
import SettingCard from '@/ui/components/composites/SettingCard.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Btn, Dropdown, InputField } from '@/ui/components/primitives';
import Badge from '@/ui/components/primitives/Badge.svelte';
import { BLOCKED_TEMP_MAIL_SITES } from '@/utils/blocked-temp-mail-sites.js';
import {
  exportProvidersAsJson,
  getAllProviderConfigs,
  loadProviderConfig,
  type ProviderConfig,
  saveProviderOverridesToStorage,
} from '@/utils/email-service.js';
import { getErrorMessage } from '@/utils/errors.js';
import { getDisabledInstances, setDisabledInstances } from '@/utils/instance-manager.js';
import * as PingService from '@/utils/ping-service.js';
import { PORTAL_Z } from '@/utils/portal-layers.js';
import { domainIndexKey } from '@/utils/storage-keys.js';
import { timeAgo } from '@/utils/time-format.js';
import { toastStore } from '@/utils/toastStore.js';
import type { Account, ProviderInstance } from '@/utils/types.js';

let {
  onBack = () => {},
  selectedProvider = '',
  autoRenew = false,
  notificationsEnabled = false,
  soundEnabled = false,
  expiryWarningThreshold = 60 * 60 * 1000,
  autoRefreshInterval = 30000,
  emailPreviewEnabled = true,
  providerInstances = [] as ProviderInstance[],
  selectedProviderInstance = null as string | null,
  defaultDomain = '',
  allInboxes = [] as Account[],
  onProviderChange = (_p: string) => {},
  onSetAutoRenew = undefined as ((v: boolean) => void) | undefined,
  onSetNotificationsEnabled = undefined as ((v: boolean) => void) | undefined,
  onSetSoundEnabled = undefined as ((v: boolean) => void) | undefined,
  onSetExpiryWarningThreshold = undefined as ((v: number) => void) | undefined,
  onSetAutoRefreshInterval = undefined as ((v: number) => void) | undefined,
  onSetEmailPreviewEnabled = undefined as ((v: boolean) => void) | undefined,
  onSetProviderInstance = (_id: string) => {},
  onAddCustomInstance = (_name: string, _url: string) => {},
  onLoadProviderInstances = async () => {},
  onSetDefaultDomain = undefined as ((v: string) => void) | undefined,
  onSaveSettings = () => {},
  onNavigateTo = undefined,
} = $props<{
  onBack?: () => void;
  selectedProvider?: string;
  autoRenew?: boolean;
  notificationsEnabled?: boolean;
  soundEnabled?: boolean;
  expiryWarningThreshold?: number;
  autoRefreshInterval?: number;
  emailPreviewEnabled?: boolean;
  providerInstances?: ProviderInstance[];
  selectedProviderInstance?: string | null;
  defaultDomain?: string;
  allInboxes?: Account[];
  onProviderChange?: (p: string) => void;
  onSetAutoRenew?: (v: boolean) => void;
  onSetNotificationsEnabled?: (v: boolean) => void;
  onSetSoundEnabled?: (v: boolean) => void;
  onSetExpiryWarningThreshold?: (v: number) => void;
  onSetAutoRefreshInterval?: (v: number) => void;
  onSetEmailPreviewEnabled?: (v: boolean) => void;
  onSetProviderInstance?: (id: string) => void;
  onAddCustomInstance?: (name: string, url: string) => void;
  onLoadProviderInstances?: () => void | Promise<void>;
  onSetDefaultDomain?: (v: string) => void;
  onSaveSettings?: () => void;
  onNavigateTo?: (view: string) => void;
}>();

let allProviders = $derived.by((): ProviderConfig[] => getAllProviderConfigs());
let activeTabProviderId = $state<string>('tempmail.lol');
$effect(() => {
  if (selectedProvider) {
    activeTabProviderId = selectedProvider;
  }
});
// Provider select moved to the shared <Dropdown> primitive. Ping latency is
// embedded in the label so it stays visible on the collapsed trigger too
// (matches the old button which showed ping inline for the selected provider).
let providerOptions = $derived(
  allProviders.map((p) => {
    const ping = providerPingResults.get(p.id) ?? null;
    const fastest = ping ? PingService.getFastestPing(ping) : null;
    const pingText =
      fastest !== null && fastest !== undefined
        ? `${getPingDot(fastest)} ${formatPing(fastest)}`
        : '⏳';
    return { value: p.id, label: `${p.displayName}  ${pingText}` };
  })
);
let showCustomInstanceForm = $state(false);
let customInstanceName = $state('');
let customInstanceUrl = $state('');
let pinging = $state(false);
let providerPingResults = $state(new Map<string, Map<string, number | 'timeout'>>());
/** Disabled (blacklist) instance ids for the active provider — checkbox pool. */
let disabledInstances = $state<Set<string>>(new Set());
// Provider health dashboard — create/fetch success + latency (intelligence graph)
let providerHealth = $state<RankedProvider[] | null>(null);
let lastFailover = $state<{
  requested: string;
  used: string;
  at: number;
  reason?: 'retry' | 'health';
} | null>(null);
// Instance-level auto-failover (multi-instance pool fell back mid-create).
let lastInstanceFailover = $state<{ requested: string; used: string; at: number } | null>(null);
// Legacy single-pin props kept for AppLayout wire-compat (pool model replaces them).
$effect(() => {
  void onSetProviderInstance;
  void selectedProviderInstance;
});

async function pingAllProviders() {
  if (pinging) return;
  pinging = true;
  const results = new Map<string, Map<string, number | 'timeout'>>();
  for (const provider of allProviders) {
    const config = loadProviderConfig(provider.id);
    const pingResults = await PingService.pingProviderInstances(
      config,
      config.multiInstance?.enabled && providerInstances.length > 0 ? providerInstances : []
    );
    results.set(provider.id, pingResults);
  }
  providerPingResults = results;
  await loadProviderHealth();
  pinging = false;
}

function getPingDot(ping: number | 'timeout'): string {
  if (ping === 'timeout') return '🔴';
  if (ping < 100) return '🟢';
  if (ping < 300) return '🟡';
  return '🔴';
}

function formatPing(ping: number | 'timeout' | undefined | null): string {
  if (ping === 'timeout') return $t('ping.timeout');
  if (ping === undefined || ping === null) return '…';
  return PingService.formatPing(ping);
}

async function loadProviderHealth() {
  try {
    providerHealth = await rankProvidersByHealth(allProviders.map((p) => p.id));
  } catch {
    /* intelligence storage unavailable */
    providerHealth = null;
  }
}

function providerDisplayName(id: string): string {
  try {
    return loadProviderConfig(id).displayName || id;
  } catch {
    return id;
  }
}

function healthScoreColor(score: number): string {
  if (score >= 70) return 'text-md-success';
  if (score >= 40) return 'text-md-warning';
  return 'text-md-error';
}

function successRate(attempts: number, successes: number): string | null {
  if (attempts <= 0) return null;
  return `${Math.round((successes / attempts) * 100)}%`;
}

function avgLatency(samples: number[]): string | null {
  if (!samples || samples.length === 0) return null;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return avg >= 1000 ? `${(avg / 1000).toFixed(1)}s` : `${Math.round(avg)}ms`;
}

async function loadLastFailover() {
  try {
    const { lastProviderFailover } = (await browser.storage.local.get([
      'lastProviderFailover',
    ])) as {
      lastProviderFailover?: {
        requested: string;
        used: string;
        at: number;
        reason?: 'retry' | 'health';
      };
    };
    lastFailover =
      lastProviderFailover && Date.now() - lastProviderFailover.at < 30 * 60 * 1000
        ? lastProviderFailover
        : null;
  } catch {
    lastFailover = null;
  }
}

async function loadLastInstanceFailover() {
  try {
    const { lastInstanceFailover: stored } = (await browser.storage.local.get([
      'lastInstanceFailover',
    ])) as {
      lastInstanceFailover?: { requested: string; used: string; at: number };
    };
    lastInstanceFailover = stored && Date.now() - stored.at < 30 * 60 * 1000 ? stored : null;
  } catch {
    lastInstanceFailover = null;
  }
}

async function handleProviderChange(provider: string) {
  await browser.storage.local.set({ selectedProvider: provider });
  await browser.runtime.sendMessage({ type: 'setProvider', provider });
  onProviderChange(provider);
  const config = loadProviderConfig(provider);
  if (config.multiInstance?.enabled) {
    await onLoadProviderInstances();
  }
}

function showAddCustomInstance() {
  showCustomInstanceForm = true;
  customInstanceName = '';
  customInstanceUrl = '';
}

function hideCustomInstanceForm() {
  showCustomInstanceForm = false;
  customInstanceName = '';
  customInstanceUrl = '';
}

function saveCustomInstance() {
  const name = customInstanceName.trim();
  const url = customInstanceUrl.trim();
  if (!name || !url) return;
  onAddCustomInstance(name, url);
  hideCustomInstanceForm();
}

// Domain override state - username -> effective domain string
let domainOverrides = $state<Record<string, string>>({});

// Runtime provider JSON editor (overrides bundled providers.jsonc via storage)
let jsonEditorOpen = $state(false);
let providerJsonText = $state('');
let jsonEditorError = $state('');
let jsonEditorStatus = $state('');
let jsonSaving = $state(false);

async function saveProviderJson() {
  jsonEditorError = '';
  jsonEditorStatus = '';
  jsonSaving = true;
  try {
    const parsed = JSON.parse(providerJsonText) as ProviderConfig[];
    if (!Array.isArray(parsed)) throw new Error('Root must be a JSON array of providers');
    await saveProviderOverridesToStorage(browser, parsed);
    jsonEditorStatus = get(t)('mailProvider.editJsonSaved') as string;
    toastStore.success(get(t)('mailProvider.editJsonSaved') as string);
  } catch (e) {
    jsonEditorError = e instanceof Error ? e.message : String(e);
  } finally {
    jsonSaving = false;
  }
}

async function resetProviderJson() {
  jsonSaving = true;
  jsonEditorError = '';
  try {
    await saveProviderOverridesToStorage(browser, null);
    providerJsonText = exportProvidersAsJson();
    jsonEditorStatus = get(t)('mailProvider.editJsonResetDone') as string;
  } catch (e) {
    jsonEditorError = e instanceof Error ? e.message : String(e);
  } finally {
    jsonSaving = false;
  }
}

async function loadDomainOverrides() {
  const config = loadProviderConfig(selectedProvider);
  const domains = config.multiDomain?.domains || [];
  if (domains.length === 0) return;
  const multiDomainAccounts = allInboxes.filter((a: Account) => a.provider === selectedProvider);
  if (multiDomainAccounts.length === 0) return;
  const keys = multiDomainAccounts.map((a: Account) =>
    domainIndexKey(selectedProvider, a.address.split('@')[0])
  );
  const result = (await browser.storage.local.get(keys)) as Record<string, number>;
  const overrides: Record<string, string> = {};
  for (const acc of multiDomainAccounts) {
    const username = acc.address.split('@')[0];
    const key = domainIndexKey(selectedProvider, username);
    const idx = result[key];
    overrides[username] = idx !== undefined ? domains[idx] || domains[0] : domains[0];
  }
  domainOverrides = overrides;
}

function getEffectiveDomain(account: Account): string {
  if (!loadProviderConfig(account.provider).multiDomain?.enabled)
    return account.address.split('@')[1] || '';
  const username = account.address.split('@')[0];
  return domainOverrides[username] || account.address.split('@')[1] || '';
}

onMount(() => {
  loadDomainOverrides();
  loadLastFailover().then(() => {
    // Toast only on genuine failure-then-retry failover; a proactive health
    // pick (provider merely deprioritized, not down) stays in the inline card.
    if (lastFailover && lastFailover.reason !== 'health') {
      toastStore.info(
        get(t)('mailProvider.failoverNotice', {
          values: {
            from: providerDisplayName(lastFailover.requested),
            to: providerDisplayName(lastFailover.used),
          },
        })
      );
    }
  });
  loadLastInstanceFailover().then(() => {
    if (lastInstanceFailover) {
      toastStore.info(
        get(t)('mailProvider.instanceFailoverNotice', {
          values: {
            from: lastInstanceFailover.requested,
            to: lastInstanceFailover.used,
          },
        })
      );
    }
  });
});

// Keep the failover notices live while the view is open (inbox creation can
// fail over in the background after this page mounted).
$effect(() => {
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local') return;
    if (changes.lastProviderFailover) void loadLastFailover();
    if (changes.lastInstanceFailover) void loadLastInstanceFailover();
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => browser.storage.onChanged.removeListener(onChanged);
});

$effect(() => {
  const timer = setTimeout(() => pingAllProviders(), 100);
  return () => clearTimeout(timer);
});

$effect(() => {
  void loadProviderHealth();
});

async function loadDisabledInstances() {
  try {
    disabledInstances = new Set(await getDisabledInstances(selectedProvider));
  } catch {
    /* ignore */
    disabledInstances = new Set();
  }
}

async function toggleInstance(instance: ProviderInstance) {
  const willDisable = !disabledInstances.has(instance.id);
  // Min-1 guard: never allow disabling every instance (config + custom).
  if (willDisable && providerInstances.length - disabledInstances.size <= 1) {
    toastStore.warning($t('mailProvider.minOneInstance'));
    return;
  }
  const next = new Set(disabledInstances);
  if (willDisable) next.add(instance.id);
  else next.delete(instance.id);
  try {
    await setDisabledInstances(selectedProvider, [...next]);
    disabledInstances = next;
  } catch (err) {
    toastStore.error(getErrorMessage(err));
  }
}

$effect(() => {
  const config = loadProviderConfig(selectedProvider);
  if (config.multiInstance?.enabled) onLoadProviderInstances();
  if (config.multiDomain?.enabled) loadDomainOverrides();
  void loadDisabledInstances();
});

// Reload overrides when inboxes change
$effect(() => {
  if (allInboxes.length >= 0 && loadProviderConfig(selectedProvider).multiDomain?.enabled)
    loadDomainOverrides();
});

// Domain switch dialog state
let domainSwitchDialog = $state<{
  pendingDomain: string;
  domains: string[];
  domainCounts: Record<string, number>;
} | null>(null);
let domainSwitchScope = $state<'new' | 'existing'>('new');
let domainSwitchAll = $state(true);
let domainSwitchFromDomain = $state<string>('');

function openDomainSwitchDialog(newDomain: string) {
  const config = loadProviderConfig(selectedProvider);
  const domains = config.multiDomain?.domains || [];
  const multiDomainAccounts = allInboxes.filter(
    (a: Account) => a.provider === selectedProvider && a.status === 'active'
  );
  const domainCounts: Record<string, number> = {};
  for (const d of domains) domainCounts[d] = 0;
  for (const acc of multiDomainAccounts) {
    const d = getEffectiveDomain(acc);
    if (d && d in domainCounts) domainCounts[d]++;
  }
  domainSwitchDialog = { pendingDomain: newDomain, domains, domainCounts };
  domainSwitchScope = 'new';
  domainSwitchAll = true;
  domainSwitchFromDomain = '';
}

async function applyDomainSwitch() {
  if (!domainSwitchDialog) return;
  const { pendingDomain, domains } = domainSwitchDialog;

  const prevDefault = defaultDomain;
  onSetDefaultDomain?.(pendingDomain);
  onSaveSettings();

  if (domainSwitchScope === 'existing') {
    const { inboxes = [] } = (await browser.storage.local.get(['inboxes'])) as {
      inboxes?: Account[];
    };
    const toUpdate = domainSwitchAll
      ? inboxes.filter((a) => a.provider === selectedProvider && a.status === 'active')
      : inboxes.filter((a) => {
          const d = getEffectiveDomain(a);
          return (
            a.provider === selectedProvider && a.status === 'active' && d === domainSwitchFromDomain
          );
        });

    const pendingIndex = domains.indexOf(pendingDomain);
    const storageUpdates: Record<string, number> = {};
    /** Snapshot previous domain indices for undo */
    const undoSnapshot: Record<string, number> = {};
    for (const acc of toUpdate) {
      const key = domainIndexKey(selectedProvider, acc.address.split('@')[0]);
      const prev = (await browser.storage.local.get([key])) as Record<string, number | undefined>;
      if (typeof prev[key] === 'number') undoSnapshot[key] = prev[key] as number;
      else undoSnapshot[key] = 0;
      storageUpdates[key] = pendingIndex >= 0 ? pendingIndex : 0;
    }
    if (Object.keys(storageUpdates).length > 0) {
      await browser.storage.local.set(storageUpdates);
    }
    if (toUpdate.length > 0) {
      toastStore.success(
        get(t)('mailProvider.updatedAddresses', {
          default: 'mailProvider.updatedAddressesPlural',
          values: { n: toUpdate.length, domain: pendingDomain },
        }),
        10000,
        async () => {
          await browser.storage.local.set(undoSnapshot);
          onSetDefaultDomain?.(prevDefault || '');
          onSaveSettings();
          await loadDomainOverrides();
          toastStore.info(get(t)('mailProvider.domainSwitchUndone') as string);
        }
      );
      await loadDomainOverrides();
    }
  }

  domainSwitchDialog = null;
}
</script>

<div class="flex flex-col h-full">
  <!-- Title + actions - back lives in app header on this deep page -->
  <div class="flex items-center gap-3 px-2 py-3 border-b border-md-outline-variant/30">
    <div class="flex-1">
      <h1 class="text-sm font-semibold text-md-on-surface">{$t('mailProvider.title')}</h1>
      <p class="text-xs text-md-on-surface/50">{$t('mailProvider.subtitle')}</p>
    </div>
    <button
      class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-md-secondary-container transition-colors"
      onclick={() => { providerPingResults = new Map(); pingAllProviders(); }}
      aria-label={$t('mailProvider.rep')}
    >
      <Icon name="refresh" class="w-4 h-4" />
    </button>
  </div>

  <div class="flex-1 overflow-y-auto px-2 py-3 space-y-4">

    <!-- Provider Selection -->
    <section class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="instances" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('mailProvider.provider')}</span>
      </div>
      <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-1.5">
        <div class="text-xs font-medium text-md-on-surface/60">{$t('mailProvider.mailProvider')}</div>
        <Dropdown
          variant="outlined"
          value={selectedProvider}
          ariaLabel={$t('mailProvider.selectMailProvider')}
          options={providerOptions}
          onchange={(v) => handleProviderChange(v as string)}
        />
      </div>

      <!-- Programmatic Provider Tabs Row -->
      <div class="flex items-center gap-1 overflow-x-auto py-1 scrollbar-none border-b border-md-outline-variant/20 mb-1">
        {#each allProviders as provider (provider.id)}
          {@const isActiveTab = activeTabProviderId === provider.id}
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors {isActiveTab ? 'bg-md-primary text-md-on-primary shadow-xs' : 'bg-md-surface-variant/40 text-md-on-surface/70 hover:bg-md-surface-variant'}"
            onclick={() => activeTabProviderId = provider.id}
          >
            {provider.displayName}
            {#if provider.id === selectedProvider}
              <span class="ms-1 text-label-sm opacity-80" title={$t('common.active') || 'Active'}>★</span>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Instance Selection: checkbox pool — only ticked instances are used for generation -->
      {#if loadProviderConfig(selectedProvider).multiInstance?.enabled}
        <div class="bg-md-primary-container rounded-xl px-3 py-3">
          <div class="flex items-center justify-between gap-2 mb-1.5">
            <div class="text-xs font-medium text-md-on-surface/60">{$t('mailProvider.instance')}</div>
            <span class="text-label-sm text-md-on-surface/50">
              {$t('mailProvider.enabledCount', {
                values: { n: Math.max(0, (providerInstances.length || 0) - disabledInstances.size) },
              })}
            </span>
          </div>
          <p class="text-xs text-md-on-surface/50 mb-2">{$t('mailProvider.instanceCheckboxHint')}</p>
          <div class="flex flex-col gap-1">
            {#each providerInstances as instance}
              {@const enabled = !disabledInstances.has(instance.id)}
              {@const pingResults = providerPingResults.get(selectedProvider)}
              {@const instancePing = pingResults?.get(instance.id)}
              <button
                type="button"
                role="checkbox"
                aria-checked={enabled}
                class="w-full px-2 py-1.5 rounded-lg text-start text-sm hover:bg-md-secondary-container/60 flex items-center gap-2"
                onclick={() => void toggleInstance(instance)}
              >
                <Icon
                  name={enabled ? 'checkBox' : 'checkBoxBlank'}
                  class="w-4 h-4 shrink-0 {enabled ? 'text-md-primary' : 'text-md-on-surface/25'}"
                />
                <span class="flex-1 min-w-0 truncate text-md-on-surface">
                  {instance.displayName}{instance.isCustom ? $t('mailProvider.instanceCustom') : ''}
                </span>
                {#if instancePing !== undefined && instancePing !== null}
                  <span class="text-xs text-md-on-surface/50 shrink-0">{getPingDot(instancePing)} {formatPing(instancePing)}</span>
                {:else}
                  <span class="text-xs text-md-on-surface/50 shrink-0">⏳</span>
                {/if}
              </button>
            {/each}
          </div>
        </div>

        {#if !showCustomInstanceForm}
          <button class="btn-primary w-full rounded-xl py-2.5 flex items-center justify-center gap-2 text-sm" onclick={showAddCustomInstance}>
            <Icon name="plus" class="w-4 h-4" />{$t('mailProvider.addInstance')}
          </button>
        {:else}
          <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-3">
            <div>
              <div class="text-xs font-medium text-md-on-surface/60 mb-1.5">{$t('mailProvider.instanceName')}</div>
              <InputField placeholder={$t('mailProvider.instanceNamePlaceholder')} bind:value={customInstanceName} />
            </div>
            <div class="border-t border-md-outline-variant/30"></div>
            <div>
              <div class="text-xs font-medium text-md-on-surface/60 mb-1.5">{$t('mailProvider.apiUrl')}</div>
              <InputField type="url" placeholder={$t('mailProvider.apiUrlPlaceholder')} bind:value={customInstanceUrl} />
            </div>
            <div class="flex gap-2">
              <Btn variant="primary" size="md" class="flex-1" onclick={saveCustomInstance}>{$t('mailProvider.save')}</Btn>
              <Btn variant="secondary" size="md" class="flex-1" onclick={hideCustomInstanceForm}>{$t('mailProvider.cancel')}</Btn>
            </div>
          </div>
        {/if}
      {/if}

      <!-- Default Domain -->
      {#if loadProviderConfig(selectedProvider).multiDomain?.enabled}
        {@const md = loadProviderConfig(selectedProvider).multiDomain}
        {@const multiDomainActive = allInboxes.filter((a: Account) => a.provider === selectedProvider && a.status === 'active')}
        {@const _overrides = domainOverrides}
        <div class="bg-md-tertiary-container rounded-xl px-3 py-3">
          <div class="text-xs font-medium text-md-on-surface/60 mb-1.5">{$t('mailProvider.defaultDomain')}</div>

          <!-- Domain address count stats -->
          {#if multiDomainActive.length > 0}
            <div class="flex flex-wrap gap-x-3 gap-y-1 mb-2.5">
              {#each md?.domains || [] as d}
                {@const count = multiDomainActive.filter((a: Account) => getEffectiveDomain(a) === d).length}
                <div class="flex items-center gap-1.5">
                  <span class="text-label-sm font-medium text-md-on-surface">@{d}</span>
                  <span class="text-xs px-1.5 py-0.5 rounded-full font-semibold {count > 0 ? 'bg-md-primary/15 text-md-primary' : 'bg-md-secondary-container text-md-on-surface/40'}">{count}</span>
                </div>
              {/each}
            </div>
          {/if}

          <Dropdown
            variant="outlined"
            ariaLabel={$t('mailProvider.defaultDomain')}
            value={defaultDomain || ''}
            onchange={(v) => openDomainSwitchDialog(String(v))}
            options={[
              { value: '', label: $t('mailProvider.cycleNoDefault') },
              ...(md?.domains || []).map((domain) => ({ value: domain, label: `@${domain}` })),
            ]}
          />
          <div class="text-xs text-md-on-surface/50 mt-1">{$t('mailProvider.defaultDomainDescription')}</div>
        </div>
      {/if}
    </section>

    <!-- Sites known to reject disposable / temp-mail addresses -->
    <section class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="shield" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('mailProvider.blockedSitesTitle')}</span>
      </div>
      <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
        <p class="text-xs text-md-on-surface/60 leading-relaxed">
          {$t('mailProvider.blockedSitesDescription')}
        </p>
        <ul class="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto" aria-label={$t('mailProvider.blockedSitesTitle')}>
          {#each BLOCKED_TEMP_MAIL_SITES as site (site)}
            <li
              class="px-2 py-0.5 rounded-lg text-label-sm font-medium bg-md-surface-variant/80 text-md-on-surface/75 border border-md-outline-variant/40"
            >
              {site}
            </li>
          {/each}
        </ul>
        <p class="text-label-sm text-md-on-surface/45 leading-snug">
          {$t('mailProvider.blockedSitesNote')}
        </p>
      </div>
    </section>

    <!-- Provider Health Dashboard -->
    <section class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="barChart" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('mailProvider.healthTitle')}</span>
      </div>

      {#if lastFailover}
        <div
          class="bg-md-warning/15 border border-md-warning/40 text-md-warning rounded-xl px-3 py-2 text-xs"
          role="status"
          aria-label={$t('mailProvider.failoverAria')}
        >
          {lastFailover.reason === 'health'
            ? $t('mailProvider.healthPickNotice', {
                values: {
                  from: providerDisplayName(lastFailover.requested),
                  to: providerDisplayName(lastFailover.used),
                },
              })
            : $t('mailProvider.failoverNotice', {
                values: {
                  from: providerDisplayName(lastFailover.requested),
                  to: providerDisplayName(lastFailover.used),
                },
              })}
        </div>
      {/if}

      {#if lastInstanceFailover}
        <div
          class="bg-md-tertiary/15 border border-md-tertiary/40 text-md-tertiary rounded-xl px-3 py-2 text-xs"
          role="status"
          aria-label={$t('mailProvider.instanceFailoverAria')}
        >
          {$t('mailProvider.instanceFailoverNotice', {
            values: {
              from: lastInstanceFailover.requested,
              to: lastInstanceFailover.used,
            },
          })}
        </div>
      {/if}

      <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
        <p class="text-xs text-md-on-surface/60">{$t('mailProvider.healthSubtitle')}</p>
        <div class="space-y-1.5">
          {#each providerHealth ?? [] as row (row.providerId)}
            {@const h = row.health}
            {@const hasData = h.createAttempts + h.fetchAttempts > 0}
            {@const createRate = successRate(h.createAttempts, h.createSuccesses)}
            {@const fetchRate = successRate(h.fetchAttempts, h.fetchSuccesses)}
            {@const lat = avgLatency(h.createLatencyMs)}
            <div class="flex items-center gap-3 bg-md-surface-variant/40 rounded-xl px-3 py-2">
              <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-md-on-surface truncate">{providerDisplayName(row.providerId)}</div>
                <div class="text-xs text-md-on-surface/50 mt-0.5">
                  {#if h.lastFailureAt}
                    <span class="text-md-error">{timeAgo(h.lastFailureAt)}</span>
                  {:else if !hasData}
                    <span>{$t('mailProvider.healthNoData')}</span>
                  {:else}
                    <span class="text-md-success">✓</span>
                  {/if}
                </div>
              </div>
              {#if lat}
                <span class="text-xs text-md-on-surface/70 shrink-0" title={$t('mailProvider.healthLatency')}>⏱ {lat}</span>
              {/if}
              {#if createRate}
                <span class="text-xs text-md-on-surface/70 shrink-0" title={$t('mailProvider.healthCreateSuccess')}>↑ {createRate}</span>
              {/if}
              {#if fetchRate}
                <span class="text-xs text-md-on-surface/70 shrink-0" title={$t('mailProvider.healthFetchSuccess')}>↓ {fetchRate}</span>
              {/if}
              <span class="text-sm font-bold shrink-0 {hasData ? healthScoreColor(row.score) : 'text-md-on-surface/40'}">{hasData ? row.score : '—'}</span>
            </div>
          {/each}
        </div>
        {#if providerHealth === null}
          <div class="text-xs text-md-on-surface/50">{$t('mailProvider.healthNoData')}</div>
        {/if}
      </div>
    </section>

    <!-- Advanced: edit providers JSON (runtime override of providers.jsonc) -->
    <section class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="edit" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('mailProvider.editJsonTitle')}</span>
      </div>
      <div class="bg-md-primary-container rounded-xl px-3 py-3 space-y-2">
        <p class="text-xs text-md-on-surface/60">{$t('mailProvider.editJsonHint')}</p>
        {#if !jsonEditorOpen}
          <Btn
            variant="primaryOutline"
            size="md"
            class="w-full"
            onclick={() => {
              providerJsonText = exportProvidersAsJson();
              jsonEditorOpen = true;
              jsonEditorError = '';
              jsonEditorStatus = '';
            }}
          >
            {$t('mailProvider.editJsonOpen')}
          </Btn>
        {:else}
          <textarea
            class="w-full min-h-[180px] max-h-[320px] text-xs font-mono rounded-xl border border-md-outline-variant bg-md-surface px-2 py-2 outline-none focus:ring-2 focus:ring-md-primary"
            bind:value={providerJsonText}
            spellcheck="false"
            aria-label={$t('mailProvider.editJsonTitle')}
          ></textarea>
          {#if jsonEditorError}
            <p class="text-xs text-md-error">{jsonEditorError}</p>
          {/if}
          {#if jsonEditorStatus}
            <p class="text-xs text-md-primary">{jsonEditorStatus}</p>
          {/if}
          <div class="flex flex-wrap gap-2">
            <Btn
              variant="primary"
              size="sm"
              class="flex-1 min-w-[6rem]"
              disabled={jsonSaving}
              onclick={() => void saveProviderJson()}
            >{$t('common.save')}</Btn>
            <Btn
              variant="outline"
              size="sm"
              class="flex-1 min-w-[6rem]"
              onclick={() => {
                providerJsonText = exportProvidersAsJson();
                jsonEditorError = '';
                jsonEditorStatus = '';
              }}
            >{$t('mailProvider.editJsonReload')}</Btn>
            <Btn
              variant="dangerOutline"
              size="sm"
              class="flex-1 min-w-[6rem]"
              disabled={jsonSaving}
              onclick={() => void resetProviderJson()}
            >{$t('mailProvider.editJsonReset')}</Btn>
            <Btn
              variant="outline"
              size="sm"
              class="flex-1 min-w-[6rem]"
              onclick={() => {
                jsonEditorOpen = false;
                jsonEditorError = '';
                jsonEditorStatus = '';
              }}
            >{$t('common.close')}</Btn>
          </div>
        {/if}
      </div>
      <p class="text-label-sm text-md-on-surface/45 px-1">{$t('mailProvider.inboxMovedHint')}</p>
    </section>

    <!-- Dynamic End-of-Page Spacer: allows content to flow behind floating nav while ensuring the final section can scroll cleanly above controls -->
    <div
      class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
      style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
      aria-hidden="true"
    ></div>
  </div>
</div>

<!-- Domain Switch Dialog -->
{#if domainSwitchDialog}
  {@const { pendingDomain, domains, domainCounts } = domainSwitchDialog}
  <ModalDialog
    open={true}
    title={$t('mailProvider.switchDefaultDomain')}
    maxWidth="sm"
    showCloseButton={false}
    ariaLabel={$t('mailProvider.switchDefaultDomain')}
    onClose={() => { domainSwitchDialog = null; }}
  >
    <div class="text-xs text-md-on-surface/60 mb-3">
      {#if pendingDomain}
        {$t('mailProvider.switchingTo')} <span class="font-medium text-md-primary">@{pendingDomain}</span>
      {:else}
        {$t('mailProvider.removingDefaultDomain')}
      {/if}
    </div>

      <!-- Domain usage stats -->
      <div class="bg-md-secondary-container/50 rounded-xl px-3 py-2 mb-4 space-y-1">
        {#each domains as d}
          {@const count = domainCounts[d] ?? 0}
          <div class="flex justify-between items-center text-xs">
            <span class="text-md-on-surface/70">@{d}</span>
            <span class="font-medium text-md-on-surface">{$t('mailProvider.addressCount', { default: 'mailProvider.addressCountPlural', values: { n: count } })}</span>
          </div>
        {/each}
      </div>

      <!-- Scope selector -->
      <div class="space-y-2 mb-4">
        <button
          class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 transition-colors text-start {domainSwitchScope === 'new' ? 'border-md-primary bg-md-primary/10' : 'border-md-secondary-container bg-transparent'}"
          onclick={() => { domainSwitchScope = 'new'; }}
        >
          <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {domainSwitchScope === 'new' ? 'border-md-primary' : 'border-md-outline-variant'}">
            {#if domainSwitchScope === 'new'}<div class="w-2 h-2 rounded-full bg-md-primary"></div>{/if}
          </div>
          <div>
            <div class="text-sm font-medium text-md-on-surface">{$t('mailProvider.newAddressesOnly')}</div>
            <div class="text-xs text-md-on-surface/50">{$t('mailProvider.newAddressesOnlyDescription')}</div>
          </div>
        </button>
        {#if pendingDomain}
          <button
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 transition-colors text-start {domainSwitchScope === 'existing' ? 'border-md-primary bg-md-primary/10' : 'border-md-secondary-container bg-transparent'}"
            onclick={() => { domainSwitchScope = 'existing'; }}
          >
            <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {domainSwitchScope === 'existing' ? 'border-md-primary' : 'border-md-outline-variant'}">
              {#if domainSwitchScope === 'existing'}<div class="w-2 h-2 rounded-full bg-md-primary"></div>{/if}
            </div>
            <div>
              <div class="text-sm font-medium text-md-on-surface">{$t('mailProvider.alsoChangeExisting')}</div>
              <div class="text-xs text-md-on-surface/50">{$t('mailProvider.alsoChangeExistingDescription')}</div>
            </div>
          </button>
        {/if}
      </div>

      <!-- Sub-options when changing existing -->
      {#if domainSwitchScope === 'existing'}
        <div class="bg-md-secondary-container/50 rounded-xl px-2 py-2 mb-4 space-y-2">
          <button class="w-full flex items-center gap-2 text-start" onclick={() => { domainSwitchAll = true; }}>
            <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {domainSwitchAll ? 'border-md-primary' : 'border-md-outline-variant'}">
              {#if domainSwitchAll}<div class="w-2 h-2 rounded-full bg-md-primary"></div>{/if}
            </div>
            <span class="text-xs text-md-on-surface">{$t('mailProvider.changeAllAddresses')}</span>
          </button>
          <button class="w-full flex items-center gap-2 text-start" onclick={() => { domainSwitchAll = false; }}>
            <div class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 {!domainSwitchAll ? 'border-md-primary' : 'border-md-outline-variant'}">
              {#if !domainSwitchAll}<div class="w-2 h-2 rounded-full bg-md-primary"></div>{/if}
            </div>
            <span class="text-xs text-md-on-surface">{$t('mailProvider.onlyAddressesUsingDomain')}</span>
          </button>
          {#if !domainSwitchAll}
            <Dropdown
              class="mt-1"
              variant="outlined"
              zIndex={PORTAL_Z.dialogMenu}
              ariaLabel={$t('mailProvider.selectDomainFrom')}
              bind:value={domainSwitchFromDomain}
              options={[
                { value: '', label: $t('mailProvider.selectDomainFrom') },
                ...domains
                  .filter((d) => (domainCounts[d] ?? 0) > 0)
                  .map((d) => ({
                    value: d,
                    label: `@${d} (${$t('mailProvider.addressCount', {
                      default: 'mailProvider.addressCountPlural',
                      values: { n: domainCounts[d] },
                    })})`,
                  })),
              ]}
            />
          {/if}
        </div>
      {/if}

    {#snippet footer()}
      <Btn
        variant="secondary"
        size="md"
        class="flex-1"
        onclick={() => { domainSwitchDialog = null; }}
      >{$t('mailProvider.cancel')}</Btn>
      <Btn
        variant="primary"
        size="md"
        class="flex-1"
        disabled={domainSwitchScope === 'existing' && !domainSwitchAll && !domainSwitchFromDomain}
        onclick={applyDomainSwitch}
      >{$t('mailProvider.apply')}</Btn>
    {/snippet}
  </ModalDialog>
{/if}

<ToastContainer />
