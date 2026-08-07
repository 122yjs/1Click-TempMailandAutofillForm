<script lang="ts">
import type { Snippet } from 'svelte';
import Icon from '@/ui/components/icons/Icon.svelte';

let {
  title = '',
  description = '',
  icon = '',
  action,
  header,
  children,
  class: className = '',
}: {
  title?: string;
  description?: string;
  icon?: string;
  action?: Snippet;
  header?: Snippet;
  children?: Snippet;
  class?: string;
} = $props();
</script>

<div
  class="bg-md-surface-container rounded-2xl p-4 shadow-sm border border-md-outline-variant/15 flex flex-col gap-3 transition-colors {className}"
>
  {#if header}
    {@render header()}
  {:else if title || icon || action}
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2.5 min-w-0">
        {#if icon}
          <div class="w-8 h-8 rounded-xl bg-md-primary/10 text-md-primary flex items-center justify-center shrink-0">
            <Icon name={icon} class="w-4 h-4" />
          </div>
        {/if}
        <div class="min-w-0">
          {#if title}
            <h3 class="text-sm font-bold text-md-on-surface truncate">{title}</h3>
          {/if}
          {#if description}
            <p class="text-xs text-md-on-surface/60 truncate">{description}</p>
          {/if}
        </div>
      </div>
      {#if action}
        <div class="shrink-0 flex items-center gap-2">
          {@render action()}
        </div>
      {/if}
    </div>
  {/if}

  {#if children}
    {@render children()}
  {/if}
</div>
