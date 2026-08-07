<script lang="ts">
/**
 * Always-visible multi-select row for users who avoid long-press / marquee / context menu.
 * Hidden when list is empty. Enabled by default via parent (selectionUiEnabled).
 */
import { t } from 'svelte-i18n';
import Icon from '@/ui/components/icons/Icon.svelte';

let {
  visible = true,
  itemCount = 0,
  selectedCount = 0,
  selectionActive = false,
  onEnterSelection = () => {},
  onSelectAll = () => {},
  onClear = () => {},
  onExit = () => {},
  /** Extra action buttons (archive, delete, etc.) when selectionActive */
  actions = undefined as import('svelte').Snippet | undefined,
} = $props<{
  /** Parent feature flag — hide entirely when false */
  visible?: boolean;
  /** Total items in current list (hide toolbar when 0) */
  itemCount?: number;
  selectedCount?: number;
  selectionActive?: boolean;
  onEnterSelection?: () => void;
  onSelectAll?: () => void;
  onClear?: () => void;
  onExit?: () => void;
  actions?: import('svelte').Snippet;
}>();

const show = $derived(visible && itemCount > 0);
</script>

{#if show}
  <div
    class="selection-toolbar shrink-0 flex items-center gap-1.5 px-2 py-1.5 border-b border-md-outline-variant/30 bg-md-surface-container-low/80"
    role="toolbar"
    aria-label={$t('selection.toolbarAria')}
  >
    {#if !selectionActive}
      <button
        type="button"
        class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-md-secondary-container text-md-on-secondary-container hover:brightness-105 transition-all"
        onclick={(e) => {
          e.stopPropagation();
          onEnterSelection();
        }}
      >
        <Icon name="checkCircle" class="w-3.5 h-3.5" />
        {$t('selection.select')}
      </button>
      <span class="text-label-sm text-md-on-surface/40 truncate">{$t('selection.hint')}</span>
    {:else}
      <button
        type="button"
        class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-md-primary/15 text-md-primary hover:bg-md-primary/25 transition-colors"
        onclick={(e) => {
          e.stopPropagation();
          onSelectAll();
        }}
      >
        {$t('selection.selectAll')}
      </button>
      {#if selectedCount > 0}
        <button
          type="button"
          class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-md-on-surface/70 hover:bg-md-surface-variant transition-colors"
          onclick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          {$t('selection.clear')}
        </button>
      {/if}
      <span class="text-label-sm font-semibold text-md-on-surface/55 tabular-nums">
        {$t('selection.count', { values: { n: selectedCount } })}
      </span>
      <div class="flex-1 min-w-0"></div>
      {#if actions}
        {@render actions()}
      {/if}
      <button
        type="button"
        class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium text-md-on-surface/60 hover:bg-md-surface-variant transition-colors"
        onclick={(e) => {
          e.stopPropagation();
          onExit();
        }}
      >
        {$t('common.done')}
      </button>
    {/if}
  </div>
{/if}
