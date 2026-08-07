<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import SelectionToolbar from '@/ui/blocks/mail/SelectionToolbar.svelte';
import CopyButton from '@/ui/components/composites/CopyButton.svelte';
import DragHint from '@/ui/components/composites/DragHint.svelte';
import EmptyState from '@/ui/components/composites/EmptyState.svelte';
import SearchBar from '@/ui/components/composites/SearchBar.svelte';
import TotpBadge from '@/ui/components/composites/TotpBadge.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Checkbox } from '@/ui/components/primitives';
import FaviconImage from '@/ui/components/primitives/FaviconImage.svelte';
import { withLock } from '@/utils/mutex.js';
import { PORTAL_Z_CLASS } from '@/utils/portal-layers.js';
import type { CredentialsHistoryItem, Identity } from '@/utils/types.js';
import {
  getVaultConfig,
  isVaultLocked,
  unlockVaultWithBiometrics,
  unlockVaultWithPassword,
} from '@/utils/vault-lock.js';

let {
  context = 'popup',
  onBack = () => {},
  savedLogins = [],
  onDelete = () => {},
  showToast = (_msg: string) => {},
  identities = [] as Identity[],
  onReorder = (_sourceId: string, _targetId: string) => {},
  /** Pre-applied email filter (e.g. from message detail) */
  initialEmailFilter = '',
  /** Bump to focus the search field (ghost FAB) */
  focusSearchSignal = 0,
} = $props<{
  context?: 'popup' | 'sidepanel' | 'app';
  onBack?: () => void;
  savedLogins?: CredentialsHistoryItem[];
  onDelete?: (id: string) => void;
  showToast?: (message: string) => void;
  identities?: Identity[];
  /** Reorder by stable login id (not filtered list index) */
  onReorder?: (
    sourceId: string,
    targetId: string,
    contextLogins?: CredentialsHistoryItem[]
  ) => void;
  initialEmailFilter?: string;
  focusSearchSignal?: number;
}>();

let isLocked = $state(false);
let vaultMode = $state<'standard' | 'password' | 'biometrics'>('standard');
let unlockPassword = $state('');
let unlockError = $state('');
let unlocking = $state(false);
let searchRootEl = $state<HTMLElement | null>(null);
/** Local checklist: which policy URLs the user marked as reviewed */
let policyReviewed = $state<Record<string, boolean>>({});
let selectionMode = $state(false);
let selectedLoginIds = $state<Set<string>>(new Set());

$effect(() => {
  if (!focusSearchSignal) return;
  // Focus search input when ghost FAB is pressed
  queueMicrotask(() => {
    if (!searchRootEl?.isConnected) return;
    const input = searchRootEl.querySelector<HTMLInputElement>('input');
    input?.focus();
  });
});

async function checkLockStatus() {
  const config = await getVaultConfig();
  vaultMode = config.mode;
  isLocked = await isVaultLocked();
}

onMount(() => {
  void checkLockStatus();
  void (async () => {
    try {
      const res = (await browser.storage.local.get([
        'policyReviewedMap',
        'dragHintSeen_savedLoginInfo',
      ])) as {
        policyReviewedMap?: Record<string, boolean>;
        dragHintSeen_savedLoginInfo?: boolean;
      };
      if (res.policyReviewedMap) policyReviewed = res.policyReviewedMap;
      if (res.dragHintSeen_savedLoginInfo) dragHintDismissed = true;
    } catch {
      /* ignore */
    }
  })();
});

async function handleUnlockPassword() {
  unlockError = '';
  if (!unlockPassword) return;
  unlocking = true;
  const result = await unlockVaultWithPassword(unlockPassword);
  unlocking = false;
  if (result.success) {
    isLocked = false;
    unlockPassword = '';
    showToast($t('savedLoginInfo.vaultUnlocked'));
  } else if (result.lockedOutUntil) {
    const remainSecs = Math.ceil((result.lockedOutUntil - Date.now()) / 1000);
    const remainStr =
      remainSecs >= 3600
        ? `${Math.ceil(remainSecs / 3600)}h`
        : remainSecs >= 60
          ? `${Math.ceil(remainSecs / 60)}m`
          : `${remainSecs}s`;
    unlockError = $t('savedLoginInfo.vaultLockedOut', { values: { time: remainStr } });
  } else {
    unlockError = $t('savedLoginInfo.incorrectPassword');
  }
}

async function handleUnlockBiometrics() {
  unlockError = '';
  unlocking = true;
  const success = await unlockVaultWithBiometrics();
  unlocking = false;
  if (success) {
    isLocked = false;
    showToast($t('savedLoginInfo.vaultUnlocked'));
  } else {
    unlockError = 'Biometric verification failed';
  }
}

function formatTimestamp(ts: number): string {
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
  if (mins < 1) return rtf.format(0, 'minute');
  if (mins < 60) return rtf.format(-mins, 'minute');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, 'day');
  return new Date(ts).toLocaleDateString();
}

function getDomain(login: CredentialsHistoryItem): string {
  try {
    const site = (login.website as string | undefined) || login.domain || '';
    return site.startsWith('http') ? new URL(site).hostname : site;
  } catch {
    /* ignore */
    return login.domain || '';
  }
}

let searchQuery = $state('');
let debouncedQuery = $state('');
let searchTimeout: ReturnType<typeof setTimeout>;

$effect(() => {
  const query = searchQuery;
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    debouncedQuery = query;
  }, 150);
});

let filterIdentityId = $state<string | null>(null);
let filterEmail = $state('');
let filterDropdownOpen = $state(false);
let filterEmailDropdownOpen = $state(false);
let searchFocused = $state(false);

$effect(() => {
  if (initialEmailFilter) filterEmail = initialEmailFilter;
});

let draggedLoginId = $state<string | null>(null);
let dropTargetLoginId = $state<string | null>(null);

function handleLoginDragStart(e: DragEvent, loginId: string) {
  if (searchQuery.trim() || filterIdentityId || filterEmail) {
    e.preventDefault();
    return;
  }
  draggedLoginId = loginId;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', loginId);
  }
}

let dragHintDismissed = $state(false);
function handleLoginDragHintDismiss(): void {
  dragHintDismissed = true;
  void browser.storage.local.set({ dragHintSeen_savedLoginInfo: true });
}

function handleLoginDragOver(e: DragEvent, loginId: string) {
  if (!draggedLoginId || draggedLoginId === loginId) return;
  e.preventDefault();
  dropTargetLoginId = loginId;
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
}

function handleLoginDragLeave(loginId: string) {
  if (dropTargetLoginId === loginId) {
    dropTargetLoginId = null;
  }
}

function handleLoginDrop(e: DragEvent, targetId: string, groupLogins?: CredentialsHistoryItem[]) {
  e.preventDefault();
  const sourceId = draggedLoginId;
  draggedLoginId = null;
  dropTargetLoginId = null;
  if (!sourceId || sourceId === targetId) return;
  // Parent resolves ids against full loginInfo storage (not filteredLogins indices)
  onReorder(sourceId, targetId, groupLogins);
}

function handleLoginDragEnd() {
  draggedLoginId = null;
  dropTargetLoginId = null;
}

let filteredLogins = $derived.by(() => {
  let result = savedLogins;
  if (filterIdentityId) {
    result = result.filter((l: CredentialsHistoryItem) => l.identityId === filterIdentityId);
  }
  if (filterEmail) {
    const fe = filterEmail.toLowerCase();
    result = result.filter((l: CredentialsHistoryItem) => (l.email || '').toLowerCase() === fe);
  }
  if (debouncedQuery.trim()) {
    const q = debouncedQuery.trim().toLowerCase();
    // If search matches the active identity filter name, keep identity-only results
    const activeIdentityName = filterIdentityId
      ? (identities.find((i: Identity) => i.id === filterIdentityId)?.name || '').toLowerCase()
      : '';
    if (!(filterIdentityId && activeIdentityName && activeIdentityName === q)) {
      result = result.filter((l: CredentialsHistoryItem) => {
        const domain = getDomain(l).toLowerCase();
        const name = (l.name || '').toLowerCase();
        const email = (l.email || '').toLowerCase();
        const idName = (
          identities.find((i: Identity) => i.id === l.identityId)?.name || ''
        ).toLowerCase();
        return domain.includes(q) || name.includes(q) || email.includes(q) || idName.includes(q);
      });
    }
  }
  return result;
});

/** Group filtered logins into domain collections (preserve list order within each). */
let loginsByDomain = $derived.by(() => {
  const map = new Map<string, CredentialsHistoryItem[]>();
  for (const login of filteredLogins) {
    const d = getDomain(login) || 'unknown';
    const list = map.get(d) || [];
    list.push(login);
    map.set(d, list);
  }
  return Array.from(map.entries()).map(([domain, logins]) => ({ domain, logins }));
});

const identitiesWithLogins = $derived(
  identities.filter((i: Identity) =>
    savedLogins.some((l: CredentialsHistoryItem) => l.identityId === i.id)
  )
);

const emailsWithLogins = $derived.by(() => {
  const set = new Set<string>();
  for (const l of savedLogins) {
    if (l.email?.trim()) set.add(l.email.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
});

// Detect OS for keyboard shortcut hint
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPod|iPad/.test(navigator.platform);
const shortcutLabel = isMac ? '⌘ K' : 'Ctrl K';

/** Scrollspy for domain section chips */
let credentialsScrollEl = $state<HTMLElement | null>(null);
let activeDomainSpy = $state('');

// Set initial spy domain once — do not re-read activeDomainSpy after writing
let domainSpyInitialized = false;
$effect(() => {
  const domains = loginsByDomain.map((g) => g.domain);
  if (!domains.length) return;
  if (!domainSpyInitialized) {
    domainSpyInitialized = true;
    activeDomainSpy = domains[0];
  }
});

function scrollToDomain(domain: string) {
  activeDomainSpy = domain;
  const el = credentialsScrollEl?.querySelector(`[data-domain-section="${CSS.escape(domain)}"]`);
  if (el instanceof HTMLElement) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function onCredentialsScroll() {
  const root = credentialsScrollEl;
  if (!root) return;
  const sections = root.querySelectorAll<HTMLElement>('[data-domain-section]');
  let current = activeDomainSpy;
  const top = root.scrollTop + 48;
  for (const sec of sections) {
    if (sec.offsetTop <= top) current = sec.dataset.domainSection || current;
  }
  if (current) activeDomainSpy = current;
}
</script>

<div class="flex flex-col h-full">
{#if isLocked}
  <div class="flex-1 flex flex-col items-center justify-center p-6 text-center space-y-4">
    <div class="w-16 h-16 rounded-full bg-md-primary/10 border border-md-primary/20 flex items-center justify-center text-md-primary shadow-lg">
      <Icon name="shield" class="w-8 h-8" />
    </div>

    <div class="max-w-xs space-y-1">
      <h3 class="text-base font-bold text-md-on-surface">{$t('savedLoginInfo.vaultLockedTitle')}</h3>
      <p class="text-xs text-md-on-surface/60">
        {#if vaultMode === 'password'}
          {$t('savedLoginInfo.vaultLockedPasswordBody')}
        {:else}
          {$t('savedLoginInfo.vaultLockedBiometricsBody')}
        {/if}
      </p>
    </div>

    {#if unlockError}
      <div class="p-2.5 rounded-xl bg-md-error-container/40 border border-md-error/30 text-xs text-md-error flex items-center gap-2 max-w-xs">
        <Icon name="info" class="w-4 h-4 shrink-0" />
        <span>{unlockError}</span>
      </div>
    {/if}

    {#if vaultMode === 'password'}
      <form class="w-full max-w-xs space-y-3" onsubmit={(e) => { e.preventDefault(); handleUnlockPassword(); }}>
        <input
          type="password"
          class="w-full bg-md-surface-variant/40 border border-md-outline-variant rounded-xl px-3.5 py-2.5 text-xs text-md-on-surface outline-none focus:border-md-primary transition-colors text-center"
          placeholder={$t('savedLoginInfo.masterPasswordPlaceholder')}
          bind:value={unlockPassword}
        />
        <button
          type="submit"
          disabled={unlocking}
          class="w-full py-2.5 px-4 rounded-xl bg-md-primary text-md-on-primary font-semibold text-xs hover:bg-md-primary/90 transition-colors shadow-md disabled:opacity-50"
        >
          {unlocking ? $t('savedLoginInfo.unlocking') : $t('savedLoginInfo.unlockVault')}
        </button>
      </form>
    {:else}
      <button
        onclick={handleUnlockBiometrics}
        disabled={unlocking}
        class="py-2.5 px-6 rounded-xl bg-md-primary text-md-on-primary font-semibold text-xs hover:bg-md-primary/90 transition-colors shadow-md flex items-center gap-2 disabled:opacity-50"
      >
        <Icon name="user" class="w-4 h-4" />
        <span>{unlocking ? $t('savedLoginInfo.verifying') : $t('savedLoginInfo.unlockBiometrics')}</span>
      </button>
    {/if}
  </div>
{:else}
<!-- Domain scrollspy chips -->
{#if loginsByDomain.length > 1}
  <div class="shrink-0 px-2 pt-2 pb-1 flex gap-1.5 overflow-x-auto border-b border-md-outline-variant/15" role="tablist" aria-label={$t('savedLoginInfo.domainSections')}>
    {#each loginsByDomain as group (group.domain)}
      <button
        type="button"
        role="tab"
        aria-selected={activeDomainSpy === group.domain}
        class="shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold transition-colors
          {activeDomainSpy === group.domain
            ? 'bg-md-secondary-container text-md-on-secondary-container'
            : 'bg-md-surface-container-high text-md-on-surface/60 hover:bg-md-surface-variant'}"
        onclick={() => scrollToDomain(group.domain)}
      >
        {group.domain}
      </button>
    {/each}
  </div>
{/if}
<!-- Selection row for multi-delete without long-press -->
<SelectionToolbar
  visible={true}
  itemCount={filteredLogins.length}
  selectedCount={selectedLoginIds.size}
  selectionActive={selectionMode}
  onEnterSelection={() => {
    selectionMode = true;
  }}
  onSelectAll={() => {
    selectionMode = true;
    selectedLoginIds = new Set(
      filteredLogins.map((l: CredentialsHistoryItem) => l.id).filter(Boolean) as string[]
    );
  }}
  onClear={() => {
    selectedLoginIds = new Set();
  }}
  onExit={() => {
    selectionMode = false;
    selectedLoginIds = new Set();
  }}
>
  {#snippet actions()}
    {#if selectedLoginIds.size > 0}
      <button
        type="button"
        class="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold bg-md-error/15 text-md-error"
        onclick={async (e) => {
          e.stopPropagation();
          const ids = new Set(selectedLoginIds);
          selectedLoginIds = new Set();
          selectionMode = false;
          await withLock('login_info_lock', async () => {
            const res = (await browser.storage.local.get(['loginInfo'])) as { loginInfo?: import('@/utils/types.js').CredentialsHistoryItem[] };
            const loginInfo = res.loginInfo || [];
            const updated = loginInfo.filter(l => !ids.has(l.id || ''));
            await browser.storage.local.set({ loginInfo: updated });
          });
        }}
      >
        {$t('common.delete')}
      </button>
    {/if}
  {/snippet}
</SelectionToolbar>
<!-- Search + Filter bar (settings-style SearchBar). z-30 so dropdowns sit above list. -->
<div class="relative z-30 px-0 pt-3 pb-2 border-b border-md-outline-variant/15 bg-md-surface/95 backdrop-blur-sm" bind:this={searchRootEl}>
  <div class="relative">
    <SearchBar
      scope="saved-logins"
      bind:value={searchQuery}
      placeholder={$t('savedLoginInfo.searchPlaceholder')}
      animatedPlaceholders={[
        $t('savedLoginInfo.searchPlaceholder'),
        $t('savedLoginInfo.website'),
        $t('savedLoginInfo.email'),
      ]}
      ariaLabel={$t('savedLoginInfo.searchAria')}
      settingsStyle={true}
      showSlashButton={true}
      shortcuts={[
        {
          prefix: 'domain:',
          label: 'domain:',
          description: $t('savedLoginInfo.filterByEmail'),
        },
      ]}
      onFocus={() => { searchFocused = true; }}
      onBlur={() => { searchFocused = false; }}
    >
      {#snippet filterControl()}
        <button
          id="button-savedlogin-filter"
          type="button"
          class="w-8 h-8 flex items-center justify-center rounded-xl border transition-colors relative
            {filterDropdownOpen || filterIdentityId || filterEmail
              ? 'border-md-primary bg-md-primary/10 text-md-primary'
              : 'border-md-outline-variant text-md-on-surface/60 hover:bg-md-surface-variant'}
            {!!draggedLoginId ? 'opacity-50 pointer-events-none' : ''}"
          aria-label={$t('common.filter')}
          title={$t('common.filter')}
          aria-haspopup="dialog"
          aria-expanded={filterDropdownOpen}
          disabled={!!draggedLoginId}
          onclick={(e) => {
            e.stopPropagation();
            if (draggedLoginId) return;
            filterDropdownOpen = !filterDropdownOpen;
            filterEmailDropdownOpen = false;
          }}
        >
          <Icon name="filter" class="w-4 h-4" />
          {#if filterIdentityId || filterEmail}
            <span class="absolute top-1 end-1 w-1.5 h-1.5 rounded-full bg-md-primary"></span>
          {/if}
        </button>
      {/snippet}
    </SearchBar>

        <!-- Unified filter menu: Identity + Mailbox -->
        {#if filterDropdownOpen}
          <button
            class="fixed inset-0 {PORTAL_Z_CLASS.navMenu} bg-transparent cursor-default"
            aria-label={$t('common.close')}
            onclick={() => filterDropdownOpen = false}
          ></button>

          <div class="absolute top-full end-0 mt-2 bg-md-surface border border-md-outline-variant rounded-2xl shadow-2xl {PORTAL_Z_CLASS.accountMenu} overflow-hidden min-w-[220px] max-h-80 overflow-y-auto">
            <div class="flex items-center justify-between px-4 py-3 border-b border-md-outline-variant/30">
              <span class="text-sm font-semibold text-md-on-surface">{$t('common.filter')}</span>
              <button
                class="w-5 h-5 flex items-center justify-center text-md-on-surface/60 hover:text-md-on-surface transition-colors rounded-lg"
                aria-label={$t('common.close')}
                onclick={() => filterDropdownOpen = false}
              >
                <Icon name="x" class="w-3.5 h-3.5" />
              </button>
            </div>

            <!-- Identity section -->
            <div class="px-3 pt-2 pb-1 text-label-sm font-bold text-md-on-surface/45">
              {$t('savedLoginInfo.filterByIdentity')}
            </div>
            <button
              class="w-full flex items-center gap-3 px-4 py-2 text-sm text-start hover:bg-md-surface-variant/50 transition-colors
                {!filterIdentityId ? 'text-md-primary font-medium' : 'text-md-on-surface'}"
              onclick={() => { filterIdentityId = null; }}
            >
              <span class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors
                {!filterIdentityId ? 'border-md-primary' : 'border-md-outline-variant'}">
                {#if !filterIdentityId}
                  <span class="w-2 h-2 rounded-full bg-md-primary"></span>
                {/if}
              </span>
              {$t('savedLoginInfo.allIdentities')}
            </button>
            {#each identitiesWithLogins as identity (identity.id)}
              <button
                class="w-full flex items-center gap-3 px-4 py-2 text-sm text-start hover:bg-md-surface-variant/50 transition-colors
                  {filterIdentityId === identity.id ? 'text-md-primary font-medium' : 'text-md-on-surface'}"
                onclick={() => { filterIdentityId = identity.id; }}
              >
                <span class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors
                  {filterIdentityId === identity.id ? 'border-md-primary' : 'border-md-outline-variant'}">
                  {#if filterIdentityId === identity.id}
                    <span class="w-2 h-2 rounded-full bg-md-primary"></span>
                  {/if}
                </span>
                <span class="truncate">{identity.name}</span>
              </button>
            {/each}

            <div class="h-px bg-md-outline-variant/30 my-1 mx-2"></div>

            <!-- Mailbox section (moved from standalone mail icon) -->
            <div class="px-3 pt-1 pb-1 text-label-sm font-bold text-md-on-surface/45 flex items-center gap-1.5">
              <Icon name="mail" class="w-3 h-3 opacity-70" />
              {$t('savedLoginInfo.filterMailbox')}
            </div>
            <button
              class="w-full flex items-center gap-3 px-4 py-2 text-sm text-start hover:bg-md-surface-variant/50 transition-colors
                {!filterEmail ? 'text-md-primary font-medium' : 'text-md-on-surface'}"
              onclick={() => { filterEmail = ''; }}
            >
              <span class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0
                {!filterEmail ? 'border-md-primary' : 'border-md-outline-variant'}">
                {#if !filterEmail}
                  <span class="w-2 h-2 rounded-full bg-md-primary"></span>
                {/if}
              </span>
              {$t('savedLoginInfo.allEmails')}
            </button>
            {#each emailsWithLogins as addr (addr)}
              <button
                class="w-full flex items-center gap-3 px-4 py-2 text-sm text-start hover:bg-md-surface-variant/50 transition-colors
                  {filterEmail === addr ? 'text-md-primary font-medium' : 'text-md-on-surface'}"
                onclick={() => { filterEmail = addr; }}
              >
                <span class="w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0
                  {filterEmail === addr ? 'border-md-primary' : 'border-md-outline-variant'}">
                  {#if filterEmail === addr}
                    <span class="w-2 h-2 rounded-full bg-md-primary"></span>
                  {/if}
                </span>
                <span class="truncate">{addr}</span>
              </button>
            {/each}
          </div>
        {/if}
  </div>

  <!-- Result count / active filter info -->
  {#if filteredLogins.length !== savedLogins.length}
    <div class="flex items-center justify-between mt-1.5">
      <div class="text-xs text-md-on-surface/40">{$t('savedLoginInfo.shown', { values: { filtered: filteredLogins.length, total: savedLogins.length } })}</div>
      {#if filterIdentityId || filterEmail || searchQuery}
        <button
          class="text-xs text-md-primary hover:underline flex items-center gap-0.5"
          onclick={() => { filterIdentityId = null; filterEmail = ''; searchQuery = ''; }}
        >
          <Icon name="x" class="w-2.5 h-2.5" />
          {$t('savedLoginInfo.clearFilters')}
        </button>
      {/if}
    </div>
  {/if}
</div>

<div
  class="relative z-0 flex-1 overflow-y-auto px-0 py-3 space-y-3"
  bind:this={credentialsScrollEl}
  onscroll={onCredentialsScroll}
>
  {#if savedLogins.length === 0}
    <div class="h-full flex flex-col justify-center">
      <EmptyState
        icon="lock"
        title={$t('savedLoginInfo.noSavedLogin')}
      />
    </div>
  {:else if filteredLogins.length === 0}
    <div class="h-full flex flex-col justify-center">
      <EmptyState
        icon="search"
        title={$t('savedLoginInfo.noResultsMatchSearch')}
        actionLabel={$t('savedLoginInfo.clearFilters')}
        onAction={() => { filterIdentityId = null; filterEmail = ''; searchQuery = ''; }}
      />
    </div>
  {:else}
    {#each loginsByDomain as group, groupIdx (group.domain)}
      <div class="space-y-2 scroll-mt-2" data-domain-section={group.domain}>
        <!-- Domain collection header -->
        <div class="flex items-center gap-2 px-1">
          <div class="w-6 h-6 rounded-lg bg-md-primary-container flex items-center justify-center shrink-0 overflow-hidden">
            <FaviconImage
              domain={group.domain}
              size={24}
              class="w-4 h-4 object-contain"
              fallbackLetter={group.domain.charAt(0).toUpperCase()}
            />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-bold text-md-on-surface truncate">{group.domain}</div>
            <div class="text-xs text-md-on-surface/45">{$t('savedLoginInfo.domainLoginCount', { values: { n: group.logins.length } })}</div>
          </div>
        </div>

    {#each group.logins as login, loginIdx (login.id)}
      {@const domain = group.domain}
      {@const isDragging = draggedLoginId === login.id}
      {@const isDropTarget = dropTargetLoginId === login.id}
      {@const signupStatus = login.signupStatus || (login.verified ? 'verified' : 'pending_submit')}
      <div
        class="relative bg-md-surface-container-highest rounded-xl overflow-hidden transition-all {searchQuery.trim() || filterIdentityId ? '' : 'cursor-move'} {isDragging ? 'opacity-50' : ''} {isDropTarget ? 'ring-2 ring-md-primary drop-target-pulse' : ''}"
        draggable={!searchQuery.trim() && !filterIdentityId}
        role="listitem"
        ondragstart={(e) => { handleLoginDragStart(e, login.id || ''); dragHintDismissed = true; }}
        ondragover={(e) => handleLoginDragOver(e, login.id || '')}
        ondragleave={() => handleLoginDragLeave(login.id || '')}
        ondrop={(e) => handleLoginDrop(e, login.id || '', group.logins)}
        ondragend={handleLoginDragEnd}
        aria-label={$t('savedLoginInfo.dragToReorder', { values: { domain } })}
      >
        {#if groupIdx === 0 && loginIdx === 0 && !dragHintDismissed}
          <DragHint
            hintKey="dragHintSeen_savedLoginInfo"
            text={$t('savedLoginInfo.dragHint')}
            visible={true}
            onDismiss={handleLoginDragHintDismiss}
          />
        {/if}
        <!-- Header: email/identity + timestamp + delete (domain is section title) -->
        <div class="flex items-center gap-3 px-3 pt-3 pb-2">
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-sm truncate">{login.email || login.username || domain}</div>
            <div class="flex items-center gap-2 flex-wrap">
              {#if login.timestamp}
                <div class="text-xs text-md-on-surface/40">{$t('savedLoginInfo.autofilledAt', { values: { time: formatTimestamp(login.timestamp) } })}</div>
              {/if}
              <span
                class="inline-flex px-1.5 py-0.5 rounded-md text-label-sm font-semibold
                  {signupStatus === 'verified'
                    ? 'bg-md-primary/15 text-md-primary'
                    : signupStatus === 'failed'
                      ? 'bg-md-error/15 text-md-error'
                      : signupStatus === 'undetected'
                        ? 'bg-md-surface-variant text-md-on-surface/55'
                        : signupStatus === 'submitted'
                          ? 'bg-md-tertiary/15 text-md-tertiary'
                          : 'bg-md-surface-variant text-md-on-surface/50'}"
              >
                {#if signupStatus === 'verified'}
                  {$t('savedLoginInfo.signupVerified')}
                {:else if signupStatus === 'failed'}
                  {$t('savedLoginInfo.signupFailed')}
                {:else if signupStatus === 'undetected'}
                  {$t('savedLoginInfo.signupUndetected')}
                {:else if signupStatus === 'submitted'}
                  {$t('savedLoginInfo.signupSubmitted')}
                {:else}
                  {$t('savedLoginInfo.signupPending')}
                {/if}
              </span>
              {#if login.identityId}
                {@const identityId = String(login.identityId)}
                {@const identity = identities.find((i: Identity) => i.id === identityId)}
                {#if identity}
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-md-primary text-md-on-primary font-semibold hover:brightness-110 transition-all cursor-pointer"
                    title={$t('savedLoginInfo.filterByIdentityName', { values: { name: identity.name } })}
                    onclick={(e) => {
                      e.stopPropagation();
                      filterIdentityId = identityId;
                      searchQuery = identity.name;
                      filterDropdownOpen = false;
                    }}
                  >
                    <span>👤</span>{identity.name}
                  </button>
                {:else}
                  <div class="text-xs px-2 py-0.5 rounded-full bg-md-secondary-container text-md-on-surface/50 font-medium">{$t('savedLoginInfo.identity')}</div>
                {/if}
              {/if}
            </div>
          </div>
          <button
            class="w-6 h-6 flex items-center justify-center rounded-lg bg-transparent hover:bg-md-primary-container text-md-error transition-colors shrink-0"
            aria-label={$t('savedLoginInfo.deleteLogin')}
            onclick={() => onDelete(login.id)}
          >
            <Icon name="trash" class="w-4 h-4" />
          </button>
        </div>

        <div class="h-px bg-md-outline-variant/30 mx-3"></div>

        <!-- Details rows -->
        <div class="px-2 py-2 space-y-1.5">
          {#if login.filledFields && login.filledFields.length}
            <div class="flex items-start gap-2 mb-1">
              <span class="text-xs text-md-on-surface/40 w-16 shrink-0 pt-0.5">{$t('savedLoginInfo.filledFields')}</span>
              <div class="flex flex-wrap gap-1 flex-1 min-w-0">
                {#each login.filledFields as field (field)}
                  <span class="inline-flex px-1.5 py-0.5 rounded-md text-label-sm font-semibold bg-md-primary/12 text-md-primary">
                    {$t(`savedLoginInfo.field_${field}`)}
                  </span>
                {/each}
              </div>
            </div>
          {/if}
          {#if login.name}
            <div class="flex items-center gap-2">
              <span class="text-xs text-md-on-surface/40 w-16 shrink-0">{$t('savedLoginInfo.name')}</span>
              <span class="text-xs text-md-on-surface flex-1 truncate">{login.name}</span>
              <CopyButton text={String(login.name)} size="sm" tooltip={$t('savedLoginInfo.copyName')} />
            </div>
          {/if}
          {#if login.email}
            <div class="flex items-center gap-2">
              <span class="text-xs text-md-on-surface/40 w-16 shrink-0">{$t('savedLoginInfo.email')}</span>
              <span class="text-xs text-md-on-surface flex-1 truncate">{login.email}</span>
              <CopyButton text={String(login.email)} size="sm" tooltip={$t('savedLoginInfo.copyEmail')} />
            </div>
          {/if}
          {#if login.phone}
            <div class="flex items-center gap-2">
              <span class="text-xs text-md-on-surface/40 w-16 shrink-0">{$t('savedLoginInfo.phone')}</span>
              <span class="text-xs text-md-on-surface flex-1 truncate">{login.phone}</span>
              <CopyButton text={String(login.phone)} size="sm" tooltip={$t('savedLoginInfo.copyPhone')} />
            </div>
          {/if}
          {#if login.password}
            <div class="flex items-center gap-2">
              <span class="text-xs text-md-on-surface/40 w-16 shrink-0">{$t('savedLoginInfo.password')}</span>
              <span class="text-xs text-md-on-surface flex-1 truncate font-mono">{login.password}</span>
              <CopyButton text={String(login.password)} purgeDelayMs={30000} size="sm" tooltip={$t('savedLoginInfo.copyPassword')} />
            </div>
          {/if}
          {#if login.totpSecret || login.otp}
            <div class="flex items-center gap-2">
              <span class="text-xs text-md-primary/60 w-16 shrink-0">{$t('savedLoginInfo.otp')}</span>
              <div class="flex-1 min-w-0">
                <TotpBadge secret={login.totpSecret || ''} staticOtp={typeof login.otp === 'string' ? login.otp : (typeof login.totp === 'string' ? login.totp : '')} />
              </div>
            </div>
          {/if}
          {#if true}
            {@const linkedIdentity = login.identityId
              ? identities.find((i: Identity) => i.id === login.identityId)
              : undefined}
            {@const countryVal = (login.country as string | null | undefined) || linkedIdentity?.country}
            {@const genderVal = (login.gender as string | null | undefined) || linkedIdentity?.gender}
            {@const dobVal = (login.dateOfBirth as string | null | undefined) || linkedIdentity?.dateOfBirth}
            {@const pinVal = (login.pin as string | null | undefined) || linkedIdentity?.pin}
            {#if countryVal}
              <div class="flex items-center gap-2">
                <span class="text-xs text-md-on-surface/40 w-16 shrink-0">{$t('savedLoginInfo.country')}</span>
                <span class="text-xs text-md-on-surface flex-1 truncate">{countryVal}</span>
                <CopyButton text={String(countryVal)} size="sm" tooltip={$t('savedLoginInfo.copyCountry')} />
              </div>
            {/if}
            {#if genderVal}
              <div class="flex items-center gap-2">
                <span class="text-xs text-md-on-surface/40 w-16 shrink-0">{$t('savedLoginInfo.gender')}</span>
                <span class="text-xs text-md-on-surface flex-1 truncate">{genderVal}</span>
                <CopyButton text={String(genderVal)} size="sm" tooltip={$t('savedLoginInfo.copyGender')} />
              </div>
            {/if}
            {#if dobVal}
              <div class="flex items-center gap-2">
                <span class="text-xs text-md-on-surface/40 w-16 shrink-0">{$t('savedLoginInfo.dateOfBirth')}</span>
                <span class="text-xs text-md-on-surface flex-1 truncate">{dobVal}</span>
                <CopyButton text={String(dobVal)} size="sm" tooltip={$t('savedLoginInfo.copyDob')} />
              </div>
            {/if}
            {#if pinVal}
              <div class="flex items-center gap-2">
                <span class="text-xs text-md-on-surface/40 w-16 shrink-0">{$t('savedLoginInfo.pinZip')}</span>
                <span class="text-xs text-md-on-surface flex-1 truncate font-mono">{pinVal}</span>
                <CopyButton text={String(pinVal)} size="sm" tooltip={$t('savedLoginInfo.copyPin')} />
              </div>
            {/if}
          {/if}
          {#if login.policyUrls?.length}
            <div class="pt-1 space-y-1.5">
              <div class="text-xs text-md-on-surface/40">{$t('savedLoginInfo.policyUrls')}</div>
              <p class="text-label-sm text-md-on-surface/55">{$t('savedLoginInfo.policyAcceptChecklist')}</p>
              {#each login.policyUrls as policyUrl, pIdx (policyUrl + String(pIdx))}
                {@const reviewedKey = `${login.id || login.email || ''}|${policyUrl}`}
                {@const isReviewed = policyReviewed[reviewedKey]}
                <div class="rounded-lg border border-md-outline-variant/30 bg-md-surface-container-low/50 px-2 py-1.5 space-y-1">
                  <div class="flex items-center gap-2">
                    <a
                      href={policyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-label-sm text-md-primary underline truncate flex-1 min-w-0"
                      style="direction: ltr; unicode-bidi: isolate;"
                      title={policyUrl}
                    >{policyUrl}</a>
                    <button
                      type="button"
                      class="w-6 h-6 flex items-center justify-center rounded hover:bg-md-primary-container transition-colors shrink-0"
                      aria-label={$t('savedLoginInfo.openPolicyUrl')}
                      title={$t('savedLoginInfo.openPolicyUrl')}
                      onclick={() => {
                        try {
                          void browser.tabs.create({ url: policyUrl });
                        } catch {
                          /* ignore */
                          window.open(policyUrl, '_blank', 'noopener,noreferrer');
                        }
                      }}
                    >
                      <Icon name="expand" class="w-3.5 h-3.5 text-md-on-surface/50" />
                    </button>
                    <CopyButton
                      text={policyUrl}
                      size="sm"
                      variant="ghost"
                      tooltip={$t('savedLoginInfo.copyPolicyUrl')}
                      onCopied={() => showToast($t('savedLoginInfo.policyUrlCopied'))}
                      class="w-6 h-6 p-0"
                    />
                  </div>
                  <label class="flex items-center gap-2 cursor-pointer select-none">
                    <Checkbox
                      checked={!!isReviewed}
                      onchange={(e) => {
                        const checked = e.currentTarget.checked;
                        policyReviewed = { ...policyReviewed, [reviewedKey]: checked };
                        void browser.storage.local.set({ policyReviewedMap: policyReviewed });
                      }}
                    />
                    <span class="text-label-sm text-md-on-surface/70">
                      {isReviewed ? $t('savedLoginInfo.policyAccepted') : $t('savedLoginInfo.policyAcceptedMark')}
                    </span>
                  </label>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/each}
      </div>
    {/each}
  {/if}
  <!-- Dynamic End-of-List Spacer: allows content to flow behind floating nav & strips while ensuring the final item can scroll cleanly above controls -->
  <div
    class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
    style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
    aria-hidden="true"
  ></div>
</div>
{/if}
</div>
