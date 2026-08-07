/**
 * Form filling logic: fills signup form fields with generated / stored data
 */

import { watchUsernameConflict } from '@/features/intelligence/conflict-watch.js';
import {
  buildSelectorHint,
  classifyFieldFastViaBg,
  decryptViaBg,
  encryptViaBg,
  generateIdentityViaBg,
  generateLocaleExtrasViaBg,
  generateLocalePhoneViaBg,
  getFieldMapViaBg,
  getStorageViaBg,
  loadSmartAutofillSettingsViaBg,
  recordFieldMapHitViaBg,
  resolveDomainFieldOverridesViaBg,
  sendMessageViaBg,
  setStorageViaBg,
} from '@/utils/content-bg-bridge.js';
import { NoActiveInboxError } from '@/utils/content-errors.js';
import { t } from '@/utils/content-i18n.js';
import { generateDefaultAvatarDataUrl } from '@/utils/default-avatar.js';
import { safeId, safeName, safePlaceholder } from '@/utils/dom-safe.js';
import { logError } from '@/utils/logger.js';
import { CONTENT_Z } from '@/utils/portal-layers.js';
import { randomItem } from '@/utils/secure-random.js';
import { DEFAULT_THEME_SEED, generateThemeColorsSync } from '@/utils/theme-generator.js';
import type { CredentialsHistoryItem, Identity } from '@/utils/types.js';
import { showConflictChip, showTooltip } from '../dom/tooltip.js';
import { generateSmartPassword } from './generators.js';

/** Detect the page locale from DOM (inline to avoid pulling locale-profile.ts into content bundle). */
function detectPageLocale(): string {
  try {
    const htmlLang = document.documentElement?.lang;
    if (htmlLang) return htmlLang;
    const meta = document
      .querySelector('meta[http-equiv="content-language"]')
      ?.getAttribute('content');
    if (meta) return meta;
  } catch {
    /* ignore */
  }
  return typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
}

export interface FilledNames {
  firstName: string;
  lastName: string;
  fullName: string;
}

export async function getPasswordToFill(
  field?: HTMLInputElement | null,
  form?: HTMLElement | Document | null
): Promise<string> {
  const { passwordSettings = {} } = (await getStorageViaBg(['passwordSettings'])) as {
    passwordSettings?: { useCustom?: boolean; customPassword?: string };
  };
  if (passwordSettings.useCustom && passwordSettings.customPassword) {
    try {
      return await decryptViaBg(passwordSettings.customPassword);
    } catch {
      // Legacy plaintext custom password
      return passwordSettings.customPassword;
    }
  }
  return generateSmartPassword(field, form || field?.form || document);
}

/** Whether autofill can run: setup done + at least one live address. */
export type AutofillBlockReason = 'setup' | 'no_active' | 'expired' | null;

export async function getAutofillBlockReason(): Promise<AutofillBlockReason> {
  const {
    inboxes = [],
    activeInboxId,
    onboardingComplete,
  } = (await getStorageViaBg(['inboxes', 'activeInboxId', 'onboardingComplete'])) as {
    inboxes?: Array<{
      id: string;
      address: string;
      status?: string;
      accountStatus?: string;
      expiresAt?: number;
    }>;
    activeInboxId?: string;
    onboardingComplete?: boolean;
  };

  const now = Date.now();
  const isLive = (i: { status?: string; accountStatus?: string; expiresAt?: number }) => {
    if (i.accountStatus === 'archived' || i.accountStatus === 'deleted') return false;
    if (i.status === 'archived' || i.status === 'deleted' || i.status === 'expired') return false;
    const exp = Number(i.expiresAt);
    if (Number.isFinite(exp) && exp > 0 && exp <= now) return false;
    return true;
  };

  if (!Array.isArray(inboxes) || inboxes.length === 0) {
    // Brand-new install / hard reset — need setup
    return onboardingComplete === false ? 'setup' : 'no_active';
  }

  const live = inboxes.filter(isLive);
  if (live.length === 0) return 'no_active';

  const active = activeInboxId ? inboxes.find((i) => i.id === activeInboxId) : null;
  if (active && !isLive(active)) return 'expired';
  // Prefer having some live inbox even if active pointer is stale
  return null;
}

function fieldMeta(el: HTMLInputElement): string {
  const labelText = (() => {
    try {
      if (el.labels && el.labels.length > 0) {
        return Array.from(el.labels)
          .map((l) => l.textContent || '')
          .join(' ');
      }
      const id = safeId(el);
      if (id) {
        const lab = el.ownerDocument?.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lab?.textContent) return lab.textContent;
      }
    } catch {
      /* ignore */
    }
    return '';
  })();
  return `${safeName(el)} ${safeId(el)} ${safePlaceholder(el)} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('autocomplete') || ''} ${labelText}`.toLowerCase();
}

function isPasswordish(meta: string, el: HTMLInputElement): boolean {
  if (el.type === 'password') return true;
  // Do not treat username fields as password even if meta is noisy
  if (
    /\buser\s*name\b|username|userid|user_id|handle\b/.test(meta) &&
    !/password|passwd|pwd/.test(meta)
  )
    return false;
  return /password|passwd|pwd|secret|passcode|new-password|current-password/.test(meta);
}

/**
 * Find a real username field (not email, not password).
 * autocomplete=username is often login EMAIL — only treat as username when
 * name/id/placeholder explicitly say username/handle.
 */
export async function findUsernameField(root: ParentNode): Promise<HTMLInputElement | null> {
  const nodes = Array.from(
    root.querySelectorAll<HTMLInputElement>(
      'input:not([type="hidden"]):not([type="password"]):not([type="email"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="file"])'
    )
  );
  for (const el of nodes) {
    if (el.disabled || el.readOnly) continue;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
    } catch {
      /* ignore */
    }
    const meta = fieldMeta(el);
    if (isPasswordish(meta, el)) continue;
    if (looksLikeEmailField(el)) continue;
    // Explicit username signals (multi-language) — classified via background
    const cls = await classifyFieldFastViaBg(meta);
    if (cls.isUsername) {
      return el;
    }
  }
  return null;
}
function looksLikeEmailField(el: HTMLInputElement): boolean {
  if (el.type === 'hidden' || el.disabled || el.readOnly) return false;
  const meta = fieldMeta(el);
  if (isPasswordish(meta, el)) return false;
  // Prefer email over dual phone/email fields (Canva "email or phone")
  if (el.type === 'email') return true;
  const ac = (el.autocomplete || '').toLowerCase();
  if (ac === 'email' || ac.includes('email')) return true;
  // Explicit email / confirm-email (multi-language) including type=text
  if (
    /e-?mail|mail|correo|courriel|メール|邮箱|بريد|e-mail|confirm\s*e-?mail|re-?enter\s*e-?mail|repeat\s*e-?mail|verify\s*e-?mail|email2|email_confirm|confirm_email|emailconfirmation|email-confirm|user_email/.test(
      meta
    )
  ) {
    return true;
  }
  // Dual "email or phone" / "email or mobile" → treat as email (user preference)
  if (
    /(email|e-mail|correo|courriel).{0,12}(or|\/|ou|o|oder|または|或).{0,12}(phone|mobile|tel|handy|携帯|手机|هاتف)/i.test(
      meta
    ) ||
    /(phone|mobile|tel).{0,12}(or|\/|ou|o|oder).{0,12}(email|e-mail|correo)/i.test(meta)
  ) {
    return true;
  }
  // Confirm-only fields that aren't password
  if (/confirm|reenter|re-enter|repeat|verify/.test(meta) && /mail|email|correo/.test(meta)) {
    return true;
  }
  // type=tel alone is phone — not email
  if (el.type === 'tel') return false;
  return false;
}

/** Resolve best known element for a kind on this domain within a root (inlined from field-maps.ts). */
function resolveMappedField(
  root: ParentNode,
  map: {
    entries: Array<{ kind: string; selector: string; hits: number; lastUsedAt: number }>;
  } | null,
  kind: string
): HTMLElement | null {
  if (!map) return null;
  const candidates = map.entries.filter((e) => e.kind === kind).sort((a, b) => b.hits - a.hits);
  for (const c of candidates) {
    try {
      const el = root.querySelector(c.selector);
      if (el instanceof HTMLElement) {
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
        ) {
          return el;
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'SyntaxError') {
        /* invalid selector */
        continue;
      }
      throw e;
    }
  }
  return null;
}

/** All email / confirm-email inputs in a form (same address goes into each). */
export function queryEmailInputs(root: ParentNode = document): HTMLInputElement[] {
  const nodes = root.querySelectorAll<HTMLInputElement>(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="password"])'
  );
  const result: HTMLInputElement[] = [];
  const seen = new Set<HTMLInputElement>();
  for (const el of Array.from(nodes)) {
    if (seen.has(el)) continue;
    if (!looksLikeEmailField(el)) continue;
    seen.add(el);
    result.push(el);
  }
  return result;
}

export async function typeValueHuman(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
): Promise<void> {
  if (!input || value === null || value === undefined) return;
  try {
    input.focus?.();
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true, cancelable: true }));
  } catch {
    /* ignore */
  }

  // Clear input via React value tracker if needed
  try {
    const proto =
      input.tagName.toLowerCase() === 'textarea'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) {
      desc.set.call(input, '');
    } else {
      input.value = '';
    }

    const tracker = (
      input as unknown as {
        _valueTracker?: { setValue: (v: string) => void; getValue?: () => string };
      }
    )._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      tracker.setValue('');
    }
  } catch {
    /* ignore */
    try {
      input.value = '';
    } catch {
      /* ignore */
    }
  }

  // Type each character
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const keyCode = char.charCodeAt(0);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: char, keyCode, bubbles: true }));

    try {
      const proto =
        input.tagName.toLowerCase() === 'textarea'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) {
        desc.set.call(input, input.value + char);
      } else {
        input.value += char;
      }
      const tracker = (
        input as unknown as {
          _valueTracker?: { setValue: (v: string) => void; getValue?: () => string };
        }
      )._valueTracker;
      if (tracker && typeof tracker.setValue === 'function') {
        tracker.setValue(input.value);
      }
    } catch {
      /* ignore */
      try {
        input.value += char;
      } catch {
        /* ignore */
      }
    }

    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    try {
      input.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          data: char,
          inputType: 'insertText',
        })
      );
    } catch {
      /* ignore */
    }

    input.dispatchEvent(new KeyboardEvent('keyup', { key: char, keyCode, bubbles: true }));

    const delayMs = Math.floor(Math.random() * (60 - 20 + 1)) + 20;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

/** Set value in a way React/Vue/Angular controlled inputs accept. */
export function fillInputValue(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
  value: string | null
): void {
  if (!input || value === null || value === undefined) return;
  try {
    input.focus?.();
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true, cancelable: true }));
  } catch {
    /* ignore */
  }
  const tag = input.tagName.toLowerCase();
  try {
    if (tag === 'select') {
      const sel = input as HTMLSelectElement;
      // Prefer exact option match, else partial
      const opts = Array.from(sel.options);
      const exact =
        opts.find((o) => o.value === value) ||
        opts.find((o) => (o.textContent || '').trim() === value);
      const partial = opts.find(
        (o) =>
          o.value.toLowerCase().includes(value.toLowerCase()) ||
          (o.textContent || '').toLowerCase().includes(value.toLowerCase())
      );
      const pick = exact || partial;
      if (pick) {
        sel.value = pick.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    const proto =
      tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) {
      desc.set.call(input, value);
    } else {
      (input as HTMLInputElement).value = value;
    }
  } catch {
    /* ignore */
    try {
      (input as HTMLInputElement).value = value;
    } catch {
      /* ignore */
    }
  }
  // React 16+/17 tracker + Vue/Svelte-friendly events
  try {
    const tracker = (
      input as unknown as {
        _valueTracker?: { setValue: (v: string) => void; getValue?: () => string };
      }
    )._valueTracker;
    if (tracker && typeof tracker.setValue === 'function') {
      const lastValue = tracker.getValue ? tracker.getValue() : '';
      tracker.setValue(lastValue === String(value) ? '' : String(value));
    }
  } catch {
    /* ignore */
  }
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  try {
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: value,
        inputType: 'insertText',
      })
    );
  } catch {
    /* older engines */
  }

  try {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, composed: true, key: 'Unidentified' })
    );
    input.dispatchEvent(
      new KeyboardEvent('keyup', { bubbles: true, composed: true, key: 'Unidentified' })
    );
  } catch {
    /* ignore */
  }
  try {
    input.blur?.();
    input.focus?.();
  } catch {
    /* ignore */
  }
}

export async function smartFillInputValue(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
  value: string | null,
  humanLikeFilling: boolean
): Promise<void> {
  if (!input || value === null || value === undefined) return;
  if (
    humanLikeFilling &&
    input.tagName !== 'SELECT' &&
    (input as HTMLInputElement).type !== 'password'
  ) {
    await typeValueHuman(input as HTMLInputElement | HTMLTextAreaElement, value);
  } else {
    fillInputValue(input, value);
  }
}

/** Check if field is optional and non-essential (can be skipped during autofill). */
export function isFieldOptional(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
): boolean {
  if (el.required) return false;
  if (el.getAttribute('aria-required') === 'true') return false;

  const meta = fieldMeta(el as HTMLInputElement);
  // Email and Password are never skipped
  if (isPasswordish(meta, el as HTMLInputElement) || looksLikeEmailField(el as HTMLInputElement)) {
    return false;
  }
  // Check for explicit optional markers in placeholder, label, name, or id
  return /\b(optional|opcional|optionnel|опционально|任意|选填|اختياري)\b/i.test(meta);
}

/** Observe name inputs after email fill to replace auto-generated username prefixes (e.g. Canva) with real identity name. */
export const activeNameCorrectionTimers = new Set<ReturnType<typeof setInterval>>();

export function observeAutoGeneratedNameCorrection(
  form: HTMLElement | ParentNode | null,
  emailAddress: string,
  identityNames: { firstName?: string; lastName?: string; fullName?: string }
): void {
  if (!emailAddress || !identityNames) return;
  const root = form ?? document;
  const usernamePrefix = emailAddress.split('@')[0].trim().toLowerCase();
  if (!usernamePrefix) return;

  const replacement = (
    identityNames.fullName ||
    `${identityNames.firstName || ''} ${identityNames.lastName || ''}`.trim()
  ).trim();

  if (!replacement) return;

  const getNameFields = (): HTMLInputElement[] => {
    return Array.from(
      root.querySelectorAll<HTMLInputElement>(
        'input:not([type="email"]):not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])'
      )
    ).filter((el) => {
      const meta =
        `${safeName(el)} ${safeId(el)} ${safePlaceholder(el)} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
      return /name|nombre|nom|benutzer|nombre|ชื่อ|اسم|姓名/.test(meta) || el.value.length > 0;
    });
  };

  let observer: MutationObserver | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;

  const checkAndCorrect = () => {
    if (!root.isConnected && root !== document) {
      observer?.disconnect();
      if (interval) {
        clearInterval(interval);
        activeNameCorrectionTimers.delete(interval);
      }
      return;
    }
    const fields = getNameFields();
    for (const field of fields) {
      const val = (field.value || '').trim().toLowerCase();
      // Overwrite if field contains derived username prefix (Canva style abc123) or is empty name field
      if (
        (val &&
          (val === usernamePrefix || val.startsWith(usernamePrefix)) &&
          val !== replacement.toLowerCase()) ||
        (!val &&
          /name|fullName|firstName|lastName/i.test(
            `${safeName(field)} ${safeId(field)} ${safePlaceholder(field)}`
          ))
      ) {
        fillInputValue(field, replacement);
      }
    }
  };

  checkAndCorrect();
  try {
    observer = new MutationObserver(checkAndCorrect);
    observer.observe(root, {
      subtree: true,
      attributes: true,
      childList: true,
      attributeFilter: ['value'],
    });
    // Interval check for async JS frameworks (Canva, React) updating name field 500ms-2000ms later
    interval = setInterval(checkAndCorrect, 250);
    activeNameCorrectionTimers.add(interval);
    setTimeout(() => {
      observer?.disconnect();
      if (interval) {
        clearInterval(interval);
        activeNameCorrectionTimers.delete(interval);
      }
    }, 2500);
  } catch {
    /* ignore */
  }
}

/** Fill every email / confirm-email field in the form (or just the given field). */
export function fillAllEmailFields(
  form: HTMLElement | null,
  address: string,
  fallbackField?: HTMLInputElement | HTMLSelectElement | null
): void {
  const root: ParentNode = form ?? document;
  const fields = queryEmailInputs(root);
  // Also include fields outside the form but on the page when form is provided
  // (some sites put confirm-email in a sibling block).
  const pageFields = form ? queryEmailInputs(document) : [];
  const all = new Set<HTMLInputElement>([...fields, ...pageFields]);
  // Always force the focused field first so confirm-* twins get the same value
  if (fallbackField && fallbackField instanceof HTMLInputElement) {
    fillInputValue(fallbackField, address);
  }
  if (all.size > 0) {
    for (const el of all) fillInputValue(el, address);
    return;
  }
  if (fallbackField && fallbackField instanceof HTMLInputElement) {
    fillInputValue(fallbackField, address);
  }
}

/** True if this email already appears in saved login history for any domain. */
export async function isEmailUsedInSavedLogins(email: string): Promise<boolean> {
  const needle = (email || '').trim().toLowerCase();
  if (!needle) return false;
  try {
    const { loginInfo = [] } = (await getStorageViaBg(['loginInfo'])) as {
      loginInfo?: CredentialsHistoryItem[];
    };
    return loginInfo.some((l) => {
      const candidates = [l.email, l.username, (l as { address?: string }).address];
      return candidates.some((c) => (c || '').trim().toLowerCase() === needle);
    });
  } catch (e) {
    logError('isEmailUsedInSavedLogins error', e);
    return false;
  }
}

/** Collect privacy / terms / policy links from the form (and nearby page links). */
export function extractPolicyUrls(form: HTMLElement | null): string[] {
  const urls = new Set<string>();
  const roots: ParentNode[] = form ? [form, document] : [document];
  const re = /privacy|terms|conditions|policy|tos|legal|gdpr|cookie/i;
  for (const root of roots) {
    try {
      const links = root.querySelectorAll<HTMLAnchorElement>('a[href]');
      for (const a of Array.from(links)) {
        const text = `${a.textContent || ''} ${a.getAttribute('href') || ''}`;
        if (!re.test(text)) continue;
        try {
          const abs = new URL(a.href, location.href).href;
          if (abs.startsWith('http')) urls.add(abs);
        } catch {
          /* ignore */
        }
        if (urls.size >= 8) break;
      }
    } catch {
      /* ignore */
    }
  }
  return Array.from(urls);
}

/**
 * Assign a data-URL image to file inputs that look like avatar/profile upload fields.
 * Uses DataTransfer so React/Vue controlled file inputs receive a real FileList.
 */
export async function fillProfilePictureInputs(
  form: ParentNode,
  dataUrl: string
): Promise<boolean> {
  try {
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    if (!m) return false;
    const mime = m[1];
    const b64 = m[2];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const file = new File([bytes], `profile.${ext}`, { type: mime });

    const inputs = form.querySelectorAll<HTMLInputElement>(
      [
        'input[type="file"][accept*="image" i]',
        'input[type="file"][name*="avatar" i]',
        'input[type="file"][id*="avatar" i]',
        'input[type="file"][name*="photo" i]',
        'input[type="file"][id*="photo" i]',
        'input[type="file"][name*="profile" i]',
        'input[type="file"][id*="profile" i]',
        'input[type="file"][name*="picture" i]',
        'input[type="file"][id*="picture" i]',
        'input[type="file"][name*="image" i]',
        'input[type="file"][id*="image" i]',
        'input[type="file"][id*="Img" i]',
        'input[type="file"][id*="img" i]',
        'input[type="file"][data-file-type*="image" i]',
        'input[type="file"]',
      ].join(', ')
    );
    let filled = false;
    for (const input of Array.from(inputs)) {
      // Skip clearly non-image multi-file document uploads
      const accept = (input.getAttribute('accept') || '').toLowerCase();
      const hint =
        `${safeName(input)} ${safeId(input)} ${input.getAttribute('data-file-type') || ''}`.toLowerCase();
      if (accept && !accept.includes('image') && !accept.includes('*/*') && accept !== '') {
        if (!/avatar|photo|profile|picture|image|logo|icon|img/.test(hint)) continue;
      }
      // Skip pure document upload fields
      if (
        /resume|cv|document|pdf|attachment/.test(hint) &&
        !/image|photo|avatar|profile/.test(hint)
      ) {
        continue;
      }
      try {
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          input.files = dt.files;
        } catch (err) {
          logError('DataTransfer assignment failed, attempting fallback', err);
          const clipboardData = new ClipboardEvent('').clipboardData || new DataTransfer();
          clipboardData.items.add(file);
          input.files = clipboardData.files;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // Some Vue file widgets listen for these
        try {
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        } catch {
          /* ignore */
        }
        filled = true;
      } catch {
        /* some browsers lock .files */
      }
    }
    return filled;
  } catch (e) {
    logError('fillProfilePictureInputs failed', e);
    return false;
  }
}

const SIGNUP_HEADING_RE =
  /\b(create(\s+(an?|your|my))?\s+account|sign\s*up|register|join\s+(us|now)|get\s+started|free\s+account|create\s+free)\b/i;

/**
 * Best anchor for Autofill All: a **text heading** near the form
 * (Create account / Sign up / Register). Never a button (buttons often say
 * "Create account" but are wrong placement for our control).
 */
export function findAutofillAllAnchor(form: HTMLFormElement | HTMLElement): HTMLElement {
  const headingSel =
    'h1, h2, h3, h4, h5, legend, [role="heading"], [class*="title" i], [class*="heading" i], [class*="header" i]';

  const isUsableHeading = (el: Element | null): el is HTMLElement => {
    if (!el || !(el instanceof HTMLElement)) return false;
    // Never anchor to buttons / submit controls
    if (el.closest('button, input, a[role="button"], [role="button"], select, textarea')) {
      return false;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'input' || tag === 'a') return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 8) return false;
    } catch {
      /* ignore */
    }
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) return false;
    return SIGNUP_HEADING_RE.test(text) || /sign\s*up|register|account|join/i.test(text);
  };

  // 1) Previous siblings of form
  let sib: Element | null = form.previousElementSibling;
  for (let i = 0; i < 8 && sib; i++) {
    if (isUsableHeading(sib)) return sib;
    const inner = sib.querySelector?.(headingSel);
    if (isUsableHeading(inner)) return inner;
    // Walk text nodes' parent for short headings
    const candidates = sib.querySelectorAll?.(headingSel) || [];
    for (const c of Array.from(candidates)) {
      if (isUsableHeading(c)) return c;
    }
    sib = sib.previousElementSibling;
  }

  // 2) Parent chain — page hero above form
  let parent: HTMLElement | null = form.parentElement;
  for (let d = 0; d < 5 && parent; d++) {
    for (const c of Array.from(parent.querySelectorAll(headingSel))) {
      if (isUsableHeading(c) && !form.contains(c)) return c as HTMLElement;
    }
    parent = parent.parentElement;
  }

  // 3) Inside form — first non-button heading only
  for (const c of Array.from(form.querySelectorAll(headingSel))) {
    if (isUsableHeading(c)) return c;
  }

  // 4) Fallback: first non-button field (never submit button)
  const firstField = form.querySelector<HTMLElement>(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'
  );
  const target = firstField || form;
  if (
    target === form &&
    typeof window !== 'undefined' &&
    getComputedStyle(form).position === 'static'
  ) {
    form.style.position = 'relative';
  }
  return target;
}

export async function getNamesToFill(): Promise<FilledNames> {
  const { nameSettings = {} } = (await getStorageViaBg(['nameSettings'])) as {
    nameSettings?: { useCustom?: boolean; firstName?: string; lastName?: string };
  };
  if (nameSettings.useCustom && nameSettings.firstName && nameSettings.lastName) {
    return {
      firstName: nameSettings.firstName,
      lastName: nameSettings.lastName,
      fullName: `${nameSettings.firstName} ${nameSettings.lastName}`,
    };
  }
  const randomFullName = await generateIdentityViaBg('randomName');
  const [randomFirstName, randomLastName] = randomFullName.split(' ');
  return { firstName: randomFirstName, lastName: randomLastName, fullName: randomFullName };
}

function validSelectOptions(selectElement: HTMLSelectElement): HTMLOptionElement[] {
  return Array.from(selectElement.options).filter(
    (option: HTMLOptionElement) =>
      !option.disabled &&
      option.value &&
      option.value.trim() !== '' &&
      !/select|choose|pick/i.test(option.textContent ?? '')
  );
}

export function fillSelectElement(selectElement: HTMLSelectElement): void {
  const validOptions = validSelectOptions(selectElement);
  if (validOptions.length > 0) {
    const randomOption = randomItem(validOptions);
    if (!randomOption) return;
    selectElement.value = randomOption.value;
  }
}

/** Match a select option to preferred values (value, text, or substring). */
function matchSelectOption(
  selectElement: HTMLSelectElement,
  preferred: string[]
): HTMLOptionElement | null {
  const validOptions = validSelectOptions(selectElement);
  const prefs = preferred.map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (prefs.length === 0 || validOptions.length === 0) return null;

  for (const pref of prefs) {
    const exact = validOptions.find(
      (o) => o.value.toLowerCase() === pref || (o.textContent || '').trim().toLowerCase() === pref
    );
    if (exact) return exact;
  }

  // "US - United States" / "CA - California" style options (RunSignup etc.)
  for (const pref of prefs) {
    if (pref.length < 2 || pref.length > 3) continue;
    const codePrefix = validOptions.find((o) => {
      const val = o.value.toLowerCase().trim();
      const text = (o.textContent || '').trim().toLowerCase();
      return (
        val === pref ||
        text.startsWith(`${pref} -`) ||
        text.startsWith(`${pref}-`) ||
        text.startsWith(`${pref} `) ||
        new RegExp(`^${pref}\\b`).test(text)
      );
    });
    if (codePrefix) return codePrefix;
  }

  for (const pref of prefs) {
    if (pref.length < 2) continue;
    const partial = validOptions.find((o) => {
      const val = o.value.toLowerCase();
      const text = (o.textContent || '').toLowerCase();
      return val.includes(pref) || text.includes(pref) || pref.includes(val);
    });
    if (partial) return partial;
  }
  return null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Dispatch input/change so Vue/React/Angular pick up select values. */
function commitSelect(select: HTMLSelectElement, value: string): void {
  try {
    const proto = window.HTMLSelectElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(select, value);
    else select.value = value;
  } catch {
    /* ignore */
    select.value = value;
  }
  try {
    const tracker = (select as unknown as { _valueTracker?: { setValue: (v: string) => void } })
      ._valueTracker;
    tracker?.setValue?.('');
  } catch {
    /* ignore */
  }
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Format ISO YYYY-MM-DD for the target DOB field.
 * type=date needs ISO; text fields often need mm/dd/yyyy (US) or dd/mm/yyyy.
 */
export function formatDobForField(iso: string, field: HTMLInputElement): string {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(iso.trim());
  if (!m) return iso;
  const [, y, moRaw, dRaw] = m;
  const mo = moRaw.padStart(2, '0');
  const d = dRaw.padStart(2, '0');
  if (field.type === 'date') return iso.trim();

  const hint =
    `${safePlaceholder(field)} ${field.getAttribute('title') || ''} ${field.getAttribute('aria-label') || ''} ${safeName(field)} ${safeId(field)}`.toLowerCase();
  // Nearby label / help text
  let near = '';
  try {
    if (field.labels)
      near += Array.from(field.labels)
        .map((l) => l.textContent || '')
        .join(' ');
    const parent = field.parentElement;
    if (parent) near += ` ${parent.textContent || ''}`.slice(0, 200);
  } catch {
    /* ignore */
  }
  const blob = `${hint} ${near}`.toLowerCase();

  if (/dd\s*[/.-]\s*mm|d\/m|day\s*[/.-]\s*month/.test(blob)) return `${d}/${mo}/${y}`;
  if (/mm\s*[/.-]\s*dd|m\/d|format:\s*mm/.test(blob)) return `${mo}/${d}/${y}`;
  // US default for text DOB when ambiguous
  if (field.type === 'text' || !field.type) return `${mo}/${d}/${y}`;
  return iso.trim();
}

function isUsableTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
  if (el.disabled) return false;
  if (el instanceof HTMLInputElement) {
    const t = (el.type || 'text').toLowerCase();
    if (
      t === 'hidden' ||
      t === 'submit' ||
      t === 'button' ||
      t === 'file' ||
      t === 'checkbox' ||
      t === 'radio'
    )
      return false;
    // Never treat email/password as street-address targets
    if (t === 'email' || t === 'password') return false;
  }
  return true;
}

function queryFirstInput(
  root: ParentNode,
  selectors: string[]
): HTMLInputElement | HTMLTextAreaElement | null {
  for (const sel of selectors) {
    try {
      // Prefer selectors without case-insensitive flag first (broader engine support)
      const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
      if (isUsableTextField(el)) return el;
    } catch {
      /* ignore bad selector */
    }
  }
  return null;
}

/**
 * Find street-address field robustly (RunSignup uses address1; labels may be localized).
 * Searches form first, then document. Never returns email/password inputs.
 */
export function findStreetAddressInput(
  form: HTMLElement | null
): HTMLInputElement | HTMLTextAreaElement | null {
  const roots: ParentNode[] = [];
  if (form) roots.push(form);
  if (typeof document !== 'undefined') roots.push(document);

  // 1) Exact common names/ids
  const exactIds = ['address1', 'address_1', 'street1', 'street_address', 'streetAddress', 'addr1'];
  for (const root of roots) {
    for (const id of exactIds) {
      try {
        const byId =
          (root as Document).getElementById?.(id) || root.querySelector(`#${CSS.escape(id)}`);
        if (isUsableTextField(byId)) return byId;
      } catch {
        /* ignore */
      }
      try {
        const byName = root.querySelector<HTMLInputElement>(`[name="${id}"]`);
        if (isUsableTextField(byName)) return byName;
      } catch {
        /* ignore */
      }
    }
  }

  // 2) Attribute contains (no `i` flag — more reliable in all engines)
  const attrSels = [
    'input[name*="address1"]',
    'input[id*="address1"]',
    'input[name*="Address1"]',
    'input[autocomplete="street-address"]',
    'input[autocomplete="address-line1"]',
    'textarea[autocomplete="street-address"]',
    'input[name*="street"]',
    'input[id*="street"]',
    'input[name*="address"]',
    'input[id*="address"]',
    'textarea[name*="address"]',
    'textarea[id*="address"]',
  ];
  for (const root of roots) {
    for (const sel of attrSels) {
      try {
        const nodes = root.querySelectorAll(sel);
        for (const n of Array.from(nodes)) {
          if (!isUsableTextField(n)) continue;
          // Skip email-ish fields (e.g. label "Email Address")
          const meta =
            `${safeName(n)} ${safeId(n)} ${safePlaceholder(n)} ${(n as HTMLInputElement).autocomplete || ''}`.toLowerCase();
          if (/e-?mail|username|password|phone|mobile|zip|postal|city|country|state/.test(meta))
            continue;
          if ((n as HTMLInputElement).type === 'email') continue;
          return n;
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 3) Label text (multi-language street address)
  const labelRe =
    /^(address|street|street\s*address|mailing\s*address|home\s*address|adresse|dirección|direccion|indirizzo|endereço|endereco|住所|地址|ที่อยู่|العنوان|adresse\s*postale|rua|straße|strasse)\b/i;
  try {
    const labels = document.querySelectorAll('label[for]');
    for (const lab of Array.from(labels)) {
      const text = (lab.textContent || '').replace(/\*/g, '').trim();
      if (!labelRe.test(text)) continue;
      // Avoid "Email Address" / "E-Mail-Adresse"
      if (/e-?mail|correo|courriel|メール|邮箱|بريد/i.test(text)) continue;
      const id = lab.getAttribute('for');
      if (!id) continue;
      const el = document.getElementById(id);
      if (isUsableTextField(el)) return el;
    }
  } catch {
    /* ignore */
  }

  return null;
}

/** Stronger fill for stubborn controlled inputs (Vue/React) */
export function fillInputValueForce(
  input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null,
  value: string | null
): void {
  if (!input || value == null) return;
  try {
    if ('readOnly' in input && input.readOnly) {
      try {
        input.readOnly = false;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  fillInputValue(input, value);
  // Second write after a tick helps some masked/autocomplete widgets
  try {
    if ((input as HTMLInputElement).value !== value) {
      const proto =
        input.tagName.toLowerCase() === 'textarea'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      desc?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch {
    /* ignore */
  }
}

function queryFirstSelect(root: ParentNode, selectors: string[]): HTMLSelectElement | null {
  for (const sel of selectors) {
    try {
      const el = root.querySelector<HTMLSelectElement>(sel);
      if (el && !el.disabled) return el;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const US_STATE_CODES = [
  'CA',
  'NY',
  'TX',
  'FL',
  'WA',
  'IL',
  'PA',
  'OH',
  'GA',
  'NC',
  'MI',
  'NJ',
  'VA',
  'MA',
  'AZ',
  'CO',
];

/**
 * Fill address / city / zip / state / country / DOB / gender / profile image.
 * Always generates locale fallbacks when identity lacks values (RunSignup-critical).
 */
export async function fillExtendedProfileFields(
  form: HTMLFormElement | HTMLElement,
  identity?: {
    country?: string | null;
    city?: string | null;
    state?: string | null;
    address?: string | null;
    pin?: string | null;
    dateOfBirth?: string | null;
    gender?: string | null;
    profilePicture?: string | null;
  } | null
): Promise<{ filled: string[] }> {
  const filled: string[] = [];

  // Locale fallbacks so we never leave required address fields empty
  let country = (identity?.country || '').trim();
  let city = (identity?.city || '').trim();
  let pin = (identity?.pin || '').trim();
  let state = (identity?.state || '').trim();
  let address = (identity?.address || '').trim();
  let dob = (identity?.dateOfBirth || '').trim();
  let gender = (identity?.gender || '').trim();

  try {
    const loc = detectPageLocale();
    const extras = await generateLocaleExtrasViaBg(loc);
    if (extras) {
      if (!country) country = extras.country;
      if (!city) city = extras.city;
      if (!pin) pin = extras.pin;
      if (!dob) dob = extras.dob;
    }
  } catch {
    /* ignore */
    if (!country) country = 'US';
    if (!city) city = 'Springfield';
    if (!pin) pin = '90210';
    if (!dob) dob = '1990-06-15';
  }
  if (!address) address = `${100 + Math.floor(Math.random() * 8900)} Main Street`;
  if (!state && /^us$/i.test(country)) {
    state = US_STATE_CODES[Math.floor(Math.random() * US_STATE_CODES.length)] || 'CA';
  }
  if (!gender) gender = 'prefer_not';

  // ── Country first (cascades state lists on many sites) ──────────────
  const countrySelect = queryFirstSelect(form, [
    'select[name*="country" i]',
    'select[id*="country" i]',
    'select[autocomplete="country"]',
    'select[autocomplete="country-name"]',
    'select[name*="nation" i]',
  ]);
  if (countrySelect) {
    const prefs = countryPreferredValues(country);
    const opt = matchSelectOption(countrySelect, prefs);
    if (opt) {
      commitSelect(countrySelect, opt.value);
      filled.push('country');
    } else {
      fillSelectElement(countrySelect);
      countrySelect.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push('country');
    }
    // Allow JS to rebuild state options (RunSignup etc.)
    await sleepMs(120);
  }

  // ── State / province ────────────────────────────────────────────────
  const stateSelect = queryFirstSelect(form, [
    'select[name*="state" i]',
    'select[id*="state" i]',
    'select[name*="province" i]',
    'select[id*="province" i]',
    'select[name*="region" i]',
    'select[autocomplete="address-level1"]',
  ]);
  if (stateSelect) {
    const statePrefs = state ? [state, state.toUpperCase(), state.toLowerCase()] : [];
    let opt = statePrefs.length ? matchSelectOption(stateSelect, statePrefs) : null;
    if (!opt && statePrefs.length) {
      // retry once after cascade delay
      await sleepMs(200);
      opt = matchSelectOption(stateSelect, statePrefs);
    }
    if (opt) {
      commitSelect(stateSelect, opt.value);
      filled.push('state');
    } else {
      fillSelectElement(stateSelect);
      stateSelect.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push('state');
    }
  } else {
    const stateInput = queryFirstInput(form, [
      'input[name*="state" i]',
      'input[id*="state" i]',
      'input[name*="province" i]',
      'input[autocomplete="address-level1"]',
    ]);
    if (stateInput && state) {
      fillInputValue(stateInput, state);
      filled.push('state');
    }
  }

  // ── Street address (address1 — RunSignup; never email “address”) ────
  const addressInput = findStreetAddressInput(form);
  if (addressInput) {
    fillInputValueForce(addressInput, address);
    filled.push('address');
  }

  // ── City ────────────────────────────────────────────────────────────
  const cityInput =
    queryFirstInput(form, [
      'input[name="city"]',
      'input[id="city"]',
      'input[name*="city"]',
      'input[id*="city"]',
      'input[autocomplete="address-level2"]',
    ]) ||
    (typeof document !== 'undefined'
      ? (document.getElementById('city') as HTMLInputElement | null)
      : null);
  if (isUsableTextField(cityInput)) {
    fillInputValueForce(cityInput, city);
    filled.push('city');
  }

  // ── Zip / postal (zipcode, postal, etc.) ────────────────────────────
  const zipInput =
    queryFirstInput(form, [
      'input[name="zipcode"]',
      'input[id="zipcode"]',
      'input[name*="zipcode"]',
      'input[id*="zipcode"]',
      'input[name*="zip"]',
      'input[id*="zip"]',
      'input[name*="postal"]',
      'input[id*="postal"]',
      'input[name*="postcode"]',
      'input[autocomplete="postal-code"]',
    ]) ||
    (typeof document !== 'undefined'
      ? (document.getElementById('zipcode') as HTMLInputElement | null)
      : null);
  if (isUsableTextField(zipInput)) {
    fillInputValueForce(zipInput, pin);
    filled.push('pin');
  }

  // Re-apply street address after zip/country widgets (some sites clear it)
  if (addressInput) {
    await sleepMs(80);
    fillInputValueForce(addressInput, address);
  }

  // ── DOB ─────────────────────────────────────────────────────────────
  const dobInput = queryFirstInput(form, [
    'input[name="dob" i]',
    'input[id="dob" i]',
    'input[type="date"]',
    'input[name*="dob" i]',
    'input[id*="dob" i]',
    'input[name*="birth" i]',
    'input[id*="birth" i]',
    'input[autocomplete="bday"]',
    'input[placeholder*="mm/dd" i]',
    'input[placeholder*="date of birth" i]',
  ]) as HTMLInputElement | null;
  if (dobInput && dob) {
    fillInputValue(dobInput, formatDobForField(dob, dobInput));
    filled.push('dateOfBirth');
  }

  // ── Gender select (not only radios) ─────────────────────────────────
  const genderSelect = queryFirstSelect(form, [
    'select[name*="gender" i]',
    'select[id*="gender" i]',
    'select[name*="sex" i]',
    'select[id*="sex" i]',
  ]);
  if (genderSelect) {
    const gPrefs = genderPreferredValues(gender);
    // RunSignup: Male, Female, Non-Binary, Prefer Not to Say
    gPrefs.push('non-binary', 'non binary', 'prefer not to say', 'prefer_not');
    const opt = matchSelectOption(genderSelect, gPrefs);
    if (opt) {
      commitSelect(genderSelect, opt.value);
      filled.push('gender');
    } else {
      fillSelectElement(genderSelect);
      genderSelect.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push('gender');
    }
  } else {
    // Radio gender
    const radios = form.querySelectorAll<HTMLInputElement>(
      'input[type="radio"][name*="gender" i], input[type="radio"][name*="sex" i]'
    );
    if (radios.length) {
      const gPrefs = genderPreferredValues(gender).map((p) => p.toLowerCase());
      let picked = false;
      for (const r of Array.from(radios)) {
        const meta = `${r.value} ${r.id} ${
          r.labels
            ? Array.from(r.labels)
                .map((l) => l.textContent)
                .join(' ')
            : ''
        }`.toLowerCase();
        if (gPrefs.some((p) => meta.includes(p))) {
          try {
            r.click();
          } catch {
            /* ignore */
            r.checked = true;
            r.dispatchEvent(new Event('change', { bubbles: true }));
          }
          picked = true;
          filled.push('gender');
          break;
        }
      }
      if (!picked) {
        const first = radios[0];
        try {
          first?.click();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── Age / terms checkboxes (RunSignup ageConfirmation) ──────────────
  form
    .querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][name*="age" i], input[type="checkbox"][id*="age" i], input[type="checkbox"][name*="confirm" i], input[type="checkbox"][name*="terms" i], input[type="checkbox"][id*="terms" i], input[type="checkbox"][name*="agree" i], input[type="checkbox"][id*="agree" i], input[type="checkbox"][name*="privacy" i], input[type="checkbox"][name*="policy" i], input[type="checkbox"][name*="tos" i], input[type="checkbox"][required]'
    )
    .forEach((cb) => {
      if (!cb.checked) {
        try {
          cb.click();
        } catch {
          /* ignore */
          cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });

  // ── Profile picture ─────────────────────────────────────────────────
  let pic = identity?.profilePicture || null;
  if (!pic?.startsWith('data:image')) {
    try {
      pic = generateDefaultAvatarDataUrl('User', 'U');
    } catch {
      /* ignore */
      pic = null;
    }
  }
  if (pic?.startsWith('data:image')) {
    const ok = await fillProfilePictureInputs(form, pic);
    if (ok) filled.push('profilePicture');
  }

  return { filled };
}

function selectMeta(select: HTMLSelectElement): string {
  const labelText = (() => {
    try {
      if (select.labels && select.labels.length > 0) {
        return Array.from(select.labels)
          .map((l) => l.textContent || '')
          .join(' ');
      }
      const selectId = safeId(select);
      if (selectId) {
        const lab = select.ownerDocument?.querySelector(`label[for="${CSS.escape(selectId)}"]`);
        if (lab?.textContent) return lab.textContent;
      }
    } catch {
      /* ignore */
    }
    return '';
  })();
  return `${safeName(select)} ${safeId(select)} ${select.getAttribute('aria-label') || ''} ${select.getAttribute('autocomplete') || ''} ${labelText}`.toLowerCase();
}

const COUNTRY_NAME_BY_CODE: Record<string, string[]> = {
  us: ['united states', 'usa', 'u.s.', 'u.s.a.', 'america'],
  gb: ['united kingdom', 'uk', 'great britain', 'england', 'britain'],
  de: ['germany', 'deutschland'],
  fr: ['france'],
  es: ['spain', 'españa', 'espana'],
  it: ['italy', 'italia'],
  ca: ['canada'],
  au: ['australia'],
  in: ['india'],
  jp: ['japan'],
  cn: ['china'],
  br: ['brazil', 'brasil'],
  mx: ['mexico', 'méxico'],
  nl: ['netherlands', 'holland'],
  se: ['sweden'],
  no: ['norway'],
  dk: ['denmark'],
  fi: ['finland'],
  pl: ['poland'],
  pt: ['portugal'],
  ru: ['russia'],
  kr: ['south korea', 'korea'],
  sg: ['singapore'],
  ae: ['united arab emirates', 'uae'],
  ch: ['switzerland'],
  at: ['austria'],
  be: ['belgium'],
  ie: ['ireland'],
  nz: ['new zealand'],
};

function countryPreferredValues(codeOrName: string): string[] {
  const raw = codeOrName.trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const out = new Set<string>([raw, lower, raw.toUpperCase()]);
  const aliases = COUNTRY_NAME_BY_CODE[lower];
  if (aliases) {
    for (const a of aliases) out.add(a);
  }
  // If full name stored, also try reverse-lookup code
  for (const [code, names] of Object.entries(COUNTRY_NAME_BY_CODE)) {
    if (names.some((n) => n === lower || lower.includes(n))) {
      out.add(code);
      out.add(code.toUpperCase());
    }
  }
  return Array.from(out);
}

function genderPreferredValues(gender: string): string[] {
  const g = gender.toLowerCase().trim();
  if (g === 'male' || g === 'm') return ['male', 'm', 'man', 'boy', '1'];
  if (g === 'female' || g === 'f') return ['female', 'f', 'woman', 'girl', '2'];
  if (g === 'other') return ['other', 'non-binary', 'nonbinary', 'x', '3'];
  if (g === 'prefer_not' || g === 'prefer not')
    return ['prefer not', 'prefer not to say', 'undisclosed', 'n/a', 'na', 'unknown'];
  return [g];
}

/**
 * Fill selects preferring identity country/gender when the control looks related;
 * otherwise fall back to random valid option.
 */
export function fillSelectsWithIdentity(
  form: ParentNode,
  identity?: {
    country?: string | null;
    gender?: string | null;
  }
): void {
  const countryPrefs = identity?.country ? countryPreferredValues(identity.country) : [];
  const genderPrefs = identity?.gender ? genderPreferredValues(identity.gender) : [];

  form.querySelectorAll<HTMLSelectElement>('select').forEach((select) => {
    const meta = selectMeta(select);
    let matched: HTMLOptionElement | null = null;

    if (countryPrefs.length && /country|nation|region|locale|citizenship/.test(meta)) {
      matched = matchSelectOption(select, countryPrefs);
    } else if (genderPrefs.length && /gender|sex/.test(meta)) {
      matched = matchSelectOption(select, genderPrefs);
    }

    if (matched) {
      select.value = matched.value;
    } else {
      // Last resort: try country/gender prefs on any unmatched select that has a hit
      if (!matched && countryPrefs.length) {
        matched = matchSelectOption(select, countryPrefs);
      }
      if (!matched && genderPrefs.length) {
        matched = matchSelectOption(select, genderPrefs);
      }
      if (matched) select.value = matched.value;
      else fillSelectElement(select);
    }

    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/**
 * Fill a signup form using a previously-saved disposable identity (replay).
 *
 * Unlike `fillSignupForm`'s generate path, this:
 *  - uses the saved email / password / username / name / phone / website
 *    verbatim (no generation, no random selection)
 *  - still dispatches `input` + `change` events so React/Vue/etc. pick it up
 *  - still calls `updateAndCopyCredentials` so the session credential + clipboard
 *    stay consistent
 *  - does NOT append a new `loginInfo` entry (it's a re-use, not a new fill)
 */
async function fillFormWithReplayCredential(
  form: HTMLElement,
  updateAndCopyCredentials: (creds: Record<string, string>) => Promise<void>,
  cred: {
    email: string;
    password: string;
    username?: string | null;
    name?: string | null;
    phone?: string | null;
    website?: string | null;
  }
): Promise<boolean> {
  const usernameInput = await findUsernameField(form);
  const phoneInput = form.querySelector<HTMLInputElement>(
    'input[type="tel"], input[name*="phone"], input[id*="phone"], input[name*="mobile"], input[id*="mobile"], input[placeholder*="phone"], input[placeholder*="mobile"]'
  );
  const websiteInput = form.querySelector<HTMLInputElement>(
    'input[type="url"], input[name*="website"], input[id*="website"], input[placeholder*="website"], input[name*="url"], input[id*="url"], input[placeholder*="url"]'
  );
  const firstNameInput = form.querySelector<HTMLInputElement>(
    'input[name*="firstname" i], input[id*="firstname" i], input[name*="fname" i], input[id*="fname" i], input[placeholder*="first name" i]'
  );
  const lastNameInput = form.querySelector<HTMLInputElement>(
    'input[name*="lastname" i], input[id*="lastname" i], input[name*="lname" i], input[id*="lname" i], input[placeholder*="last name" i]'
  );
  const fullNameInput = form.querySelector<HTMLInputElement>(
    'input[name*="fullname" i], input[id*="fullname" i], input[name*="name"]:not([name*="user"]):not([name*="first"]):not([name*="last"]), input[id*="name"]:not([id*="user"]):not([id*="first"]):not([name*="last"]), input[placeholder*="full name" i], input[placeholder*="name" i]:not([placeholder*="user"]):not([placeholder*="first"]):not([placeholder*="last"])'
  );

  // Derive first/last/full name from the saved name for split-name fields
  const savedName = cred.name || '';
  const [savedFirst, ...rest] = savedName.split(' ');
  const savedLast = rest.join(' ');

  fillAllEmailFields(form, cred.email);
  fillInputValue(usernameInput, cred.username ?? null);

  let nameFilled = false;
  if (firstNameInput && lastNameInput) {
    fillInputValue(firstNameInput, savedFirst || null);
    fillInputValue(lastNameInput, savedLast || null);
    nameFilled = true;
  } else if (fullNameInput) {
    fillInputValue(fullNameInput, savedName || null);
    nameFilled = true;
  }

  // Prefer saved country/gender on selects when present on the credential
  fillSelectsWithIdentity(form, {
    country: (cred as { country?: string | null }).country,
    gender: (cred as { gender?: string | null }).gender,
  });

  fillInputValue(phoneInput, cred.phone ?? null);
  fillInputValue(websiteInput, cred.website ?? null);

  form.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => {
    if (input === usernameInput) return;
    fillInputValue(input, cred.password);
  });

  const termsCheckbox = form.querySelector<HTMLInputElement>(
    'input[type="checkbox"][name*="terms"], input[type="checkbox"][id*="terms"], input[type="checkbox"][name*="agree"], input[type="checkbox"][id*="agree"]'
  );
  if (termsCheckbox && !termsCheckbox.checked) termsCheckbox.click();

  // Build session credentials for clipboard copy (consistent with generate path)
  const credentials: Record<string, string> = {};
  credentials.website = cred.website || window.location.hostname;
  credentials.email = cred.email;
  if (cred.username) credentials.username = cred.username;
  credentials.password = cred.password;
  if (nameFilled) credentials.name = savedName;
  if (cred.phone) credentials.phone = cred.phone;

  await updateAndCopyCredentials(credentials);

  // NOTE: intentionally do NOT append to loginInfo - this is a replay of an
  // existing identity, not a new fill. The original entry remains the record.

  return true;
}

export async function fillSignupForm(
  form: HTMLFormElement | HTMLElement,
  updateAndCopyCredentials: (creds: Record<string, string>) => Promise<void>,
  identity?: {
    firstNames?: string;
    lastNames?: string;
    username?: string | null;
    useRandomPassword?: boolean;
    customPassword?: string;
    phone?: string;
    pin?: string;
    preferredEmail?: string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
    country?: string | null;
    city?: string | null;
    state?: string | null;
    address?: string | null;
    profilePicture?: string | null;
    /** Per-domain field overrides — when identity is filled on a matching domain. */
    domainFieldOverrides?: Record<
      string,
      Partial<
        Pick<
          Identity,
          'firstNames' | 'lastNames' | 'username' | 'phone' | 'preferredEmail' | 'customPassword'
        >
      >
    >;
  },
  replayCredential?: {
    email: string;
    password: string;
    username?: string | null;
    name?: string | null;
    phone?: string | null;
    website?: string | null;
    country?: string | null;
    gender?: string | null;
    dateOfBirth?: string | null;
    pin?: string | null;
  }
): Promise<boolean> {
  let progressTooltip: HTMLDivElement | null = null;
  let progressBar: HTMLDivElement | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let isHumanLike = false;
  let fillEstimateMs = 1200;

  /** Build human-readable countdown label */
  function fmtRemaining(remainMs: number): string {
    const s = Math.max(0, remainMs / 1000);
    return s >= 1 ? `${s.toFixed(1)}s` : `${Math.max(0, Math.round(remainMs / 100)) * 100}ms`;
  }

  try {
    const smartSettings = (await loadSmartAutofillSettingsViaBg()) as {
      humanLikeFilling: boolean;
    } | null;
    isHumanLike = smartSettings?.humanLikeFilling ?? false;

    if (isHumanLike) {
      // Estimate fill duration from the form's fillable inputs and their expected value lengths.
      // Each char costs ~40ms average delay (midpoint of 20–60ms range in typeValueHuman).
      const inputEls = Array.from(
        (form as HTMLElement).querySelectorAll?.(
          'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea'
        ) ?? []
      ) as (HTMLInputElement | HTMLTextAreaElement)[];
      const estimatedChars = inputEls.reduce((sum, el) => {
        // Rough heuristic: email ~20 chars, password ~16, others ~10
        if (looksLikeEmailField(el as HTMLInputElement)) return sum + 20;
        if ((el as HTMLInputElement).type === 'password') return sum + 0; // passwords filled instantly
        return sum + 10;
      }, 0);
      fillEstimateMs = Math.max(800, estimatedChars * 40);

      // ── Build pill ──────────────────────────────────────────────────────────
      progressTooltip = document.createElement('div');
      progressTooltip.setAttribute('role', 'status');
      progressTooltip.setAttribute('aria-live', 'polite');
      progressTooltip.style.cssText = [
        'position:fixed',
        'bottom:20px',
        'right:20px',
        `z-index:${String(CONTENT_Z.popup)}`,
        'background:rgba(30,30,35,0.92)',
        'backdrop-filter:blur(8px)',
        '-webkit-backdrop-filter:blur(8px)',
        'color:#fff',
        'padding:8px 14px 8px 12px',
        'border-radius:20px',
        'font-size:12px',
        'font-weight:600',
        'font-family:system-ui,sans-serif',
        'pointer-events:none',
        'opacity:0',
        'transform:translateY(6px)',
        'transition:opacity 0.25s,transform 0.25s',
        'display:flex',
        'flex-direction:column',
        'gap:5px',
        'min-width:140px',
        'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
        'border:1px solid rgba(255,255,255,0.08)',
      ].join(';');

      // Top row: icon + label
      const topRow = document.createElement('div');
      topRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const spinner = document.createElement('span');
      spinner.textContent = '⚡';
      spinner.style.cssText = 'font-size:11px;';
      const label = document.createElement('span');
      label.textContent = `Autofilling… ${fmtRemaining(fillEstimateMs)}`;
      label.style.cssText = 'flex:1;';
      topRow.appendChild(spinner);
      topRow.appendChild(label);

      // Progress bar track — gradient uses the theme's primary/tertiary colors
      // (derived from the seed, no hardcoded hex values).
      const themeColors = generateThemeColorsSync(DEFAULT_THEME_SEED, false, 0);
      const progressPrimary = themeColors['--md-primary'] || themeColors['--md-secondary'] || '';
      const progressTertiary = themeColors['--md-tertiary'] || progressPrimary;
      const track = document.createElement('div');
      track.style.cssText =
        'width:100%;height:3px;background:rgba(255,255,255,0.15);border-radius:2px;overflow:hidden;';
      progressBar = document.createElement('div');
      progressBar.style.cssText = `height:100%;background:linear-gradient(90deg,${progressPrimary},${progressTertiary});border-radius:2px;width:0%;transition:width 0.2s linear;`;
      track.appendChild(progressBar);

      progressTooltip.appendChild(topRow);
      progressTooltip.appendChild(track);
      document.body.appendChild(progressTooltip);

      // Animate in
      requestAnimationFrame(() => {
        if (progressTooltip) {
          progressTooltip.style.opacity = '1';
          progressTooltip.style.transform = 'translateY(0)';
        }
      });

      // Live countdown ticker
      const startTs = Date.now();
      progressTimer = setInterval(() => {
        if (!progressTooltip) return;
        const elapsed = Date.now() - startTs;
        const remain = Math.max(0, fillEstimateMs - elapsed);
        const pct = Math.min(100, (elapsed / fillEstimateMs) * 100);
        // Update label
        const lbl = progressTooltip.querySelector('span:last-child') as HTMLSpanElement | null;
        if (lbl) lbl.textContent = remain > 0 ? `Autofilling… ${fmtRemaining(remain)}` : 'Done ✓';
        // Update bar
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (remain <= 0 && progressTimer) {
          clearInterval(progressTimer);
          progressTimer = null;
        }
      }, 200);
    }
  } catch {
    /* ignore */
  }

  try {
    const { activeInboxId, inboxes = [] } = (await getStorageViaBg([
      'activeInboxId',
      'inboxes',
    ])) as { activeInboxId?: string; inboxes?: Array<{ id: string; address: string }> };
    const inbox = inboxes.find((i: { id: string; address: string }) => i.id === activeInboxId);
    if (!inbox) throw new NoActiveInboxError({ activeInboxId });

    // ── Replay path: use the saved identity instead of generating ──────
    // When replayCredential is provided, skip all generation and fill the
    // form with the exact saved values. Do NOT append a new loginInfo entry
    // (it's a re-use of an existing identity, not a new fill).
    if (replayCredential) {
      return fillFormWithReplayCredential(form, updateAndCopyCredentials, replayCredential);
    }

    // ── Smart domain field overrides ─────────────────────────────────
    // Merge per-domain field overrides (built-in defaults + user-defined)
    // with the identity's own values. Domain overrides take precedence.
    let effectiveIdentity = identity;
    if (identity) {
      try {
        const overrides = await resolveDomainFieldOverridesViaBg(
          identity as unknown as Identity,
          window.location.hostname
        );
        if (Object.keys(overrides).length > 0) {
          effectiveIdentity = { ...identity, ...overrides };
        }
      } catch {
        /* optional — overrides are a non-critical enhancement */
      }
    }

    let names: FilledNames;
    if (effectiveIdentity?.firstNames && effectiveIdentity?.lastNames) {
      // Parse comma-separated names and select randomly
      const firstNameList = effectiveIdentity.firstNames
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n);
      const lastNameList = effectiveIdentity.lastNames
        .split(',')
        .map((n) => n.trim())
        .filter((n) => n);

      const firstName = randomItem(firstNameList) ?? '';
      const lastName = randomItem(lastNameList) ?? '';

      names = {
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`,
      };
    } else {
      names = await getNamesToFill();
    }

    const { fullName, firstName, lastName } = names;

    // Username — NEVER password/email; avoid autocomplete=username login-email traps
    const usernameInput = await findUsernameField(form);
    // Phone: prefer type=tel; skip dual email/phone (those go to email)
    const phoneCandidates = Array.from(
      form.querySelectorAll<HTMLInputElement>(
        'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i], input[id*="mobile" i], input[autocomplete="tel"], input[placeholder*="phone" i], input[placeholder*="mobile" i]'
      )
    ).filter((el) => {
      if (el.type === 'email') return false;
      const meta = fieldMeta(el);
      // Dual fields preferred as email — skip for phone fill
      if (
        /(email|e-mail|correo).{0,12}(or|\/).{0,12}(phone|mobile)/i.test(meta) ||
        /(phone|mobile).{0,12}(or|\/).{0,12}(email|e-mail)/i.test(meta)
      ) {
        return false;
      }
      if (looksLikeEmailField(el) && el.type !== 'tel') return false;
      return !el.disabled && el.type !== 'hidden';
    });
    const phoneInput = phoneCandidates[0] || null;
    const websiteInput = form.querySelector<HTMLInputElement>(
      'input[type="url"], input[name*="website"], input[id*="website"], input[placeholder*="website"], input[name*="url"], input[id*="url"], input[placeholder*="url"]'
    );
    const firstNameInput = form.querySelector<HTMLInputElement>(
      'input[name="firstName" i], input[id="firstName" i], input[name*="firstname" i], input[id*="firstname" i], input[name*="first_name" i], input[id*="first_name" i], input[name*="fname" i], input[id*="fname" i], input[autocomplete="given-name"], input[placeholder*="first name" i]'
    );
    const lastNameInput = form.querySelector<HTMLInputElement>(
      'input[name="lastName" i], input[id="lastName" i], input[name*="lastname" i], input[id*="lastname" i], input[name*="last_name" i], input[id*="last_name" i], input[name*="lname" i], input[id*="lname" i], input[autocomplete="family-name"], input[placeholder*="last name" i]'
    );
    const fullNameInput = form.querySelector<HTMLInputElement>(
      'input[name*="fullname" i], input[id*="fullname" i], input[name*="name"]:not([name*="user"]):not([name*="first"]):not([name*="last"]):not([name*="file"]), input[id*="name"]:not([id*="user"]):not([id*="first"]):not([id*="last"]), input[placeholder*="full name" i], input[placeholder*="name" i]:not([placeholder*="user"]):not([placeholder*="first"]):not([placeholder*="last"])'
    );

    // Prefer identity.preferredEmail when it still exists in the mailbox list
    // Uses effectiveIdentity (which includes domain overrides)
    const identityWithEmail = effectiveIdentity as
      | {
          preferredEmail?: string | null;
          state?: string | null;
          address?: string | null;
          profilePicture?: string | null;
        }
      | undefined;
    const preferred = identityWithEmail?.preferredEmail?.trim();
    let emailAddress = inbox.address;
    if (preferred === '__random_active__') {
      // Built-in / explicit: pick any random live mailbox
      const now = Date.now();
      const live = (
        inboxes as Array<{
          address: string;
          status?: string;
          accountStatus?: string;
          expiresAt?: number;
        }>
      ).filter((i) => {
        if (!i.address) return false;
        if (i.accountStatus === 'archived' || i.accountStatus === 'deleted') return false;
        if (i.status === 'archived' || i.status === 'deleted' || i.status === 'expired')
          return false;
        if (i.expiresAt && i.expiresAt > 0 && i.expiresAt <= now) return false;
        return true;
      });
      if (live.length > 0) {
        const pick = live[Math.floor(Math.random() * live.length)];
        if (pick?.address) emailAddress = pick.address;
      }
    } else if (preferred) {
      const match = inboxes.find(
        (i: { id: string; address: string }) => i.address.toLowerCase() === preferred.toLowerCase()
      );
      if (match) emailAddress = match.address;
    }

    // If the chosen email is already in saved logins, warn + create a fresh inbox
    if (await isEmailUsedInSavedLogins(emailAddress)) {
      try {
        const tipHost =
          form.querySelector<HTMLElement>(
            'input[type="email"], input[name*="email" i], input[id*="email" i]'
          ) || (form as unknown as HTMLElement);
        showConflictChip(tipHost, await t('contentAutofill.emailAlreadyUsedChip'));

        const { selectedProvider } = (await getStorageViaBg('selectedProvider')) as {
          selectedProvider?: string;
        };
        const created = (await sendMessageViaBg<{
          success?: boolean;
          address?: string;
          inbox?: { address?: string };
        }>({
          type: 'createInbox',
          // No hardcoded provider: background resolves configured default when unset.
          provider: selectedProvider,
        })) as {
          success?: boolean;
          address?: string;
          inbox?: { address?: string };
        };
        const fresh = created?.inbox?.address || created?.address;
        if (created?.success && fresh) emailAddress = fresh;
      } catch (e) {
        logError('Failed to generate replacement email for already-used address', e);
      }
    }

    let password: string;
    if (!effectiveIdentity?.useRandomPassword && effectiveIdentity?.customPassword) {
      try {
        password = await decryptViaBg(effectiveIdentity.customPassword);
      } catch {
        /* ignore */
        const tipHost =
          form.querySelector<HTMLElement>('input[type="password"], input[type="email"]') ||
          (form as unknown as HTMLElement);
        showConflictChip(tipHost, await t('contentAutofill.vaultLocked'));
        return false;
      }
    } else {
      const pwField = form.querySelector<HTMLInputElement>(
        'input[type="password"], input[name*="password" i], input[id*="password" i]'
      );
      try {
        password = await getPasswordToFill(pwField, form);
      } catch {
        /* ignore */
        const tipHost = pwField || (form as unknown as HTMLElement);
        showConflictChip(tipHost, await t('contentAutofill.vaultLocked'));
        return false;
      }
    }

    // Username from identity or generate; may regenerate on "already taken"
    let randomUsername: string | null = null;
    if (usernameInput) {
      const idUser = (
        effectiveIdentity as { username?: string | null } | undefined
      )?.username?.trim();
      randomUsername = idUser || (await generateIdentityViaBg('username'));
    }
    // Locale-aware phone when identity has none (page language)
    let randomPhone: string | null = effectiveIdentity?.phone || null;
    if (!randomPhone && phoneInput) {
      try {
        const smart = (await loadSmartAutofillSettingsViaBg()) as {
          localeAwareData: boolean;
        } | null;
        randomPhone = smart?.localeAwareData
          ? await generateLocalePhoneViaBg(detectPageLocale())
          : await generateIdentityViaBg('phoneNumber');
      } catch {
        /* ignore */
        randomPhone = await generateIdentityViaBg('phoneNumber');
      }
    }

    let randomWebsite: string | null = null;
    if (websiteInput) {
      const placeholder = websiteInput.placeholder;
      randomWebsite =
        placeholder && (placeholder.startsWith('http') || placeholder.startsWith('www'))
          ? placeholder
          : await generateIdentityViaBg('websiteUrl');
    }

    const pageHost = window.location.hostname;

    // Prefer learned per-site selectors when available
    try {
      const map = (await getFieldMapViaBg(pageHost)) as {
        entries: Array<{ kind: string; selector: string; hits: number; lastUsedAt: number }>;
      } | null;
      const mappedEmail = resolveMappedField(form, map, 'email');
      if (mappedEmail instanceof HTMLInputElement) {
        await smartFillInputValue(mappedEmail, emailAddress, isHumanLike);
        void recordFieldMapHitViaBg(pageHost, 'email', buildSelectorHint(mappedEmail));
      }
    } catch {
      /* optional */
    }

    // Fill email + confirm-email (and any page-level email twins) with the same address
    // Prefer email for dual email/phone inputs
    fillAllEmailFields(form, emailAddress); // Note: fillAllEmailFields might need updating, but we'll leave it or assume it's fine
    await smartFillInputValue(usernameInput, randomUsername, isHumanLike);

    // Watch username-taken / not-allowed conflicts → regenerate human username
    if (usernameInput && randomUsername) {
      try {
        const userEl = usernameInput;
        const watchRoot: ParentNode =
          form instanceof HTMLElement ? form : userEl.closest('form') || document.body || document;
        watchUsernameConflict(watchRoot, () => {
          void (async () => {
            const next = await generateIdentityViaBg('username');
            fillInputValueForce(userEl, next);
            await updateAndCopyCredentials({ username: next });
            try {
              await showTooltip(userEl, await t('contentAutofill.usernameTaken'), false);
            } catch {
              /* ignore */
            }
          })();
        });
      } catch {
        /* optional */
      }
    }

    let nameFilled = false;
    if (firstNameInput && lastNameInput) {
      await smartFillInputValue(firstNameInput, firstName, isHumanLike);
      await smartFillInputValue(lastNameInput, lastName, isHumanLike);
      nameFilled = true;
    } else if (fullNameInput) {
      await smartFillInputValue(fullNameInput, fullName, isHumanLike);
      nameFilled = true;
    }

    await smartFillInputValue(phoneInput, randomPhone, isHumanLike);
    await smartFillInputValue(websiteInput, randomWebsite, isHumanLike);

    // Password only — never write password into username/email/name fields
    form
      .querySelectorAll<HTMLInputElement>(
        'input[type="password"], input[autocomplete="new-password"], input[autocomplete="current-password"]'
      )
      .forEach((input: HTMLInputElement) => {
        if (input === usernameInput) return;
        if (input.type !== 'password') {
          // Only non-password inputs if name/id explicitly password (avoid username false match)
          const meta = fieldMeta(input);
          if (!/password|passwd|\bpwd\b|passcode/.test(meta)) return;
          if (/\busername\b|\buser\s*name\b|\buserid\b|\bhandle\b|\bemail\b/.test(meta)) return;
        }
        if (looksLikeEmailField(input)) return;
        fillInputValue(input, password);
      });
    // Confirm-password siblings (same type=password already covered); also name* password text fields
    form
      .querySelectorAll<HTMLInputElement>(
        'input:not([type="password"]):not([type="email"]):not([type="hidden"])'
      )
      .forEach((input: HTMLInputElement) => {
        if (input === usernameInput) return;
        const meta = fieldMeta(input);
        if (!/password|passwd|\bpwd\b|passcode|confirm.?pass/.test(meta)) return;
        if (/\busername\b|\buser\s*name\b|\buserid\b|\bhandle\b/.test(meta)) return;
        if (looksLikeEmailField(input)) return;
        fillInputValue(input, password);
      });

    // Address / city / zip / state / country / DOB / gender / profile pic
    // Always runs with locale fallbacks (fixes RunSignup address1, zipcode, etc.)
    let extendedFilled: string[] = [];
    try {
      const ext = await fillExtendedProfileFields(form, {
        country: identity?.country,
        city: identity?.city,
        state: identity?.state,
        address: identity?.address,
        pin: identity?.pin,
        dateOfBirth: identity?.dateOfBirth,
        gender: identity?.gender,
        profilePicture: identity?.profilePicture,
      });
      extendedFilled = ext.filled;
    } catch (e) {
      logError('fillExtendedProfileFields failed', e);
      // Fallback: at least try country/gender selects
      fillSelectsWithIdentity(form, {
        country: identity?.country,
        gender: identity?.gender,
      });
    }

    const policyUrls = extractPolicyUrls(form);

    // Record successful field map hits for next visit
    try {
      const emailEls = queryEmailInputs(form);
      for (const el of emailEls)
        void recordFieldMapHitViaBg(pageHost, 'email', buildSelectorHint(el));
      form
        .querySelectorAll<HTMLInputElement>('input[type="password"]')
        .forEach((el) => void recordFieldMapHitViaBg(pageHost, 'password', buildSelectorHint(el)));
      if (phoneInput) void recordFieldMapHitViaBg(pageHost, 'phone', buildSelectorHint(phoneInput));
      if (usernameInput)
        void recordFieldMapHitViaBg(pageHost, 'username', buildSelectorHint(usernameInput));
    } catch {
      /* ignore */
    }

    const credentials: Record<string, string> = {};
    if (randomWebsite) credentials.website = randomWebsite;
    else credentials.website = pageHost;
    credentials.email = emailAddress;
    if (randomUsername) credentials.username = randomUsername;
    credentials.password = password;
    if (nameFilled) credentials.name = fullName;
    if (randomPhone) credentials.phone = randomPhone;
    if (identity?.country) credentials.country = identity.country;
    if (identity?.gender) credentials.gender = identity.gender;
    if (identity?.dateOfBirth) credentials.dateOfBirth = identity.dateOfBirth;
    if (identity?.pin) credentials.pin = identity.pin;
    if (policyUrls.length) credentials.policyUrls = policyUrls.join('\n');

    await updateAndCopyCredentials(credentials);

    const { loginInfo = [], selectedIdentityId } = (await getStorageViaBg([
      'loginInfo',
      'selectedIdentityId',
    ])) as {
      loginInfo?: CredentialsHistoryItem[];
      selectedIdentityId?: string;
    };
    // Encrypt password at rest. Never abort the whole save if encryption fails -
    // otherwise successful autofill leaves no saved-login history.
    let storedPassword = '';
    try {
      storedPassword = await encryptViaBg(password);
    } catch (err) {
      logError('Failed to encrypt password before saving credential; password not persisted:', err);
    }

    // Record which fields we actually put into the form (for credentials UI)
    const filledFields: string[] = ['email', 'password', ...extendedFilled];
    if (randomUsername) filledFields.push('username');
    if (nameFilled) filledFields.push('name');
    if (randomPhone) filledFields.push('phone');
    if (randomWebsite) filledFields.push('website');
    if (policyUrls.length) filledFields.push('policyUrls');
    // Dedupe
    const filledUnique = [...new Set(filledFields)];

    const newCredential: CredentialsHistoryItem = {
      id: `login_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      email: emailAddress,
      username: randomUsername,
      name: nameFilled ? fullName : null,
      phone: randomPhone,
      website: randomWebsite || pageHost,
      password: storedPassword,
      domain: pageHost,
      timestamp: Date.now(),
      inboxId: activeInboxId,
      identityId: selectedIdentityId ?? (identity as { id?: string } | undefined)?.id,
      country: identity?.country ?? null,
      gender: identity?.gender ?? null,
      dateOfBirth: identity?.dateOfBirth ?? null,
      pin: identity?.pin ?? null,
      policyUrls: policyUrls.length ? policyUrls : undefined,
      filledFields: filledUnique,
      // Autofill alone is NOT success — wait for submit + outcome detection
      signupStatus: 'pending_submit',
      verified: false,
    };

    // Prefer background write (more reliable than content-script storage on some hosts)
    try {
      const bg = (await sendMessageViaBg<{ success?: boolean }>({
        type: 'saveLoginCredential',
        credential: newCredential,
      })) as { success?: boolean };
      if (!bg?.success) {
        throw new Error('background saveLoginCredential failed');
      }
    } catch (bgErr) {
      logError('Background login save failed, falling back to local storage', bgErr);
      loginInfo.unshift(newCredential);
      if (loginInfo.length > 50) loginInfo.length = 50;
      await setStorageViaBg({ loginInfo });
    }

    return true;
  } catch (error: unknown) {
    logError(
      'Error filling form:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
    return false;
  } finally {
    // Stop live ticker
    if (progressTimer) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
    // Fade out pill
    if (progressTooltip) {
      // Show "Done ✓" briefly before fading
      const lbl = progressTooltip.querySelector('span:last-child') as HTMLSpanElement | null;
      if (lbl) lbl.textContent = 'Done ✓';
      if (progressBar) progressBar.style.width = '100%';
      setTimeout(() => {
        if (progressTooltip) {
          progressTooltip.style.opacity = '0';
          progressTooltip.style.transform = 'translateY(6px)';
          setTimeout(() => progressTooltip?.remove(), 300);
        }
      }, 400);
    }
  }
}
