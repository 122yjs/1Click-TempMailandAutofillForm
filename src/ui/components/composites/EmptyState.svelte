<script lang="ts">
import type { Snippet } from 'svelte';
import Icon, { type IconName } from '@/ui/components/icons/Icon.svelte';
import Btn from '@/ui/components/primitives/Btn.svelte';

let {
  icon = 'inbox',
  iconName,
  title = '',
  description = '',
  actionLabel = '',
  onAction,
  actionVariant = 'primary',
  compact = false,
  /** Fill the parent's height and center vertically (use inside min-h-0 scroll scroll containers). */
  fillParent = false,
  class: className = '',
  children,
}: {
  icon?: IconName;
  iconName?: IconName;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionVariant?: 'primary' | 'secondary' | 'outline';
  compact?: boolean;
  fillParent?: boolean;
  class?: string;
  children?: Snippet;
} = $props();

const displayIcon = $derived(iconName || icon);
</script>

<div
  class="flex flex-col items-center justify-center px-4 text-center select-none {compact
    ? 'py-8'
    : 'py-12'} {fillParent ? 'h-full min-h-full' : ''} {className}"
>
  {#if displayIcon}
    <div
      class="rounded-full bg-md-surface-variant/40 text-md-on-surface/50 flex items-center justify-center mb-3 shadow-inner {compact
        ? 'w-10 h-10'
        : 'w-14 h-14'}"
    >
      <Icon name={displayIcon} class={compact ? 'w-5 h-5' : 'w-7 h-7'} />
    </div>
  {/if}

  <h3
    class="text-md-on-surface max-w-sm mb-1 {compact ? 'text-sm font-semibold' : 'text-base font-bold'}"
  >{title}</h3>

  {#if description}
    <p
      class="text-xs text-md-on-surface/60 max-w-xs leading-relaxed {compact ? 'mb-3' : 'mb-4'}"
    >{description}</p>
  {/if}

  {#if children}
    <div class="mb-4">
      {@render children()}
    </div>
  {/if}

  {#if actionLabel && onAction}
    <Btn variant={actionVariant} size="sm" onclick={onAction}>
      {actionLabel}
    </Btn>
  {/if}
</div>
