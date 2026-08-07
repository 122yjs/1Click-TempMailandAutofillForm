<script module lang="ts">
export const INBOX_SEARCH_SHELL_CLASS =
  'w-full flex items-center flex-wrap gap-1 ps-8 pe-16 py-1.5 text-sm rounded-xl bg-md-surface-container-high border border-md-outline-variant/40 focus-within:border-md-primary transition-colors min-h-[32px]';

export const SETTINGS_SEARCH_INPUT_CLASS =
  'flex-1 bg-transparent border-0 outline-none text-sm text-md-on-surface placeholder:text-md-on-surface-variant/60 min-w-[80px] py-0.5';

export type SearchShortcut = {
  prefix: string;
  label: string;
  description: string;
  /** Optional grouping for the shortcuts panel — 'exclude' entries render under
   * a dedicated "Exclude" section with error-tinted chips. Anything else is
   * treated as a regular (include) shortcut. */
  group?: string;
};
</script>

<script lang="ts">
/**
 * Unified SearchBar component combining search input, search history chips,
 * animated rotating placeholders, voice search, and shortcuts panel.
 */
import type { Snippet } from 'svelte';
import { onMount, untrack } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import Icon from '@/ui/components/icons/Icon.svelte';
import {
  getSearchHistory,
  pushSearchHistory,
  removeSearchHistoryItem,
} from '@/utils/search-history.js';

let {
  scope = 'default',
  value = $bindable(''),
  placeholder = 'Search…',
  ariaLabel = 'Search',
  settingsStyle = true,
  inputClass = '',
  onChange = (_v: string) => {},
  onFocus = () => {},
  onBlur = () => {},
  onSubmit = (_v: string) => {},
  trailing = undefined as Snippet | undefined,
  filterControl = undefined as Snippet | undefined,
  shortcuts = [] as SearchShortcut[],
  showSlashButton = false,
  animatedPlaceholders = [] as string[],
  showVoiceSearch = true,
  prefixContent = undefined as Snippet | undefined,
  inputId = undefined as string | undefined,
  onkeydown = undefined as ((e: KeyboardEvent) => void) | undefined,
  onInputRef = undefined as ((el: HTMLInputElement | null) => void) | undefined,
} = $props<{
  scope?: string;
  value?: string;
  placeholder?: string;
  ariaLabel?: string;
  settingsStyle?: boolean;
  inputClass?: string;
  onChange?: (v: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSubmit?: (v: string) => void;
  trailing?: Snippet;
  filterControl?: Snippet;
  shortcuts?: SearchShortcut[];
  showSlashButton?: boolean;
  animatedPlaceholders?: string[];
  showVoiceSearch?: boolean;
  prefixContent?: Snippet;
  inputId?: string;
  onkeydown?: (e: KeyboardEvent) => void;
  onInputRef?: (el: HTMLInputElement | null) => void;
}>();

let history = $state<string[]>([]);
let open = $state(false);
let focused = $state(false);
let slashIconPref = $state(true);

onMount(() => {
  void browser.storage.local.get(['showSearchSlashIcon']).then((r) => {
    slashIconPref = (r as { showSearchSlashIcon?: boolean }).showSearchSlashIcon !== false;
  });
  const onCh = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !changes.showSearchSlashIcon) return;
    slashIconPref = changes.showSearchSlashIcon.newValue !== false;
  };
  try {
    browser.storage.onChanged.addListener(onCh);
  } catch {
    /* ignore */
  }
  return () => {
    try {
      browser.storage.onChanged.removeListener(onCh);
    } catch {
      /* ignore */
    }
  };
});

let showSlashUi = $derived(showSlashButton && slashIconPref);
let shortcutsOpen = $state(false);
/** Search-syntax quick-ref panel (? button). */
let helpOpen = $state(false);
let blurTimer: ReturnType<typeof setTimeout> | null = null;
let inputEl = $state<HTMLInputElement | null>(null);

$effect(() => {
  if (onInputRef) {
    onInputRef(inputEl);
  }
});

type SpeechRecLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }>;
      }) => void)
    | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecCtor = new () => SpeechRecLike;

let voiceSearchEnabled = $state(true);
let voiceSupported = $state(false);
let listening = $state(false);
let recognition: SpeechRecLike | null = null;

function getSpeechRecognitionCtor(): SpeechRecCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecCtor;
    webkitSpeechRecognition?: SpeechRecCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

let showMic = $derived(showVoiceSearch && voiceSearchEnabled && voiceSupported);
let voiceInterimTimer: ReturnType<typeof setTimeout> | null = null;

function applyVoiceTranscript(text: string, isFinal: boolean) {
  value = text;
  if (isFinal) {
    if (voiceInterimTimer) {
      clearTimeout(voiceInterimTimer);
      voiceInterimTimer = null;
    }
    onChange(text);
    return;
  }
  if (voiceInterimTimer) clearTimeout(voiceInterimTimer);
  voiceInterimTimer = setTimeout(() => {
    onChange(text);
    voiceInterimTimer = null;
  }, 280);
}

function startVoiceSearch() {
  if (!voiceSupported) return;
  if (listening) {
    try {
      recognition?.stop();
    } catch {
      /* ignore */
    }
    listening = false;
    return;
  }
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    voiceSupported = false;
    return;
  }
  const rec = new Ctor();
  recognition = rec;
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = document.documentElement.lang || navigator.language || 'en-US';
  rec.onstart = () => {
    listening = true;
  };
  rec.onend = () => {
    listening = false;
  };
  rec.onerror = () => {
    listening = false;
  };
  rec.onresult = (event) => {
    let transcript = '';
    let isFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const row = event.results[i];
      transcript += row[0]?.transcript || '';
      if (row.isFinal) isFinal = true;
    }
    const text = transcript.trim();
    if (text) applyVoiceTranscript(text, isFinal);
  };
  try {
    rec.start();
  } catch {
    /* ignore */
    listening = false;
  }
}

async function refresh() {
  history = await getSearchHistory(scope);
}

onMount(() => {
  void refresh();
  voiceSupported = typeof window !== 'undefined' && !!getSpeechRecognitionCtor();
  void browser.storage.local.get(['voiceSearchEnabled']).then((res) => {
    const v = (res as { voiceSearchEnabled?: boolean }).voiceSearchEnabled;
    voiceSearchEnabled = v !== false;
  });
  const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !changes.voiceSearchEnabled) return;
    const v = changes.voiceSearchEnabled.newValue;
    voiceSearchEnabled = v !== false;
  };
  browser.storage.onChanged.addListener(onStorage);
  return () => {
    browser.storage.onChanged.removeListener(onStorage);
    if (voiceInterimTimer) clearTimeout(voiceInterimTimer);
    try {
      recognition?.stop();
    } catch {
      /* ignore */
    }
  };
});

let showSlashPanel = $derived(
  (showSlashButton || shortcuts.length > 0) &&
    (shortcutsOpen || (focused && (value.trim() === '/' || value.trim().startsWith('/'))))
);

let includeShortcuts = $derived(shortcuts.filter((s: SearchShortcut) => (s.group || 'include') !== 'exclude'));
let excludeShortcuts = $derived(shortcuts.filter((s: SearchShortcut) => (s.group || 'include') === 'exclude'));

function handleFocus() {
  if (blurTimer) clearTimeout(blurTimer);
  focused = true;
  open = true;
  onFocus();
  // When the field is empty, the rotating placeholder overlay is hidden while
  // focused — pin the caret to the start so it doesn't float mid-overlay.
  if (!value && inputEl) {
    try {
      inputEl.setSelectionRange(0, 0);
    } catch {
      /* ignore */
    }
  }
}

function handleBlur() {
  blurTimer = setTimeout(() => {
    focused = false;
    open = false;
    shortcutsOpen = false;
    helpOpen = false;
    onBlur();
  }, 180);
}

function handleInput(e: Event) {
  const target = e.target as HTMLInputElement;
  value = target.value;
  // Typing '/' reopens the shortcut panel — close the help panel so the two
  // never overlap.
  if (value.trim().startsWith('/')) helpOpen = false;
  onChange(value);
}

async function commit() {
  const trimmed = value.trim();
  if (trimmed) {
    history = await pushSearchHistory(scope, trimmed);
  }
  onSubmit(trimmed);
  open = false;
  shortcutsOpen = false;
}

async function handlePick(item: string) {
  value = item;
  onChange(item);
  history = await pushSearchHistory(scope, item);
  onSubmit(item);
  open = false;
}

async function handleRemove(e: MouseEvent, item: string) {
  e.stopPropagation();
  history = await removeSearchHistoryItem(scope, item);
}

/** Normalizes a shortcut prefix for display/insert: guarantees a single
 * trailing ':' (callers may pass either 'from' or 'from:'). */
function colon(prefix: string): string {
  return prefix.endsWith(':') ? prefix : `${prefix}:`;
}

function applyShortcut(prefix: string) {
  shortcutsOpen = false;
  const p = colon(prefix);
  if (!value || value === '/') {
    value = p;
  } else if (!value.toLowerCase().includes(p.toLowerCase())) {
    value = `${value.trim()} ${p}`;
  }
  onChange(value);
  inputEl?.focus();
}

// Rotating placeholder shows regardless of focus (no separate "typing" placeholder).
// When animated placeholder words exist and there's no typed value, hide the static
// input placeholder entirely so ONLY the upward animation is visible.
const displayPlaceholder = $derived(
  value?.trim() || animatedPlaceholders.length > 0 ? '' : placeholder
);

// ── Animated rotating placeholder (merged from RotatingPlaceholder.svelte) ──
// Static prefix (e.g. "Search") stays fixed while rotating words animate vertically.
let animIdx = $state(0);
let animPhase = $state<'enter' | 'hold' | 'exit'>('enter');

const placeholderPrefix = $derived($t('common.search'));
const placeholderWordsKey = $derived((animatedPlaceholders || []).join('\0'));

// Strip the locale search prefix (e.g. 'Search', 'Buscar', 'Suchen') from the
// beginning or end of each word so the moving text never contains the word 'search'.
// Then split phrases on " or " / " / " / commas so each rotating word is a clean,
// separate concept (e.g. "Search addresses or tags..." → ["addresses", "tags"]).
const cleanWords = $derived.by(() => {
  const wordsList = animatedPlaceholders || [];
  const searchPrefix = placeholderPrefix || '';
  const stripSearch = (w: string): string => {
    if (!searchPrefix) return w;
    const escaped = searchPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const beginRe = new RegExp(`^${escaped}\\s+`, 'u');
    const endRe = new RegExp(`\\s+${escaped}\\W*$`, 'iu');
    const wordRe = new RegExp(`\\b${escaped}\\b`, 'giu');
    let r = w.replace(beginRe, '');
    if (r !== w) return r;
    r = w.replace(endRe, '').trim();
    if (r !== w.trim()) return r;
    r = w.replace(wordRe, '').replace(/\s+/g, ' ').trim();
    return r || w;
  };
  const words: string[] = [];
  for (const raw of wordsList) {
    if (!raw) continue;
    const cleaned = stripSearch(raw);
    // Split on separators: " or ", " / ", commas, and ellipsis
    const parts = cleaned
      .split(/\s+(?:or|ou|o|oder|または|或)\s+|\s*\/\s*|,\s*|\.\.\.?/iu)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    for (const p of parts) {
      if (!words.includes(p)) words.push(p);
    }
  }
  return words.slice(0, 6);
});

$effect(() => {
  const key = placeholderWordsKey;
  const list = key ? key.split('\0') : [];
  if (!!value || !list.length) return;

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    if (cancelled) return;
    if (animPhase === 'enter') {
      animPhase = 'hold';
      timer = setTimeout(tick, 2000);
    } else if (animPhase === 'hold') {
      animPhase = 'exit';
      timer = setTimeout(tick, 300);
    } else if (animPhase === 'exit') {
      untrack(() => {
        animIdx = (animIdx + 1) % list.length;
      });
      animPhase = 'enter';
      timer = setTimeout(tick, 300);
    }
  };

  animPhase = 'enter';
  timer = setTimeout(tick, 300);

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
});
</script>

<div class="flex items-center gap-1 w-full min-w-0">
  <div class="relative flex-1 min-w-0">
    {#if settingsStyle}
      <div
        class="{INBOX_SEARCH_SHELL_CLASS} {trailing || showSlashButton || showMic
          ? 'pe-[4.5rem]'
          : ''} {inputClass}"
      >
        <Icon
          name="search"
          class="w-4 h-4 text-md-on-surface-variant absolute start-2.5 top-1/2 -translate-y-1/2 pointer-events-none z-[1]"
        />
        {@render rotatingPlaceholder()}
        {#if prefixContent}
          {@render prefixContent()}
        {/if}
        <input
          id={inputId}
          bind:this={inputEl}
          type="text"
          inputmode="search"
          enterkeyhint="search"
          class="{SETTINGS_SEARCH_INPUT_CLASS} search-no-native-clear"
          placeholder={displayPlaceholder}
          aria-label={ariaLabel}
          value={value}
          oninput={handleInput}
          onfocus={handleFocus}
          onblur={handleBlur}
          onkeydown={(e) => {
            if (onkeydown) onkeydown(e);
            if (e.defaultPrevented) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            } else if (e.key === 'Escape') {
              open = false;
              shortcutsOpen = false;
              helpOpen = false;
              inputEl?.blur();
            }
          }}
        />
        {#if showSlashUi || shortcuts.length > 0}
          <button
            type="button"
            class="shrink-0 ms-1 px-1.5 py-0.5 text-label-sm font-mono font-bold rounded border border-md-outline-variant/60 bg-md-surface-container text-md-on-surface-variant/80 hover:border-md-primary hover:text-md-primary transition-colors cursor-pointer"
            title={$t('inbox.searchHelp.aria') || 'Search syntax help'}
            aria-label={$t('inbox.searchHelp.aria') || 'Search syntax help'}
            aria-expanded={helpOpen}
            onclick={(e) => {
              e.stopPropagation();
              if (blurTimer) clearTimeout(blurTimer);
              helpOpen = !helpOpen;
              // Panels are mutually exclusive: opening help closes the history
              // and / shortcut panels so they never stack at the same position.
              if (helpOpen) {
                shortcutsOpen = false;
                open = false;
              }
              inputEl?.focus();
            }}
          >
            ?
          </button>
        {/if}
        <div class="absolute end-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5 z-[2]">
          {#if value}
            <button
              type="button"
              class="p-1 text-md-on-surface-variant/60 hover:text-md-on-surface rounded-lg hover:bg-md-surface-variant/40 transition-colors"
              aria-label={$t('common.clearSearch') || 'Clear search'}
              onclick={() => {
                value = '';
                onChange('');
                inputEl?.focus();
              }}
            >
              <Icon name="x" class="w-3.5 h-3.5" />
            </button>
          {/if}
          {#if showSlashUi}
            <button
              type="button"
              class="px-1.5 py-0.5 text-label-sm font-mono font-bold rounded border border-md-outline-variant/60 bg-md-surface-container text-md-on-surface-variant/80 hover:border-md-primary hover:text-md-primary transition-colors cursor-pointer"
              title={$t('inbox.searchFilterShortcutsTooltip') || 'Filter shortcuts (type /)'}
              aria-label={$t('inbox.searchFilterShortcuts') || 'Filter shortcuts'}
              onclick={(e) => {
                e.stopPropagation();
                if (blurTimer) clearTimeout(blurTimer);
                shortcutsOpen = !shortcutsOpen;
                if (shortcutsOpen) {
                  helpOpen = false;
                  open = false;
                }
                inputEl?.focus();
              }}
            >
              /
            </button>
          {/if}
          {#if showMic}
            <button
              type="button"
              class="p-1 rounded-lg transition-colors cursor-pointer {listening
                ? 'text-md-error bg-md-error-container/60 animate-pulse'
                : 'text-md-on-surface-variant/60 hover:text-md-primary hover:bg-md-surface-variant/40'}"
              title={listening
                ? $t('inbox.voiceListening') || 'Listening…'
                : $t('inbox.voiceSearchTooltip') || 'Search by voice'}
              aria-label={$t('inbox.voiceSearch') || 'Voice search'}
              onclick={(e) => {
                e.stopPropagation();
                startVoiceSearch();
              }}
            >
              <Icon name="mic" class="w-3.5 h-3.5" />
            </button>
          {/if}
          {#if trailing}
            {@render trailing()}
          {/if}
        </div>
      </div>
    {:else}
      <div class="relative">
        <Icon
          name="search"
          class="w-4 h-4 text-md-on-surface-variant absolute start-3 top-1/2 -translate-y-1/2 pointer-events-none"
        />
        {@render rotatingPlaceholder()}
        <input
          id={inputId}
          bind:this={inputEl}
          type="text"
          inputmode="search"
          enterkeyhint="search"
          class="w-full ps-9 pe-8 py-2 text-sm rounded-xl bg-md-surface-container-high border border-md-outline-variant/40 focus:border-md-primary focus:outline-none text-md-on-surface placeholder:text-md-on-surface-variant/60 transition-colors {inputClass}"
          placeholder={displayPlaceholder}
          aria-label={ariaLabel}
          value={value}
          oninput={handleInput}
          onfocus={handleFocus}
          onblur={handleBlur}
          onkeydown={(e) => {
            if (onkeydown) onkeydown(e);
            if (e.defaultPrevented) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
          }}
        />
        {#if value}
          <button
            type="button"
            class="absolute end-2 top-1/2 -translate-y-1/2 p-1 text-md-on-surface-variant/60 hover:text-md-on-surface rounded-lg"
            aria-label={$t('common.clearSearch') || 'Clear search'}
            onclick={() => {
              value = '';
              onChange('');
              inputEl?.focus();
            }}
          >
            <Icon name="x" class="w-3.5 h-3.5" />
          </button>
        {/if}
      </div>
    {/if}

    {#if open && history.length > 0 && !value && !shortcutsOpen && !helpOpen}
      <div
        class="absolute start-0 end-0 top-full mt-1.5 p-2 rounded-xl bg-md-surface-container-high border border-md-outline-variant/40 shadow-lg z-30 flex flex-wrap gap-1.5 max-h-36 overflow-y-auto"
      >
        <span class="w-full text-label-sm font-bold text-md-on-surface-variant/60 px-1 mb-0.5">
          {$t('searchHistory.recent') || 'Recent searches'}
        </span>
        {#each history as item (item)}
          <button
            type="button"
            class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-md-surface text-xs font-medium text-md-on-surface hover:bg-md-primary/10 hover:text-md-primary transition-colors group cursor-pointer"
            onclick={() => void handlePick(item)}
          >
            <Icon name="clock" class="w-3 h-3 text-md-on-surface-variant/60 group-hover:text-md-primary" />
            <span>{item}</span>
            <span
              role="button"
              tabindex="0"
              class="p-0.5 rounded hover:bg-md-outline-variant/30 text-md-on-surface-variant/40 group-hover:text-md-on-surface"
              aria-label={$t('common.removeSearch')}
              onclick={(e) => void handleRemove(e, item)}
              onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  void handleRemove(e as unknown as MouseEvent, item);
                }
              }}
            >
              <Icon name="x" class="w-3 h-3" />
            </span>
          </button>
        {/each}
      </div>
    {/if}

    {#if showSlashPanel}
      <div
        class="absolute start-0 end-0 top-full mt-1.5 p-2 rounded-xl bg-md-surface-container-high border border-md-outline-variant/50 shadow-xl z-30 space-y-1 max-h-48 overflow-y-auto"
      >
        <div class="text-label-sm font-bold text-md-primary px-1 pb-1 border-b border-md-outline-variant/20 flex items-center justify-between">
          <span>{$t('inbox.searchFilterShortcuts') || 'Filter shortcuts'}</span>
          <span class="text-md-on-surface-variant/50 font-normal">{$t('inbox.searchFilterHint') || 'click to add'}</span>
        </div>
        {#each includeShortcuts as sc (sc.prefix)}
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-md-primary/15 text-start transition-colors cursor-pointer group"
            onclick={() => applyShortcut(sc.prefix)}
          >
            <div class="flex items-center gap-2 min-w-0">
              <span class="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-md-primary/20 text-md-primary group-hover:bg-md-primary group-hover:text-md-on-primary transition-colors">
                {colon(sc.prefix)}
              </span>
              <span class="text-xs font-medium text-md-on-surface truncate">{sc.label}</span>
            </div>
              <span class="text-label-sm text-md-on-surface-variant/60 truncate shrink-0">{sc.description}</span>
          </button>
        {/each}
        {#if excludeShortcuts.length > 0}
          <div
            class="text-label-sm font-bold text-md-error px-1 pt-2 pb-0.5 mt-1 border-t border-md-outline-variant/20 flex items-center gap-1.5"
            aria-hidden="true"
          >
            <Icon name="x" class="w-3 h-3" />
            {$t('inbox.searchShortcut.excludeGroup') || 'Exclude'}
          </div>
          {#each excludeShortcuts as sc (sc.prefix)}
            <button
              type="button"
              class="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-md-error/15 text-start transition-colors cursor-pointer group"
              onclick={() => applyShortcut(sc.prefix)}
            >
              <div class="flex items-center gap-2 min-w-0">
                <span class="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-md-error/15 text-md-error group-hover:bg-md-error group-hover:text-md-on-error transition-colors">
                  {colon(sc.prefix)}
                </span>
                <span class="text-xs font-medium text-md-on-surface truncate">{sc.label}</span>
              </div>
              <span class="text-label-sm text-md-on-surface-variant/60 truncate shrink-0">{sc.description}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    {#if helpOpen}
      <div
        class="absolute start-0 end-0 top-full mt-1.5 p-2 rounded-xl bg-md-surface-container-high border border-md-outline-variant/50 shadow-xl z-30 space-y-1 max-h-56 overflow-y-auto"
        role="dialog"
        aria-label={$t('inbox.searchHelp.title') || 'Search syntax'}
      >
        <div class="text-label-sm font-bold text-md-primary px-1 pb-1 border-b border-md-outline-variant/20">
          {$t('inbox.searchHelp.title') || 'Search syntax'}
        </div>
        <button
          type="button"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-md-primary/15 text-start transition-colors cursor-pointer group"
          onclick={() => { helpOpen = false; applyShortcut('is:otp'); }}
        >
          <span class="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-md-primary/20 text-md-primary group-hover:bg-md-primary group-hover:text-md-on-primary transition-colors shrink-0">is:otp</span>
          <span class="flex-1 min-w-0">
            <span class="block text-xs font-medium text-md-on-surface truncate">{$t('inbox.searchHelp.otpLabel') || 'OTP emails'}</span>
            <span class="block text-label-sm text-md-on-surface-variant/60 truncate">{$t('inbox.searchHelp.otpDesc') || 'Only emails containing a one-time code'}</span>
          </span>
        </button>
        <button
          type="button"
          class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-md-primary/15 text-start transition-colors cursor-pointer group"
          onclick={() => { helpOpen = false; applyShortcut('has:attachment'); }}
        >
          <span class="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-md-primary/20 text-md-primary group-hover:bg-md-primary group-hover:text-md-on-primary transition-colors shrink-0">has:attachment</span>
          <span class="flex-1 min-w-0">
            <span class="block text-xs font-medium text-md-on-surface truncate">{$t('inbox.searchHelp.attachmentLabel') || 'Attachments'}</span>
            <span class="block text-label-sm text-md-on-surface-variant/60 truncate">{$t('inbox.searchHelp.attachmentDesc') || 'Only emails with attached files'}</span>
          </span>
        </button>
        <div
          class="text-label-sm font-bold text-md-error px-1 pt-2 pb-0.5 mt-1 border-t border-md-outline-variant/20 flex items-center gap-1.5"
          aria-hidden="true"
        >
          <Icon name="x" class="w-3 h-3" />
          {$t('inbox.searchHelp.negateTitle') || 'Exclude'}
        </div>
        <p class="px-1 text-xs text-md-on-surface-variant/60 leading-relaxed">
          {$t('inbox.searchHelp.negateDesc') || 'Prefix any filter with ! to exclude it (e.g. !from:spam.com)'}
        </p>
        <p class="px-1 pt-1.5 text-label-sm text-md-on-surface-variant/45 border-t border-md-outline-variant/20">
          {$t('inbox.searchHelp.savedFilters') || 'Combine filters with spaces · saved filters live in the filter menu'}
        </p>
      </div>
    {/if}
  </div>

  {#if filterControl}
    <div class="shrink-0 flex items-center">
      {@render filterControl()}
    </div>
  {/if}
</div>

{#snippet rotatingPlaceholder()}
  {#if !value && !focused && cleanWords.length > 0}
    <div
      class="absolute inset-y-0 start-8 flex items-center pointer-events-none overflow-hidden"
      aria-hidden="true"
    >
      {#if placeholderPrefix}
        <span class="text-sm text-md-on-surface-variant/60 whitespace-pre">{placeholderPrefix}</span
        ><span class="w-1"></span>
      {/if}
      <div class="relative h-[20px] flex items-center overflow-hidden w-44">
        {#each cleanWords as word, i (i)}
          {#if i === animIdx}
            <span
              class="absolute inset-0 flex items-center text-sm text-md-on-surface-variant/60 transition-all duration-300"
              style="transform: translateY({animPhase === 'enter' ? '20px' : animPhase === 'exit' ? '-20px' : '0'}); opacity: {animPhase === 'hold' ? '1' : '0'};"
            >
              {word}
            </span>
          {/if}
        {/each}
      </div>
    </div>
  {/if}
{/snippet}
