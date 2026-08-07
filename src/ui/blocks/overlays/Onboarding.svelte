<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import { handleCreateInbox } from '@/features/onboarding/onboarding-actions.js';
import { setPendingProductTour } from '@/features/product-tour/tour-storage.js';
import LanguageSwitcher from '@/ui/components/composites/LanguageSwitcher.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import FaviconImage from '@/ui/components/primitives/FaviconImage.svelte';
import { avatarColor } from '@/utils/avatar-color.js';
import { getAllProviderConfigs, type ProviderConfig } from '@/utils/email-service.js';
import { setLanguage } from '@/utils/i18n';
import { mapToSupportedLocale } from '@/utils/i18n-utils.js';
import { getProviderInstancesWithCustom } from '@/utils/instance-manager.js';
import { logError } from '@/utils/logger.js';
import { getFastestPing, pingProviderInstances } from '@/utils/ping-service.js';

let {
  onCreateInbox,
  onStartProductTour = () => {},
  onImportBackup = () => {},
}: {
  onCreateInbox: (provider: string) => void | Promise<void>;
  /** Called after first inbox so parent can launch the interactive tour */
  onStartProductTour?: () => void;
  /** Open full import backup dialog */
  onImportBackup?: () => void;
} = $props();

let selectedProvider = $state<string>('');
let step = $state<1 | 2 | 3>(1);
let creating = $state(false);
let createError = $state('');
/** Best instance ping ms per provider id */
let providerPings = $state<Record<string, number | 'timeout' | '…'>>({});

// Detect browser/OS language and pre-select it on first onboarding (no saved preference yet)
onMount(() => {
  void (async () => {
    try {
      const stored = (await browser.storage.local.get(['locale', 'preferredLanguage'])) as {
        locale?: string;
        preferredLanguage?: string;
      };
      if (stored.preferredLanguage || stored.locale) {
        // Honor existing choice
        await setLanguage(mapToSupportedLocale(stored.preferredLanguage || stored.locale));
        return;
      }
      const nav =
        (typeof navigator !== 'undefined' && (navigator.language || navigator.languages?.[0])) ||
        'en';
      const mapped = mapToSupportedLocale(nav);
      await setLanguage(mapped);
    } catch (e) {
      logError('Onboarding locale detect failed', e);
    }
  })();
});

// Load providers dynamically — never include synthetic Demo
let providers = $derived.by((): ProviderConfig[] => {
  try {
    return getAllProviderConfigs();
  } catch (error) {
    logError('Failed to load onboarding provider configurations', error);
    return [];
  }
});

// Select first provider by default (guard so we only write when empty)
$effect(() => {
  if (providers.length === 0) return;
  if (!selectedProvider) {
    selectedProvider = providers[0].id;
  }
});

// Ping each provider (best instance) when step 2 is shown.
// Never read+write providerPings in the same reactive effect (causes effect_update_depth_exceeded).
$effect(() => {
  if (step !== 2 || providers.length === 0) return;
  const list = providers;
  let cancelled = false;
  void (async () => {
    const next: Record<string, number | 'timeout' | '…'> = {};
    for (const p of list) {
      if (cancelled) return;
      next[p.id] = '…';
      // Write a new object without reading reactive providerPings
      providerPings = { ...next };
      try {
        const instances = await getProviderInstancesWithCustom(p.id);
        const results = await pingProviderInstances(p, instances);
        if (cancelled) return;
        const best = getFastestPing(results);
        next[p.id] = best === null ? 'timeout' : best;
        providerPings = { ...next };
      } catch {
        /* ignore */
        if (!cancelled) {
          next[p.id] = 'timeout';
          providerPings = { ...next };
        }
      }
    }
  })();
  return () => {
    cancelled = true;
  };
});

function formatPing(v: number | 'timeout' | '…' | undefined): string {
  if (v === undefined || v === '…') return '…';
  if (v === 'timeout') return '—';
  return `${v} ms`;
}

/** Format a provider expiry duration (ms) as a compact localized duration, e.g. "1h" / "24h" / "30m". */
function formatExpiryDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return $t('onboarding.noExpiry');
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// Reusable onboarding color tokens — keep icon & label colors consistent site-wide.
// (Tailwind's `text-md-*` utilities resolve to these same MD3 variables.)
const ICON_CLASS = 'text-md-primary';
const LABEL_CLASS = 'text-md-on-surface';
const LABEL_MUTED_CLASS = 'text-md-on-surface/60';

async function createFirstInbox(provider: string) {
  if (!provider || creating) return;
  creating = true;
  createError = '';
  try {
    await handleCreateInbox(provider, browser, {
      onCreateInbox: async (p) => {
        await onCreateInbox(p);
      },
    });
    // Only queue / start product tour AFTER first inbox creation succeeds
    try {
      await setPendingProductTour(true);
    } catch {
      /* ignore */
    }
    onStartProductTour();
  } catch (e) {
    createError = e instanceof Error ? e.message : String(e || 'Failed to create address');
    logError('Onboarding createFirstInbox failed', e);
    // Allow retry with another provider — do not leave UI stuck
  } finally {
    creating = false;
  }
}
</script>

{#if step === 1}
  <!-- Welcome Step (no app logo — header already brands the shell) -->
  <div class="flex flex-col items-center justify-center h-full px-6 py-8 text-center gap-5 overflow-y-auto onboarding-scroll">
    <div class="w-full flex justify-end">
      <LanguageSwitcher />
    </div>

    <div>
      <h2 class="text-xl font-bold {LABEL_CLASS} mb-1">{$t('onboarding.welcome')}</h2>
      <p class="text-sm {LABEL_MUTED_CLASS}">{$t('onboarding.welcomeDescription')}</p>
    </div>

    <!-- Feature highlights -->
    <div class="w-full flex flex-col gap-2.5">
      <div class="flex items-center gap-3 bg-md-surface-container-low rounded-xl px-4 py-2.5">
        <div class="w-8 h-8 rounded-lg bg-md-primary/10 flex items-center justify-center shrink-0">
          <Icon name="checkCircle" class="w-4 h-4 {ICON_CLASS}" />
        </div>
        <div class="text-start">
          <p class="text-xs font-semibold {LABEL_CLASS}">{$t('onboarding.feature1Title')}</p>
          <p class="text-xs {LABEL_MUTED_CLASS}">{$t('onboarding.feature1Description')}</p>
        </div>
      </div>

      <div class="flex items-center gap-3 bg-md-surface-container-low rounded-xl px-4 py-2.5">
        <div class="w-8 h-8 rounded-lg bg-md-primary/10 flex items-center justify-center shrink-0">
          <Icon name="shield" class="w-4 h-4 {ICON_CLASS}" />
        </div>
        <div class="text-start">
          <p class="text-xs font-semibold {LABEL_CLASS}">{$t('onboarding.feature2Title')}</p>
          <p class="text-xs {LABEL_MUTED_CLASS}">{$t('onboarding.feature2Description')}</p>
        </div>
      </div>

      <div class="flex items-center gap-3 bg-md-surface-container-low rounded-xl px-4 py-2.5">
        <div class="w-8 h-8 rounded-lg bg-md-primary/10 flex items-center justify-center shrink-0">
          <Icon name="lock" class="w-4 h-4 {ICON_CLASS}" />
        </div>
        <div class="text-start">
          <p class="text-xs font-semibold {LABEL_CLASS}">{$t('onboarding.feature3Title')}</p>
          <p class="text-xs {LABEL_MUTED_CLASS}">{$t('onboarding.feature3Description')}</p>
        </div>
      </div>
    </div>

    <!-- Import backup + Get Started (same row) -->
    <div class="w-full flex items-center gap-2">
      <button
        type="button"
        class="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-md-primary {ICON_CLASS} hover:bg-md-primary/10 transition-colors text-sm font-semibold"
        title={$t('onboarding.importBackupHint')}
        onclick={() => onImportBackup()}
      >
        <Icon name="upload" class="w-4 h-4" />
        {$t('onboarding.importBackup')}
      </button>
      <button
        class="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl bg-md-primary text-md-on-primary hover:bg-md-primary/90 transition-colors"
        onclick={() => step = 2}
      >
        {$t('onboarding.continue')}
        <Icon name="back" class="w-4 h-4 rotate-180" />
      </button>
    </div>
  </div>

{:else}
  <!-- Create First Inbox Step -->
  <div class="flex flex-col items-center h-full px-3 py-6 text-center gap-4 overflow-y-auto onboarding-scroll">
    <div>
      <h2 class="text-lg font-bold {LABEL_CLASS} mb-1">{$t('onboarding.chooseProvider')}</h2>
      <p class="text-sm {LABEL_MUTED_CLASS}">{$t('onboarding.chooseProviderDescription')}</p>
    </div>

    <!-- Comparison table -->
    <div class="w-full overflow-x-auto rounded-xl border border-md-outline-variant/40">
      <table class="w-full text-start text-xs border-collapse min-w-[320px]">
        <caption class="sr-only">{$t('onboarding.providerComparison')}</caption>
        <thead>
          <tr class="bg-md-surface-variant/60 {LABEL_MUTED_CLASS}">
            <th class="px-2 py-1.5 font-semibold">{$t('onboarding.compareProvider')}</th>
            <th class="px-2 py-1.5 font-semibold">{$t('onboarding.compareCustom')}</th>
            <th class="px-2 py-1.5 font-semibold">{$t('onboarding.compareRenew')}</th>
            <th class="px-2 py-1.5 font-semibold">{$t('onboarding.compareExpiryIn')}</th>
            <th class="px-2 py-1.5 font-semibold">{$t('onboarding.compareMultiInst')}</th>
            <th class="px-2 py-1.5 font-semibold">{$t('onboarding.compareDomains')}</th>
            <th class="px-2 py-1.5 font-semibold">{$t('onboarding.comparePing')}</th>
          </tr>
        </thead>
        <tbody>
          {#each providers as provider (provider.id)}
            <tr
              class="border-t border-md-outline-variant/30 cursor-pointer {selectedProvider === provider.id ? 'bg-md-primary/10' : 'hover:bg-md-surface-variant/40'}"
              onclick={() => { selectedProvider = provider.id; createError = ''; }}
            >
              <td class="px-2 py-1.5 font-semibold {LABEL_CLASS}">{provider.displayName}</td>
              <td class="px-2 py-1.5 {LABEL_MUTED_CLASS}">{provider.customEmail?.supported || provider.ui?.supportsCustomEmail ? $t('common.yes') : $t('common.no')}</td>
              <td class="px-2 py-1.5 {LABEL_MUTED_CLASS}">{provider.expiry?.renewable ? $t('common.yes') : $t('common.no')}</td>
              <td class="px-2 py-1.5 {LABEL_MUTED_CLASS} tabular-nums">{formatExpiryDuration(provider.expiry?.duration)}</td>
              <td class="px-2 py-1.5 {LABEL_MUTED_CLASS}">{provider.multiInstance?.enabled ? $t('common.yes') : $t('common.no')}</td>
              <td class="px-2 py-1.5 {LABEL_MUTED_CLASS}">{provider.multiDomain?.domains?.length ? String(provider.multiDomain.domains.length) : '—'}</td>
              <td class="px-2 py-1.5 {LABEL_MUTED_CLASS} tabular-nums">{formatPing(providerPings[provider.id])}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- Provider selection cards -->
    <div class="w-full flex flex-col gap-2">
      {#each providers as provider (provider.id)}
        {@const domain = provider.websiteUrl ? new URL(provider.websiteUrl).hostname : ''}
        <button
          type="button"
          class="flex items-center gap-3 w-full rounded-xl px-3 py-2.5 border-2 transition-all {selectedProvider === provider.id ? 'border-md-primary bg-md-primary/5' : 'border-md-outline-variant bg-md-surface-container-low hover:border-md-outline-variant/20'}"
          onclick={() => { selectedProvider = provider.id; createError = ''; }}
        >
          <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 overflow-hidden">
            <FaviconImage {domain} size={28} class="w-6 h-6 object-contain" fallbackLetter={provider.displayName.charAt(0).toUpperCase()} fallbackColor={provider.ui?.color?.replace('text-', 'bg-') || avatarColor(provider.id)} />
          </div>
          <div class="text-start flex-1 min-w-0">
            <p class="text-sm font-semibold {LABEL_CLASS} truncate">{provider.displayName}</p>
            <p class="text-xs {LABEL_MUTED_CLASS} line-clamp-2">{provider.ui?.description || $t('onboarding.tempProviderFallback')}</p>
            <p class="text-label-sm {LABEL_MUTED_CLASS} mt-0.5 tabular-nums">
              {$t('onboarding.pingLabel')}: {formatPing(providerPings[provider.id])}
            </p>
          </div>
          {#if selectedProvider === provider.id}
            <Icon name="checkCircle" class="w-5 h-5 {ICON_CLASS} shrink-0" />
          {/if}
        </button>
      {/each}
    </div>

    {#if createError}
      <p class="w-full text-xs text-md-error text-start px-1" role="alert">
        {createError}
        <span class="{LABEL_MUTED_CLASS}"> · {$t('onboarding.retryWithOtherProvider')}</span>
      </p>
    {/if}

    <!-- Back + Create First Address (same row) -->
    <div class="w-full flex items-center gap-2">
      <button
        type="button"
        class="flex-1 px-3 py-2 text-sm rounded-xl bg-transparent {LABEL_MUTED_CLASS} hover:bg-md-surface-variant transition-colors"
        onclick={() => step = 1}
      >
        {$t('onboarding.back')}
      </button>
      <button
        type="button"
        class="flex-1 px-4 py-2 text-sm font-semibold rounded-xl bg-md-primary text-md-on-primary hover:bg-md-primary/90 transition-colors flex items-center justify-center gap-1.5 disabled:opacity-60"
        disabled={creating || !selectedProvider}
        onclick={() => void createFirstInbox(selectedProvider)}
      >
        <Icon name="envelope" class="w-4 h-4" />
        {creating ? $t('common.loading') : $t('onboarding.createFirstAddress')}
      </button>
    </div>
  </div>
{/if}

<style>
  /* Hide the vertical scrollbar on the onboarding scroll containers while keeping them scrollable. */
  .onboarding-scroll {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .onboarding-scroll::-webkit-scrollbar {
    display: none;
  }
</style>


