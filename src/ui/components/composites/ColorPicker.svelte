<script lang="ts">
/**
 * Cross-browser MD3 color picker popover (replaces native input[type=color]).
 * Shows a swatch trigger; opens a panel with hex input + preset palette + optional hue slider.
 */
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import Icon from '@/ui/components/icons/Icon.svelte';
import { sanitizeColor } from '@/utils/validation.js';

let {
  value = $bindable(''),
  ariaLabel = 'Choose color',
  presets = [
    '#4c662b',
    '#445e91',
    '#7d5260',
    '#006a6a',
    '#8b5000',
    '#ba1a1a',
    '#6750a4',
    '#006e1c',
    '#984061',
    '#006493',
  ] as string[],
  onChange = (_hex: string) => {},
  allowClear = true,
} = $props<{
  value?: string;
  ariaLabel?: string;
  presets?: string[];
  onChange?: (hex: string) => void;
  allowClear?: boolean;
}>();

let open = $state(false);
let hexDraft = $state('');
let hexError = $state('');
let rootEl = $state<HTMLElement | null>(null);

const displayColor = $derived(sanitizeColor(value) || value || 'var(--md-primary)');

$effect(() => {
  hexDraft = value?.startsWith('#') ? value : value || '';
  hexError = '';
});

function isValidHex(hex: string) {
  return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(hex);
}

function commitHex(raw: string) {
  if (!isValidHex(raw)) {
    hexError = 'Invalid hex';
    return;
  }
  let h = raw.trim();
  // Expand #rgb
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  const safe = sanitizeColor(h);
  if (safe) {
    value = safe;
    onChange(safe);
    hexDraft = safe;
    hexError = '';
  }
}

function pick(hex: string) {
  value = hex;
  onChange(hex);
  hexDraft = hex;
  hexError = '';
}

function clear() {
  value = '';
  onChange('');
  hexDraft = '';
  open = false;
}

onMount(() => {
  const onDoc = (e: MouseEvent) => {
    if (!open || !rootEl) return;
    if (!rootEl.contains(e.target as Node)) {
      open = false;
    }
  };

  $effect(() => {
    if (open) {
      document.addEventListener('mousedown', onDoc);
    } else {
      document.removeEventListener('mousedown', onDoc);
    }
    return () => document.removeEventListener('mousedown', onDoc);
  });
});
</script>

<div class="color-picker relative inline-flex items-center gap-1" bind:this={rootEl}>
  <button
    type="button"
    class="w-8 h-8 rounded-full border-4 border-md-secondary-container shadow-md shrink-0 transition-transform hover:scale-105 active:scale-95"
    style="background: {displayColor};"
    aria-label={ariaLabel}
    aria-expanded={open}
    onclick={(e) => {
      e.stopPropagation();
      open = !open;
    }}
  ></button>
  {#if allowClear && value}
    <button
      type="button"
      class="w-5 h-5 flex items-center justify-center rounded-full bg-transparent hover:bg-md-secondary-container transition-colors border-0"
      aria-label={$t('preferences.resetColor')}
      onclick={(e) => {
        e.stopPropagation();
        clear();
      }}
    >
      <Icon name="x" class="w-3 h-3" />
    </button>
  {/if}

  {#if open}
    <div
      class="absolute top-full end-0 mt-2 z-[300] w-[220px] rounded-2xl border border-md-outline-variant bg-md-surface-container shadow-2xl p-3 space-y-2.5 color-picker-panel"
      role="dialog"
      aria-label={ariaLabel}
    >
      <div class="grid grid-cols-5 gap-1.5">
        {#each presets as hex (hex)}
          <button
            type="button"
            class="w-8 h-8 rounded-full border-2 transition-transform hover:scale-110
              {value?.toLowerCase() === hex.toLowerCase()
                ? 'border-md-on-surface ring-2 ring-md-primary/40'
                : 'border-md-outline-variant/40'}"
            style="background: {hex};"
            aria-label={hex}
            aria-pressed={value?.toLowerCase() === hex.toLowerCase()}
            onclick={() => pick(hex)}
          ></button>
        {/each}
      </div>
      <div class="flex items-center gap-1.5">
        <span
          class="w-7 h-7 rounded-lg border border-md-outline-variant shrink-0"
          style="background: {sanitizeColor(hexDraft) || hexDraft || 'transparent'};"
        ></span>
        <div class="flex-1">
          <input
            type="text"
            class="w-full px-2 py-1.5 text-xs font-mono rounded-lg border bg-md-surface text-md-on-surface outline-none {hexError ? 'border-md-error' : 'border-md-outline-variant focus:border-md-primary'}"
            placeholder="#4c662b"
            maxlength="9"
            bind:value={hexDraft}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitHex(hexDraft);
              }
            }}
            onblur={() => commitHex(hexDraft)}
          />
          {#if hexError}
            <p class="text-label-sm text-md-error mt-0.5">{hexError}</p>
          {/if}
        </div>
      </div>
      <!-- Native picker as progressive enhancement for free color selection -->
      <label
        class="flex items-center justify-center gap-2 w-full py-1.5 rounded-xl text-xs font-semibold bg-md-secondary-container text-md-on-secondary-container cursor-pointer hover:brightness-105 transition-all"
      >
        <Icon name="edit" class="w-3.5 h-3.5" />
        {$t('preferences.chooseThemeColor')}
        <input
          type="color"
          class="sr-only"
          value={value?.startsWith('#') && value.length >= 7 ? value.slice(0, 7) : '#4c662b'}
          oninput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            pick(v);
          }}
        />
      </label>
    </div>
  {/if}
</div>

<style>
  .color-picker-panel {
    animation: color-picker-in 180ms cubic-bezier(0.2, 0, 0, 1) both;
  }
  @keyframes color-picker-in {
    from {
      opacity: 0;
      transform: translateY(-4px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .color-picker-panel {
      animation: none;
    }
  }
</style>
