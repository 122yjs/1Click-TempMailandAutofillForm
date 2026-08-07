<script lang="ts">
import type { Snippet } from 'svelte';
import { t } from 'svelte-i18n';
import SearchBar from '@/ui/components/composites/SearchBar.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';

let {
  value = $bindable(''),
  placeholder = 'Search...',
  ariaLabel = 'Search',
  totalCount,
  filteredCount,
  showFilterButton = false,
  filterActive = false,
  onFilterClick,
  scope = 'default',
  class: className = '',
  extraActions,
}: {
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  totalCount?: number;
  filteredCount?: number;
  showFilterButton?: boolean;
  filterActive?: boolean;
  onFilterClick?: () => void;
  scope?: string;
  class?: string;
  extraActions?: Snippet;
} = $props();

let searchInputEl: HTMLInputElement | null = null;
</script>

<div class="relative z-30 px-0 pt-3 pb-2 border-b border-md-outline-variant/15 bg-md-surface/95 backdrop-blur-sm {className}">
  <div class="relative flex items-center gap-2">
    <div class="flex-1 min-w-0">
      <SearchBar
        {scope}
        bind:value
        {placeholder}
        {ariaLabel}
        onInputRef={(el) => (searchInputEl = el)}
      >
        {#snippet filterControl()}
          {#if showFilterButton}
            <button
              type="button"
              class="w-8 h-8 flex items-center justify-center rounded-xl border transition-colors relative shrink-0
                {filterActive
                  ? 'border-md-primary bg-md-primary/10 text-md-primary'
                  : 'border-md-outline-variant text-md-on-surface/60 hover:bg-md-surface-variant'}"
              onclick={onFilterClick}
              aria-label={$t('common.filter')}
              title={$t('common.filter')}
            >
              <Icon name="filter" class="w-4 h-4" />
            </button>
          {/if}
        {/snippet}
      </SearchBar>
    </div>

    {#if extraActions}
      <div class="flex items-center gap-1.5 shrink-0">
        {@render extraActions()}
      </div>
    {/if}
  </div>

  {#if typeof filteredCount === 'number' && typeof totalCount === 'number' && value.trim().length > 0}
    <div class="mt-2 text-xs text-md-on-surface/50 font-medium px-1 flex items-center justify-between">
      <span>Showing {filteredCount} of {totalCount}</span>
      {#if value}
        <button
          type="button"
          class="text-md-primary hover:underline focus:outline-none"
          onclick={() => {
            value = '';
            // Return focus to the search input so the user can keep typing
            // instead of dropping focus to document.body.
            searchInputEl?.focus();
          }}
        >
          {$t('common.clearSearch')}
        </button>
      {/if}
    </div>
  {/if}
</div>
