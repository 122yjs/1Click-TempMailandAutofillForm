<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Btn } from '@/ui/components/primitives';

let { onBack = () => {}, showToast = (_msg: string) => {} } = $props<{
  onBack?: () => void;
  showToast?: (msg: string) => void;
}>();

export type NavItemId =
  | 'mailbox'
  | 'addresses'
  | 'autofill'
  | 'organize'
  | 'activity'
  | 'settings'
  | 'about';

export const DEFAULT_NAV_ORDER: NavItemId[] = [
  'mailbox',
  'addresses',
  'autofill',
  'organize',
  'activity',
  'settings',
  'about',
];

const NAV_ITEM_METADATA: Record<NavItemId, { labelKey: string; icon: string }> = {
  mailbox: { labelKey: 'nav.mailbox', icon: 'inbox' },
  addresses: { labelKey: 'nav.addresses', icon: 'envelope' },
  autofill: { labelKey: 'nav.autofill', icon: 'person' },
  organize: { labelKey: 'nav.organize', icon: 'grid' },
  activity: { labelKey: 'nav.activity', icon: 'barChart' },
  settings: { labelKey: 'nav.settings', icon: 'settings' },
  about: { labelKey: 'nav.about', icon: 'info' },
};

let navOrder = $state<NavItemId[]>([...DEFAULT_NAV_ORDER]);

onMount(() => {
  void browser.storage.local.get(['customNavOrder']).then((res) => {
    if (res.customNavOrder && Array.isArray(res.customNavOrder)) {
      const valid = (res.customNavOrder as string[]).filter((id): id is NavItemId =>
        DEFAULT_NAV_ORDER.includes(id as NavItemId)
      );
      const missing = DEFAULT_NAV_ORDER.filter((id) => !valid.includes(id));
      navOrder = [...valid, ...missing];
    }
  });
});

async function moveUp(idx: number) {
  if (idx <= 0) return;
  const copy = [...navOrder];
  const item = copy[idx];
  copy[idx] = copy[idx - 1];
  copy[idx - 1] = item;
  navOrder = copy;
  await saveOrder();
}

async function moveDown(idx: number) {
  if (idx >= navOrder.length - 1) return;
  const copy = [...navOrder];
  const item = copy[idx];
  copy[idx] = copy[idx + 1];
  copy[idx + 1] = item;
  navOrder = copy;
  await saveOrder();
}

async function saveOrder() {
  await browser.storage.local.set({ customNavOrder: $state.snapshot(navOrder) });
  showToast($t('common.saved'));
}

async function resetOrder() {
  navOrder = [...DEFAULT_NAV_ORDER];
  await browser.storage.local.set({ customNavOrder: DEFAULT_NAV_ORDER });
  showToast($t('common.reset'));
}
</script>

<div class="flex flex-col h-full min-h-0 bg-md-surface text-md-on-surface">
  <!-- Header -->
  <div class="flex items-center gap-2 px-2 py-3 border-b border-md-outline-variant/20 shrink-0">
    <button
      type="button"
      class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-md-surface-variant/50 transition-colors"
      onclick={onBack}
      aria-label={$t('common.back')}
    >
      <Icon name="chevronLeft" class="w-5 h-5" />
    </button>
    <div class="flex-1 min-w-0">
      <h1 class="text-sm font-semibold text-md-on-surface truncate">{$t('settings.navbarOrderTitle') || 'Customizable Navbar Order'}</h1>
      <p class="text-xs text-md-on-surface/50 truncate">{$t('settings.navbarOrderHint') || 'Re-order navigation items (More menu stays last)'}</p>
    </div>
    <Btn variant="outline" size="sm" onclick={() => void resetOrder()}>
      {$t('common.reset') || 'Reset'}
    </Btn>
  </div>

  <!-- Content -->
  <div class="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-4">
    <!-- Items list -->
    <div class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="grip" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('settings.primaryNavItems') || 'Primary Navigation Order'}</span>
      </div>
      <div class="space-y-1.5">
      {#each navOrder as id, idx (id)}
        {@const meta = NAV_ITEM_METADATA[id]}
        <div class="flex items-center justify-between p-2.5 rounded-xl bg-md-surface-container-low border border-md-outline-variant/20 shadow-xs">
          <div class="flex items-center gap-3">
            <span class="text-xs font-bold text-md-on-surface/40 w-4 text-center">{idx + 1}</span>
            <Icon name={meta.icon} class="w-4 h-4 text-md-primary" />
            <span class="text-sm font-medium text-md-on-surface">{$t(meta.labelKey)}</span>
          </div>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-md-surface-variant/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              disabled={idx === 0}
              onclick={() => void moveUp(idx)}
              aria-label={$t('common.moveUp') || 'Move item up'}
            >
              <Icon name="chevronUp" class="w-4 h-4" />
            </button>
            <button
              type="button"
              class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-md-surface-variant/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              disabled={idx === navOrder.length - 1}
              onclick={() => void moveDown(idx)}
              aria-label={$t('common.moveDown') || 'Move item down'}
            >
              <Icon name="chevronDown" class="w-4 h-4" />
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Responsiveness rules hint -->
  <div class="p-3 rounded-xl bg-md-tertiary-container/30 text-xs text-md-on-surface/70 space-y-1 leading-relaxed">
    <p class="font-bold">💡 {$t('settings.responsiveOrderHintTitle') || 'Responsive Layout Rules'}:</p>
    <p>{$t('settings.responsiveOrderHintBody') || 'Items dynamically expand into the navigation bar based on available screen width. The More menu always remains the final item when displayed.'}</p>
  </div>

    <!-- Dynamic End-of-Page Spacer -->
    <div
      class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
      style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
      aria-hidden="true"
    ></div>
  </div>
</div>
