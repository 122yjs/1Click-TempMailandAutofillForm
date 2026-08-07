<script lang="ts">
import { onDestroy, onMount, tick } from 'svelte';
import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import { generateSingleEMLContent } from '@/features/inbox/inbox-export.js';
import { isDarkThemeActive } from '@/features/theme/theme-actions.js';
import CopyButton from '@/ui/components/composites/CopyButton.svelte';
import EmailBody from '@/ui/components/composites/EmailBody.svelte';
import EmptyState from '@/ui/components/composites/EmptyState.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import FaviconImage from '@/ui/components/primitives/FaviconImage.svelte';
import {
  DETAIL_TOOLBAR_STRIP,
  DETAIL_TOOLBAR_TONE_ACCENT,
  DETAIL_TOOLBAR_TONE_DANGER,
  DETAIL_TOOLBAR_TONE_NEUTRAL,
  detailToolbarBtnClass,
} from '@/ui/detail-toolbar.js';
import { copyToClipboardAndSchedulePurge } from '@/utils/clipboard.js';
import { isEmailStarred, toggleStarInSet } from '@/utils/email-star-key.js';
import { emailTagsStore } from '@/utils/email-tags-store.js';
import { logError } from '@/utils/logger.js';
import { buildEmailPrintHtml, printHtmlDocument } from '@/utils/print-email.js';
import { escapeHtmlText, initSanitize, sanitizeHtml } from '@/utils/sanitize-html.js';
import { toMs } from '@/utils/time.js';
import { formatFullDateTime, timeAgo } from '@/utils/time-format.js';
import type { Account, Email } from '@/utils/types.js';
import { actionBtnCascade } from '@/utils/use-action-btn-cascade.js';

let {
  onBack = () => {},
  selectedThread = [],
  onMarkUnread = () => {},
  onArchive = () => {},
  onDelete = () => {},
  hasPrev = false,
  hasNext = false,
  onPrev = () => {},
  onNext = () => {},
  mailboxAddress = '',
  /** When true (split view), toolbar buttons show icon + text label */
  showToolbarLabels = false,
  context = 'app',
  showToast = (_msg: string) => {},
  onSearchText = (_text: string) => {},
} = $props<{
  onBack?: () => void;
  selectedThread?: Email[];
  onMarkUnread?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  mailboxAddress?: string;
  showToolbarLabels?: boolean;
  context?: 'popup' | 'sidepanel' | 'app';
  showToast?: (msg: string) => void;
  onSearchText?: (text: string) => void;
}>();

// The message action buttons target the latest message in the thread.
let currentMessage = $derived(selectedThread.length > 0 ? selectedThread[0] : null);
let isThread = $derived(selectedThread.length > 1);

let bodiesById = $state<Record<string, string>>({});
let emailTagsMap = $state<Record<string, string[]>>({});
let perMessageImagesLoaded = $state<Set<string>>(new Set());
let tagDialogOpen = $state(false);
let tagDialogInput = $state('');
let downloadDialogOpen = $state(false);
let starredEmailIds = $state<Set<string>>(new Set());
let starBusy = $state(false);
let detailToolbarEl = $state<HTMLElement | null>(null);
let detailToolbarHeightPx = $state(0);

$effect(() => {
  const el = detailToolbarEl;
  if (!el || typeof ResizeObserver === 'undefined') {
    detailToolbarHeightPx = 0;
    return;
  }
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const rect = entry.target.getBoundingClientRect();
      detailToolbarHeightPx = Math.ceil(rect.height);
    }
  });
  ro.observe(el);
  return () => ro.disconnect();
});

let currentEmailTags = $derived(currentMessage ? emailTagsMap[currentMessage.id] || [] : []);
let isStarred = $derived(
  currentMessage
    ? isEmailStarred(
        starredEmailIds,
        currentMessage.id,
        currentMessage.original_inbox || mailboxAddress
      )
    : false
);

let selectedText = $state('');
let selectionPopupPos = $state<{ x: number; y: number } | null>(null);

function handleSelectionChange() {
  if (typeof window === 'undefined') return;
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (text.length > 0 && text.length < 500) {
    selectedText = text;
    try {
      const range = sel?.getRangeAt(0);
      if (!range) return;
      const rect = range.getBoundingClientRect();
      if (rect.width > 0) {
        selectionPopupPos = {
          x: Math.max(16, rect.left + rect.width / 2),
          y: Math.max(40, rect.top - 36),
        };
        return;
      }
    } catch {
      /* ignore */
    }
  }
  selectedText = '';
  selectionPopupPos = null;
}
let bestMagicLink = $derived(
  currentMessage?.magicLinks && currentMessage.magicLinks.length > 0
    ? currentMessage.magicLinks[0]
    : null
);
/** Stack height for bottom strips (OTP + magic link) above toolbar */
let bottomStripsRem = $derived.by(() => {
  let n = 0;
  if (currentMessage?.isOtp && currentMessage?.otp) n += 1;
  if (bestMagicLink) n += 1;
  if (n === 0) return '0.75rem';
  // each strip ~2.5rem + gaps
  return `${0.75 + n * 2.75}rem`;
});

/** Per-sender counts for the hover tooltip (UX item #3): here = current mailbox, other = all other mailboxes. */
let senderHereCount = $state(0);
let senderOtherCount = $state(0);

async function refreshSenderStats(msg: Email | null, addr: string): Promise<void> {
  const sender = msg?.from;
  if (!sender) {
    senderHereCount = 0;
    senderOtherCount = 0;
    return;
  }
  try {
    const { storedEmails = {} } = (await browser.storage.local.get(['storedEmails'])) as {
      storedEmails?: Record<string, Email[]>;
    };
    let here = 0;
    let other = 0;
    for (const [bag, msgs] of Object.entries(storedEmails)) {
      if (!Array.isArray(msgs)) continue;
      const c = msgs.filter((m) => m?.from === sender).length;
      if (bag === addr) here += c;
      else other += c;
    }
    senderHereCount = here;
    senderOtherCount = other;
  } catch {
    /* ignore */
    senderHereCount = 0;
    senderOtherCount = 0;
  }
}

// Recompute when the displayed message or mailbox changes. Read the tracked
// deriveds synchronously so the effect re-runs, then hand off to the async fetch.
$effect(() => {
  void refreshSenderStats(currentMessage, mailboxAddress);
});

async function openMagicLink(url: string) {
  try {
    await browser.tabs.create({ url });
  } catch (err) {
    logError(
      'Failed to open magic link',
      undefined,
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

async function copyMagicLink(url: string) {
  try {
    await copyToClipboardAndSchedulePurge(url);
  } catch (err) {
    logError(
      'Failed to copy magic link',
      undefined,
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

/** Contextual copy for subject & sender */
async function copySubject() {
  if (!currentMessage?.subject) return;
  try {
    await copyToClipboardAndSchedulePurge(currentMessage.subject);
    showToast?.(
      get(t)('inbox.subjectCopiedText', { values: { subject: currentMessage.subject } }) as string
    );
  } catch (err) {
    logError(
      'Failed to copy subject',
      undefined,
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

async function copySender() {
  if (!currentMessage?.from) return;
  try {
    await copyToClipboardAndSchedulePurge(currentMessage.from);
    showToast?.(
      get(t)('inbox.senderEmailCopiedText', { values: { email: currentMessage.from } }) as string
    );
  } catch (err) {
    logError(
      'Failed to copy sender',
      undefined,
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

function printEmail() {
  if (!currentMessage) return;
  // Popup / sidepanel cannot keep a print dialog alive (the popup closes the
  // moment the dialog steals focus, and panels have no reliable print support) —
  // open the full app page, which prints in its own user gesture.
  if (context !== 'app') {
    void openAppForPrint();
    return;
  }
  const rawBody =
    bodiesById[currentMessage.id] || currentMessage.body_html || currentMessage.body || '';
  const bodyContent = sanitizeHtml(rawBody);
  const html = buildEmailPrintHtml(currentMessage, bodyContent);
  printHtmlDocument(html, currentMessage.subject || get(t)('activity.noSubject'));
}

/** Open the full app page with a print intent for the current message. */
async function openAppForPrint() {
  if (!currentMessage) return;
  try {
    const runtime = browser.runtime as unknown as { getURL?: (p: string) => string };
    const appUrl = typeof runtime.getURL === 'function' ? runtime.getURL('/app.html') : '/app.html';
    const qs = new URLSearchParams({
      printInbox: currentMessage.original_inbox || mailboxAddress,
      printEmail: currentMessage.id,
    });
    await browser.tabs.create({ url: `${appUrl}?${qs.toString()}` });
    // Only the sidepanel stays visible after the new tab steals focus — the
    // popup closes immediately, so a toast there would never be seen.
    if (context === 'sidepanel') {
      showToast?.(get(t)('inbox.printOpenedApp') as string);
    }
  } catch (error) {
    logError(
      'Failed to open app for printing',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
    showToast?.(get(t)('inbox.printOpenFailed') as string);
  }
}

function downloadAsMarkdown() {
  if (!currentMessage) return;
  const subject = currentMessage.subject || get(t)('activity.noSubject');
  const from = currentMessage.from || currentMessage.from_name || get(t)('activity.unknownSender');
  const dateStr =
    currentMessage.time || new Date(toMs(currentMessage.received_at)).toLocaleString();
  const rawHtml = currentMessage.body_html || currentMessage.body || '';

  let markdown = `# ${subject}\n\n- **${get(t)('activity.fromLabel')}:** ${from}\n- **${get(t)('activity.dateLabel')}:** ${dateStr}\n- **ID:** ${currentMessage.id}\n\n---\n\n`;
  markdown += convertHtmlToMarkdown(rawHtml || currentMessage.body || '');

  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const slug =
    subject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'email';
  a.download = `${slug}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast?.(get(t)('inbox.markdownExported') as string);
}

function convertHtmlToMarkdown(html: string): string {
  if (!html) return '';
  let text = html;
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)');
  text = text.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)');
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<[^>]*>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.trim();
}

onMount(async () => {
  await initSanitize();
  void sanitizeAll();
});

let showImages = $state(true);

function rawContentHasImages(msg: Email): boolean {
  const rawHtml = msg.body_html || '';
  const rawText = msg.body || msg.body_plain || '';
  const isHtmlText = !rawHtml && /<[a-z][\s\S]*>/i.test(rawText);
  const content = rawHtml || (isHtmlText ? rawText : '');
  return /<img[\s>]/i.test(content) || /res\.php\?r=1/i.test(content);
}

function shouldShowLoadImagesChip(msg: Email): boolean {
  if (showImages || perMessageImagesLoaded.has(msg.id)) return false;
  return rawContentHasImages(msg);
}

function loadImagesForMessage(msgId: string) {
  perMessageImagesLoaded = new Set([...perMessageImagesLoaded, msgId]);
  void sanitizeAll();
}

async function loadShowImages() {
  try {
    const { showImages: val } = (await browser.storage.local.get(['showImages'])) as {
      showImages?: boolean;
    };
    showImages = val !== false;
  } catch {
    /* ignore */
    showImages = true;
  }
}

onMount(() => {
  void loadShowImages();
  void loadStarred();
  const unsubTags = emailTagsStore.subscribe((map) => {
    emailTagsMap = map;
  });
  document.addEventListener('selectionchange', handleSelectionChange);
  const handleStorageChange = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    areaName: string
  ) => {
    if (areaName !== 'local') return;
    if (changes.showImages) {
      showImages = changes.showImages.newValue !== false;
      void sanitizeAll();
    }
    if (changes.starredEmails) void loadStarred();
  };

  // Re-sanitize when the resolved theme flips (covers both the settings toggle
  // and `system` mode following the OS). Sanitized bodies bake in the dark-mode
  // neutralization, so switching themes must re-derive them from the raw HTML.
  const themeObserver =
    typeof MutationObserver !== 'undefined' ? new MutationObserver(() => void sanitizeAll()) : null;
  themeObserver?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  browser.storage.onChanged.addListener(handleStorageChange);
  onDestroy(() => {
    unsubTags();
    themeObserver?.disconnect();
    browser.storage.onChanged.removeListener(handleStorageChange);
  });
});

$effect(() => {
  if (selectedThread.length > 0) {
    void sanitizeAll();
  }
});

function formatPlainTextEmail(text: string): string {
  if (!text) return '';
  const escaped = escapeHtmlText(text);
  const linked = escaped.replace(
    /(https?:\/\/[^\s<>'"]+)/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="text-md-primary underline font-medium">$1</a>'
  );
  return `<div class="plain-text-email" style="white-space: pre-wrap; word-break: break-word; font-family: inherit; line-height: 1.6; font-size: 0.875rem;">${linked}</div>`;
}

function sanitizeAll() {
  const next: Record<string, string> = {};
  for (const msg of selectedThread) {
    const rawHtml = msg.body_html || '';
    const rawText = msg.body || msg.body_plain || '';

    // Check if rawText contains HTML tags even if body_html was not set
    const isHtmlText = !rawHtml && /<[a-z][\s\S]*>/i.test(rawText);
    const contentToSanitize = rawHtml || (isHtmlText ? rawText : '');

    if (contentToSanitize) {
      const allowImages = showImages || perMessageImagesLoaded.has(msg.id);
      next[msg.id] = sanitizeHtml(contentToSanitize, {
        allowImages,
        // EmailBody renders into an OPEN shadow DOM, so sanitized <style>
        // blocks (safe CSS subset — layout/@media only) are scoped there and
        // can never restyle the app. Kept so responsive email styling works.
        allowStyleBlocks: true,
        // Neutralize hardcoded light backgrounds / dark text on dark themes so
        // emails stay readable; layout and the email's own colors are kept.
        darkMode: isDarkThemeActive(),
      });
    } else {
      next[msg.id] = formatPlainTextEmail(rawText);
    }
  }
  bodiesById = next;
}

async function loadStarred() {
  const result = (await browser.storage.local.get(['starredEmails'])) as {
    starredEmails?: string[];
  };
  starredEmailIds = new Set(result.starredEmails || []);
}

async function toggleStar() {
  if (!currentMessage?.id || starBusy) return;
  starBusy = true;
  try {
    const result = (await browser.storage.local.get(['starredEmails'])) as {
      starredEmails?: string[];
    };
    const addr = currentMessage.original_inbox || mailboxAddress;
    const updated = toggleStarInSet(result.starredEmails || [], currentMessage.id, addr);
    starredEmailIds = updated;
    await browser.storage.local.set({ starredEmails: Array.from(updated) });
  } catch (e) {
    logError('toggleStar failed', e);
    await loadStarred();
  } finally {
    starBusy = false;
  }
}

async function saveEmailTagsToStorage() {
  const snapshot = $state.snapshot(emailTagsMap) as Record<string, string[]>;
  await emailTagsStore.replaceMap(snapshot);
}

function openTagDialog() {
  if (!currentMessage) return;
  tagDialogInput = (emailTagsMap[currentMessage.id] || []).join(', ');
  tagDialogOpen = true;
}

function closeTagDialog() {
  tagDialogOpen = false;
  tagDialogInput = '';
}

async function saveEmailTags() {
  if (!currentMessage) return;
  const tags = Array.from(
    new Set(
      tagDialogInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    )
  );
  const newMap: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(emailTagsMap)) {
    if (Array.isArray(v)) newMap[k] = v.slice();
  }
  if (tags.length === 0) {
    delete newMap[currentMessage.id];
  } else {
    newMap[currentMessage.id] = tags.slice();
  }
  emailTagsMap = newMap;
  await tick();
  await saveEmailTagsToStorage();
  closeTagDialog();
}

let allEmailTags = $derived.by(() => {
  const set = new Set<string>();
  for (const tags of Object.values(emailTagsMap)) {
    if (!Array.isArray(tags)) continue;
    for (const t of tags) set.add(t);
  }
  return Array.from(set).sort();
});

function _forwardMessage() {
  if (!currentMessage) return;

  const subject = encodeURIComponent(`Fwd: ${currentMessage.subject || 'No Subject'}`);
  const body = encodeURIComponent(
    `\n\n--- Forwarded Message ---\n` +
      `From: ${currentMessage.from || 'Unknown Sender'}\n` +
      `Date: ${currentMessage.time || 'Unknown'}\n` +
      `Subject: ${currentMessage.subject || 'No Subject'}\n\n` +
      `${currentMessage.body || 'No content'}`
  );
  const mailtoLink = `mailto:?subject=${subject}&body=${body}`;
  browser.tabs.create({ url: mailtoLink });
}

async function _downloadAsEML() {
  if (!currentMessage) return;

  try {
    const { activeInboxId, inboxes = [] } = (await browser.storage.local.get([
      'activeInboxId',
      'inboxes',
    ])) as {
      activeInboxId?: string;
      inboxes?: Account[];
    };

    const currentInbox = inboxes.find((inbox) => inbox.id === activeInboxId);
    if (!currentInbox) {
      logError('No current inbox found');
      return;
    }

    const emlContent = generateSingleEMLContent(currentInbox, currentMessage);
    const blob = new Blob([emlContent], { type: 'message/rfc822' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const subject = (currentMessage.subject || get(t)('activity.noSubject'))
      .replace(/[^a-zA-Z0-9\s]/g, '_')
      .substring(0, 50);
    a.download = `${subject}.eml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    logError(
      'Failed to download email as EML:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

const toolbarBtn = $derived(detailToolbarBtnClass(showToolbarLabels));
</script>

{#if currentMessage}
<div class="sticky top-0 bg-md-surface z-10">
  <!-- Subject header -->
  <div class="bg-md-surface-container-low rounded-xl mx-1 mt-2">
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="p-4" oncontextmenu={(e) => e.preventDefault()}>
      <div class="flex items-start justify-between gap-2">
        <div
          class="font-semibold text-base leading-snug cursor-pointer select-text min-w-0"
          role="button"
          tabindex="0"
          title={$t('common.copy')}
          ondblclick={copySubject}
          ontouchend={copySubject}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void copySubject(); } }}
        >{currentMessage.subject}</div>
        <button
          type="button"
          id="button-star-header"
          class="flex-shrink-0 w-8 h-8 -mt-0.5 flex items-center justify-center rounded-full transition-all active:scale-90 {isStarred ? 'text-md-tertiary hover:bg-md-secondary-container' : 'text-md-on-surface/35 hover:text-md-on-surface/70 hover:bg-md-surface-variant/60'}"
          aria-label={$t('inbox.emailActions.star')}
          title={$t('inbox.emailActions.star')}
          aria-pressed={isStarred}
          onclick={(e) => {
            e.stopPropagation();
            void toggleStar();
          }}
        >
          <Icon name="star" class="w-5 h-5 shrink-0" filled={isStarred} />
        </button>
      </div>
      <div class="text-xs text-md-on-surface/60 mt-2 flex items-center gap-1.5">
        <div
          class="cursor-pointer select-text flex items-center gap-1.5"
          role="button"
          tabindex="0"
          title={$t('common.copy')}
          ondblclick={copySender}
          ontouchend={copySender}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void copySender(); } }}
        >
          <FaviconImage
            email={currentMessage.from}
            size={20}
            class="w-5 h-5 rounded-full"
            fallbackLetter={(currentMessage.from[0] || '?').toUpperCase()}
          />
          {$t('activity.fromLabel')}: <span title={$t('inbox.senderStatsTooltip', { values: { here: senderHereCount, other: senderOtherCount } })}>{currentMessage.from}</span></div>
        <div class="w-px h-3 bg-md-outline-variant/30"></div>
        <div class="text-md-on-surface/60 cursor-help" title={formatFullDateTime(currentMessage.received_at)}>{currentMessage.time}</div>
      </div>
      <!-- Label pills + "Add a label" pill under time row -->
      <div class="flex flex-wrap items-center gap-1.5 mt-2.5">
        {#each currentEmailTags as tag (tag)}
          <span class="px-2.5 py-0.5 text-xs font-semibold rounded-full bg-md-primary-container text-md-on-primary-container border border-md-primary/20">
            {tag}
          </span>
        {/each}
        <button
          type="button"
          class="inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-full border border-dashed border-md-outline-variant text-md-on-surface/55 hover:border-md-primary hover:text-md-primary hover:bg-md-primary/10 transition-colors"
          title={$t('inbox.emailActions.addLabel')}
          aria-label={$t('inbox.emailActions.addLabel')}
          onclick={(e) => {
            e.stopPropagation();
            openTagDialog();
          }}
        >
          <Icon name="tag" class="w-3 h-3" />
          {$t('inbox.emailActions.addLabel')}
        </button>
      </div>
      {#if isThread}
        <div class="text-xs font-semibold text-md-primary/80 mt-2">
          {$t('inbox.messagesInThread', { values: { n: selectedThread.length } })}
        </div>
      {/if}
    </div>
  </div>
</div>
{/if}

{#if selectedThread.length > 0}
<div class="relative flex-1 flex flex-col min-h-0">
  <div class="flex-1 px-1 py-3 flex flex-col gap-3 overflow-y-auto pb-20">
    {#each selectedThread as msg, idx (msg.id)}
      <div class="bg-md-surface-container-low rounded-xl flex-shrink-0">
        {#if isThread}
          <div class="flex items-center justify-between px-3 pt-2">
            <div class="flex items-center gap-2">
              <FaviconImage
                email={msg.from}
                size={20}
                class="w-5 h-5 rounded-full"
                fallbackLetter={(msg.from[0] || '?').toUpperCase()}
              />
              <div class="text-xs font-semibold text-md-on-surface/60">
                {idx === 0 ? $t('inbox.latest') : `#${selectedThread.length - idx}`}
              </div>
            </div>
            <div class="text-xs text-md-on-surface/50">
              {msg.time}
            </div>
          </div>
        {/if}
        <div class="px-3 pb-3 pt-2">
          {#if isThread}
            <div class="text-xs text-md-on-surface/60 mb-1.5 flex items-center gap-1.5">
              <span class="font-semibold text-md-on-surface">{msg.from || msg.from_name || $t('activity.unknownSender')}</span>
            </div>
          {/if}
          {#if msg.local_only || (msg.messageExpiresAt && msg.messageExpiresAt <= Date.now())}
            {@const deletedWhen = (() => {
              const ts =
                msg.local_only_since ||
                msg.local_deleted_at ||
                msg.stored_at ||
                toMs(msg.received_at);
              return ts ? timeAgo(ts) : '';
            })()}
            <div class="mb-2">
              <span
                class="inline-flex px-1.5 py-0.5 text-xs rounded-full bg-md-tertiary-container text-md-on-tertiary-container cursor-help font-medium"
                title={deletedWhen
                  ? $t('inbox.deletedFromServerAgo', { values: { when: deletedWhen } })
                  : $t('inbox.localOnlyTooltip')}
              >{$t('inbox.localOnlyBadge')}</span>
            </div>
          {/if}
          {#if shouldShowLoadImagesChip(msg)}
            <button
              type="button"
              class="mb-2 inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-full border border-md-outline-variant text-md-on-surface/70 hover:border-md-primary hover:text-md-primary hover:bg-md-primary/10 transition-colors"
              onclick={(e) => {
                e.stopPropagation();
                loadImagesForMessage(msg.id);
              }}
            >
              <Icon name="globe" class="w-3 h-3" />
              {$t('inbox.loadImagesForMessage')}
            </button>
          {/if}
          {#if Array.isArray(msg.attachments) && msg.attachments.length > 0}
            <div class="mb-2 space-y-1" aria-label={$t('inbox.attachments')}>
              <div class="text-label-sm text-md-on-surface/50">{$t('inbox.attachments')}</div>
              <div class="flex flex-wrap gap-1.5">
                {#each msg.attachments as att (att.filename || att.partNumber || att.mimeType)}
                  {#if att.downloadUrl}
                    <a
                      href={att.downloadUrl}
                      download={att.filename || true}
                      target="_blank"
                      rel="noreferrer"
                      class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-md-secondary-container text-md-on-surface hover:bg-md-secondary-container/80 hover:text-md-primary transition-colors max-w-full"
                      title={att.filename || att.mimeType}
                    >
                      <Icon name="download" class="w-3 h-3 shrink-0" />
                      <span class="truncate">{att.filename || att.mimeType}</span>
                    </a>
                  {:else}
                    <span
                      class="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-md-surface-variant/70 text-md-on-surface/60 border border-md-outline-variant/40 max-w-full cursor-help"
                      title={$t('inbox.attachmentsNoDownload')}
                    >
                      <Icon name="downloadAlt" class="w-3 h-3 shrink-0" />
                      <span class="truncate">{att.filename || att.mimeType}</span>
                    </span>
                  {/if}
                {/each}
              </div>
            </div>
          {/if}
          <!-- Email body renders inside a Shadow DOM root for full style isolation;
               the sanitizer (sanitize-html) remains the security boundary. -->
          <EmailBody html={bodiesById[msg.id] || ''} />
          {#if isThread}
            {@const msgTags = emailTagsMap[msg.id] || []}
            {#if msgTags.length}
              <div class="flex flex-wrap gap-1.5 mt-2">
                {#each msgTags as tag (tag)}
                  <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-md-primary-container text-md-on-primary-container">{tag}</span>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/each}
    <!-- Dynamic End-of-Page Spacer: allows content to flow behind floating nav & detail toolbar -->
    <div
      class="w-full shrink-0 transition-[height] duration-200 ease-in-out pointer-events-none"
      style="height: calc(var(--bottom-safe-area, 0px) + {detailToolbarHeightPx}px + 12px);"
      aria-hidden="true"
    ></div>
  </div>

  <!-- Bottom strips: OTP + magic link (user-click only for links) -->
  <div class="shrink-0 flex flex-col gap-1 mx-1 mb-1">
    {#if currentMessage?.isOtp && currentMessage.otp}
      <div
        id="button-otp-strip-detail"
        class="flex items-center gap-2 px-3 bg-md-secondary-container rounded-xl h-[52px] shadow-sm"
      >
        <div class="flex items-center gap-2 min-w-0">
          <div class="flex-shrink-0 w-7 h-7 rounded-lg bg-md-surface flex items-center justify-center overflow-hidden">
            {#if currentMessage.from}
              <FaviconImage
                email={currentMessage.from}
                size={24}
                class="w-4 h-4"
                fallbackLetter={(currentMessage.from[0] || '?').toUpperCase()}
              />
            {/if}
          </div>
          <div class="min-w-0">
            <div class="text-xs font-bold text-md-on-surface leading-tight truncate max-w-[100px]">
              {currentMessage.from_name || currentMessage.from?.split('@')[0] || 'OTP'}
            </div>
            <div class="text-xs font-semibold text-md-on-surface/40 leading-tight">
              {$t('inbox.otpDetected')}
            </div>
          </div>
        </div>
        <div class="w-px h-7 bg-md-outline-variant/20 flex-shrink-0 mx-1"></div>
        <div class="flex-1 flex items-center justify-center min-w-0">
          <CopyButton
            text={currentMessage.otp}
            purgeDelayMs={30000}
            variant="primary"
            label={currentMessage.otp.replace(/\s/g, '')}
            tooltip={$t('inbox.copyOtpAria')}
            class="font-mono text-lg tracking-widest"
          />
        </div>
      </div>
    {/if}

    {#if bestMagicLink}
      <div
        id="button-magic-link-strip-detail"
        class="flex items-center gap-2 px-3 bg-md-tertiary-container rounded-xl min-h-[40px] py-1 shadow-sm"
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <div class="flex-shrink-0 w-7 h-7 rounded-lg bg-md-surface flex items-center justify-center">
            <Icon name="globe" class="w-4 h-4 text-md-tertiary" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-xs font-semibold text-md-on-surface/40 leading-tight">
              {$t('inbox.magicLinkDetected')}
            </div>
            <div class="text-label-sm font-semibold text-md-on-surface truncate" title={bestMagicLink.url}>
              {bestMagicLink.host || bestMagicLink.label || bestMagicLink.url}
            </div>
          </div>
        </div>
        <button
          type="button"
          class="px-2.5 py-1 rounded-full text-label-sm font-semibold bg-md-tertiary text-md-on-tertiary hover:opacity-90 flex-shrink-0 transition-opacity"
          aria-label={$t('inbox.openMagicLink')}
          title={$t('inbox.openMagicLinkHost', { values: { host: bestMagicLink.host || '' } })}
          onclick={(e) => {
            e.stopPropagation();
            void openMagicLink(bestMagicLink!.url);
          }}
        >
          {$t('inbox.openMagicLink')}
        </button>
        <button
          type="button"
          class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-md-surface/60 flex-shrink-0"
          aria-label={$t('inbox.copyMagicLink')}
          title={$t('inbox.copyMagicLink')}
          onclick={(e) => {
            e.stopPropagation();
            void copyMagicLink(bestMagicLink!.url);
          }}
        >
          <Icon name="copy" class="w-3.5 h-3.5 text-md-on-surface/70" />
        </button>
      </div>
    {/if}
  </div>

  <div
    class="absolute inset-x-0 z-30 flex items-center justify-center gap-1.5 px-2 pointer-events-none"
    style="bottom: calc(var(--bottom-safe-area, 0px) + 4px);"
  >
    <div bind:this={detailToolbarEl} use:actionBtnCascade class="{DETAIL_TOOLBAR_STRIP}">
      <button
        type="button"
        id="button-archive-detail"
        class="{toolbarBtn} {DETAIL_TOOLBAR_TONE_NEUTRAL}"
        aria-label={$t('inbox.emailActions.archive')}
        title={$t('inbox.emailActions.archive')}
        onclick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
      >
        <Icon name="archive" class="w-4 h-4 shrink-0" />
        {#if showToolbarLabels}<span>{$t('inbox.emailActions.archive')}</span>{/if}
      </button>
      <button
        type="button"
        id="button-delete-detail"
        class="{toolbarBtn} {DETAIL_TOOLBAR_TONE_DANGER}"
        aria-label={$t('inbox.emailActions.delete')}
        title={$t('inbox.emailActions.delete')}
        onclick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Icon name="trash" class="w-4 h-4 shrink-0" />
        {#if showToolbarLabels}<span>{$t('inbox.emailActions.delete')}</span>{/if}
      </button>
      <button
        type="button"
        id="button-download"
        class="{toolbarBtn} {DETAIL_TOOLBAR_TONE_NEUTRAL}"
        aria-label={$t('inbox.emailActions.download')}
        title={$t('inbox.emailActions.download')}
        onclick={(e) => {
          e.stopPropagation();
          downloadDialogOpen = true;
        }}
      >
        <Icon name="download" class="w-4 h-4 shrink-0" />
        {#if showToolbarLabels}<span>{$t('inbox.emailActions.downloadShort')}</span>{/if}
      </button>
      <button
        type="button"
        id="button-print-detail"
        class="{toolbarBtn} {DETAIL_TOOLBAR_TONE_ACCENT}"
        aria-label={$t('inbox.emailActions.print')}
        title={$t('inbox.emailActions.print')}
        onclick={(e) => {
          e.stopPropagation();
          printEmail();
        }}
      >
        <Icon name="print" class="w-4 h-4 shrink-0" />
        {#if showToolbarLabels}<span>{$t('inbox.emailActions.print')}</span>{/if}
      </button>
      <button
        type="button"
        id="button-forward"
        class="{toolbarBtn} {DETAIL_TOOLBAR_TONE_NEUTRAL}"
        aria-label={$t('inbox.emailActions.forward')}
        title={$t('inbox.emailActions.forward')}
        onclick={(e) => {
          e.stopPropagation();
          _forwardMessage();
        }}
      >
        <Icon name="envelope" class="w-4 h-4 shrink-0" />
        {#if showToolbarLabels}<span>{$t('inbox.emailActions.forwardShort')}</span>{/if}
      </button>
      <button
        type="button"
        id="button-mark-unread"
        class="{toolbarBtn} {DETAIL_TOOLBAR_TONE_NEUTRAL}"
        aria-label={$t('inbox.emailActions.markUnread')}
        title={$t('inbox.emailActions.markUnread')}
        onclick={(e) => {
          e.stopPropagation();
          onMarkUnread();
        }}
      >
        <Icon name="mail" class="w-4 h-4 shrink-0" />
        {#if showToolbarLabels}<span>{$t('inbox.emailActions.markUnreadShort')}</span>{/if}
      </button>
    </div>
  </div>

  <!-- Left Chevron Button -->
  <button
    class="absolute start-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full flex items-center justify-center bg-md-surface-container-high/70 backdrop-blur-sm border border-md-outline-variant/30 text-md-primary shadow-md transition-all opacity-40 hover:opacity-100 hover:scale-105 active:scale-95 disabled:opacity-15 disabled:cursor-not-allowed disabled:scale-100"
    onclick={(e) => { e.stopPropagation(); onPrev(); }}
    disabled={!hasPrev}
    title={hasPrev ? $t('inbox.emailActions.prevEmail') : $t('inbox.emailActions.noPrevEmail')}
    aria-label={$t('inbox.emailActions.prevEmail')}
  >
    <Icon name="chevronLeft" class="w-5 h-5 rtl-flip" />
  </button>

  <!-- End-side chevron (next) -->
  <button
    class="absolute end-2 top-1/2 -translate-y-1/2 z-20 w-8 h-8 rounded-full flex items-center justify-center bg-md-surface-container-high/70 backdrop-blur-sm border border-md-outline-variant/30 text-md-primary shadow-md transition-all opacity-40 hover:opacity-100 hover:scale-105 active:scale-95 disabled:opacity-15 disabled:cursor-not-allowed disabled:scale-100"
    onclick={(e) => { e.stopPropagation(); onNext(); }}
    disabled={!hasNext}
    title={hasNext ? $t('inbox.emailActions.nextEmail') : $t('inbox.emailActions.noNextEmail')}
    aria-label={$t('inbox.emailActions.nextEmail')}
  >
    <Icon name="chevronRight" class="w-5 h-5 rtl-flip" />
  </button>

  <!-- Label dialog: absolute so it stays inside this detail pane only -->
  {#if tagDialogOpen}
    <div class="absolute inset-0 z-[10000] flex items-center justify-center p-3" role="dialog" aria-modal="true">
      <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" role="button" tabindex="-1" onclick={closeTagDialog} onkeydown={(e) => e.key === 'Escape' && closeTagDialog()}></div>
      <div class="relative bg-md-surface rounded-2xl shadow-2xl p-4 w-72 z-10 border border-md-outline-variant/30 ring-1 ring-md-outline-variant/20">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-bold text-md-on-surface">{$t('inbox.emailActions.labelDialogTitle')}</h3>
          <button type="button" class="w-7 h-7 flex items-center justify-center rounded-full hover:bg-md-surface-variant transition-colors" onclick={(e) => { e.stopPropagation(); closeTagDialog(); }} aria-label={$t('common.close')}>
            <Icon name="x" class="w-4 h-4 text-md-on-surface/60" />
          </button>
        </div>
        <p class="text-xs text-md-on-surface/60 mb-2">{$t('inbox.labelDialogHint')}</p>
        <input
          type="text"
          class="w-full px-3 py-2 text-sm rounded-lg border border-md-outline-variant bg-md-surface-container-low focus:outline-none focus:border-md-primary focus:ring-1 focus:ring-md-primary"
          placeholder={$t('inbox.labelDialogPlaceholder')}
          bind:value={tagDialogInput}
          onkeydown={(e) => { if (e.key === 'Enter') saveEmailTags(); else if (e.key === 'Escape') closeTagDialog(); }}
        />
        {#if allEmailTags.length > 0}
          <div class="flex flex-wrap gap-1.5 mt-2">
            {#each allEmailTags as t}
              <button
                type="button"
                class="px-2 py-0.5 text-xs rounded-full bg-md-primary/10 text-md-primary hover:bg-md-primary/20 transition-colors"
                onclick={(e) => { e.stopPropagation(); tagDialogInput = tagDialogInput ? `${tagDialogInput}, ${t}` : t; }}
              >{t}</button>
            {/each}
          </div>
        {/if}
        <div class="flex gap-2 mt-3">
          <button type="button" class="flex-1 py-1.5 text-sm rounded-xl bg-md-secondary-container text-md-on-secondary-container hover:bg-md-secondary-container/80 transition-colors" onclick={(e) => { e.stopPropagation(); closeTagDialog(); }}>{$t('common.cancel')}</button>
          <button type="button" class="flex-1 py-1.5 text-sm rounded-xl bg-md-primary text-md-on-primary hover:bg-md-primary/90 transition-colors" onclick={(e) => { e.stopPropagation(); saveEmailTags(); }}>{$t('common.save')}</button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Download format dialog: EML / Markdown / PDF -->
  {#if downloadDialogOpen}
    <div
      class="absolute inset-0 z-[10000] flex items-center justify-center p-3"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      onkeydown={(e) => e.key === 'Escape' && (downloadDialogOpen = false)}
    >
      <div class="absolute inset-0 bg-black/30 backdrop-blur-sm" role="button" tabindex="-1" onclick={() => (downloadDialogOpen = false)} onkeydown={(e) => e.key === 'Escape' && (downloadDialogOpen = false)}></div>
      <div class="relative bg-md-surface rounded-2xl shadow-2xl p-4 w-72 z-10 border border-md-outline-variant/30 ring-1 ring-md-outline-variant/20">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-sm font-bold text-md-on-surface">{$t('inbox.emailActions.downloadDialogTitle')}</h3>
          <button type="button" class="w-7 h-7 flex items-center justify-center rounded-full hover:bg-md-surface-variant transition-colors" onclick={(e) => { e.stopPropagation(); downloadDialogOpen = false; }} aria-label={$t('common.close')}>
            <Icon name="x" class="w-4 h-4 text-md-on-surface/60" />
          </button>
        </div>
        <p class="text-xs text-md-on-surface/60 mb-2">{$t('inbox.emailActions.downloadDialogHint')}</p>
        <div class="space-y-2">
          <button
            type="button"
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-md-outline-variant/40 bg-md-surface-container-low hover:bg-md-primary/10 hover:border-md-primary transition-colors text-start"
            onclick={(e) => { e.stopPropagation(); downloadDialogOpen = false; void _downloadAsEML(); }}
          >
            <span class="w-9 h-9 rounded-lg bg-md-primary-container text-md-primary flex items-center justify-center shrink-0"><Icon name="mail" class="w-4 h-4" /></span>
            <span class="min-w-0">
              <span class="block text-sm font-semibold text-md-on-surface">{$t('inbox.emailActions.downloadEml')}</span>
              <span class="block text-xs text-md-on-surface/50 truncate">{$t('inbox.emailActions.downloadEmlHint')}</span>
            </span>
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-md-outline-variant/40 bg-md-surface-container-low hover:bg-md-primary/10 hover:border-md-primary transition-colors text-start"
            onclick={(e) => { e.stopPropagation(); downloadDialogOpen = false; downloadAsMarkdown(); }}
          >
            <span class="w-9 h-9 rounded-lg bg-md-secondary-container text-md-on-secondary-container flex items-center justify-center shrink-0"><Icon name="fileText" class="w-4 h-4" /></span>
            <span class="min-w-0">
              <span class="block text-sm font-semibold text-md-on-surface">{$t('inbox.emailActions.downloadMarkdown')}</span>
              <span class="block text-xs text-md-on-surface/50 truncate">{$t('inbox.emailActions.downloadMarkdownHint')}</span>
            </span>
          </button>
          <button
            type="button"
            class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-md-outline-variant/40 bg-md-surface-container-low hover:bg-md-primary/10 hover:border-md-primary transition-colors text-start"
            onclick={(e) => { e.stopPropagation(); downloadDialogOpen = false; printEmail(); }}
          >
            <span class="w-9 h-9 rounded-lg bg-md-tertiary-container text-md-on-tertiary-container flex items-center justify-center shrink-0"><Icon name="print" class="w-4 h-4" /></span>
            <span class="min-w-0">
              <span class="block text-sm font-semibold text-md-on-surface">{$t('inbox.emailActions.downloadPdf')}</span>
              <span class="block text-xs text-md-on-surface/50 truncate">{$t('inbox.emailActions.downloadPdfHint')}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
{:else}
  <EmptyState
    compact={true}
    iconName="mail"
    title={$t('inbox.noMessageSelected')}
    description={$t('inbox.splitEmptyHint')}
  />
{/if}

{#if selectionPopupPos && selectedText}
  <div
    class="fixed z-[10000] -translate-x-1/2 flex items-center gap-1 p-1 rounded-full bg-md-surface-container-high border border-md-outline-variant/40 shadow-xl backdrop-blur-md"
    style="left: {selectionPopupPos.x}px; top: {selectionPopupPos.y}px;"
  >
    <button
      type="button"
      class="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full bg-md-primary text-md-on-primary hover:brightness-110 active:scale-95 transition-all"
      onclick={async (e) => {
        e.stopPropagation();
        await copyToClipboardAndSchedulePurge(selectedText);
        showToast(get(t)('inbox.copiedToClipboard') as string);
        window.getSelection()?.removeAllRanges();
      }}
    >
      <Icon name="copy" class="w-3.5 h-3.5" />
      <span>{$t('common.copy')}</span>
    </button>
    <button
      type="button"
      class="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-full bg-md-secondary-container text-md-on-secondary-container hover:brightness-110 active:scale-95 transition-all"
      onclick={(e) => {
        e.stopPropagation();
        onSearchText(selectedText);
        window.getSelection()?.removeAllRanges();
      }}
    >
      <Icon name="search" class="w-3.5 h-3.5" />
      <span>{$t('inbox.searchMailbox')}</span>
    </button>
  </div>
{/if}
