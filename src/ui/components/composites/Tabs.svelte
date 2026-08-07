<script lang="ts">
/**
 * Reusable Tabs composite component.
 *
 * Variants:
 *  - variant="underline"  MD3 bottom-indicator tabs (default; for Mailbox, Autofill, etc.)
 *  - variant="pill"       Segmented pill tabs (for Addresses, AccountSelector, etc.)
 *
 * Supports: icon, heading label, subheading, badge count (null = hidden),
 *           drag-and-drop targets per tab, custom drop-ring highlight.
 */
import Icon from '@/ui/components/icons/Icon.svelte';

export type TabItem = {
  id: string;
  /** Heading / primary label text */
  label: string;
  /** Optional icon name (Icon component) */
  icon?: string;
  /** Optional sub-label below heading (pill variant) */
  subheading?: string;
  /** null = hidden, undefined = hidden, 0+ = shown */
  badge?: number | string | null;
};

let {
  tabs = [] as TabItem[],
  activeTab = $bindable(''),
  /** Visual variant */
  variant = 'underline' as 'underline' | 'pill',
  /** Whether tabs expand to fill the container width */
  fullWidth = false,
  /** ID of the tab currently being hovered over with a drag item */
  dropTargetId = null as string | null,
  onchange = (_id: string) => {},
  /** Called when a drag enters a tab area */
  ondragenter = (_id: string, _e: DragEvent) => {},
  /** Called when a drag leaves a tab area */
  ondragleave = (_id: string, _e: DragEvent) => {},
  /** Called when a drop occurs on a tab */
  ondrop = (_id: string, _e: DragEvent) => {},
  /** Called when a dragged item is over a tab (fires repeatedly) */
  ondragover = (_id: string, _e: DragEvent) => {},
} = $props<{
  tabs?: TabItem[];
  activeTab?: string;
  variant?: 'underline' | 'pill';
  fullWidth?: boolean;
  dropTargetId?: string | null;
  onchange?: (id: string) => void;
  ondragenter?: (id: string, e: DragEvent) => void;
  ondragleave?: (id: string, e: DragEvent) => void;
  ondrop?: (id: string, e: DragEvent) => void;
  ondragover?: (id: string, e: DragEvent) => void;
}>();

function handleTabClick(id: string) {
  activeTab = id;
  onchange(id);
}

const hasDragListeners = $derived(
  ondragenter !== undefined || ondragleave !== undefined || ondrop !== undefined
);

/** Whether badge should be shown for a tab */
function showBadge(tab: TabItem): boolean {
  return tab.badge !== undefined && tab.badge !== null;
}
</script>

{#if variant === 'pill'}
  <!-- ── Pill / segmented tabs ─────────────────────────────────────────── -->
  <div class="flex gap-1 p-1 rounded-full bg-md-surface-variant shrink-0 {fullWidth ? 'w-full' : ''}">
    {#each tabs as tab (tab.id)}
      {@const isActive = activeTab === tab.id}
      {@const isDropTarget = dropTargetId === tab.id}
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        class="flex items-center justify-center gap-2 px-3 py-1.5 h-10 min-h-10 max-h-10 rounded-full transition-all duration-200 {fullWidth
          ? 'flex-1'
          : 'flex-none min-w-[80px]'}
          {isActive ? 'bg-md-surface shadow-sm' : ''}
          {isDropTarget ? 'ring-2 ring-md-primary ring-inset' : ''}"
        onclick={() => handleTabClick(tab.id)}
        ondragover={hasDragListeners
          ? (e) => {
              e.preventDefault();
              ondragover(tab.id, e);
            }
          : undefined}
        ondragenter={hasDragListeners
          ? (e) => {
              ondragenter(tab.id, e);
            }
          : undefined}
        ondragleave={hasDragListeners
          ? (e) => {
              ondragleave(tab.id, e);
            }
          : undefined}
        ondrop={hasDragListeners
          ? (e) => {
              e.preventDefault();
              ondrop(tab.id, e);
            }
          : undefined}
      >
        {#if tab.icon}
          <Icon name={tab.icon} class="w-3.5 h-3.5 shrink-0 {isActive ? 'text-md-primary' : 'text-md-on-surface/40'}" />
        {/if}
        <span class="flex flex-col items-start justify-center leading-none min-w-0 {tab.subheading ? 'min-h-[28px] gap-0.5' : ''}">
          <span class="text-xs font-bold whitespace-nowrap {isActive ? 'text-md-on-surface' : 'text-md-on-surface/40'}">{tab.label}</span>
          {#if tab.subheading}
            <span class="text-label-sm font-medium truncate max-w-full {isActive ? 'text-md-on-surface/50' : 'text-md-on-surface/30'}">{tab.subheading}</span>
          {/if}
        </span>
        {#if showBadge(tab)}
          <span class="text-label-sm font-bold px-1.5 py-0.5 rounded-full shrink-0 {isActive ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface-variant/40 text-md-on-surface/60'}">
            {tab.badge}
          </span>
        {/if}
      </button>
    {/each}
  </div>

{:else}
  <!-- ── Underline tabs (MD3 style) ────────────────────────────────────── -->
  <div class="tabs-underline flex flex-row overflow-x-auto whitespace-nowrap gap-0 border-b border-md-outline-variant/30 {fullWidth ? 'w-full' : ''}">
    {#each tabs as tab (tab.id)}
      {@const isActive = activeTab === tab.id}
      <button
        type="button"
        role="tab"
        aria-selected={isActive}
        onclick={() => handleTabClick(tab.id)}
        class="flex flex-col items-center justify-center gap-0.5 px-4 py-2.5 relative transition-colors shrink-0 {fullWidth
          ? 'flex-1'
          : ''}
          {isActive
          ? 'text-md-primary'
          : 'text-md-on-surface-variant hover:text-md-on-surface hover:bg-md-surface-variant/20'}"
      >
        <div class="flex items-center gap-1.5">
          {#if tab.icon}
            <Icon name={tab.icon} class="w-4 h-4" />
          {/if}
          <span class="text-sm font-semibold">{tab.label}</span>
          {#if showBadge(tab)}
            <span class="inline-flex items-center justify-center bg-md-secondary-container text-md-on-secondary-container text-label-sm font-bold px-1.5 py-0.5 rounded-full min-w-[16px] h-[16px]">
              {tab.badge}
            </span>
          {/if}
        </div>
        {#if tab.subheading}
          <span class="text-label-sm text-md-on-surface-variant/70">{tab.subheading}</span>
        {/if}
        <!-- Active indicator bar -->
        {#if isActive}
          <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-md-primary rounded-t-full"></div>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .tabs-underline {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }
  .tabs-underline::-webkit-scrollbar {
    display: none;
  }
</style>
