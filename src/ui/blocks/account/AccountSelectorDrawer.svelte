<script lang="ts">
import { onDestroy, tick } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import { updateInboxTag, updateInboxTags } from '@/features/account/tag-actions.js';
import { canUnarchive } from '@/features/inbox/inbox-management.js';
import AccountCard from '@/ui/blocks/account/AccountCard.svelte';
import TagDialog from '@/ui/blocks/dialogs/TagDialog.svelte';
import SearchBar from '@/ui/components/composites/SearchBar.svelte';
import Tabs from '@/ui/components/composites/Tabs.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import {
  canAutoRenew,
  isArchived as isAccountArchivedStatus,
  isDeleted as isAccountDeletedStatus,
  isExpiredNotArchived,
  isTimeExpired,
  resolveDragLifecycleAction,
} from '@/utils/account-status.js';
import { accountMatchesTagSearch, accountTagsList } from '@/utils/account-tags.js';
import {
  loadAllProviderConfigs,
  loadProviderConfig,
  type ProviderConfig,
} from '@/utils/email-service.js';
import { fitActionButtonsLayout } from '@/utils/fit-label-font.js';
import { setupFocusTrap } from '@/utils/focusTrap.js';
import { logError } from '@/utils/logger.js';
import {
  collectIntersectingIds,
  isInteractiveTarget,
  MARQUEE_THRESHOLD,
  normalizeMarquee,
} from '@/utils/marquee-selection.js';
import { portalDialogAction } from '@/utils/portal-layers.js';
import { getInboxes, setInboxes } from '@/utils/storage-keys.js';
import type { Account } from '@/utils/types.js';
import { actionBtnCascade } from '@/utils/use-action-btn-cascade.js';

let {
  open = false,
  onClose = () => {},
  selectedEmail = '',
  accounts = [],
  allAccounts = [],
  onSelectAccount = () => {},
  onEditAccount = () => {},
  onCreateInbox = () => {},
  onNavigateToManage = () => {},
  onReloadAccounts = async () => {},
  onNavigateToSettings = () => {},
  onCreateInboxWithProvider = () => {},
  onToggleAutoExtend = () => {},
  onArchiveAccount = () => {},
  onUnarchiveAccount = () => {},
  onRemoveAccount = () => {},
  onRestoreAccount = () => {},
  onTagAccount = () => {},
  onMarkAllRead = async (_account: Account) => {},
  onMarkAllUnread = async (_account: Account) => {},
  showToast = (_message: string, _type?: string, _undo?: (() => void | Promise<void>) | null) => {},
  selectedProviderInstance = null,
  defaultDomain = '',
} = $props<{
  open?: boolean;
  onClose?: () => void;
  selectedEmail?: string;
  accounts?: Account[];
  allAccounts?: Account[];
  onSelectAccount?: (address: string) => void;
  onEditAccount?: (account: Account) => void;
  onCreateInbox?: (provider?: string, instanceId?: string) => void;
  onNavigateToManage?: () => void;
  onReloadAccounts?: () => Promise<void>;
  onNavigateToSettings?: () => void;
  onCreateInboxWithProvider?: (providerId: string, instanceId?: string) => void;
  onToggleAutoExtend?: (account: Account) => void;
  onArchiveAccount?: (account: Account) => void;
  onUnarchiveAccount?: (account: Account) => void;
  onRemoveAccount?: (address: string) => void;
  onRestoreAccount?: (address: string) => void;
  onTagAccount?: (account: Account) => void;
  onMarkAllRead?: (account: Account) => void | Promise<void>;
  onMarkAllUnread?: (account: Account) => void | Promise<void>;
  showToast?: (message: string, type?: string, undo?: (() => void | Promise<void>) | null) => void;
  selectedProviderInstance?: string | null;
  defaultDomain?: string;
}>();

let openSection = $state<'live' | 'inactive'>('live');
let prevLiveCount = -1;
let prevInactiveCount = -1;
/** Dynamic font & layout for sticky Create / Manage action labels */
let stickyActionFontPx = $state(12);
let stickyActionEqualWidth = $state(true);
let stickyActionsEl = $state<HTMLElement | null>(null);

function fitStickyActionFonts() {
  if (!stickyActionsEl) return;
  const buttons = Array.from(stickyActionsEl.querySelectorAll<HTMLElement>('button'));
  if (!buttons.length) return;
  const items = buttons.map((btn) => {
    const el = btn.querySelector('span.btn-label, span.whitespace-nowrap');
    const text = (el?.textContent || btn.textContent || '').trim();
    return { text };
  });
  const res = fitActionButtonsLayout(items, stickyActionsEl.clientWidth, {
    basePx: 12,
    minPx: 8.5,
    weight: 600,
    reservedPx: 36,
    gapPx: 6,
  });
  stickyActionFontPx = res.fontPx;
  stickyActionEqualWidth = res.equalWidth;
}

$effect(() => {
  void $t;
  void open;
  if (!open) return;
  void tick().then(() => {
    fitStickyActionFonts();
    requestAnimationFrame(fitStickyActionFonts);
  });
});

let tabDropTarget = $state<'live' | 'inactive' | null>(null);
let crossTabPrompt = $state<{
  direction: 'toInactive' | 'toLive' | 'toLiveRenew';
  account: Account;
} | null>(null);

/** Marquee multi-select inside account selector */
let selectorSelectedIds = $state<Set<string>>(new Set());
let marqueeActive = $state(false);
let marqueeStart = $state<{ x: number; y: number } | null>(null);
let marqueeRect = $state<{ left: number; top: number; right: number; bottom: number } | null>(null);
let listScrollEl = $state<HTMLElement | null>(null);

/** Confirm dialog for strip action drops (archive/delete/tag/auto-renew) */
let actionDropPrompt = $state<{
  action: 'archive' | 'delete' | 'tag' | 'autoRenew';
  account: Account;
} | null>(null);
let stripDropTarget = $state<'archive' | 'delete' | 'tag' | 'autoRenew' | null>(null);

$effect(() => {
  const liveCount = accountsByCategory.live.length;
  const inactiveCount = accountsByCategory.available.length + accountsByCategory.unavailable.length;
  if (prevLiveCount !== -1) {
    if (liveCount < prevLiveCount && inactiveCount > prevInactiveCount) {
      openSection = 'inactive';
    } else if (inactiveCount < prevInactiveCount && liveCount > prevLiveCount) {
      openSection = 'live';
    }
  }
  prevLiveCount = liveCount;
  prevInactiveCount = inactiveCount;
});

let availableCollapsed = $state(false);
let unavailableCollapsed = $state(false);
let selectedTagFilter = $state<string | null>(null);
let dropdownSearch = $state('');
let tagDialogOpen = $state(false);
let tagTargetAccount = $state<Account | null>(null);
let draggedAccount = $state<Account | null>(null);
let draggedFromSection = $state<'live' | 'inactive' | null>(null);
let dropTargetAccount = $state<Account | null>(null);
let localAccountOrder = $state<Account[] | null>(null);
let activeAccountIndex = $state(0);
let searchInputRef = $state<HTMLInputElement | null>(null);
let dialogRef = $state<HTMLElement | null>(null);
let cleanupFocusTrap: (() => void) | null = null;
let overlayHost = $state<HTMLElement | null>(null);

function closeOverlay() {
  dropdownSearch = '';
  actionDropPrompt = null;
  crossTabPrompt = null;
  removePortalOverlay();
  onClose();
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeOverlay();
  if (e.key === 'Tab') {
    const focusableElements = document.querySelectorAll(
      '#account-selector-dialog button, #account-selector-dialog input, #account-selector-dialog [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

    if (e.shiftKey) {
      if (document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      }
    } else {
      if (document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    }
  }
}

// Auto-focus search input when dialog opens
$effect(() => {
  if (open) {
    setTimeout(() => {
      searchInputRef?.focus();
    }, 50);
  }
});

// Portal overlay to document.body so header/footer stacking never covers it.
// The overlay root uses `use:portalToBody` (see markup) — the action moves it
// to document.body on mount and removes it on destroy, avoiding the previous
// rAF + querySelector('.account-selector-overlay') timing fragility.
function removePortalOverlay() {
  try {
    if (overlayHost?.parentElement === document.body) overlayHost.remove();
  } catch {
    /* ignore */
  }
  overlayHost = null;
}

$effect(() => {
  if (open) {
    document.body.style.overflow = 'hidden';
    setTimeout(() => {
      if (dialogRef) {
        cleanupFocusTrap = setupFocusTrap(dialogRef);
      }
    }, 50);
  }
  return () => {
    document.body.style.overflow = '';
    if (cleanupFocusTrap) {
      cleanupFocusTrap();
      cleanupFocusTrap = null;
    }
  };
});

// Wrap callbacks to clear cache before actions
const wrappedOnArchiveAccount = (account: Account) => {
  localAccountOrder = null;
  onArchiveAccount(account);
};

const wrappedOnUnarchiveAccount = (account: Account) => {
  localAccountOrder = null;
  onUnarchiveAccount(account);
};

const wrappedOnRemoveAccount = (address: string) => {
  localAccountOrder = null;
  onRemoveAccount(address);
};

const wrappedOnRestoreAccount = (address: string) => {
  localAccountOrder = null;
  onRestoreAccount(address);
};

function toggleSection(section: 'live' | 'inactive') {
  openSection = section;
}

// Filter accounts by search (address or tag)
let filteredAccounts = $derived.by(() => {
  const source =
    draggedAccount !== null && localAccountOrder !== null ? localAccountOrder : allAccounts;
  if (!dropdownSearch) return source;
  const search = dropdownSearch.toLowerCase();
  return source.filter(
    (a: Account) => a.address.toLowerCase().includes(search) || accountMatchesTagSearch(a, search)
  );
});

// Filter accounts by tag
let tagFilteredAccounts = $derived.by(() => {
  if (!selectedTagFilter) return filteredAccounts;
  return filteredAccounts.filter((a: Account) => {
    if (selectedTagFilter === 'archived') return a.status === 'archived';
    if (selectedTagFilter === 'deleted') return a.status === 'deleted';
    if (selectedTagFilter === 'expired') return a.status === 'expired';
    return false;
  });
});

// Helper to check if account can be recoverable
function isRecoverable(account: Account): boolean {
  const currentTime = Date.now();
  const expiresAt = account.expiresAt || currentTime;
  const isExpired = currentTime >= expiresAt;

  if (!isExpired) return true;
  if (account.autoExtend) return true;
  try {
    const config = loadProviderConfig(account.provider);
    if (config.expiry?.renewable) return true;
  } catch {
    /* ignore */
  }
  return false;
}

// Group accounts by categorization (Live, Available, Unavailable)
let accountsByCategory = $derived.by(() => {
  const live: Account[] = [];
  const available: Account[] = [];
  const unavailable: Account[] = [];

  tagFilteredAccounts.forEach((a: Account) => {
    const currentTime = Date.now();
    const expiresAt = a.expiresAt || currentTime;
    const isExpired = currentTime >= expiresAt;

    if (a.status === 'active' && !isExpired) {
      live.push(a);
    } else {
      if (isRecoverable(a)) {
        available.push(a);
      } else {
        unavailable.push(a);
      }
    }
  });

  return { live, available, unavailable };
});

async function updateTag(accountId: string, tag: string, color: string | undefined = undefined) {
  await updateInboxTag(accountId, tag, browser, { onReloadAccounts }, color);
}

function openTagDialogForAccount(account: Account) {
  tagTargetAccount = account;
  tagDialogOpen = true;
}

function closeTagDialog() {
  tagDialogOpen = false;
  tagTargetAccount = null;
}

function saveTag(tag: string, color: string) {
  if (!tagTargetAccount) return;
  updateTag(tagTargetAccount.id, tag, color);
  closeTagDialog();
}

function saveTags(tags: Array<{ name: string; color: string }>) {
  if (!tagTargetAccount) return;
  void updateInboxTags(tagTargetAccount.id, tags, browser, { onReloadAccounts });
  closeTagDialog();
}

// Drag and drop handlers
let lastDraggedAccount: Account | null = null;

function handleDragStart(e: DragEvent, account: Account) {
  draggedAccount = account;
  lastDraggedAccount = account;
  draggedFromSection = openSection;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData('text/plain', account.id);
    e.dataTransfer.setData('application/x-account-id', account.id);
  }
}

function resolveDraggedAccount(e?: DragEvent): Account | null {
  const fromState = draggedAccount || lastDraggedAccount;
  if (fromState) return fromState;
  const id =
    e?.dataTransfer?.getData('application/x-account-id') ||
    e?.dataTransfer?.getData('text/plain') ||
    '';
  if (!id) return null;
  return allAccounts.find((a: Account) => a.id === id) || null;
}

function handleDragEnd() {
  draggedAccount = null;
  draggedFromSection = null;
  dropTargetAccount = null;
  tabDropTarget = null;
  stripDropTarget = null;
  setTimeout(() => {
    lastDraggedAccount = null;
  }, 50);
}

function handleTabDrop(tab: 'live' | 'inactive', e?: DragEvent) {
  tabDropTarget = null;
  const account = resolveDraggedAccount(e);
  if (!account) return;
  handleDragEnd();
  const action = resolveDragLifecycleAction(account, tab);
  if (action === 'noop') return;
  if (action === 'error_no_renew') {
    showToast($t('account.cannotActivateExpiredNoRenew'));
    return;
  }
  if (action === 'archive') {
    crossTabPrompt = { direction: 'toInactive', account };
    return;
  }
  if (action === 'renew' || action === 'unarchive_and_renew') {
    crossTabPrompt = { direction: 'toLiveRenew', account };
    return;
  }
  if (action === 'unarchive') {
    crossTabPrompt = { direction: 'toLive', account };
  }
}

function applyTabDropToLiveRenew() {
  const account = crossTabPrompt?.account;
  crossTabPrompt = null;
  if (!account) return;
  if (!account.autoExtend) onToggleAutoExtend(account);
}

function handleActionStripDrop(action: 'archive' | 'delete' | 'tag' | 'autoRenew', e?: DragEvent) {
  stripDropTarget = null;
  const account = resolveDraggedAccount(e);
  if (!account) return;
  handleDragEnd();
  if (action === 'archive') wrappedOnArchiveAccount(account);
  else if (action === 'delete') wrappedOnRemoveAccount(account.address);
  else if (action === 'tag') openTagDialogForAccount(account);
  else if (action === 'autoRenew') onToggleAutoExtend(account);
}

function applyActionDrop() {
  const p = actionDropPrompt;
  actionDropPrompt = null;
  if (!p) return;
  if (p.action === 'archive') wrappedOnArchiveAccount(p.account);
  else if (p.action === 'delete') wrappedOnRemoveAccount(p.account.address);
  else if (p.action === 'tag') openTagDialogForAccount(p.account);
  else if (p.action === 'autoRenew') onToggleAutoExtend(p.account);
}

function applyTabDropToInactive(action: 'archive' | 'delete') {
  const account = crossTabPrompt?.account;
  crossTabPrompt = null;
  if (!account) return;
  if (action === 'archive') {
    wrappedOnArchiveAccount(account);
  } else {
    wrappedOnRemoveAccount(account.address);
  }
}

function applyTabDropToLive(action: 'unarchive' | 'restore') {
  const account = crossTabPrompt?.account;
  crossTabPrompt = null;
  if (!account) return;
  if (action === 'unarchive') {
    if (!canUnarchive(account)) return;
    wrappedOnUnarchiveAccount(account);
  } else {
    wrappedOnRestoreAccount(account.address);
  }
}

// Marquee multi-select
function onListMarqueeDown(e: PointerEvent) {
  if (e.button !== 0) return;
  if (isInteractiveTarget(e.target)) return;
  const root = e.currentTarget as HTMLElement | null;
  if (!root) return;
  listScrollEl = root;
  marqueeStart = { x: e.clientX, y: e.clientY };
  marqueeActive = false;
  marqueeRect = null;
  const onMove = (ev: PointerEvent) => {
    if (!marqueeStart) return;
    const dx = Math.abs(ev.clientX - marqueeStart.x);
    const dy = Math.abs(ev.clientY - marqueeStart.y);
    if (!marqueeActive && dx < MARQUEE_THRESHOLD && dy < MARQUEE_THRESHOLD) return;
    marqueeActive = true;
    marqueeRect = normalizeMarquee(marqueeStart, { x: ev.clientX, y: ev.clientY });
    if (listScrollEl) {
      const ids = collectIntersectingIds(listScrollEl, '[data-marquee-id]', marqueeRect);
      selectorSelectedIds = new Set(ids);
    }
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    marqueeStart = null;
    marqueeActive = false;
    marqueeRect = null;
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function handleDragOver(e: DragEvent, targetAccount: Account) {
  e.preventDefault();
  dropTargetAccount = targetAccount;
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
}

async function handleDrop(e: DragEvent, targetAccount: Account, section: 'live' | 'inactive') {
  e.preventDefault();
  dropTargetAccount = null;
  if (!draggedAccount || draggedAccount.id === targetAccount.id) return;
  if (draggedFromSection !== section) return;

  const sourceDragged = draggedAccount;
  handleDragEnd();

  try {
    const inboxes = await getInboxes();
    const sourceIndex = inboxes.findIndex((i: Account) => i.id === sourceDragged.id);
    if (sourceIndex === -1) return;

    const filteredInboxes = inboxes.filter((i: Account) => i.id !== sourceDragged.id);
    const targetIndex = filteredInboxes.findIndex((i: Account) => i.id === targetAccount.id);

    if (targetIndex === -1) {
      logError('Drag-drop: could not find target account ID in storage', {
        sourceId: sourceDragged.id,
        targetId: targetAccount.id,
      });
      return;
    }

    filteredInboxes.splice(targetIndex, 0, sourceDragged);

    const currentSource = localAccountOrder ?? allAccounts;
    const filteredLocal = currentSource.filter((a: Account) => a.id !== sourceDragged.id);
    const localTargetIdx = filteredLocal.findIndex((a: Account) => a.id === targetAccount.id);
    if (localTargetIdx !== -1) {
      filteredLocal.splice(localTargetIdx, 0, sourceDragged);
      localAccountOrder = filteredLocal;
    }

    await setInboxes(filteredInboxes);
    await onReloadAccounts();
    localAccountOrder = null;
  } catch (error) {
    logError('Failed to reorder accounts', error);
    localAccountOrder = null;
  }
}
</script>

{#if open}
  <!-- Low z so portaled Tag/Confirm dialogs (z-10000) always paint above -->
  <div
    bind:this={overlayHost}
    use:portalDialogAction
    class="account-selector-overlay fixed inset-0 z-[40] flex items-stretch justify-stretch"
    data-portal-layer="accountSelector"
    role="dialog"
    aria-modal="true"
  >
    <!-- Scrim blocks all chrome interaction -->
    <button
      id="button-close-dropdown-backdrop"
      type="button"
      class="absolute inset-0 z-0 cursor-default border-0 bg-md-scrim/50 backdrop-blur-sm"
      aria-label={$t('common.close')}
      onclick={closeOverlay}
      onkeydown={handleKeyDown}
    ></button>

    <!-- Content inset: 25px all sides (relative so Tag/Confirm dialogs cover this layer only) -->
    <div
      class="relative z-10 flex flex-col w-full h-full min-h-0"
      style="padding: 25px;"
      data-account-selector-pane
    >
      <button
        id="button-close-dialog"
        type="button"
        class="self-end shrink-0 mb-2 w-9 h-9 rounded-full bg-md-surface hover:bg-md-surface-variant flex items-center justify-center shadow-md transition-colors"
        aria-label={$t('common.close')}
        title={$t('common.close')}
        onclick={closeOverlay}
      >
        <Icon name="x" class="w-4 h-4 text-md-on-surface/70" />
      </button>

      <!-- Dialog card fills remaining space -->
      <div id="account-selector-dialog" bind:this={dialogRef} class="bg-md-surface rounded-xl shadow-2xl p-3 flex flex-col gap-2 w-full flex-1 min-h-0 overflow-hidden border border-md-outline-variant/30">
        <!-- Sticky header: search -->
        <div class="relative shrink-0">
          <SearchBar
            scope="account-selector"
            inputId="account-selector-search"
            bind:value={dropdownSearch}
            placeholder={$t('mailManagement.searchAddressesOrTags')}
            animatedPlaceholders={[
              $t('mailManagement.searchAddressesOrTags'),
              $t('tagManagement.tagName'),
              $t('account.address'),
            ]}
            ariaLabel={$t('mailManagement.searchAddressesOrTags')}
            settingsStyle={true}
            showSlashButton={false}
            showVoiceSearch={false}
            onInputRef={(el) => (searchInputRef = el)}
            onkeydown={(e) => {
              const activeList = openSection === 'live' ? accountsByCategory.live : [...accountsByCategory.available, ...accountsByCategory.unavailable];
              if (activeList.length === 0) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                activeAccountIndex = (activeAccountIndex + 1) % activeList.length;
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                activeAccountIndex = (activeAccountIndex - 1 + activeList.length) % activeList.length;
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const target = activeList[activeAccountIndex];
                if (target) {
                  onSelectAccount(target.address);
                  closeOverlay();
                }
              }
            }}
          />
        </div>

        <div class="space-y-1 flex-1 min-h-0 flex flex-col">
          <!-- Live/Inactive tabs (drop targets for drag) — sticky under search -->
          <Tabs
            variant="pill"
            fullWidth
            activeTab={openSection}
            dropTargetId={tabDropTarget}
            tabs={[
              {
                id: 'live',
                label: $t('mailManagement.live'),
                badge: accountsByCategory.live.length,
              },
              {
                id: 'inactive',
                label: $t('mailManagement.inactive'),
                badge: accountsByCategory.available.length + accountsByCategory.unavailable.length,
              },
            ]}
            onchange={(id) => toggleSection(id as 'live' | 'inactive')}
            ondragover={(id, e) => {
              e.preventDefault();
              tabDropTarget = id as 'live' | 'inactive';
            }}
            ondragleave={(id) => {
              if (tabDropTarget === id) tabDropTarget = null;
            }}
            ondrop={(id, e) => {
              e.preventDefault();
              e.stopPropagation();
              tabDropTarget = null;
              handleTabDrop(id as 'live' | 'inactive', e);
            }}
          />

          <!-- Live tab content -->
          {#if openSection === 'live'}
            <div
              class="relative space-y-1 mt-1 flex-1 min-h-0 overflow-y-auto"
              role="list"
              onpointerdown={onListMarqueeDown}
            >
              {#each accountsByCategory.live as account (account.id)}
                <div
                  data-marquee-id={account.id}
                  class="rounded-xl {selectorSelectedIds.has(account.id) ? 'ring-2 ring-md-secondary' : ''}"
                  ondrop={(e) => handleDrop(e, account, 'live')}
                  ondragover={(e) => handleDragOver(e, account)}
                  role="listitem"
                >
                  <AccountCard
                    {account}
                    {selectedEmail}
                    isInAvailable={false}
                    isInUnavailable={false}
                    draggable={true}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDrop={(e) => handleDrop(e, account, 'live')}
                    isDragging={draggedAccount?.id === account.id}
                    isDropTarget={dropTargetAccount?.id === account.id}
                    onSelectAccount={(address) => { onSelectAccount(address); closeOverlay(); }}
                    onToggleAutoExtend={onToggleAutoExtend}
                    onArchiveAccount={wrappedOnArchiveAccount}
                    onUnarchiveAccount={wrappedOnUnarchiveAccount}
                    onEditAccount={onEditAccount}
                    onRemoveAccount={wrappedOnRemoveAccount}
                    onRestoreAccount={wrappedOnRestoreAccount}
                    onTagAccount={openTagDialogForAccount}
                    onMarkAllRead={(acc) => void onMarkAllRead(acc)}
                    onMarkAllUnread={(acc) => void onMarkAllUnread(acc)}
                  />
                </div>
              {/each}
            </div>
          {/if}

          <!-- Inactive tab content -->
          {#if openSection === 'inactive'}
            <!-- Tag filter pills -->
            <div class="flex gap-1 mt-1 px-2 flex-wrap">
              <button
                id="button-filter-all"
                class="text-xs px-2 py-0.5 rounded-full {selectedTagFilter === null ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface-variant text-md-on-surface/60'} hover:bg-md-primary hover:text-md-on-primary transition-colors"
                onclick={() => (selectedTagFilter = null)}
              >
                {$t('common.all')}
              </button>
              <button
                id="button-filter-archived"
                class="text-xs px-2 py-0.5 rounded-full {selectedTagFilter === 'archived' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface-variant text-md-on-surface/60'} hover:bg-md-primary hover:text-md-on-primary transition-colors"
                onclick={() => (selectedTagFilter = selectedTagFilter === 'archived' ? null : 'archived')}
              >
                {$t('common.archived')}
              </button>
              <button
                id="button-filter-deleted"
                class="text-xs px-2 py-0.5 rounded-full {selectedTagFilter === 'deleted' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface-variant text-md-on-surface/60'} hover:bg-md-primary hover:text-md-on-primary transition-colors"
                onclick={() => (selectedTagFilter = selectedTagFilter === 'deleted' ? null : 'deleted')}
              >
                {$t('common.deleted')}
              </button>
              <button
                id="button-filter-expired"
                class="text-xs px-2 py-0.5 rounded-full {selectedTagFilter === 'expired' ? 'bg-md-primary text-md-on-primary' : 'bg-md-surface-variant text-md-on-surface/60'} hover:bg-md-primary hover:text-md-on-primary transition-colors"
                onclick={() => (selectedTagFilter = selectedTagFilter === 'expired' ? null : 'expired')}
              >
                {$t('mailManagement.expiredStatus')}
              </button>
            </div>

            <!-- Available collapsible section -->
            <div class="mt-2">
              <button
                id="button-collapse-available"
                class="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-md-surface-variant transition-colors"
                onclick={() => (availableCollapsed = !availableCollapsed)}
              >
                <span class="text-label-sm font-semibold text-md-on-surface">{$t('account.available')} ({accountsByCategory.available.length})</span>
                <Icon name="chevronDown" class={`w-4 h-4 text-md-on-surface/50 transition-transform ${availableCollapsed ? 'rotate-180' : ''}`} />
              </button>
              {#if !availableCollapsed && accountsByCategory.available.length > 0}
                <div
                  class="mt-1 space-y-1 max-h-60 overflow-y-auto"
                  role="list"
                  onpointerdown={onListMarqueeDown}
                >
                  {#each accountsByCategory.available as account (account.id)}
                    <div
                      data-marquee-id={account.id}
                      class="rounded-xl {selectorSelectedIds.has(account.id) ? 'ring-2 ring-md-secondary' : ''}"
                      ondrop={(e) => handleDrop(e, account, 'inactive')}
                      ondragover={(e) => handleDragOver(e, account)}
                      role="listitem"
                    >
                      <AccountCard
                        {account}
                        {selectedEmail}
                        isInAvailable={true}
                        isInUnavailable={false}
                        draggable={true}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onDrop={(e) => handleDrop(e, account, 'inactive')}
                        isDragging={draggedAccount?.id === account.id}
                        isDropTarget={dropTargetAccount?.id === account.id}
                        onSelectAccount={(address) => { onSelectAccount(address); closeOverlay(); }}
                        onToggleAutoExtend={onToggleAutoExtend}
                        onArchiveAccount={wrappedOnArchiveAccount}
                        onUnarchiveAccount={wrappedOnUnarchiveAccount}
                        onEditAccount={onEditAccount}
                        onRemoveAccount={wrappedOnRemoveAccount}
                        onRestoreAccount={wrappedOnRestoreAccount}
                        onTagAccount={openTagDialogForAccount}
                        onMarkAllRead={(acc) => void onMarkAllRead(acc)}
                        onMarkAllUnread={(acc) => void onMarkAllUnread(acc)}
                      />
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <!-- Unavailable collapsible section -->
            <div class="mt-2">
              <button
                id="button-collapse-unavailable"
                class="w-full flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-md-surface-variant transition-colors"
                onclick={() => (unavailableCollapsed = !unavailableCollapsed)}
              >
                <span class="text-label-sm font-semibold text-md-on-surface">{$t('account.unavailable')} ({accountsByCategory.unavailable.length})</span>
                <Icon name="chevronDown" class={`w-4 h-4 text-md-on-surface/50 transition-transform ${unavailableCollapsed ? 'rotate-180' : ''}`} />
              </button>
              {#if !unavailableCollapsed && accountsByCategory.unavailable.length > 0}
                <div
                  class="mt-1 space-y-1 max-h-60 overflow-y-auto"
                  role="list"
                  onpointerdown={onListMarqueeDown}
                >
                  {#each accountsByCategory.unavailable as account (account.id)}
                    <div
                      data-marquee-id={account.id}
                      class="rounded-xl {selectorSelectedIds.has(account.id) ? 'ring-2 ring-md-secondary' : ''}"
                      ondrop={(e) => handleDrop(e, account, 'inactive')}
                      ondragover={(e) => handleDragOver(e, account)}
                      role="listitem"
                    >
                      <AccountCard
                        {account}
                        {selectedEmail}
                        isInAvailable={false}
                        isInUnavailable={true}
                        draggable={true}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onDrop={(e) => handleDrop(e, account, 'inactive')}
                        isDragging={draggedAccount?.id === account.id}
                        isDropTarget={dropTargetAccount?.id === account.id}
                        onSelectAccount={(address) => { onSelectAccount(address); closeOverlay(); }}
                        onToggleAutoExtend={onToggleAutoExtend}
                        onArchiveAccount={wrappedOnArchiveAccount}
                        onUnarchiveAccount={wrappedOnUnarchiveAccount}
                        onEditAccount={onEditAccount}
                        onRemoveAccount={wrappedOnRemoveAccount}
                        onRestoreAccount={wrappedOnRestoreAccount}
                        onTagAccount={openTagDialogForAccount}
                        onMarkAllRead={(acc) => void onMarkAllRead(acc)}
                        onMarkAllUnread={(acc) => void onMarkAllUnread(acc)}
                      />
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>

        <!-- Quick actions: drop targets (divs — buttons often swallow HTML5 drop) -->
        <div class="flex flex-row gap-1" use:actionBtnCascade>
          <div
            role="button"
            tabindex="0"
            id="button-strip-archive"
            class="flex-1 min-w-0 px-1 py-1.5 rounded-lg text-xs font-bold flex flex-col items-center gap-0.5 transition-colors cursor-pointer {stripDropTarget === 'archive' ? 'ring-2 ring-md-warning bg-md-warning/15' : 'bg-md-surface-variant/80 hover:bg-md-surface-variant'}"
            ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; stripDropTarget = 'archive'; }}
            ondragenter={(e) => { e.preventDefault(); stripDropTarget = 'archive'; }}
            ondragleave={() => { if (stripDropTarget === 'archive') stripDropTarget = null; }}
            ondrop={(e) => { e.preventDefault(); e.stopPropagation(); handleActionStripDrop('archive', e); }}
            onclick={(e) => {
              e.stopPropagation();
              const curr = allAccounts.find((a: Account) => a.address === selectedEmail);
              if (curr) wrappedOnArchiveAccount(curr);
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                const curr = allAccounts.find((a: Account) => a.address === selectedEmail);
                if (curr) wrappedOnArchiveAccount(curr);
              }
            }}
          >
            <Icon name="archive" class="w-3.5 h-3.5 pointer-events-none" />
            <span class="whitespace-nowrap overflow-visible pointer-events-none">{$t('common.archive')}</span>
          </div>
          <div
            role="button"
            tabindex="0"
            id="button-strip-delete"
            class="flex-1 min-w-0 px-1 py-1.5 rounded-lg text-xs font-bold flex flex-col items-center gap-0.5 transition-colors cursor-pointer {stripDropTarget === 'delete' ? 'ring-2 ring-md-error bg-md-error/15' : 'bg-md-surface-variant/80 hover:bg-md-surface-variant'}"
            ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; stripDropTarget = 'delete'; }}
            ondragenter={(e) => { e.preventDefault(); stripDropTarget = 'delete'; }}
            ondragleave={() => { if (stripDropTarget === 'delete') stripDropTarget = null; }}
            ondrop={(e) => { e.preventDefault(); e.stopPropagation(); handleActionStripDrop('delete', e); }}
            onclick={(e) => {
              e.stopPropagation();
              const curr = allAccounts.find((a: Account) => a.address === selectedEmail);
              if (curr) wrappedOnRemoveAccount(curr.address);
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                const curr = allAccounts.find((a: Account) => a.address === selectedEmail);
                if (curr) wrappedOnRemoveAccount(curr.address);
              }
            }}
          >
            <Icon name="trash" class="w-3.5 h-3.5 text-md-error pointer-events-none" />
            <span class="whitespace-nowrap overflow-visible pointer-events-none">{$t('common.delete')}</span>
          </div>
          <div
            role="button"
            tabindex="0"
            id="button-strip-tag"
            class="flex-1 min-w-0 px-1 py-1.5 rounded-lg text-xs font-bold flex flex-col items-center gap-0.5 transition-colors cursor-pointer {stripDropTarget === 'tag' ? 'ring-2 ring-md-primary bg-md-primary/15' : 'bg-md-surface-variant/80 hover:bg-md-surface-variant'}"
            ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; stripDropTarget = 'tag'; }}
            ondragenter={(e) => { e.preventDefault(); stripDropTarget = 'tag'; }}
            ondragleave={() => { if (stripDropTarget === 'tag') stripDropTarget = null; }}
            ondrop={(e) => { e.preventDefault(); e.stopPropagation(); handleActionStripDrop('tag', e); }}
            onclick={(e) => {
              e.stopPropagation();
              const curr = allAccounts.find((a: Account) => a.address === selectedEmail);
              if (curr) openTagDialogForAccount(curr);
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                const curr = allAccounts.find((a: Account) => a.address === selectedEmail);
                if (curr) openTagDialogForAccount(curr);
              }
            }}
          >
            <Icon name="tag" class="w-3.5 h-3.5 pointer-events-none" />
            <span class="whitespace-nowrap overflow-visible pointer-events-none">{$t('common.addTag')}</span>
          </div>
          <div
            role="button"
            tabindex="0"
            id="button-strip-autorenew"
            class="flex-1 min-w-0 px-1 py-1.5 rounded-lg text-xs font-bold flex flex-col items-center gap-0.5 transition-colors cursor-pointer {stripDropTarget === 'autoRenew' ? 'ring-2 ring-md-tertiary bg-md-tertiary/15' : 'bg-md-surface-variant/80 hover:bg-md-surface-variant'}"
            ondragover={(e) => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; stripDropTarget = 'autoRenew'; }}
            ondragenter={(e) => { e.preventDefault(); stripDropTarget = 'autoRenew'; }}
            ondragleave={() => { if (stripDropTarget === 'autoRenew') stripDropTarget = null; }}
            ondrop={(e) => { e.preventDefault(); e.stopPropagation(); handleActionStripDrop('autoRenew', e); }}
            onclick={(e) => {
              e.stopPropagation();
              const curr = allAccounts.find((a: Account) => a.address === selectedEmail);
              if (curr) onToggleAutoExtend(curr);
            }}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                const curr = allAccounts.find((a: Account) => a.address === selectedEmail);
                if (curr) onToggleAutoExtend(curr);
              }
            }}
          >
            <Icon name="autoRenew" class="w-3.5 h-3.5 pointer-events-none" />
            <span class="whitespace-nowrap overflow-visible pointer-events-none">{$t('account.autoRenew')}</span>
          </div>
        </div>

        <!-- Sticky footer: Create + Manage always visible while list scrolls -->
        <div
          class="account-selector-sticky-actions shrink-0 flex flex-row gap-1.5 pt-2 mt-auto border-t border-md-outline-variant/25 bg-md-surface"
          bind:this={stickyActionsEl}
          style="--as-action-font: {stickyActionFontPx}px;"
        >
          <button
            id="button-create-new-mail"
            type="button"
            class="{stickyActionEqualWidth ? 'flex-1' : 'flex-none'} min-w-0 px-2.5 h-9 bg-md-primary text-md-on-primary font-semibold flex items-center justify-center gap-1 rounded-xl hover:bg-md-primary/90 transition-colors motion-press"
            style="font-size: var(--as-action-font, 0.75rem);"
            onclick={() => { closeOverlay(); onCreateInbox(); }}
          >
            <Icon name="plus" class="w-3.5 h-3.5 shrink-0" />
            <span class="btn-label whitespace-nowrap overflow-visible">{$t('account.newMailAddress')}</span>
          </button>
          <button
            id="button-manage-addresses"
            type="button"
            class="{stickyActionEqualWidth ? 'flex-1' : 'flex-none'} min-w-0 px-2.5 h-9 bg-md-surface-variant font-semibold flex items-center justify-center gap-1 text-md-on-surface hover:bg-md-surface-variant/70 rounded-xl transition-colors motion-press"
            style="font-size: var(--as-action-font, 0.75rem);"
            onclick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              closeOverlay();
              queueMicrotask(() => {
                removePortalOverlay();
                onNavigateToManage();
              });
            }}
          >
            <Icon name="instances" class="w-3.5 h-3.5 shrink-0" />
            <span class="btn-label whitespace-nowrap overflow-visible">{$t('account.manageAddresses')}</span>
          </button>
        </div>
      </div>
      <!-- /dialog card -->

      <!-- Confirm dialogs INSIDE overlay so they stack above the card -->
      {#if crossTabPrompt}
        <div class="absolute inset-0 z-[150] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button
            type="button"
            class="absolute inset-0 bg-md-scrim/70 border-0 cursor-default"
            aria-label={$t('common.close')}
            onclick={() => (crossTabPrompt = null)}
          ></button>
          <div class="relative z-10 w-full max-w-[300px] rounded-2xl bg-md-surface border border-md-outline-variant/40 shadow-2xl p-4 space-y-3">
            {#if crossTabPrompt.direction === 'toInactive'}
              <h3 class="text-sm font-bold text-md-on-surface">{$t('account.dragToInactiveTitle')}</h3>
              <p class="text-xs text-md-on-surface/60" style="direction:ltr;unicode-bidi:isolate;">{crossTabPrompt.account.address}</p>
              <p class="text-label-sm text-md-on-surface/50">{$t('account.dragToInactiveBody')}</p>
              <div class="flex flex-col gap-1.5">
                <button type="button" class="w-full py-2 rounded-xl bg-md-primary text-md-on-primary text-xs font-semibold" onclick={() => applyTabDropToInactive('archive')}>
                  {$t('common.archive')}
                </button>
                <button type="button" class="w-full py-2 rounded-xl bg-md-error text-md-on-error text-xs font-semibold" onclick={() => applyTabDropToInactive('delete')}>
                  {$t('common.delete')}
                </button>
                <button type="button" class="w-full py-2 rounded-xl bg-md-surface-variant text-xs font-medium" onclick={() => (crossTabPrompt = null)}>
                  {$t('common.cancel')}
                </button>
              </div>
            {:else if crossTabPrompt.direction === 'toLiveRenew'}
              <h3 class="text-sm font-bold text-md-on-surface">{$t('account.dragToLiveRenewTitle')}</h3>
              <p class="text-xs text-md-on-surface/60" style="direction:ltr;unicode-bidi:isolate;">{crossTabPrompt.account.address}</p>
              <p class="text-label-sm text-md-on-surface/50">{$t('account.dragToLiveRenewBody')}</p>
              <div class="flex flex-col gap-1.5">
                <button type="button" class="w-full py-2 rounded-xl bg-md-primary text-md-on-primary text-xs font-semibold" onclick={() => applyTabDropToLiveRenew()}>
                  {$t('account.enableAutoRenew')}
                </button>
                <button type="button" class="w-full py-2 rounded-xl bg-md-surface-variant text-xs font-medium" onclick={() => (crossTabPrompt = null)}>
                  {$t('common.cancel')}
                </button>
              </div>
            {:else}
              <h3 class="text-sm font-bold text-md-on-surface">{$t('account.dragToLiveTitle')}</h3>
              <p class="text-xs text-md-on-surface/60" style="direction:ltr;unicode-bidi:isolate;">{crossTabPrompt.account.address}</p>
              <p class="text-label-sm text-md-on-surface/50">{$t('account.dragToLiveBody')}</p>
              <div class="flex flex-col gap-1.5">
                <button
                  type="button"
                  class="w-full py-2 rounded-xl bg-md-primary text-md-on-primary text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={!canUnarchive(crossTabPrompt.account)}
                  title={!canUnarchive(crossTabPrompt.account) ? $t('account.unarchiveNotAvailable') : undefined}
                  onclick={() => applyTabDropToLive('unarchive')}
                >
                  {$t('common.unarchive')}
                </button>
                <button type="button" class="w-full py-2 rounded-xl bg-md-tertiary text-md-on-tertiary text-xs font-semibold" onclick={() => applyTabDropToLive('restore')}>
                  {$t('common.restore')}
                </button>
                <button type="button" class="w-full py-2 rounded-xl bg-md-surface-variant text-xs font-medium" onclick={() => (crossTabPrompt = null)}>
                  {$t('common.cancel')}
                </button>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if marqueeActive && marqueeRect}
        <div
          class="fixed pointer-events-none z-[140] border border-md-primary/70 bg-md-primary/15 rounded-sm"
          style="left:{marqueeRect.left}px;top:{marqueeRect.top}px;width:{marqueeRect.right - marqueeRect.left}px;height:{marqueeRect.bottom - marqueeRect.top}px;"
          aria-hidden="true"
        ></div>
      {/if}

      {#if actionDropPrompt}
        <div class="absolute inset-0 z-[150] flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <button
            type="button"
            class="absolute inset-0 bg-md-scrim/70 border-0 cursor-default"
            aria-label={$t('common.close')}
            onclick={() => (actionDropPrompt = null)}
          ></button>
          <div class="relative z-10 w-full max-w-[300px] rounded-2xl bg-md-surface border border-md-outline-variant/40 shadow-2xl p-4 space-y-3">
            <h3 class="text-sm font-bold text-md-on-surface">{$t('account.confirmActionTitle')}</h3>
            <p class="text-xs text-md-on-surface/60" style="direction:ltr;unicode-bidi:isolate;">{actionDropPrompt.account.address}</p>
            <p class="text-label-sm text-md-on-surface/50">
              {#if actionDropPrompt.action === 'archive'}{$t('common.archive')}
              {:else if actionDropPrompt.action === 'delete'}{$t('common.delete')}
              {:else if actionDropPrompt.action === 'tag'}{$t('common.addTag')}
              {:else}{$t('account.autoRenew')}
              {/if}
            </p>
            <div class="flex flex-col gap-1.5">
              <button type="button" class="w-full py-2 rounded-xl bg-md-primary text-md-on-primary text-xs font-semibold" onclick={() => applyActionDrop()}>
                {$t('common.confirm')}
              </button>
              <button type="button" class="w-full py-2 rounded-xl bg-md-surface-variant text-xs font-medium" onclick={() => (actionDropPrompt = null)}>
                {$t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      {/if}

      <!-- Tag dialog inside overlay pane -->
      {#if tagDialogOpen && tagTargetAccount}
        <TagDialog
          open={tagDialogOpen}
          currentTag={tagTargetAccount.tag || ''}
          currentTagColor={tagTargetAccount.tagColor || null}
          currentTags={accountTagsList(tagTargetAccount)}
          onClose={closeTagDialog}
          onSave={saveTag}
          onSaveTags={saveTags}
          existingTags={Array.from(
            new Set(allAccounts.flatMap((a: Account) => accountTagsList(a).map((t) => t.name)))
          )}
          tagColors={Object.fromEntries(
            allAccounts.flatMap((a: Account) =>
              accountTagsList(a).map((t) => [t.name, t.color] as [string, string])
            )
          )}
          portal={false}
        />
      {/if}
    </div>
  </div>
{/if}
