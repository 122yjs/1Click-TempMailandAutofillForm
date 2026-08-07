<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Btn, Toggle } from '@/ui/components/primitives';

let { onBack = () => {}, showToast = (_msg: string) => {} } = $props<{
  onBack?: () => void;
  showToast?: (msg: string) => void;
}>();

export type ToolbarButtonVisibility = {
  star: boolean;
  archive: boolean;
  delete: boolean;
  download: boolean;
  forward: boolean;
  markUnread: boolean;
  print: boolean;
};

const defaultVisibility: ToolbarButtonVisibility = {
  star: true,
  archive: true,
  delete: true,
  download: true,
  forward: true,
  markUnread: true,
  print: true,
};

let visibility = $state<ToolbarButtonVisibility>({ ...defaultVisibility });

onMount(() => {
  void browser.storage.local.get(['toolbarButtonVisibility']).then((res) => {
    if (res.toolbarButtonVisibility && typeof res.toolbarButtonVisibility === 'object') {
      visibility = {
        ...defaultVisibility,
        ...(res.toolbarButtonVisibility as Record<string, boolean>),
      };
    }
  });
});

async function toggleButton(key: keyof ToolbarButtonVisibility) {
  visibility[key] = !visibility[key];
  await browser.storage.local.set({ toolbarButtonVisibility: $state.snapshot(visibility) });
  showToast($t('common.saved'));
}

async function resetAll() {
  visibility = { ...defaultVisibility };
  await browser.storage.local.set({ toolbarButtonVisibility: defaultVisibility });
  showToast($t('common.reset'));
}

const buttonsList: Array<{ key: keyof ToolbarButtonVisibility; labelKey: string; icon: string }> = [
  { key: 'star', labelKey: 'inbox.emailActions.star', icon: 'star' },
  { key: 'archive', labelKey: 'inbox.emailActions.archive', icon: 'archive' },
  { key: 'delete', labelKey: 'inbox.emailActions.delete', icon: 'trash' },
  { key: 'download', labelKey: 'inbox.emailActions.download', icon: 'download' },
  { key: 'forward', labelKey: 'inbox.emailActions.forward', icon: 'envelope' },
  { key: 'markUnread', labelKey: 'inbox.emailActions.markUnread', icon: 'mail' },
  { key: 'print', labelKey: 'inbox.emailActions.print', icon: 'print' },
];
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
      <h1 class="text-sm font-semibold text-md-on-surface truncate">{$t('settings.toolbarButtonsTitle') || 'Toolbar Buttons'}</h1>
      <p class="text-xs text-md-on-surface/50 truncate">{$t('settings.toolbarButtonsHint') || 'Choose which action buttons appear in the email toolbar'}</p>
    </div>
    <Btn variant="outline" size="sm" onclick={resetAll}>
      {$t('common.reset') || 'Reset'}
    </Btn>
  </div>

  <!-- Content -->
  <div class="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-4">
    <!-- Message Detail Toolbar section -->
    <div class="space-y-2">
      <div class="flex items-center gap-2 mb-1">
        <Icon name="grid" class="w-4 h-4 text-md-primary" />
        <span role="heading" aria-level="2" class="text-sm font-medium text-md-on-surface">{$t('settings.mailViewToolbar') || 'Mail View Toolbar'}</span>
      </div>
      <div class="grid gap-2">
      {#each buttonsList as btn (btn.key)}
        <label class="flex items-center justify-between bg-md-primary-container rounded-xl px-3 py-3 cursor-pointer">
          <div class="flex items-center gap-2.5">
            <Icon name={btn.icon} class="w-4 h-4 text-md-primary" />
            <span class="text-sm font-medium text-md-on-surface">{$t(btn.labelKey) || btn.key}</span>
          </div>
          <Toggle
            checked={visibility[btn.key]}
            onChange={() => void toggleButton(btn.key)}
          />
        </label>
      {/each}
    </div>
  </div>

    <!-- Dynamic End-of-Page Spacer -->
    <div
      class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
      style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
      aria-hidden="true"
    ></div>
  </div>
</div>
