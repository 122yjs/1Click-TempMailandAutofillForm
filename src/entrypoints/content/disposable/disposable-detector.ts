/**
 * Disposable email detection
 *
 * When a user types a "real" email (gmail, outlook, yahoo, etc.) into a signup
 * form, this module shows a small inline suggestion to use their active temp
 * alias instead. If no active inbox exists, it offers to create one.
 */

import { getBlockedTempMailSite } from '@/utils/blocked-temp-mail-sites.js';
import { getStorageViaBg, sendMessageViaBg, setStorageViaBg } from '@/utils/content-bg-bridge.js';
import { NoActiveInboxError } from '@/utils/content-errors.js';
import { t } from '@/utils/content-i18n.js';
import { trustedClick } from '@/utils/dom-guard.js';
import { logError } from '@/utils/logger.js';
import { CONTENT_Z } from '@/utils/portal-layers.js';
import { positionAtEndOfField, trackElementPosition } from '../dom/positioning.js';

/**
 * Check if the current site is known to reject disposable email domains.
 * Returns the root domain if it matches, null otherwise.
 */
function getDisposableRejectingDomain(hostname: string): string | null {
  return getBlockedTempMailSite(hostname);
}

/**
 * Build a warning chip (orange/amber) - visually distinct from the green
 * "use temp alias" suggestion chip so users can tell them apart.
 */
function buildWarningChip(text: string): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'disposable-reject-warning-chip';
  chip.style.cssText = `
    position: absolute;
    z-index: ${CONTENT_Z.chip};
    background-color: var(--md-warning);
    color: var(--md-on-warning);
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: system-ui, sans-serif;
    user-select: none;
    white-space: nowrap;
    max-width: 280px;
    pointer-events: none;
  `;
  chip.textContent = text;
  return chip;
}

const REAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'gmx.com',
  'gmx.de',
  'fastmail.com',
  'tutanota.com',
]);

const DISMISSED_DOMAINS_KEY = 'disposableHintDismissedDomains';
const PREFERRED_DOMAINS_KEY = 'disposablePreferredDomains';
const DISMISS_DURATION_MS = 5 * 60 * 1000;
const INPUT_DEBOUNCE_MS = 350;

type InboxShape = { id: string; address: string };

interface InboxResponse {
  activeInboxId?: string;
  inboxes?: InboxShape[];
}

interface DismissedDomainsResponse {
  [key: string]: number;
}

import { safeId, safeName, safePlaceholder } from '@/utils/dom-safe.js';

function isEmailField(input: HTMLInputElement): boolean {
  if (input.type === 'email') return true;
  if (safeName(input).toLowerCase().includes('email')) return true;
  if (safeId(input).toLowerCase().includes('email')) return true;
  if (safePlaceholder(input).toLowerCase().includes('email')) return true;
  if (input.getAttribute('autocomplete') === 'email') return true;
  return false;
}

function getEmailDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.includes('@')) return null;
  const parts = trimmed.split('@');
  if (parts.length !== 2) return null;
  const domain = parts[1].toLowerCase().trim();
  if (!domain?.includes('.')) return null;
  return domain;
}

async function loadDismissedDomains(): Promise<Record<string, number>> {
  try {
    return ((await getStorageViaBg(DISMISSED_DOMAINS_KEY)) as DismissedDomainsResponse) || {};
  } catch {
    /* ignore */
    return {};
  }
}

async function isDomainDismissed(domain: string): Promise<boolean> {
  const dismissed = await loadDismissedDomains();
  const ts = dismissed[domain];
  if (!ts) return false;
  if (Date.now() - ts > DISMISS_DURATION_MS) return false;
  return true;
}

async function _dismissDomain(domain: string): Promise<void> {
  try {
    const dismissed = await loadDismissedDomains();
    dismissed[domain] = Date.now();
    await setStorageViaBg({ [DISMISSED_DOMAINS_KEY]: dismissed });
  } catch (error: unknown) {
    logError('Failed to persist dismissed domain', error);
  }
}

/** Load the set of domains where the user has accepted a temp alias suggestion. */
async function loadPreferredDomains(): Promise<Set<string>> {
  try {
    const result = (await getStorageViaBg(PREFERRED_DOMAINS_KEY)) as {
      [PREFERRED_DOMAINS_KEY]?: string[];
    };
    const arr = result[PREFERRED_DOMAINS_KEY];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    /* ignore */
    return new Set();
  }
}

/** Check if the user has previously accepted a temp alias suggestion on this domain. */
export async function isDomainPreferred(domain: string): Promise<boolean> {
  const preferred = await loadPreferredDomains();
  return preferred.has(domain.toLowerCase());
}

/** Save a domain as preferred (user accepted the temp alias suggestion). */
async function savePreferredDomain(domain: string): Promise<void> {
  try {
    const preferred = await loadPreferredDomains();
    preferred.add(domain.toLowerCase());
    await setStorageViaBg({ [PREFERRED_DOMAINS_KEY]: Array.from(preferred) });
  } catch (error: unknown) {
    logError('Failed to persist preferred domain', error);
  }
}

/** Remove a domain from the preferred list (user explicitly un-pinned). */
export async function removePreferredDomain(domain: string): Promise<void> {
  try {
    const preferred = await loadPreferredDomains();
    preferred.delete(domain.toLowerCase());
    await setStorageViaBg({ [PREFERRED_DOMAINS_KEY]: Array.from(preferred) });
  } catch (error: unknown) {
    logError('Failed to remove preferred domain', error);
  }
}

async function getActiveInbox(): Promise<InboxShape | null> {
  try {
    const { activeInboxId, inboxes = [] } = (await getStorageViaBg([
      'activeInboxId',
      'inboxes',
    ])) as InboxResponse;
    if (!activeInboxId || !Array.isArray(inboxes) || inboxes.length === 0) return null;
    return inboxes.find((i) => i.id === activeInboxId) || null;
  } catch (error: unknown) {
    logError('Failed to load active inbox', error);
    return null;
  }
}

async function createTempInbox(): Promise<InboxShape | null> {
  try {
    const response = (await sendMessageViaBg({
      type: 'createInboxWithGesture',
    })) as {
      success?: boolean;
      inbox?: InboxShape;
      error?: string;
      needsUserInteraction?: boolean;
    };
    if (response?.success && response.inbox) return response.inbox;
    return null;
  } catch (error: unknown) {
    logError('Failed to create temp inbox', error);
    return null;
  }
}

function buildChip(text: string): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'disposable-suggest-chip';
  chip.style.cssText = `
    position: absolute;
    z-index: ${CONTENT_Z.chip};
    background-color: var(--md-primary);
    color: var(--md-on-primary);
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    display: flex;
    align-items: center;
    gap: 4px;
    font-family: system-ui, sans-serif;
    transition: opacity 0.2s, transform 0.1s;
    user-select: none;
    white-space: nowrap;
  `;
  chip.textContent = text;
  return chip;
}

interface DisposableTracker {
  cleanup: () => void;
}

export function attachDisposableHint(
  field: HTMLInputElement,
  updatePositionListeners: Array<() => void>
): DisposableTracker | null {
  if (!isEmailField(field)) return null;
  if (field.dataset.disposableHintAttached === '1') return null;
  field.dataset.disposableHintAttached = '1';

  // Dynamic colors handled via CSS variables on shadow DOM host

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let currentChip: HTMLElement | null = null;
  let currentDomain: string | null = null;
  let currentInbox: InboxShape | null = null;
  let _isDismissedForDomain = false;

  let warningChip: HTMLElement | null = null;
  const rejectingDomain = getDisposableRejectingDomain(window.location.hostname);

  async function translate(key: string, vars?: Record<string, string | number>): Promise<string> {
    // Use in-content i18n (same pack as autofill buttons) — no SW round-trip
    try {
      return await t(key, vars);
    } catch {
      /* ignore */
      return key;
    }
  }

  async function refreshChip(): Promise<void> {
    const value = field.value;
    const domain = getEmailDomain(value);

    // ── Disposable-rejection warning ──────────────────────────────────
    // If the current site is known to reject disposable emails AND the user
    // has typed a disposable-looking email, show a warning instead of the
    // "use temp alias" suggestion.
    if (rejectingDomain && domain && !REAL_EMAIL_DOMAINS.has(domain)) {
      hideChip();
      await showWarningChip();
      return;
    }
    hideWarningChip();

    if (!domain || !REAL_EMAIL_DOMAINS.has(domain)) {
      hideChip();
      return;
    }
    if (await isDomainDismissed(domain)) {
      _isDismissedForDomain = true;
      // Preferred domains always show the suggestion — skip dismissal
      if (!(await isDomainPreferred(domain))) {
        hideChip();
        return;
      }
      _isDismissedForDomain = false;
    }
    _isDismissedForDomain = false;

    currentDomain = domain;
    currentInbox = await getActiveInbox();
    await showChip();
  }

  function hideChip(): void {
    if (currentChip?.parentNode) {
      currentChip.parentNode.removeChild(currentChip);
    }
    currentChip = null;
    currentDomain = null;
  }

  async function showWarningChip(): Promise<void> {
    if (warningChip) return; // already showing
    const text = await translate('disposable.rejectWarning', { domain: rejectingDomain || '' });
    const chip = buildWarningChip(text);
    positionChip(chip, field, updatePositionListeners);
    document.body.appendChild(chip);
    warningChip = chip;
  }

  function hideWarningChip(): void {
    if (warningChip?.parentNode) {
      warningChip.parentNode.removeChild(warningChip);
    }
    warningChip = null;
  }

  async function showChip(): Promise<void> {
    const isPreferred = await isDomainPreferred(currentDomain || '');
    const text = currentInbox
      ? await translate('disposable.useAddressInstead', { address: currentInbox.address })
      : await translate('disposable.createAliasInstead');

    if (currentChip) {
      currentChip.textContent = isPreferred
        ? `${text} · ${await translate('disposable.preferredDomain')}`
        : text;
      return;
    }

    const chip = buildChip(text);
    if (isPreferred) {
      chip.style.backgroundColor = 'var(--md-primary)';
      chip.style.boxShadow = '0 0 0 2px var(--md-on-primary), 0 2px 8px rgba(0,0,0,0.15)';
    }
    chip.onmouseover = () => {
      chip.style.filter = 'brightness(0.9)';
    };
    chip.onmouseout = () => {
      chip.style.filter = 'none';
    };
    chip.onmousedown = () => {
      chip.style.transform = 'scale(0.97)';
    };
    chip.onmouseup = () => {
      chip.style.transform = 'scale(1)';
    };

    chip.addEventListener(
      'click',
      trustedClick(async (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        await acceptChip();
      })
    );

    positionChip(chip, field, updatePositionListeners);
    document.body.appendChild(chip);
    currentChip = chip;
  }

  async function acceptChip(): Promise<void> {
    if (!currentDomain) return;
    const domainToDismiss = currentDomain;
    try {
      let inbox = currentInbox || (await getActiveInbox());
      if (!inbox) {
        inbox = await createTempInbox();
        if (!inbox) {
          await showErrorTooltip(currentChip, await t('disposable.createFailed'));
          return;
        }
      }
      field.value = inbox.address;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await _dismissDomain(domainToDismiss);
      // Remember this domain as preferred so the chip shows again in future
      await savePreferredDomain(domainToDismiss);
      if (currentChip?.parentNode) {
        currentChip.parentNode.removeChild(currentChip);
      }
      currentChip = null;
    } catch (error: unknown) {
      if (error instanceof NoActiveInboxError) {
        await showErrorTooltip(currentChip, await t('disposable.noActiveAlias'));
      } else {
        logError('Failed to fill with temp alias', error);
      }
    }
  }

  function onInput(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void refreshChip();
    }, INPUT_DEBOUNCE_MS);
  }

  let blurTimer: ReturnType<typeof setTimeout> | null = null;

  function onBlur(): void {
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => {
      blurTimer = null;
      hideChip();
      hideWarningChip();
    }, 150);
  }

  field.addEventListener('input', onInput);
  field.addEventListener('blur', onBlur);

  return {
    cleanup: () => {
      field.removeEventListener('input', onInput);
      field.removeEventListener('blur', onBlur);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (blurTimer) clearTimeout(blurTimer);
      hideChip();
      hideWarningChip();
      delete field.dataset.disposableHintAttached;
    },
  };
}

let _errorTooltipTimer: ReturnType<typeof setTimeout> | null = null;

async function showErrorTooltip(chip: HTMLElement | null, message: string): Promise<void> {
  if (!chip) return;
  // Cancel any pending reset from a previous call so timers don't overlap
  if (_errorTooltipTimer !== null) {
    clearTimeout(_errorTooltipTimer);
    _errorTooltipTimer = null;
  }
  const originalText = chip.textContent;
  const originalBg = chip.style.backgroundColor;
  const originalColor = chip.style.color;
  chip.textContent = message;
  chip.style.backgroundColor = 'var(--md-error)';
  chip.style.color = 'var(--md-on-error)';
  _errorTooltipTimer = setTimeout(() => {
    _errorTooltipTimer = null;
    chip.textContent = originalText;
    // Restore the chip's own original color rather than assuming DEFAULT_PRIMARY_COLOR
    chip.style.backgroundColor = originalBg;
    chip.style.color = originalColor;
  }, 1500);
}

function positionChip(
  chip: HTMLElement,
  field: HTMLElement,
  updatePositionListeners: Array<() => void>
): void {
  trackElementPosition(chip, field, positionAtEndOfField, updatePositionListeners);
}
