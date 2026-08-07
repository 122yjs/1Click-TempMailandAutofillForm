<script lang="ts">
import { onDestroy, untrack } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import AccountSelectorOverlay from '@/ui/blocks/account/AccountSelectorDrawer.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import Badge from '@/ui/components/primitives/Badge.svelte';
import { copyToClipboardAndSchedulePurge } from '@/utils/clipboard.js';
import { loadProviderConfig } from '@/utils/email-service.js';
import { logError } from '@/utils/logger.js';
import { domainIndexKey } from '@/utils/storage-keys.js';
import { useCurrentTime } from '@/utils/time-store.js';
import type { Account } from '@/utils/types.js';

let {
  selectedEmail = '',
  accounts = [],
  allAccounts = [],
  displayedEmail = $bindable(''),
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
  dropdownOpen = false,
  onDropdownOpenChange = () => {},
  showToast = (_message: string, _type?: string, _undo?: (() => void | Promise<void>) | null) => {},
  selectedProviderInstance = null,
  defaultDomain = '',
  /** Notifications control */
  notificationsEnabled = true,
  onToggleNotifications = () => {},
  /** Swipe left/right on pill for next/prev when gestures enabled */
  gesturesEnabled = true,
} = $props<{
  selectedEmail?: string;
  accounts?: Account[];
  allAccounts?: Account[];
  displayedEmail?: string;
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
  dropdownOpen?: boolean;
  onDropdownOpenChange?: (open: boolean) => void;
  showToast?: (message: string, type?: string, undo?: (() => void | Promise<void>) | null) => void;
  selectedProviderInstance?: string | null;
  defaultDomain?: string;
  notificationsEnabled?: boolean;
  onToggleNotifications?: () => void;
  gesturesEnabled?: boolean;
}>();

let currentDomainIndex = $state(0);
let notifSnoozeOpen = $state(false);
let snoozeUntil = $state(0);
let snoozeCustomMin = $state(0);
let snoozeCustomHrs = $state(0);
let snoozeCustomDays = $state(0);
let pillSwipeStartX = 0;
let pillSwiping = false;

// Derived values for email display
let emailParts = $derived.by(() => displayedEmail.split('@'));
let username = $derived.by(() => emailParts[0] || '');
let domain = $derived.by(() => emailParts[1] || '');
let multiDomainList = $derived.by((): string[] => {
  const account = allAccounts.find((a: Account) => a.address === selectedEmail);
  if (!account) return [];
  try {
    const cfg = loadProviderConfig(account.provider);
    if (!cfg.multiDomain?.enabled) return [];
    return (cfg.multiDomain.domains || []).filter(Boolean);
  } catch {
    /* ignore */
    return [];
  }
});
let isMultiDomain = $derived(multiDomainList.length > 1);

// Storage key for domain index per inbox
function getDomainStorageKey(email: string, providerId: string): `domainIndex_${string}_${string}` {
  return domainIndexKey(providerId, email.split('@')[0]);
}

// Load persisted domain index when selected email changes and update displayedEmail atomically.
$effect(() => {
  if (!selectedEmail) {
    untrack(() => {
      if (displayedEmail !== '') displayedEmail = '';
    });
    return;
  }
  const account = allAccounts.find((a: Account) => a.address === selectedEmail);
  if (!account) {
    currentDomainIndex = 0;
    untrack(() => {
      if (displayedEmail !== selectedEmail) displayedEmail = selectedEmail;
    });
    return;
  }
  const providerConfig = loadProviderConfig(account.provider);
  if (!providerConfig.multiDomain?.enabled) {
    currentDomainIndex = 0;
    untrack(() => {
      if (displayedEmail !== selectedEmail) displayedEmail = selectedEmail;
    });
    return;
  }
  const key = getDomainStorageKey(selectedEmail, account.provider);
  let isCurrent = true;
  browser.storage.local.get([key]).then((result: Record<string, unknown>) => {
    if (!isCurrent) return;
    const storedIndex = result[key] as number | undefined;
    let resolvedIndex = 0;
    if (storedIndex !== undefined) {
      resolvedIndex = storedIndex;
    } else if (defaultDomain) {
      const domains = providerConfig.multiDomain?.domains || [];
      const defaultIndex = domains.indexOf(defaultDomain);
      resolvedIndex = defaultIndex >= 0 ? defaultIndex : 0;
    }
    currentDomainIndex = resolvedIndex;
    const uname = selectedEmail.split('@')[0];
    const domains = providerConfig.multiDomain?.domains || [];
    const next = `${uname}@${domains[resolvedIndex] || domains[0] || ''}`;
    untrack(() => {
      if (displayedEmail !== next) displayedEmail = next;
    });
  });
  return () => {
    isCurrent = false;
  };
});

// Use shared time store
const timeStore = useCurrentTime();
let currentTime = $state(timeStore.currentTime);

$effect(() => {
  const unsubscribe = timeStore.subscribe(() => {
    currentTime = timeStore.currentTime;
  });
  return unsubscribe;
});

// Reactive derived value for current account
let currentAccount = $derived.by(() => {
  if (!selectedEmail) return null;
  return allAccounts.find((a: Account) => a.address === selectedEmail) || null;
});

// Live accounts count for +N badge
let liveAccountsCount = $derived.by(() => {
  return allAccounts.filter((a: Account) => {
    const expiresAt = a.expiresAt || currentTime;
    const isExpired = currentTime >= expiresAt;
    return a.status === 'active' && !isExpired;
  }).length;
});

// Accounts of same status as current account for prev/next navigation
let currentStatusAccounts = $derived.by(() => {
  if (!selectedEmail) return [];
  const current = allAccounts.find((a: Account) => a.address === selectedEmail);
  if (!current) return [];
  return allAccounts.filter((a: Account) => a.status === current.status);
});

let currentIndexInStatus = $derived.by(() => {
  if (!selectedEmail) return -1;
  return currentStatusAccounts.findIndex((a: Account) => a.address === selectedEmail);
});

function goToPrev() {
  if (currentIndexInStatus > 0) {
    onSelectAccount(currentStatusAccounts[currentIndexInStatus - 1].address);
  }
}

function goToNext() {
  if (currentIndexInStatus < currentStatusAccounts.length - 1) {
    onSelectAccount(currentStatusAccounts[currentIndexInStatus + 1].address);
  }
}

// Calculate remaining time for current account
const remainingMinutes = $derived.by(() => {
  if (!currentAccount?.expiresAt) return 0;
  const remainingMs = currentAccount.expiresAt - currentTime;
  return Math.max(0, Math.ceil(remainingMs / (1000 * 60)));
});

// Calculate how long ago the account expired (in minutes)
const expiredAgoMinutes = $derived.by(() => {
  if (!currentAccount?.expiresAt) return 0;
  const elapsedMs = currentTime - currentAccount.expiresAt;
  return Math.max(0, Math.floor(elapsedMs / (1000 * 60)));
});

// Format expired-ago duration
function formatTimeAgo(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}hr ${mins}m ago` : `${hours}hr ago`;
}

// Calculate progress percentage for expiry (0-100).
const progressPercentage = $derived.by(() => {
  if (currentAccount?.autoExtend) return 100;
  if (!currentAccount?.expiresAt) return 100;
  if (!currentAccount.createdAt) {
    const maxExpiryTime = 60;
    return Math.min(Math.max((remainingMinutes / maxExpiryTime) * 100, 0), 100);
  }
  const totalDuration = currentAccount.expiresAt - currentAccount.createdAt;
  const remaining = currentAccount.expiresAt - currentTime;
  if (totalDuration <= 0) return 0;
  return Math.min(Math.max((remaining / totalDuration) * 100, 0), 100);
});

/**
 * Computes the optical vertical offset (in pixels) for the status label element.
 * Measures the rendered text layout bounds via DOM Range client rects (with Canvas TextMetrics
 * actualBoundingBoxAscent/Descent as a fallback) and computes the vertical midpoint of the text
 * bounding box ((minTop + maxBottom) / 2) to optically center the status label over the horizontal
 * progress line, adapting across languages, fonts, diacritics, and script metrics (e.g. Thai, Arabic, CJK, Latin).
 */
function computeOpticalCenterOffset(notchEl: HTMLElement): number {
  if (!notchEl || typeof window === 'undefined') return 0;

  const notchRect = notchEl.getBoundingClientRect();
  if (notchRect.height === 0) return 0;

  const elementCenterY = notchRect.top + notchRect.height / 2;

  // 1. DOM Range Layout Box Measurement
  let minTop = Infinity;
  let maxBottom = -Infinity;
  let foundRange = false;

  try {
    const range = document.createRange();
    const walker = document.createTreeWalker(notchEl, NodeFilter.SHOW_TEXT, null);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent?.trim()) {
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i];
          if (r.height > 0) {
            if (r.top < minTop) minTop = r.top;
            if (r.bottom > maxBottom) maxBottom = r.bottom;
            foundRange = true;
          }
        }
      }
      node = walker.nextNode();
    }
  } catch {
    /* ignore */
  }

  const visualTextCenterY =
    foundRange && Number.isFinite(minTop) && Number.isFinite(maxBottom)
      ? (minTop + maxBottom) / 2
      : elementCenterY;
  const domOpticalOffset = elementCenterY - visualTextCenterY;

  // 2. Canvas Rasterized Ink Bounds Measurement
  let ascent = 0;
  let descent = 0;
  let canvasGlyphCenterY = elementCenterY;
  let canvasOpticalOffset = 0;

  try {
    const text = notchEl.textContent?.trim() || '';
    if (text) {
      const computedStyle = window.getComputedStyle(notchEl);
      const fontSize = parseFloat(computedStyle.fontSize) || 12;
      const fontStyle = computedStyle.fontStyle || 'normal';
      const fontWeight = computedStyle.fontWeight || '400';
      const fontFamily = computedStyle.fontFamily || 'sans-serif';
      const fontCss = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.font = fontCss;
        const metrics = ctx.measureText(text);
        ascent = metrics.actualBoundingBoxAscent ?? 0;
        descent = metrics.actualBoundingBoxDescent ?? 0;
        if (ascent > 0 || descent > 0) {
          // Calculate optical shift from baseline center:
          // ascent is height above baseline, descent is depth below baseline.
          // Midpoint of ink relative to line box center (fontSize / 2):
          canvasOpticalOffset = -((ascent - descent) / 2 - fontSize * 0.12);
          canvasGlyphCenterY = elementCenterY - canvasOpticalOffset;
        }
      }
    }
  } catch {
    /* ignore */
  }

  // Primary: Canvas rasterized glyph ink bounds offset for true optical centering.
  // Fallback: DOM Range line-box offset if canvas context is unavailable.
  return canvasOpticalOffset !== 0 ? canvasOpticalOffset : domOpticalOffset;
}

// SVG progress border - computed reactively
let containerEl = $state<HTMLElement | null>(null);

function layout() {
  if (!containerEl) return;
  const w = containerEl.clientWidth;
  const h = containerEl.clientHeight;
  if (w < 4 || h < 4) return;
  const r = h / 2;
  const inset = 1;
  const rectW = Math.max(0, w - inset * 2);
  const rectH = Math.max(0, h - inset * 2);
  const radius = Math.max(0, r - inset);

  const track = containerEl.querySelector('svg rect.track') as SVGRectElement | null;
  const progressRect = containerEl.querySelector('svg rect.progress') as SVGRectElement | null;
  const notch = containerEl.querySelector('.notch') as HTMLElement | null;

  if (track && progressRect) {
    for (const rect of [track, progressRect]) {
      rect.setAttribute('x', String(inset));
      rect.setAttribute('y', String(inset));
      rect.setAttribute('width', String(rectW));
      rect.setAttribute('height', String(rectH));
      rect.setAttribute('rx', String(radius));
      rect.setAttribute('ry', String(radius));
    }
  }

  const isRtl =
    typeof document !== 'undefined' &&
    (document.documentElement.dir === 'rtl' ||
      getComputedStyle(document.documentElement).direction === 'rtl');

  const notchWidthPx = notch ? notch.getBoundingClientRect().width : 0;
  const offsetAfterRadius = 4; // 4px spacing after top edge rounded border ends — label sits close to the rounded radius
  const rawNotchCenterPx = isRtl
    ? w - (inset + radius + offsetAfterRadius + notchWidthPx / 2)
    : inset + radius + offsetAfterRadius + notchWidthPx / 2;
  const minCenter = inset + radius + offsetAfterRadius + notchWidthPx / 2;
  const maxCenter = w - (inset + radius + offsetAfterRadius + notchWidthPx / 2);
  const notchCenterPx = Math.max(minCenter, Math.min(maxCenter, rawNotchCenterPx));

  if (!progressRect) {
    if (notch) {
      const opticalOffset = computeOpticalCenterOffset(notch);
      notch.style.left = `${notchCenterPx}px`;
      notch.style.right = 'auto';
      notch.style.top = '0px';
      notch.style.transform = `translate(-50%, calc(-50% + ${opticalOffset.toFixed(2)}px))`;
    }
    return;
  }

  const totalLengthPx = progressRect.getTotalLength();
  if (!totalLengthPx) return;

  const centerPoint = progressRect.getPointAtLength(
    Math.min(totalLengthPx, Math.max(0, isRtl ? totalLengthPx - notchCenterPx : notchCenterPx))
  );
  if (notch) {
    const opticalOffset = computeOpticalCenterOffset(notch);
    notch.style.left = `${centerPoint.x}px`;
    notch.style.right = 'auto';
    notch.style.top = `${centerPoint.y}px`;
    notch.style.transform = `translate(-50%, calc(-50% + ${opticalOffset.toFixed(2)}px))`;
  }

  const notchLengthPercent = notchWidthPx > 0 ? (notchWidthPx / totalLengthPx) * 100 : 0;

  const notchCenterPercent = (notchCenterPx / totalLengthPx) * 100;
  const notchEnd = notchCenterPercent + 0.5 * notchLengthPercent;
  const availablePercent = Math.max(0, 100 - notchLengthPercent);

  if (track) {
    track.setAttribute('stroke-dasharray', `${availablePercent} ${notchLengthPercent}`);
    track.setAttribute('stroke-dashoffset', String(-notchEnd));
  }

  if (progressRect) {
    const remainingFraction = Math.max(0, Math.min(1, progressPercentage / 100));
    const drawLength = remainingFraction * availablePercent;
    const gapLength = availablePercent - drawLength;
    progressRect.setAttribute('stroke-dasharray', `${drawLength} ${100 - drawLength}`);
    progressRect.setAttribute('stroke-dashoffset', String(-notchEnd - gapLength));
  }
}

let resizeObserver: ResizeObserver | null = null;
$effect(() => {
  if (containerEl) {
    resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(layout);
    });
    resizeObserver.observe(containerEl);
  }
  return () => {
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  };
});

$effect(() => {
  void progressPercentage;
  void currentAccount;
  void remainingMinutes;
  void expiredAgoMinutes;
  void $t;
  if (containerEl) {
    requestAnimationFrame(() => {
      layout();
      requestAnimationFrame(layout);
    });
  }
});

$effect(() => {
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (containerEl) {
        requestAnimationFrame(layout);
      }
    });
  }
});

function formatTimeRemaining(minutes: number): string {
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

// Copy email address to clipboard
async function copyEmailToClipboard() {
  try {
    await copyToClipboardAndSchedulePurge(selectedEmail);
  } catch (err) {
    logError('Failed to copy email', err);
  }
}

let clickTimeout: ReturnType<typeof setTimeout> | null = null;
onDestroy(() => {
  if (clickTimeout) clearTimeout(clickTimeout);
});
let triggerElement: HTMLElement | null = null;

function handleSingleClick() {
  if (clickTimeout) {
    clearTimeout(clickTimeout);
    clickTimeout = null;
  }
  clickTimeout = setTimeout(() => {
    triggerElement = document.activeElement as HTMLElement;
    onDropdownOpenChange(!dropdownOpen);
    clickTimeout = null;
  }, 250);
}

function handleDoubleClick() {
  if (clickTimeout) {
    clearTimeout(clickTimeout);
    clickTimeout = null;
  }
  copyEmailToClipboard();
  showToast($t('toasts.emailAddressCopied'));
}

function openAccountMenu(e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  triggerElement = e.currentTarget as HTMLElement;
  onDropdownOpenChange(true);
}

function onPillPointerDown(e: PointerEvent) {
  if (!gesturesEnabled) return;
  if ((e.target as HTMLElement)?.closest?.('button')) return;
  pillSwiping = true;
  pillSwipeStartX = e.clientX;
}

function onPillPointerUp(e: PointerEvent) {
  if (!gesturesEnabled || !pillSwiping) return;
  pillSwiping = false;
  const dx = e.clientX - pillSwipeStartX;
  if (Math.abs(dx) < 48) return;
  const isRtl =
    typeof document !== 'undefined' &&
    (document.documentElement.dir === 'rtl' ||
      getComputedStyle(document.documentElement).direction === 'rtl');
  const goNext = isRtl ? dx > 0 : dx < 0;
  if (goNext) goToNext();
  else goToPrev();
}

async function loadSnooze() {
  const addr = selectedEmail || currentAccount?.address || '';
  if (!addr) {
    snoozeUntil = 0;
    return;
  }
  try {
    const res = (await browser.storage.local.get(['notificationSnoozeByAddress'])) as {
      notificationSnoozeByAddress?: Record<string, number>;
    };
    const map = res.notificationSnoozeByAddress || {};
    const until = map[addr] || map[addr.toLowerCase()] || 0;
    snoozeUntil = until > Date.now() ? until : 0;
  } catch {
    /* ignore */
    snoozeUntil = 0;
  }
}

async function applyBellSnooze(ms: number) {
  const addr = selectedEmail || currentAccount?.address || '';
  if (!addr) return;
  const until = Date.now() + ms;
  try {
    const res = (await browser.storage.local.get(['notificationSnoozeByAddress'])) as {
      notificationSnoozeByAddress?: Record<string, number>;
    };
    const map = { ...(res.notificationSnoozeByAddress || {}) };
    map[addr] = until;
    await browser.storage.local.set({ notificationSnoozeByAddress: map });
    snoozeUntil = until;
  } catch {
    /* ignore */
  }
  notifSnoozeOpen = false;
}

async function applyCustomSnooze() {
  const min = Math.max(0, Number(snoozeCustomMin) || 0);
  const hrs = Math.max(0, Number(snoozeCustomHrs) || 0);
  const days = Math.max(0, Number(snoozeCustomDays) || 0);
  const ms = ((days * 24 + hrs) * 60 + min) * 60 * 1000;
  if (ms <= 0) return;
  await applyBellSnooze(ms);
}

async function clearBellSnooze() {
  const addr = selectedEmail || currentAccount?.address || '';
  if (!addr) return;
  try {
    const res = (await browser.storage.local.get(['notificationSnoozeByAddress'])) as {
      notificationSnoozeByAddress?: Record<string, number>;
    };
    const map = { ...(res.notificationSnoozeByAddress || {}) };
    delete map[addr];
    delete map[addr.toLowerCase()];
    await browser.storage.local.set({ notificationSnoozeByAddress: map });
    snoozeUntil = 0;
  } catch {
    /* ignore */
  }
  notifSnoozeOpen = false;
}

$effect(() => {
  void selectedEmail;
  void loadSnooze();
});

// Cycle through provider domains and persist selection
async function cycleDomain() {
  if (!currentAccount) return;
  const providerConfig = loadProviderConfig(currentAccount.provider);
  if (!providerConfig.multiDomain?.enabled) return;
  const domains = providerConfig.multiDomain.domains;
  const prevIndex = currentDomainIndex;
  const nextIndex = (currentDomainIndex + 1) % domains.length;
  currentDomainIndex = nextIndex;
  const key = getDomainStorageKey(selectedEmail, currentAccount.provider);
  await browser.storage.local.set({ [key]: nextIndex });
  const uname = selectedEmail.split('@')[0];
  const prevAddr = displayedEmail || selectedEmail;
  const nextAddr = `${uname}@${domains[nextIndex]}`;
  displayedEmail = nextAddr;
  showToast(
    $t('toasts.domainChanged', { values: { from: prevAddr, to: nextAddr } }),
    'success',
    async () => {
      currentDomainIndex = prevIndex;
      await browser.storage.local.set({ [key]: prevIndex });
      displayedEmail = prevAddr;
    }
  );
}
</script>

<!-- Custom dropdown trigger pill -->
<div class="relative mt-0 flex items-center gap-1" data-tour="account-selector">
  <div
    class="account-selector-outer relative flex-1 min-w-0 bg-md-surface-container-low rounded-full touch-pan-y"
    role="group"
    aria-label={$t('account.selectEmail')}
    bind:this={containerEl}
    onpointerdown={onPillPointerDown}
    onpointerup={onPillPointerUp}
    onpointercancel={() => (pillSwiping = false)}
  >
    {#if currentAccount && (currentAccount.status === 'active' || currentAccount.autoExtend)}
      <svg class="absolute inset-0 w-full h-full pointer-events-none" style="overflow:visible; z-index:0;">
        <rect class="track" fill="none" stroke="var(--md-error)" stroke-opacity="0.85" stroke-width="2.5" pathLength="100"></rect>
        <rect
          class="progress"
          fill="none"
          stroke="var(--md-primary)"
          stroke-linecap="round"
          stroke-width="2.5"
          pathLength="100"
        ></rect>
      </svg>
    {/if}
    <div
      style="position:relative; z-index:1;"
      class="flex items-center gap-0 px-1 py-1.5 rounded-full border {currentAccount?.status === 'active' ? 'border-transparent' : (currentAccount?.status === 'expired' || currentAccount?.status === 'deleted') ? 'border-md-error/30' : 'border-md-outline-variant'} {(currentAccount?.status === 'expired' || currentAccount?.status === 'deleted') ? 'bg-md-error/10' : 'bg-transparent'} flex-1 min-w-0 overflow-hidden"
      onclick={handleSingleClick}
      ondblclick={handleDoubleClick}
      onkeydown={(e) => { if (e.key === 'Enter') handleSingleClick(); }}
      role="button"
      tabindex="0"
      aria-label={$t('common.copy')}
    >
      <!-- Prev button -->
      <button
        id="button-prev-address"
        class="shrink-0 w-5 h-5 flex items-center justify-center rounded text-md-primary hover:text-md-primary/80 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
        onclick={(e) => { e.stopPropagation(); goToPrev(); }}
        disabled={currentIndexInStatus <= 0}
        aria-label={$t('account.prevAddress')}
        title={currentIndexInStatus > 0 ? currentStatusAccounts[currentIndexInStatus - 1].address : undefined}
      >
        <Icon name="chevronLeft" class="w-3.5 h-3.5 rtl-flip" />
      </button>

      <!-- Email display -->
      <div
        class="flex items-center min-w-0 flex-1 gap-0.5 cursor-pointer overflow-hidden select-none"
        style="direction: ltr; unicode-bidi: isolate; user-select: none;"
        onclick={handleSingleClick}
        ondblclick={handleDoubleClick}
        onkeydown={(e) => { if (e.key === 'Enter') handleSingleClick(); }}
        role="button"
        tabindex="0"
        id="button-select-email"
        aria-label={$t('account.selectEmail')}
        title={username && domain
          ? `${String(username).trim()}@${String(domain).trim()}\n${$t('account.tooltipClickOpen')}\n${$t('account.tooltipDoubleTapCopy')}`
          : (selectedEmail || '').replace(/\s+@/g, '@').replace(/@\s+/g, '@')}
      >
        <span class="font-medium text-sm text-md-on-surface truncate min-w-0 select-none pointer-events-none" style="user-select:none;-webkit-user-select:none;">{username}</span>
        {#if isMultiDomain}
          <span
            class="inline-flex items-center gap-1 pe-1 py-0.5 text-xs font-medium rounded-md bg-md-secondary-container text-md-on-secondary-container hover:bg-md-secondary-container/80 transition-colors cursor-pointer overflow-hidden min-w-[calc(5ch+1.5rem)] select-none"
            style="direction: ltr;"
            title={(multiDomainList || []).map((d) => `@${d}`).join('\n') || $t('account.cycleDomain')}
            onclick={(e) => { e.stopPropagation(); cycleDomain(); }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); cycleDomain(); } }}
            role="button"
            tabindex="0"
            aria-label={$t('account.cycleDomain')}
          >
            <span class="truncate flex-1 min-w-0 select-none">@{domain}</span>
            <Icon name="globe" class="w-3 h-3 shrink-0" />
          </span>
        {:else}
          <span class="font-medium text-sm text-md-on-surface shrink-0 select-none pointer-events-none">@{domain}</span>
        {/if}
      </div>

      <!-- +N badge -->
      {#if liveAccountsCount > 1}
        <Badge variant="primary" size="sm" class="shrink-0 font-semibold" label={$t('common.plusN', { values: { n: liveAccountsCount - 1 } })} />
      {/if}

      <!-- Next button -->
      <button
        id="button-next-address"
        class="shrink-0 w-5 h-5 flex items-center justify-center rounded text-md-primary hover:text-md-primary/80 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
        onclick={(e) => { e.stopPropagation(); goToNext(); }}
        disabled={currentIndexInStatus >= currentStatusAccounts.length - 1}
        aria-label={$t('account.nextAddress')}
        title={currentIndexInStatus < currentStatusAccounts.length - 1 ? currentStatusAccounts[currentIndexInStatus + 1].address : undefined}
      >
        <Icon name="chevronRight" class="w-3.5 h-3.5 rtl-flip" />
      </button>

      <!-- Separator -->
      <span class="w-px h-4 bg-md-secondary-container/20 shrink-0"></span>

      <!-- Dropdown chevron -->
      <button
        id="button-open-dropdown"
        class="shrink-0 p-0.5 text-md-primary hover:text-md-primary/80 transition-colors"
        onclick={(e) => { e.stopPropagation(); onDropdownOpenChange(!dropdownOpen); }}
        oncontextmenu={openAccountMenu}
        aria-label={$t('account.openAccountList')}
      >
        <Icon name="chevronDown" class="w-4 h-4" />
      </button>
    </div>

    {#if currentAccount}
      <div
        class="notch absolute z-[2] pointer-events-none whitespace-nowrap bg-transparent px-0 text-xs font-medium tracking-wide leading-none inline-flex items-center justify-center text-center select-none {currentAccount?.status === 'active' ? 'text-md-success' : (currentAccount?.status === 'expired' || currentAccount?.status === 'deleted') ? 'text-md-error' : 'text-md-on-surface/50'}"
        style="top: 0; transform: translate(-50%, -50%);"
      >
        {#if currentAccount.status === 'active'}
          <span class="inline-block w-1.5 h-1.5 rounded-full bg-md-success me-1 shadow-[0_0_0_3px_rgba(74,222,128,0.15)]"></span>
          {#if currentAccount.expiresAt}
            {@const pcfg = (() => { try { return loadProviderConfig(currentAccount.provider); } catch { return null; } })()}
            {@const renewable = !!(pcfg?.expiry?.renewable || pcfg?.capabilities?.supportsRenew)}
            {$t('account.statusLive')} · {#if renewable && currentAccount.autoExtend}
              {$t('account.autoRenewIn', { values: { time: formatTimeRemaining(remainingMinutes) } })}
            {:else}
              {$t('account.expiresIn', { values: { time: formatTimeRemaining(remainingMinutes) } })}
            {/if}
          {:else}
            {$t('account.statusLive')}
          {/if}
        {:else if currentAccount.status === 'expired'}
          {$t('account.statusExpired')} {formatTimeAgo(expiredAgoMinutes)}
        {:else if currentAccount.status === 'deleted'}
          {$t('account.statusDeleted')}
        {:else}
          {$t('account.statusArchived')}
        {/if}
      </div>
    {/if}
  </div>

  <!-- Notifications bell -->
  <div class="relative shrink-0">
    <button
      id="button-account-notifications"
      class="relative w-8 h-8 flex items-center justify-center rounded-xl border-0 shrink-0 transition-colors {notificationsEnabled ? 'bg-md-warning/20 hover:bg-md-warning/30' : 'bg-md-surface-variant/40 hover:bg-md-surface-variant'} {snoozeUntil > Date.now() ? 'ring-1 ring-md-primary/40' : ''}"
      aria-label={notificationsEnabled ? $t('inbox.disableNotifications') : $t('inbox.enableNotifications')}
      title={notificationsEnabled ? $t('inbox.disableNotifications') : $t('inbox.enableNotifications')}
      oncontextmenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        notifSnoozeOpen = !notifSnoozeOpen;
        void loadSnooze();
      }}
      onclick={(e) => {
        e.stopPropagation();
        onToggleNotifications();
      }}
    >
      <Icon name={notificationsEnabled ? 'bell' : 'bellOff'} class="w-4 h-4 {notificationsEnabled ? 'text-md-warning' : 'text-md-on-surface/50'}" />
    </button>
    {#if notifSnoozeOpen}
      <button type="button" class="fixed inset-0 z-40 cursor-default bg-transparent" aria-label={$t('common.close')} onclick={() => (notifSnoozeOpen = false)}></button>
      <div class="absolute top-full end-0 mt-1 z-50 min-w-[220px] max-w-[min(280px,90vw)] rounded-xl border border-md-outline-variant bg-md-surface-container shadow-xl overflow-hidden py-1" role="menu">
        <div class="px-3 py-1.5 text-xs font-semibold text-md-on-surface/50">{$t('inbox.snoozeNotifications')}</div>
        <p class="px-3 pb-1 text-xs text-md-on-surface/40 truncate max-w-full" style="direction:ltr">{selectedEmail}</p>
        <button type="button" class="w-full text-start px-3 min-h-12 text-sm hover:bg-md-surface-variant" role="menuitem" onclick={() => void applyBellSnooze(5 * 60 * 1000)}>{$t('inbox.snooze5m')}</button>
        <button type="button" class="w-full text-start px-3 min-h-12 text-sm hover:bg-md-surface-variant" role="menuitem" onclick={() => void applyBellSnooze(30 * 60 * 1000)}>{$t('inbox.snooze30m')}</button>
        <button type="button" class="w-full text-start px-3 min-h-12 text-sm hover:bg-md-surface-variant" role="menuitem" onclick={() => void applyBellSnooze(24 * 60 * 60 * 1000)}>{$t('inbox.snooze1d')}</button>
        <div class="border-t border-md-outline-variant/40 my-1"></div>
        <div class="px-3 py-1 text-xs font-semibold text-md-on-surface/45">{$t('inbox.snoozeCustom')}</div>
        <div class="px-3 pb-2 flex flex-wrap items-center gap-1.5">
          <input type="number" min="0" max="999" bind:value={snoozeCustomMin} class="w-12 px-1.5 py-1 text-label-sm rounded-lg bg-md-surface-container-low border border-md-outline-variant/40 tabular-nums" aria-label={$t('inbox.snoozeCustomMin')} />
          <span class="text-xs text-md-on-surface/50">{$t('inbox.snoozeUnitMin')}</span>
          <input type="number" min="0" max="999" bind:value={snoozeCustomHrs} class="w-12 px-1.5 py-1 text-label-sm rounded-lg bg-md-surface-container-low border border-md-outline-variant/40 tabular-nums" aria-label={$t('inbox.snoozeCustomHrs')} />
          <span class="text-xs text-md-on-surface/50">{$t('inbox.snoozeUnitHrs')}</span>
          <input type="number" min="0" max="365" bind:value={snoozeCustomDays} class="w-12 px-1.5 py-1 text-label-sm rounded-lg bg-md-surface-container-low border border-md-outline-variant/40 tabular-nums" aria-label={$t('inbox.snoozeCustomDays')} />
          <span class="text-xs text-md-on-surface/50">{$t('inbox.snoozeUnitDays')}</span>
          <button type="button" class="ms-auto px-2 py-1 rounded-lg text-label-sm font-semibold bg-md-primary text-md-on-primary" role="menuitem" onclick={() => void applyCustomSnooze()}>{$t('common.apply')}</button>
        </div>
        {#if snoozeUntil > Date.now()}
          <div class="border-t border-md-outline-variant/40 my-1"></div>
          <button type="button" class="w-full text-start px-3 min-h-12 text-sm text-md-primary hover:bg-md-surface-variant" role="menuitem" onclick={() => void clearBellSnooze()}>{$t('inbox.clearSnooze')}</button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<!-- Extracted Overlay Dialog Component -->
<AccountSelectorOverlay
  open={dropdownOpen}
  onClose={() => onDropdownOpenChange(false)}
  {selectedEmail}
  {accounts}
  {allAccounts}
  {onSelectAccount}
  {onEditAccount}
  {onCreateInbox}
  {onNavigateToManage}
  {onReloadAccounts}
  {onNavigateToSettings}
  {onCreateInboxWithProvider}
  {onToggleAutoExtend}
  {onArchiveAccount}
  {onUnarchiveAccount}
  {onRemoveAccount}
  {onRestoreAccount}
  {onTagAccount}
  {onMarkAllRead}
  {onMarkAllUnread}
  {showToast}
  {selectedProviderInstance}
  {defaultDomain}
/>

<style>
  .account-selector-outer {
    position: relative;
    display: flex;
    border-radius: 9999px;
  }
</style>
