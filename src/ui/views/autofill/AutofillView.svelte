
<script lang="ts">
/**
 * Autofill manager hub — Profiles (person templates) + Credentials (signup autofill).
 * Deep-links: openView autofill|identities|loginInfo + autofillTab.
 */
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import type { AutofillTab } from '@/features/types/view-types.js';
import EmptyState from '@/ui/components/composites/EmptyState.svelte';
import type { TabItem } from '@/ui/components/composites/Tabs.svelte';
import Tabs from '@/ui/components/composites/Tabs.svelte';
import type { CredentialsHistoryItem, Identity } from '@/utils/types.js';
import GeneratedAccountsView from './GeneratedAccountsView.svelte';
import IdentitiesView from './IdentitiesView.svelte';

let {
  context = 'popup' as 'popup' | 'sidepanel' | 'app',
  initialTab = 'profiles' as AutofillTab,
  tabSignal = 0,
  tabSignalValue = 'profiles' as AutofillTab,
  savedLogins = [] as CredentialsHistoryItem[],
  identities = [] as Identity[],
  mailboxAddresses = [] as string[],
  activeMailboxAddress = '',
  loginInfoEmailFilter = '',
  identitiesEmailFilter = '',
  focusSearchSignal = 0,
  createSignal = 0,
  editIdSignal = '',
  /** When true (≥1280), editor opens in AppLayout data-splitview host (not merged into list) */
  layoutSplit = false,
  splitHostId = 'autofill-split-host',
  splitHostRef = null,
  onDeleteLogin = (_id: string) => {},
  onReorderLogin = (_sourceId: string, _targetId: string) => {},
  showToast = (_message: string) => {},
  showConfirm = (_message: string, _onConfirm: () => void) => {},
} = $props<{
  context?: 'popup' | 'sidepanel' | 'app';
  initialTab?: AutofillTab;
  tabSignal?: number;
  tabSignalValue?: AutofillTab;
  savedLogins?: CredentialsHistoryItem[];
  identities?: Identity[];
  mailboxAddresses?: string[];
  activeMailboxAddress?: string;
  loginInfoEmailFilter?: string;
  identitiesEmailFilter?: string;
  focusSearchSignal?: number;
  createSignal?: number;
  editIdSignal?: string;
  layoutSplit?: boolean;
  splitHostId?: string;
  splitHostRef?: HTMLElement | null;
  onDeleteLogin?: (id: string) => void;
  onReorderLogin?: (sourceId: string, targetId: string) => void;
  showToast?: (message: string) => void;
  showConfirm?: (message: string, onConfirm: () => void) => void;
}>();

let activeTab = $state<AutofillTab>('profiles');
let lastTabSignal = 0;
let lastInitial = '';
let autofillFeatureEnabled = $state(true);

onMount(() => {
  void browser.storage.local.get(['autofillFeatureEnabled']).then((r) => {
    autofillFeatureEnabled =
      (r as { autofillFeatureEnabled?: boolean }).autofillFeatureEnabled !== false;
  });
  const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !changes.autofillFeatureEnabled) return;
    autofillFeatureEnabled = changes.autofillFeatureEnabled.newValue !== false;
  };
  try {
    browser.storage.onChanged.addListener(onChange);
  } catch {
    /* ignore */
  }
  return () => {
    try {
      browser.storage.onChanged.removeListener(onChange);
    } catch {
      /* ignore */
    }
  };
});

async function enableAutofillFeature() {
  autofillFeatureEnabled = true;
  await browser.storage.local.set({ autofillFeatureEnabled: true });
  showToast($t('preferences.autofillFeatureEnabled'));
}

$effect(() => {
  if (tabSignal > 0 && tabSignal !== lastTabSignal) {
    lastTabSignal = tabSignal;
    activeTab = tabSignalValue;
    return;
  }
  if (initialTab && initialTab !== lastInitial) {
    lastInitial = initialTab;
    activeTab = initialTab;
  }
});

const tabItems = $derived<TabItem[]>([
  { id: 'profiles', label: $t('nav.profiles'), badge: identities.length, icon: 'person' },
  {
    id: 'credentials',
    label: $t('nav.credentials'),
    subheading: $t('nav.credentialsSubtitle'),
    badge: savedLogins.length,
    icon: 'lock',
  },
]);
</script>

<div class="flex flex-col h-full min-h-0" data-tour="autofill-hub">
  {#if !autofillFeatureEnabled}
    <div class="flex-1 min-h-0 flex flex-col">
      <EmptyState
        iconName="editSquare"
        title={$t('autofillPage.disabledTitle')}
        description={$t('autofillPage.disabledDescription')}
        actionLabel={$t('autofillPage.enableAction')}
        onAction={() => void enableAutofillFeature()}
      />
    </div>
  {:else}
  <div class="shrink-0 px-2 pt-2 pb-1 border-b border-md-outline-variant/30">
    <h1 class="text-base font-bold text-md-on-surface px-0.5 mb-0.5">{$t('nav.autofill')}</h1>
    <p class="text-xs text-md-on-surface/55 px-0.5 mb-2">{$t('nav.autofillSubtitle')}</p>
    <Tabs
      tabs={tabItems}
      bind:activeTab
      variant="pill"
      fullWidth={true}
    />
  </div>
    {#if activeTab === 'credentials'}
      <p class="text-label-sm text-md-on-surface/50 px-0.5 mt-1.5">
        {$t('nav.credentialsSubtitle')}
      </p>
    {/if}

  <div
    class="flex-1 min-h-0 overflow-hidden"
    role="tabpanel"
    aria-labelledby="autofill-tab-{activeTab}"
  >
    {#if activeTab === 'profiles'}
      <IdentitiesView
        {context}
        savedLogins={savedLogins}
        {mailboxAddresses}
        {activeMailboxAddress}
        initialEmailFilter={identitiesEmailFilter}
        {createSignal}
        editIdSignal={editIdSignal}
        useSplitEditor={layoutSplit}
        splitHostId={splitHostId}
        splitHostRef={splitHostRef}
        {showConfirm}
      />
    {:else}
      <GeneratedAccountsView
        {context}
        {savedLogins}
        {identities}
        initialEmailFilter={loginInfoEmailFilter}
        {focusSearchSignal}
        onDelete={onDeleteLogin}
        onReorder={onReorderLogin}
        {showToast}
      />
    {/if}
  </div>
  {/if}
</div>
