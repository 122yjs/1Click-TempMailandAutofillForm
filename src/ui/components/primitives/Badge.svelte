<script lang="ts">
import type { Snippet } from 'svelte';
import { t } from 'svelte-i18n';
import Icon from '@/ui/components/icons/Icon.svelte';

export type BadgeVariant =
  | 'primary'
  | 'success'
  | 'warning'
  | 'error'
  | 'neutral'
  | 'outline'
  | 'tag';

let {
  variant = 'neutral',
  size = 'md',
  customColor = '',
  label = '',
  icon = '',
  onRemove,
  class: className = '',
  children,
}: {
  variant?: BadgeVariant;
  size?: 'sm' | 'md';
  customColor?: string;
  label?: string;
  icon?: string;
  onRemove?: () => void;
  class?: string;
  children?: Snippet;
} = $props();

function getContrastColor(hex: string): string {
  try {
    const cleanHex = hex.replace('#', '');
    const r = parseInt(cleanHex.slice(0, 2), 16);
    const g = parseInt(cleanHex.slice(2, 4), 16);
    const b = parseInt(cleanHex.slice(4, 6), 16);
    return r * 299 + g * 587 + b * 114 > 128000 ? '#1a1c16' : '#ffffff';
  } catch {
    return '#ffffff';
  }
}

const variantClasses: Record<BadgeVariant, string> = {
  primary: 'bg-md-primary/15 text-md-primary border-md-primary/20',
  success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20',
  error: 'bg-md-error/15 text-md-error border-md-error/20',
  neutral: 'bg-md-surface-variant/40 text-md-on-surface/75 border-md-outline-variant/20',
  outline: 'border border-md-outline-variant/40 text-md-on-surface/80 bg-transparent',
  tag: 'bg-md-surface-container-high text-md-on-surface border-md-outline-variant/30',
};

const sizeClasses = {
  sm: 'px-1.5 py-0.5 text-label-sm gap-1',
  md: 'px-2.5 py-1 text-xs gap-1.5',
};

let inlineStyle = $derived(
  customColor ? `background-color: ${customColor}; color: ${getContrastColor(customColor)};` : ''
);
</script>

<span
  class="inline-flex items-center font-medium rounded-full border transition-colors select-none {sizeClasses[size]} {customColor ? '' : variantClasses[variant]} {className}"
  style={inlineStyle}
>
  {#if icon}
    <Icon name={icon} class={size === 'sm' ? 'w-3 h-3 shrink-0' : 'w-3.5 h-3.5 shrink-0'} />
  {/if}

  {#if label}
    <span>{label}</span>
  {:else if children}
    {@render children()}
  {/if}

  {#if onRemove}
    <button
      type="button"
      class="hover:opacity-75 focus:outline-none shrink-0"
      onclick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      aria-label={$t('common.remove')}
    >
      <Icon name="x" class={size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
    </button>
  {/if}
</span>
