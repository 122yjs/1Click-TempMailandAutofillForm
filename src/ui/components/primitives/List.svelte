<script lang="ts">
/**
 * MD3 List primitive — shared list styling per Material Design 3.
 *
 * Spec: https://m3.material.io/components/lists/specs
 *   - Single-line item: 56px (48px compact)
 *   - Two-line item:    72px (64px compact)
 *   - Leading: 40px avatar / 24px icon
 *   - Trailing: 24px
 *   - Title: body-large (16px) · Supporting: body-medium (14px)
 *   - Divider: 1px outline-variant
 */
import type { Snippet } from 'svelte';
import Icon from '@/ui/components/icons/Icon.svelte';

export type ListItem = {
  id: string;
  /** Primary title (body-large). */
  title: string;
  /** Secondary supporting text (body-medium) — makes the row two-line. */
  supporting?: string;
  /** Leading icon name (24px). */
  icon?: string;
  /** Leading avatar letter (40px circle). */
  avatar?: string;
  /** Trailing icon name (24px). */
  trailingIcon?: string;
  /** Trailing text (label-medium). */
  trailing?: string;
  active?: boolean;
  disabled?: boolean;
  danger?: boolean;
};

let {
  items = [] as ListItem[],
  onSelect = (_id: string) => {},
  /** Compact density (48px single-line / 64px two-line). */
  compact = false,
  /** Show 1px outline-variant dividers between items. */
  dividers = false,
  class: className = '',
  role = 'list' as 'list' | 'listbox',
  ariaLabel = '',
  children,
}: {
  items?: ListItem[];
  onSelect?: (id: string) => void;
  compact?: boolean;
  dividers?: boolean;
  class?: string;
  role?: 'list' | 'listbox';
  ariaLabel?: string;
  children?: Snippet;
} = $props();

const rowBase =
  'w-full flex items-center gap-4 px-4 text-start transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-md-primary/50 ' +
  'disabled:opacity-40 disabled:pointer-events-none';
const rowHeight = $derived(compact ? 'min-h-12' : 'min-h-14'); // 48px / 56px
const rowHeightTwo = $derived(compact ? 'min-h-16' : 'min-h-[4.5rem]'); // 64px / 72px
</script>

<div
  class="list {role === 'listbox' ? 'rounded-xl' : ''} {className}"
  {role}
  aria-label={ariaLabel || undefined}
>
  {#if children}
    {@render children()}
  {:else}
    {#each items as item, i (item.id)}
      {@const twoLine = !!item.supporting}
      <li
        class="{role === 'listbox' ? 'list-none' : ''} {dividers && i > 0 ? 'divide-y divide-md-outline-variant/40' : ''}"
        role="none"
      >
        <button
          type="button"
          role={role === 'listbox' ? 'option' : undefined}
          aria-selected={role === 'listbox' ? !!item.active : undefined}
          disabled={item.disabled}
          class="{rowBase} w-full {twoLine ? rowHeightTwo : rowHeight} {item.active ? 'bg-md-secondary-container/40' : 'hover:bg-md-surface-variant/40'} {item.danger && !item.active ? 'text-md-error' : 'text-md-on-surface'}"
          onclick={(e) => {
            e.stopPropagation();
            if (!item.disabled) onSelect(item.id);
          }}
        >
          {#if item.avatar}
            <span
              class="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0 bg-md-primary-container text-md-on-primary-container"
              aria-hidden="true"
            >{item.avatar}</span>
          {:else if item.icon}
            <Icon name={item.icon} class="w-6 h-6 shrink-0 text-md-on-surface-variant" />
          {/if}

          <span class="flex-1 min-w-0 flex flex-col justify-center">
            <span class="text-base font-medium truncate leading-tight">{item.title}</span>
            {#if item.supporting}
              <span class="text-sm text-md-on-surface-variant truncate leading-tight mt-0.5">{item.supporting}</span>
            {/if}
          </span>

          {#if item.trailing}
            <span class="text-xs font-medium text-md-on-surface-variant shrink-0">{item.trailing}</span>
          {/if}
          {#if item.trailingIcon}
            <Icon name={item.trailingIcon} class="w-6 h-6 shrink-0 text-md-on-surface-variant" />
          {/if}
        </button>
      </li>
    {/each}
  {/if}
</div>