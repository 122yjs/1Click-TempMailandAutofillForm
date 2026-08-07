<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Toggle } from '@/ui/components/primitives';
import Skeleton from '@/ui/components/primitives/Skeleton.svelte';
import {
  DEFAULT_HTML_RENDERING_SETTINGS,
  type HtmlRenderingSettings,
  loadHtmlRenderingSettings,
  saveHtmlRenderingSettings,
} from '@/utils/sanitize-html.js';

interface Props {
  onBack?: () => void;
  showToast?: (msg: string) => void;
}

let { onBack, showToast }: Props = $props();

let settings = $state<HtmlRenderingSettings>({ ...DEFAULT_HTML_RENDERING_SETTINGS });
let loading = $state(true);

onMount(async () => {
  try {
    settings = await loadHtmlRenderingSettings();
  } finally {
    loading = false;
  }
});

async function toggleTag(tagKey: keyof HtmlRenderingSettings) {
  const updated = { ...settings, [tagKey]: !settings[tagKey] };
  settings = updated;
  await saveHtmlRenderingSettings(updated);
  if (showToast) {
    showToast($t('common.saved'));
  }
}

async function resetDefaults() {
  settings = { ...DEFAULT_HTML_RENDERING_SETTINGS };
  await saveHtmlRenderingSettings(settings);
  if (showToast) {
    showToast($t('common.resetToDefaults'));
  }
}

const tagOptions: {
  key: keyof HtmlRenderingSettings;
  icon: string;
  labelKey: string;
  hintKey: string;
}[] = [
  {
    key: 'img',
    icon: 'image',
    labelKey: 'settings.htmlRenderingImg',
    hintKey: 'settings.htmlRenderingImgHint',
  },
  {
    key: 'style',
    icon: 'code',
    labelKey: 'settings.htmlRenderingStyle',
    hintKey: 'settings.htmlRenderingStyleHint',
  },
  {
    key: 'table',
    icon: 'grid',
    labelKey: 'settings.htmlRenderingTable',
    hintKey: 'settings.htmlRenderingTableHint',
  },
  {
    key: 'svg',
    icon: 'fileText',
    labelKey: 'settings.htmlRenderingSvg',
    hintKey: 'settings.htmlRenderingSvgHint',
  },
  {
    key: 'audio',
    icon: 'headphones',
    labelKey: 'settings.htmlRenderingAudio',
    hintKey: 'settings.htmlRenderingAudioHint',
  },
  {
    key: 'video',
    icon: 'video',
    labelKey: 'settings.htmlRenderingVideo',
    hintKey: 'settings.htmlRenderingVideoHint',
  },
  {
    key: 'iframe',
    icon: 'globe',
    labelKey: 'settings.htmlRenderingIframe',
    hintKey: 'settings.htmlRenderingIframeHint',
  },
  {
    key: 'object',
    icon: 'box',
    labelKey: 'settings.htmlRenderingObject',
    hintKey: 'settings.htmlRenderingObjectHint',
  },
  {
    key: 'form',
    icon: 'edit',
    labelKey: 'settings.htmlRenderingForm',
    hintKey: 'settings.htmlRenderingFormHint',
  },
];
</script>

<div class="h-full flex flex-col min-h-0 bg-md-surface text-md-on-surface">
  <!-- Top bar -->
  <div class="flex items-center justify-between px-2 py-3 border-b border-md-outline-variant/20 shrink-0">
    <div class="flex items-center gap-2">
      {#if onBack}
        <button
          type="button"
          class="p-1.5 rounded-full hover:bg-md-surface-variant/50 text-md-on-surface transition-colors"
          aria-label={$t('common.back')}
          onclick={onBack}
        >
          <Icon name="chevronLeft" class="w-5 h-5" />
        </button>
      {/if}
      <div>
        <h2 class="text-sm font-semibold text-md-on-surface">{$t('settings.htmlRenderingTitle') || 'HTML Element Rendering'}</h2>
        <p class="text-xs text-md-on-surface/50">{$t('settings.htmlRenderingSubtitle') || 'Control allowed HTML tags inside email bodies'}</p>
      </div>
    </div>
    <button
      type="button"
      class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-md-secondary-container text-md-on-secondary-container hover:opacity-90 transition-opacity"
      onclick={resetDefaults}
    >
      {$t('common.resetDefaults') || 'Reset'}
    </button>
  </div>

  <!-- Content list -->
  <div class="flex-1 overflow-y-auto px-2 py-3 space-y-4">
    {#if loading}
      <div class="space-y-3">
        {#each Array(4) as _, i (i)}
          <Skeleton width="100%" height="4rem" radius="0.75rem" />
        {/each}
      </div>
    {:else}
      <div class="grid grid-cols-1 gap-2.5">
        {#each tagOptions as opt (opt.key)}
          <div class="flex items-center justify-between bg-md-primary-container rounded-xl px-3 py-3">
            <div class="flex items-start gap-3 min-w-0 pr-2">
              <div class="p-2 rounded-lg bg-md-surface text-md-primary shrink-0 mt-0.5">
                <Icon name={opt.icon} class="w-4 h-4" />
              </div>
              <div class="min-w-0">
                <div class="text-sm font-medium text-md-on-surface leading-snug">
                  {$t(opt.labelKey) || String(opt.key).toUpperCase()}
                </div>
                <div class="text-xs text-md-on-surface/50 leading-relaxed">
                  {$t(opt.hintKey) || `Allow rendering of <${String(opt.key)}> elements`}
                </div>
              </div>
            </div>
            <Toggle
              checked={settings[opt.key] ?? false}
              ariaLabel={$t(opt.labelKey) || String(opt.key)}
              onChange={() => toggleTag(opt.key)}
            />
          </div>
        {/each}
      </div>
    {/if}

    <!-- Dynamic End-of-Page Spacer -->
    <div
      class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
      style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
      aria-hidden="true"
    ></div>
  </div>
</div>
