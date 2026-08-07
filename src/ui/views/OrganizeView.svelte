<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import {
  deleteFilterFromStorage,
  renameFilterInStorage,
} from '@/features/inbox/use-email-filters.js';
import type { OrganizeTab } from '@/features/types/view-types.js';
import ConfirmDialog from '@/ui/blocks/dialogs/ConfirmDialog.svelte';
import EmptyState from '@/ui/components/composites/EmptyState.svelte';
import ModalDialog from '@/ui/components/composites/ModalDialog.svelte';
import type { TabItem } from '@/ui/components/composites/Tabs.svelte';
import Tabs from '@/ui/components/composites/Tabs.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Btn, Checkbox } from '@/ui/components/primitives';
import Badge from '@/ui/components/primitives/Badge.svelte';
import Skeleton from '@/ui/components/primitives/Skeleton.svelte';
import { accountTagsList } from '@/utils/account-tags.js';
import { emailTagsStore } from '@/utils/email-tags-store.js';
import { logError } from '@/utils/logger.js';
import { portalDialogAction } from '@/utils/portal-layers.js';
import { getInboxes, setInboxes } from '@/utils/storage-keys.js';
import { timeAgo } from '@/utils/time-format.js';
import { toastStore } from '@/utils/toastStore.js';
import type { Account, SavedSearchFilter } from '@/utils/types.js';

type CatalogTag = { tag: string; color: string; createdAt?: number };

interface LabelEntry {
  name: string;
  count: number;
}

interface AutomationRules {
  autoArchiveOnCopyOtp: boolean;
  autoArchiveOnRead: boolean;
  autoDeletePromo24h: boolean;
}

function getContrastColor(hex: string): string {
  try {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? '#000000' : '#ffffff';
  } catch {
    /* ignore */
    return '#000000';
  }
}

let {
  initialTab = 'tags' as OrganizeTab,
  allInboxes = [] as Account[],
  savedSearchFilters = [] as SavedSearchFilter[],
  onReloadAccounts = async () => {},
  onFiltersChange = async () => {},
  showConfirm = (_message: string, _onConfirm: () => void) => {},
  tagCreateSignal = 0,
  labelCreateSignal = 0,
  tabSignal = 0,
  tabSignalValue = 'tags' as OrganizeTab,
  onTabChange = (_tab: OrganizeTab) => {},
} = $props<{
  initialTab?: OrganizeTab;
  allInboxes?: Account[];
  savedSearchFilters?: SavedSearchFilter[];
  onReloadAccounts?: () => Promise<void>;
  onFiltersChange?: () => Promise<void>;
  showConfirm?: (message: string, onConfirm: () => void) => void;
  tagCreateSignal?: number;
  labelCreateSignal?: number;
  /** Increment to force tab switch from parent (FAB / deep links) */
  tabSignal?: number;
  tabSignalValue?: OrganizeTab;
  /** Keep parent FAB / sidebar in sync when user switches tabs */
  onTabChange?: (tab: OrganizeTab) => void;
}>();

let activeTab = $state<OrganizeTab>('tags');
let lastTabSignal = 0;
let lastInitial = '';
let emailTagsById = $state<Record<string, string[]>>({});

$effect(() => {
  return emailTagsStore.subscribe((map) => {
    emailTagsById = map;
  });
});

$effect(() => {
  // Sync when parent deep-links via initialTab / tabSignal
  const next = tabSignal > 0 ? tabSignalValue : initialTab;
  if (tabSignal > 0 && tabSignal !== lastTabSignal) {
    lastTabSignal = tabSignal;
    activeTab = tabSignalValue;
    return;
  }
  if (initialTab && initialTab !== lastInitial) {
    lastInitial = initialTab;
    activeTab = initialTab;
  }
  void next;
});

$effect(() => {
  onTabChange(activeTab);
});

let tagCount = $derived.by(() => {
  const set = new Set<string>();
  for (const account of allInboxes || []) {
    const tags = accountTagsList(account);
    if (tags.length > 0) {
      for (const tagName of tags) if (tagName.name) set.add(tagName.name);
    } else if (account.tag) {
      set.add(account.tag);
    }
  }
  return set.size;
});

let labelCount = $derived.by(() => {
  const set = new Set<string>();
  for (const list of Object.values(emailTagsById || {})) {
    if (!Array.isArray(list)) continue;
    for (const name of list) if (name) set.add(name);
  }
  return set.size;
});

let filterCount = $derived(savedSearchFilters.length);

const tabItems = $derived<TabItem[]>([
  { id: 'tags', label: $t('nav.tagManagement'), badge: tagCount, icon: 'tag' },
  { id: 'labels', label: $t('nav.labelManagement'), badge: labelCount, icon: 'mail' },
  {
    id: 'filters',
    label: $t('nav.savedSearches'),
    badge: filterCount,
    icon: 'filter',
  },
]);

const activeSubtitle = $derived(
  activeTab === 'tags'
    ? $t('organize.tagsHint')
    : activeTab === 'labels'
      ? $t('organize.labelsHint')
      : $t('organize.filtersHint')
);

// ── Tags ────────────────────────────────────────────────────────────────────

let tagCatalog = $state<CatalogTag[]>([]);

async function loadTagCatalog() {
  try {
    const res = (await browser.storage.local.get(['mailboxTagCatalog'])) as {
      mailboxTagCatalog?: CatalogTag[];
    };
    tagCatalog = (res.mailboxTagCatalog || []).map((c) => ({
      tag: c.tag,
      color: c.color || '#6750a4',
      createdAt: c.createdAt || Date.now(),
    }));
  } catch {
    /* ignore */
    tagCatalog = [];
  }
}

$effect(() => {
  void loadTagCatalog();
});

let tagGroups = $derived.by(() => {
  const map = new Map<string, { color: string; accounts: Account[]; createdAt: number }>();
  for (const acc of allInboxes) {
    if (!acc.tag) continue;
    const key = acc.tag;
    if (!map.has(key)) {
      map.set(key, {
        color: acc.tagColor || '#6750a4',
        accounts: [],
        createdAt: 0,
      });
    }
    map.get(key)?.accounts.push(acc);
  }
  for (const c of tagCatalog) {
    if (!map.has(c.tag)) {
      map.set(c.tag, {
        color: c.color || '#6750a4',
        accounts: [],
        createdAt: c.createdAt || Date.now(),
      });
    } else {
      const g = map.get(c.tag);
      if (g) {
        g.createdAt = c.createdAt || g.createdAt;
        if (!g.color) g.color = c.color;
      }
    }
  }
  return [...map.entries()]
    .map(([tag, { color, accounts, createdAt }]) => ({
      tag,
      color,
      accounts,
      createdAt,
    }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
});

let editingTag = $state<{
  oldTag: string;
  newTag: string;
  color: string;
  isNew?: boolean;
  assignIds: string[];
} | null>(null);
let tagSaving = $state(false);
let tagErrorMsg = $state('');
/** After create — offer assign dialog if user skipped assignment */
let postCreateAssign = $state<{ tag: string; color: string } | null>(null);
let postAssignIds = $state<string[]>([]);

let lastTagCreateSignal = 0;
$effect(() => {
  const n = tagCreateSignal;
  if (n > 0 && n !== lastTagCreateSignal) {
    lastTagCreateSignal = n;
    editingTag = {
      oldTag: '',
      newTag: '',
      color: '#6750a4',
      isNew: true,
      assignIds: [],
    };
    tagErrorMsg = '';
    postCreateAssign = null;
  }
});

function tagStartEdit(tag: string, color: string, accounts: Account[]) {
  editingTag = {
    oldTag: tag,
    newTag: tag,
    color,
    isNew: false,
    assignIds: accounts.map((a) => a.id),
  };
  tagErrorMsg = '';
}

function tagCancelEdit() {
  editingTag = null;
  tagErrorMsg = '';
}

function toggleAssignId(id: string) {
  if (!editingTag) return;
  const set = new Set(editingTag.assignIds);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  editingTag = { ...editingTag, assignIds: [...set] };
}

async function applyTagToInboxes(tag: string, color: string, assignIds: string[], oldTag?: string) {
  const inboxes = await getInboxes();
  const assignSet = new Set(assignIds);
  const updated = inboxes.map((a) => {
    // Rename: clear old tag from non-assigned
    if (oldTag && a.tag === oldTag && !assignSet.has(a.id)) {
      return { ...a, tag: undefined, tagColor: undefined };
    }
    if (assignSet.has(a.id)) {
      return { ...a, tag, tagColor: color };
    }
    return a;
  });
  await setInboxes(updated);
}

async function tagSaveEdit() {
  if (!editingTag) return;
  const { oldTag, newTag, color, isNew, assignIds } = editingTag;
  const trimmed = newTag.trim();
  if (!trimmed) {
    tagErrorMsg = get(t)('tagManagement.tagNameEmpty');
    return;
  }
  // Unique name (case-insensitive) among other tags
  const clash = tagGroups.some(
    (g) => g.tag.toLowerCase() === trimmed.toLowerCase() && g.tag !== oldTag
  );
  if (clash) {
    tagErrorMsg = get(t)('tagManagement.tagNameDuplicate');
    return;
  }
  tagSaving = true;
  try {
    if (isNew || !oldTag) {
      const next: CatalogTag[] = [
        ...tagCatalog.filter((c) => c.tag.toLowerCase() !== trimmed.toLowerCase()),
        { tag: trimmed, color, createdAt: Date.now() },
      ];
      tagCatalog = next;
      await browser.storage.local.set({ mailboxTagCatalog: next });
      if (assignIds.length > 0) {
        await applyTagToInboxes(trimmed, color, assignIds);
        await onReloadAccounts();
        editingTag = null;
      } else {
        editingTag = null;
        // Suggest assignment dialog (issue 14)
        postCreateAssign = { tag: trimmed, color };
        postAssignIds = [];
      }
      return;
    }
    await applyTagToInboxes(trimmed, color, assignIds, oldTag);
    const nextCat = tagCatalog.map((c) => (c.tag === oldTag ? { ...c, tag: trimmed, color } : c));
    // Ensure catalog entry exists
    if (!nextCat.some((c) => c.tag === trimmed)) {
      nextCat.push({ tag: trimmed, color, createdAt: Date.now() });
    }
    tagCatalog = nextCat;
    await browser.storage.local.set({ mailboxTagCatalog: nextCat });
    await onReloadAccounts();
    editingTag = null;
  } catch (e) {
    tagErrorMsg = String(e);
  } finally {
    tagSaving = false;
  }
}

async function deleteTag(tag: string) {
  showConfirm(get(t)('tagManagement.removeTagConfirm', { values: { name: tag } }), () => {
    void (async () => {
      tagSaving = true;
      try {
        const inboxes = await getInboxes();
        const updated = inboxes.map((a) =>
          a.tag === tag ? { ...a, tag: undefined, tagColor: undefined } : a
        );
        await setInboxes(updated);
        // Also remove from catalog (tags with 0 inboxes)
        const nextCat = tagCatalog.filter((c) => c.tag !== tag);
        tagCatalog = nextCat;
        await browser.storage.local.set({ mailboxTagCatalog: nextCat });
        await onReloadAccounts();
      } finally {
        tagSaving = false;
      }
    })();
  });
}

function togglePostAssign(id: string) {
  const set = new Set(postAssignIds);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  postAssignIds = [...set];
}

async function savePostAssign() {
  if (!postCreateAssign) return;
  tagSaving = true;
  try {
    if (postAssignIds.length > 0) {
      await applyTagToInboxes(postCreateAssign.tag, postCreateAssign.color, postAssignIds);
      await onReloadAccounts();
    }
    postCreateAssign = null;
    postAssignIds = [];
  } finally {
    tagSaving = false;
  }
}

function formatTagCreated(ts: number): string {
  if (!ts) return '';
  try {
    return timeAgo(ts > 1e12 ? Math.floor(ts / 1000) : ts);
  } catch {
    /* ignore */
    return new Date(ts).toLocaleDateString();
  }
}

// ── Labels ──────────────────────────────────────────────────────────────────

let labels = $state<LabelEntry[]>([]);
let labelsLoading = $state(true);
let renamingLabel = $state<string | null>(null);
let labelRenameValue = $state('');
let deleteConfirmTarget = $state<string | null>(null);
let creatingLabel = $state(false);
let createLabelValue = $state('');
let labelCatalog = $state<string[]>([]);

let lastLabelCreateSignal = 0;
$effect(() => {
  const n = labelCreateSignal;
  if (n > 0 && n !== lastLabelCreateSignal) {
    lastLabelCreateSignal = n;
    creatingLabel = true;
    createLabelValue = '';
  }
});

async function loadLabels() {
  labelsLoading = true;
  try {
    const { emailTags = {}, emailLabelCatalog = [] } = (await browser.storage.local.get([
      'emailTags',
      'emailLabelCatalog',
    ])) as {
      emailTags?: Record<string, string[]>;
      emailLabelCatalog?: string[];
    };
    labelCatalog = emailLabelCatalog || [];
    const countMap: Record<string, number> = {};
    for (const tags of Object.values(emailTags)) {
      if (!Array.isArray(tags)) continue;
      for (const tag of tags) {
        countMap[tag] = (countMap[tag] ?? 0) + 1;
      }
    }
    for (const name of labelCatalog) {
      if (countMap[name] === undefined) countMap[name] = 0;
    }
    labels = Object.entries(countMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  } finally {
    labelsLoading = false;
  }
}

async function saveNewLabel() {
  const trimmed = createLabelValue.trim();
  if (!trimmed) {
    creatingLabel = false;
    return;
  }
  if (labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) {
    toastStore.error($t('labelManagement.duplicateName'));
    return;
  }
  const next = Array.from(new Set([...labelCatalog, trimmed]));
  labelCatalog = next;
  await browser.storage.local.set({ emailLabelCatalog: next });
  creatingLabel = false;
  createLabelValue = '';
  await loadLabels();
}

function deleteLabel(labelName: string) {
  deleteConfirmTarget = labelName;
}

async function handleConfirmDeleteLabel() {
  if (!deleteConfirmTarget) return;
  const labelName = deleteConfirmTarget;
  deleteConfirmTarget = null;
  const { emailTags = {} } = (await browser.storage.local.get(['emailTags'])) as {
    emailTags?: Record<string, string[]>;
  };
  const updated: Record<string, string[]> = {};
  for (const [id, tags] of Object.entries(emailTags)) {
    if (!Array.isArray(tags)) continue;
    const filtered = tags.filter((tagName) => tagName !== labelName);
    if (filtered.length > 0) updated[id] = filtered;
  }
  await browser.storage.local.set({ emailTags: updated });
  await loadLabels();
}

async function renameLabel(oldName: string, newName: string) {
  const trimmed = newName.trim();
  if (!trimmed || trimmed === oldName) {
    renamingLabel = null;
    return;
  }
  const { emailTags = {} } = (await browser.storage.local.get(['emailTags'])) as {
    emailTags?: Record<string, string[]>;
  };
  const updated: Record<string, string[]> = {};
  for (const [id, tags] of Object.entries(emailTags)) {
    if (!Array.isArray(tags)) continue;
    updated[id] = tags.map((tagName) => (tagName === oldName ? trimmed : tagName));
  }
  await browser.storage.local.set({ emailTags: updated });
  renamingLabel = null;
  labelRenameValue = '';
  await loadLabels();
}

function labelStartRename(name: string) {
  renamingLabel = name;
  labelRenameValue = name;
}

function labelCancelCreate() {
  creatingLabel = false;
  createLabelValue = '';
}

function labelCancelRename() {
  renamingLabel = null;
  labelRenameValue = '';
}

onMount(() => {
  loadLabels().catch((err) => {
    logError('Failed to load labels in onMount', undefined, err);
  });

  const handleStorageChange = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string
  ) => {
    if (areaName !== 'local') return;
    if (changes.emailTags) {
      loadLabels().catch((err) => {
        logError('Failed to load labels on storage change', undefined, err);
      });
    }
  };

  browser.storage.onChanged.addListener(handleStorageChange);
  onDestroy(() => browser.storage.onChanged.removeListener(handleStorageChange));
});

// ── Filters ─────────────────────────────────────────────────────────────────

let filterRenamingId = $state<string | null>(null);
let filterRenameValue = $state('');
let filterSaving = $state(false);
/** Full edit of filter conditions (not just rename) */
let filterEditingId = $state<string | null>(null);
let filterEditDraft = $state({
  name: '',
  searchQuery: '',
  hasOTP: false,
  senderDomain: '',
  dateFrom: '',
  dateTo: '',
  sortBy: 'newest',
});

let automationRules = $state<AutomationRules>({
  autoArchiveOnCopyOtp: true,
  autoArchiveOnRead: false,
  autoDeletePromo24h: false,
});

async function loadAutomationRules() {
  try {
    const res = (await browser.storage.local.get(['automationRules'])) as {
      automationRules?: AutomationRules;
    };
    if (res.automationRules) {
      automationRules = { ...automationRules, ...res.automationRules };
    }
  } catch (error) {
    logError('Failed to load automation rules', error);
  }
}

async function saveAutomationRule(key: keyof AutomationRules, val: boolean) {
  automationRules[key] = val;
  try {
    await browser.storage.local.set({ automationRules });
  } catch (error) {
    logError('Failed to save automation rule', error);
  }
}

$effect(() => {
  void loadAutomationRules();
});

function filterStartRename(filter: SavedSearchFilter) {
  filterRenamingId = filter.id;
  filterRenameValue = filter.name;
  filterEditingId = null;
}

function filterCancelRename() {
  filterRenamingId = null;
  filterRenameValue = '';
}

async function filterSaveRename() {
  if (!filterRenamingId) return;
  const trimmed = filterRenameValue.trim();
  if (!trimmed) return;
  filterSaving = true;
  try {
    await renameFilterInStorage(
      browser.storage.local,
      savedSearchFilters,
      filterRenamingId,
      trimmed
    );
    await onFiltersChange();
    filterRenamingId = null;
  } finally {
    filterSaving = false;
  }
}

function filterStartEdit(filter: SavedSearchFilter) {
  filterEditingId = filter.id;
  filterRenamingId = null;
  filterEditDraft = {
    name: filter.name,
    searchQuery: filter.searchQuery || '',
    hasOTP: !!filter.hasOTP,
    senderDomain: filter.senderDomain || '',
    dateFrom: filter.dateFrom || '',
    dateTo: filter.dateTo || '',
    sortBy: filter.sortBy || 'newest',
  };
}

function filterCancelEdit() {
  filterEditingId = null;
}

async function filterSaveEdit() {
  if (!filterEditingId) return;
  const name = filterEditDraft.name.trim();
  if (!name) return;
  filterSaving = true;
  try {
    const next = savedSearchFilters.map((f: SavedSearchFilter) =>
      f.id === filterEditingId
        ? {
            ...f,
            name,
            searchQuery: filterEditDraft.searchQuery.trim(),
            hasOTP: filterEditDraft.hasOTP,
            senderDomain: filterEditDraft.senderDomain.trim(),
            dateFrom: filterEditDraft.dateFrom,
            dateTo: filterEditDraft.dateTo,
            sortBy: filterEditDraft.sortBy,
          }
        : f
    );
    await browser.storage.local.set({ savedSearchFilters: next });
    await onFiltersChange();
    filterEditingId = null;
  } finally {
    filterSaving = false;
  }
}

async function deleteFilter(id: string, name: string) {
  showConfirm(get(t)('filtersManagement.deleteFilterConfirm', { values: { name } }), () => {
    void (async () => {
      filterSaving = true;
      try {
        await deleteFilterFromStorage(browser.storage.local, savedSearchFilters, id);
        await onFiltersChange();
      } finally {
        filterSaving = false;
      }
    })();
  });
}

function formatFilterDate(ts: number): string {
  return new Date(ts).toLocaleDateString();
}

function getFilterSummary(f: SavedSearchFilter): string {
  const tr = get(t);
  const parts: string[] = [];
  if (f.searchQuery) parts.push(`"${f.searchQuery}"`);
  if (f.hasOTP) parts.push(tr('filtersManagement.otpOnly'));
  if (f.senderDomain)
    parts.push(tr('filtersManagement.fromDomain', { values: { domain: f.senderDomain } }));
  if (f.dateFrom) parts.push(tr('filtersManagement.fromDate', { values: { date: f.dateFrom } }));
  if (f.dateTo) parts.push(tr('filtersManagement.toDate', { values: { date: f.dateTo } }));
  return parts.length > 0 ? parts.join(' · ') : tr('filtersManagement.noConditions');
}
</script>

<div class="relative flex flex-col h-full min-h-0">
  <div class="shrink-0 px-2 pt-2 pb-2 border-b border-md-outline-variant/30 space-y-2">
    <div class="px-0.5">
      <h1 class="text-base font-bold text-md-on-surface">{$t('nav.organize')}</h1>
      <p class="text-xs text-md-on-surface/50 mt-0.5">{$t('organize.subtitle')}</p>
    </div>
    <Tabs
      tabs={tabItems}
      bind:activeTab
      variant="pill"
      fullWidth={true}
      onchange={(id) => {
        activeTab = id as OrganizeTab;
        onTabChange(activeTab);
      }}
    />
    <p class="px-0.5 text-label-sm text-md-on-surface/45">{activeSubtitle}</p>
  </div>

  <div
    class="flex-1 min-h-0 overflow-hidden"
    role="tabpanel"
    aria-label={tabItems.find((item) => item.id === activeTab)?.label || $t('nav.organize')}
  >
    {#if activeTab === 'tags'}
      <div class="relative flex flex-col h-full min-h-0">
        <div class="flex-1 overflow-y-auto px-2 py-3 min-h-0">
          {#if tagGroups.length === 0}
            <div class="h-full flex flex-col justify-center">
              <EmptyState
                iconName="tag"
                title={$t('tagManagement.noTags')}
                description={$t('tagManagement.noTagsHint')}
              />
            </div>
          {:else}
            <div
              class="grid gap-3"
              style="grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));"
            >
              {#each tagGroups as group (group.tag)}
                <div class="density-row-pad bg-md-primary-container rounded-xl px-4 min-w-0">
                  <div class="flex items-start justify-between gap-2">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2 min-w-0">
                        <Badge variant="tag" customColor={group.color} label={group.tag} />
                        <span class="text-xs text-md-on-surface/50 ms-1 shrink-0">
                          · {$t('tagManagement.inboxCount', {
                            values: { n: group.accounts.length },
                          })}
                        </span>
                      </div>
                      {#if group.createdAt}
                        <p class="text-xs text-md-on-surface/45 mt-0.5 ps-5">
                          {$t('tagManagement.createdAt', {
                            values: { time: formatTagCreated(group.createdAt) },
                          })}
                        </p>
                      {/if}
                    </div>
                    <div class="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-md-primary/10 text-md-primary transition-colors"
                        onclick={() => tagStartEdit(group.tag, group.color, group.accounts)}
                        aria-label={$t('tagManagement.editTag', { values: { name: group.tag } })}
                        title={$t('tagManagement.editTag', { values: { name: group.tag } })}
                      >
                        <Icon name="editSquare" class="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-md-error/10 text-md-error transition-colors"
                        onclick={() => deleteTag(group.tag)}
                        aria-label={$t('tagManagement.deleteTag', { values: { name: group.tag } })}
                        disabled={tagSaving}
                      >
                        <Icon name="trash" class="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div class="mt-2 space-y-1 ps-5">
                    {#each group.accounts as acc (acc.id)}
                      <div
                        class="text-xs text-md-on-surface/60 truncate"
                        style="direction:ltr;unicode-bidi:isolate;"
                      >
                        {acc.address}
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          <div
            class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
            style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
            aria-hidden="true"
          ></div>
        </div>

        {#if editingTag}
          <ModalDialog
            open={!!editingTag}
            title={editingTag.isNew
              ? $t('tagManagement.createTitle')
              : $t('tagManagement.editTag', { values: { name: editingTag.oldTag } })}
            onClose={tagCancelEdit}
            maxWidth="sm"
          >
            <div class="space-y-3">
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  class="w-8 h-8 rounded-lg cursor-pointer border-0 p-0.5 bg-transparent"
                  bind:value={editingTag.color}
                  aria-label={$t('tagManagement.tagColor')}
                />
                <input
                  type="text"
                  class="flex-1 bg-md-secondary-container text-sm text-md-on-surface rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-md-primary"
                  bind:value={editingTag.newTag}
                  placeholder={$t('tagManagement.tagName')}
                  aria-label={$t('tagManagement.tagName')}
                />
              </div>
              <div class="space-y-1">
                <p class="text-label-sm font-semibold text-md-on-surface/60">
                  {$t('tagManagement.assignAddresses')}
                </p>
                <div
                  class="max-h-36 overflow-y-auto rounded-lg border border-md-outline-variant/30 divide-y divide-md-outline-variant/20"
                >
                  {#if allInboxes.length === 0}
                    <p class="text-label-sm text-md-on-surface/40 px-2 py-2">
                      {$t('tagManagement.noAddresses')}
                    </p>
                  {:else}
                    {#each allInboxes as acc (acc.id)}
                      <label
                        class="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-md-surface-variant/40"
                      >
                        <Checkbox
                          checked={editingTag.assignIds.includes(acc.id)}
                          onchange={() => toggleAssignId(acc.id)}
                        />
                        <span
                          class="text-label-sm truncate"
                          style="direction:ltr;unicode-bidi:isolate;">{acc.address}</span
                        >
                      </label>
                    {/each}
                  {/if}
                </div>
              </div>
              {#if tagErrorMsg}
                <p class="text-xs text-md-error">{tagErrorMsg}</p>
              {/if}
            </div>
            {#snippet footer()}
              <div class="flex gap-2 w-full">
                <Btn
                  variant="primary"
                  class="flex-1"
                  disabled={tagSaving}
                  loading={tagSaving}
                  onClick={() => void tagSaveEdit()}
                >
                  {$t('tagManagement.save')}
                </Btn>
                <Btn
                  variant="ghost"
                  class="flex-1"
                  onClick={tagCancelEdit}
                >
                  {$t('tagManagement.cancel')}
                </Btn>
              </div>
            {/snippet}
          </ModalDialog>
        {/if}

        {#if postCreateAssign}
          <ModalDialog
            open={!!postCreateAssign}
            title={$t('tagManagement.assignAfterCreate', {
              values: { name: postCreateAssign.tag },
            })}
            onClose={() => {
              postCreateAssign = null;
              postAssignIds = [];
            }}
            maxWidth="sm"
          >
            <div
              class="max-h-36 overflow-y-auto rounded-lg border border-md-outline-variant/30 divide-y divide-md-outline-variant/20"
            >
              {#each allInboxes as acc (acc.id)}
                <label
                  class="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-md-surface-variant/40"
                >
                  <Checkbox
                    checked={postAssignIds.includes(acc.id)}
                    onchange={() => togglePostAssign(acc.id)}
                  />
                  <span
                    class="text-label-sm truncate"
                    style="direction:ltr;unicode-bidi:isolate;">{acc.address}</span
                  >
                </label>
              {/each}
            </div>
            {#snippet footer()}
              <div class="flex gap-2 w-full">
                <Btn
                  variant="primary"
                  class="flex-1"
                  disabled={tagSaving}
                  loading={tagSaving}
                  onClick={() => void savePostAssign()}
                >
                  {$t('tagManagement.assignSave')}
                </Btn>
                <Btn
                  variant="ghost"
                  class="flex-1"
                  onClick={() => {
                    postCreateAssign = null;
                    postAssignIds = [];
                  }}
                >
                  {$t('tagManagement.skipAssign')}
                </Btn>
              </div>
            {/snippet}
          </ModalDialog>
        {/if}
      </div>
    {:else if activeTab === 'labels'}
      <div class="relative flex flex-col h-full min-h-0">
        <div class="flex-1 overflow-y-auto px-2 py-3 space-y-3 min-h-0">
          {#if labelsLoading}
            {#each [1, 2, 3] as _}
              <Skeleton width="100%" height="3.5rem" radius="0.75rem" />
            {/each}
          {:else if labels.length === 0}
            <div class="h-full flex flex-col justify-center">
              <EmptyState
                iconName="tag"
                title={$t('labelManagement.noLabels')}
                description={$t('labelManagement.noLabelsHint')}
              />
            </div>
          {:else}
            <div
              class="grid gap-3"
              style="grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));"
            >
              {#each labels as label}
                <div
                  class="density-row-pad bg-md-primary-container rounded-xl px-4 flex items-center gap-3 min-w-0"
                >
                  <Icon name="tag" class="w-4 h-4 text-md-primary shrink-0" />
                  <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-md-on-surface truncate">{label.name}</div>
                    <div class="text-xs text-md-on-surface/40">
                      {$t('labelManagement.emailCount', {
                        default: 'labelManagement.emailCountPlural',
                        values: { n: label.count },
                      })}
                    </div>
                  </div>
                  <button
                    type="button"
                    class="text-xs px-2 py-1 rounded-lg bg-md-secondary-container text-md-on-surface hover:bg-md-outline-variant transition-colors"
                    onclick={() => labelStartRename(label.name)}>{$t('labelManagement.rename')}</button
                  >
                  <button
                    type="button"
                    class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-md-error/10 text-md-error transition-colors shrink-0"
                    aria-label={$t('labelManagement.deleteLabel')}
                    onclick={() => deleteLabel(label.name)}
                  >
                    <Icon name="trash" class="w-4 h-4" />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
          <div
            class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
            style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
            aria-hidden="true"
          ></div>
        </div>

        {#if creatingLabel}
          <ModalDialog
            open={creatingLabel}
            title={$t('labelManagement.newLabelPlaceholder')}
            onClose={labelCancelCreate}
            maxWidth="sm"
          >
            <input
              class="w-full bg-md-secondary-container rounded-lg px-3 py-2 text-sm text-md-on-surface outline-none border border-md-primary"
              placeholder={$t('labelManagement.newLabelPlaceholder')}
              bind:value={createLabelValue}
              onkeydown={(e) => {
                if (e.key === 'Enter') void saveNewLabel();
                else if (e.key === 'Escape') labelCancelCreate();
              }}
            />
            {#snippet footer()}
              <div class="flex gap-2 w-full">
                <Btn
                  variant="primary"
                  class="flex-1"
                  onClick={() => void saveNewLabel()}
                >
                  {$t('labelManagement.save')}
                </Btn>
                <Btn
                  variant="ghost"
                  class="flex-1"
                  onClick={labelCancelCreate}
                >
                  {$t('labelManagement.cancel')}
                </Btn>
              </div>
            {/snippet}
          </ModalDialog>
        {/if}

        {#if renamingLabel}
          <ModalDialog
            open={!!renamingLabel}
            title={$t('labelManagement.rename')}
            onClose={labelCancelRename}
            maxWidth="sm"
          >
            <input
              class="w-full bg-md-secondary-container rounded-lg px-3 py-2 text-sm text-md-on-surface outline-none border border-md-primary"
              bind:value={labelRenameValue}
              onkeydown={(e) => {
                if (e.key === 'Enter' && renamingLabel)
                  void renameLabel(renamingLabel, labelRenameValue);
                else if (e.key === 'Escape') labelCancelRename();
              }}
            />
            {#snippet footer()}
              <div class="flex gap-2 w-full">
                <Btn
                  variant="primary"
                  class="flex-1"
                  onClick={() => renamingLabel && void renameLabel(renamingLabel, labelRenameValue)}
                >
                  {$t('labelManagement.save')}
                </Btn>
                <Btn
                  variant="ghost"
                  class="flex-1"
                  onClick={labelCancelRename}
                >
                  {$t('labelManagement.cancel')}
                </Btn>
              </div>
            {/snippet}
          </ModalDialog>
        {/if}
      </div>
    {:else}
      <div class="relative flex flex-col h-full min-h-0">
        <div class="flex-1 overflow-y-auto px-2 py-3 space-y-3 min-h-0">
          {#if savedSearchFilters.length === 0}
            <div class="h-full flex flex-col justify-center">
              <EmptyState
                iconName="search"
                title={$t('filtersManagement.noFilters')}
                description={$t('filtersManagement.noFiltersHint')}
              />
            </div>
          {:else}
            <div
              class="grid gap-3"
              style="grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));"
            >
              {#each savedSearchFilters as filter}
                <div class="density-row-pad bg-md-primary-container rounded-xl px-4 min-w-0">
                  <div class="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      class="flex-1 text-start min-w-0"
                      onclick={() => filterStartEdit(filter)}
                      aria-label={$t('filtersManagement.editFilter', {
                        values: { name: filter.name },
                      })}
                    >
                      <div class="font-medium text-sm text-md-on-surface truncate">
                        {filter.name}
                      </div>
                      <div class="text-xs text-md-on-surface/50 mt-0.5 line-clamp-2">
                        {getFilterSummary(filter)}
                      </div>
                      <div class="text-xs text-md-on-surface/35 mt-0.5">
                        {$t('filtersManagement.created', {
                          values: { date: formatFilterDate(filter.createdAt) },
                        })}
                      </div>
                    </button>
                    <div class="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-md-surface-variant text-md-on-surface/60 transition-colors"
                        onclick={() => filterStartRename(filter)}
                        aria-label={$t('filtersManagement.renameFilter', {
                          values: { name: filter.name },
                        })}
                        title={$t('filtersManagement.renameFilter', {
                          values: { name: filter.name },
                        })}
                      >
                        <Icon name="edit" class="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        class="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-md-error/10 text-md-error transition-colors"
                        onclick={() => deleteFilter(filter.id, filter.name)}
                        aria-label={$t('filtersManagement.deleteFilter', {
                          values: { name: filter.name },
                        })}
                        disabled={filterSaving}
                      >
                        <Icon name="trash" class="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          <div class="mt-6 pt-4 border-t border-md-outline-variant/20 space-y-3">
            <div class="flex items-center gap-2">
              <Icon name="cog" class="w-4 h-4 text-md-primary" />
              <h2 class="text-sm font-bold text-md-on-surface">
                {$t('filtersManagement.automationsTitle')}
              </h2>
            </div>

            <div class="space-y-2">
              <label
                class="flex items-center justify-between p-3 rounded-xl bg-md-surface-container-low border border-md-outline-variant/20 cursor-pointer hover:bg-md-surface-container transition-colors"
              >
                <div class="space-y-0.5">
                  <div class="text-xs font-semibold text-md-on-surface">
                    {$t('organize.autoArchiveOnCopyOtp')}
                  </div>
                  <div class="text-xs text-md-on-surface/50">
                    {$t('organize.autoArchiveOnCopyOtpHint')}
                  </div>
                </div>
                <Checkbox
                  checked={automationRules.autoArchiveOnCopyOtp}
                  onchange={(e) =>
                    saveAutomationRule('autoArchiveOnCopyOtp', e.currentTarget.checked)}
                />
              </label>

              <label
                class="flex items-center justify-between p-3 rounded-xl bg-md-surface-container-low border border-md-outline-variant/20 cursor-pointer hover:bg-md-surface-container transition-colors"
              >
                <div class="space-y-0.5">
                  <div class="text-xs font-semibold text-md-on-surface">{$t('organize.autoArchiveOnRead')}</div>
                  <div class="text-xs text-md-on-surface/50">
                    {$t('organize.autoArchiveOnReadHint')}
                  </div>
                </div>
                <Checkbox
                  checked={automationRules.autoArchiveOnRead}
                  onchange={(e) =>
                    saveAutomationRule('autoArchiveOnRead', e.currentTarget.checked)}
                />
              </label>

              <label
                class="flex items-center justify-between p-3 rounded-xl bg-md-surface-container-low border border-md-outline-variant/20 cursor-pointer hover:bg-md-surface-container transition-colors"
              >
                <div class="space-y-0.5">
                  <div class="text-xs font-semibold text-md-on-surface">
                    {$t('organize.autoDeletePromo24h')}
                  </div>
                  <div class="text-xs text-md-on-surface/50">
                    {$t('organize.autoDeletePromo24hHint')}
                  </div>
                </div>
                <Checkbox
                  checked={automationRules.autoDeletePromo24h}
                  onchange={(e) =>
                    saveAutomationRule('autoDeletePromo24h', e.currentTarget.checked)}
                />
              </label>
            </div>
          </div>
          <div
            class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
            style="height: calc(var(--bottom-safe-area, 0px) + 16px);"
            aria-hidden="true"
          ></div>
        </div>

        {#if filterEditingId}
          <ModalDialog
            open={!!filterEditingId}
            title={$t('filtersManagement.editFilter', {
              values: { name: filterEditDraft.name || '' },
            })}
            onClose={filterCancelEdit}
            maxWidth="sm"
          >
            <div class="space-y-2">
              <label class="block text-xs text-md-on-surface/50" for="edit-filter-name"
                >{$t('filtersManagement.filterName')}</label
              >
              <input
                id="edit-filter-name"
                type="text"
                class="w-full bg-md-secondary-container text-sm text-md-on-surface rounded-lg px-3 py-1.5 outline-none focus:ring-2 focus:ring-md-primary"
                bind:value={filterEditDraft.name}
              />
              <label class="block text-xs text-md-on-surface/50" for="edit-filter-q"
                >{$t('filtersManagement.searchQuery')}</label
              >
              <input
                id="edit-filter-q"
                type="text"
                class="w-full bg-md-secondary-container text-sm text-md-on-surface rounded-lg px-3 py-1.5 outline-none"
                bind:value={filterEditDraft.searchQuery}
                placeholder={$t('filtersManagement.searchQueryPlaceholder')}
              />
              <label class="block text-xs text-md-on-surface/50" for="edit-filter-dom"
                >{$t('filtersManagement.senderDomain')}</label
              >
              <input
                id="edit-filter-dom"
                type="text"
                class="w-full bg-md-secondary-container text-sm text-md-on-surface rounded-lg px-3 py-1.5 outline-none"
                bind:value={filterEditDraft.senderDomain}
                placeholder="example.com"
              />
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <label class="block text-xs text-md-on-surface/50" for="edit-filter-from"
                    >{$t('filtersManagement.dateFrom')}</label
                  >
                  <input
                    id="edit-filter-from"
                    type="date"
                    class="w-full bg-md-secondary-container text-xs rounded-lg px-2 py-1.5 outline-none"
                    bind:value={filterEditDraft.dateFrom}
                  />
                </div>
                <div>
                  <label class="block text-xs text-md-on-surface/50" for="edit-filter-to"
                    >{$t('filtersManagement.dateTo')}</label
                  >
                  <input
                    id="edit-filter-to"
                    type="date"
                    class="w-full bg-md-secondary-container text-xs rounded-lg px-2 py-1.5 outline-none"
                    bind:value={filterEditDraft.dateTo}
                  />
                </div>
              </div>
              <label class="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox bind:checked={filterEditDraft.hasOTP} />
                {$t('filtersManagement.otpOnly')}
              </label>
            </div>
            {#snippet footer()}
              <div class="flex gap-2 w-full pt-1">
                <Btn
                  variant="primary"
                  class="flex-1"
                  disabled={filterSaving}
                  loading={filterSaving}
                  onClick={filterSaveEdit}
                >
                  {$t('filtersManagement.save')}
                </Btn>
                <Btn
                  variant="ghost"
                  class="flex-1"
                  onClick={filterCancelEdit}
                >
                  {$t('filtersManagement.cancel')}
                </Btn>
              </div>
            {/snippet}
          </ModalDialog>
        {/if}

        {#if filterRenamingId}
          <ModalDialog
            open={!!filterRenamingId}
            title={$t('filtersManagement.filterName')}
            onClose={filterCancelRename}
            maxWidth="sm"
          >
            <input
              type="text"
              class="w-full bg-md-secondary-container text-sm text-md-on-surface rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-md-primary"
              bind:value={filterRenameValue}
              placeholder={$t('filtersManagement.filterName')}
              aria-label={$t('filtersManagement.filterName')}
            />
            {#snippet footer()}
              <div class="flex gap-2 w-full">
                <Btn
                  variant="primary"
                  class="flex-1"
                  disabled={filterSaving}
                  loading={filterSaving}
                  onClick={filterSaveRename}
                >
                  {$t('filtersManagement.save')}
                </Btn>
                <Btn
                  variant="ghost"
                  class="flex-1"
                  onClick={filterCancelRename}
                >
                  {$t('filtersManagement.cancel')}
                </Btn>
              </div>
            {/snippet}
          </ModalDialog>
        {/if}
      </div>
    {/if}
  </div>
</div>

<ConfirmDialog
  confirmDialog={deleteConfirmTarget
    ? {
        title: $t('labelManagement.deleteLabel'),
        message: $t('labelManagement.deleteConfirm', {
          values: { name: deleteConfirmTarget },
        }),
        confirmLabel: $t('labelManagement.delete'),
        onConfirm: handleConfirmDeleteLabel,
      }
    : null}
  onClose={() => {
    deleteConfirmTarget = null;
  }}
/>
