/**
 * Autofill button injection and removal.
 */

import { buildAutofillPlan } from '@/features/intelligence/autofill-plan.js';
import {
  createFreshInboxAddress,
  watchEmailConflict,
} from '@/features/intelligence/conflict-watch.js';
import { showDryRunPreview } from '@/features/intelligence/dry-run.js';
import { maybeHumanDelay } from '@/features/intelligence/fill-timing.js';
import { armSignupOutcomeAfterSubmit } from '@/features/intelligence/submit-action.js';
import { getFormUndoStack } from '@/features/intelligence/undo-stack.js';
import type { ReusableCredential } from '@/features/login-info/login-crypto.js';
import {
  detectWizardStepFromPage,
  generateIdentityViaBg,
  getActiveInboxMetaViaBg,
  getIconSvgViaBg,
  getStorageViaBg,
  loadSmartAutofillSettingsViaBg,
  pickFreshestIdentityViaBg,
  recordAutofillFailureViaBg,
  recordAutofillOutcomeViaBg,
  recordAutofillSuccessViaBg,
  routeIdentityForDomainViaBg,
  sendMessageViaBg,
  setStorageViaBg,
  upsertWizardSessionViaBg,
} from '@/utils/content-bg-bridge.js';
import { BUTTON_OPACITY_DEFAULT, BUTTON_OPACITY_HOVER } from '@/utils/content-constants.js';
import { t } from '@/utils/content-i18n.js';
import { trustedClick } from '@/utils/dom-guard.js';
import { safeId, safeName, safePlaceholder } from '@/utils/dom-safe.js';
import { logError, logWarn } from '@/utils/logger.js';
import { CONTENT_Z } from '@/utils/portal-layers.js';
import {
  positionAfterElement,
  positionAtEndOfField,
  trackElementPosition,
} from '../dom/positioning.js';
import {
  BUTTON_CLASS,
  CONTAINER_CLASS,
  getOrCreateShadowRoot,
  POPUP_CLASS,
} from '../dom/shadow-dom.js';
import { showConflictChip, showFillMicroStatus, showTooltip } from '../dom/tooltip.js';
import { startMultiStepOtpWatch } from '../otp/multi-step-otp.js';
import { showWaitOtpPanel } from '../otp/wait-otp-panel.js';
import {
  classifyFormIntent,
  isSigninForm,
  isSignupForm,
  scoreSignupForm,
} from './form-detector.js';
import {
  type AutofillBlockReason,
  fillAllEmailFields,
  fillInputValue,
  fillSignupForm,
  findAutofillAllAnchor,
  getAutofillBlockReason,
  getNamesToFill,
  getPasswordToFill,
  isEmailUsedInSavedLogins,
} from './form-filler.js';

type FieldSnapshot = {
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  value: string;
  checked?: boolean;
};

function snapshotFormFields(form: ParentNode): FieldSnapshot[] {
  const out: FieldSnapshot[] = [];
  try {
    const fields = form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >('input, select, textarea');
    for (const el of Array.from(fields)) {
      if ((el as HTMLInputElement).type === 'password') {
        out.push({ el, value: (el as HTMLInputElement).value || '', checked: false });
        continue;
      }
      if (
        (el as HTMLInputElement).type === 'checkbox' ||
        (el as HTMLInputElement).type === 'radio'
      ) {
        out.push({ el, value: '', checked: !!(el as HTMLInputElement).checked });
        continue;
      }
      out.push({ el, value: el.value || '' });
    }
  } catch {
    /* ignore */
  }
  return out;
}

function restoreFormFields(snap: FieldSnapshot[]): void {
  for (const s of snap) {
    try {
      if (!s.el.isConnected) continue;
      if (s.checked !== undefined && 'checked' in s.el) {
        (s.el as HTMLInputElement).checked = !!s.checked;
      } else {
        s.el.value = s.value;
      }
      s.el.dispatchEvent(new Event('input', { bubbles: true }));
      s.el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      /* ignore */
    }
  }
}

/** Create a new inbox via background and fill email + confirm fields. */
async function generateAndFillNewEmail(
  form: HTMLElement | null,
  inputField: HTMLInputElement | HTMLSelectElement,
  updateAndCopyCredentials: (creds: Record<string, string>) => Promise<void>
): Promise<boolean> {
  const { selectedProvider } = (await getStorageViaBg('selectedProvider')) as {
    selectedProvider?: string;
  };
  const result = (await sendMessageViaBg({
    type: 'createInbox',
    // No hardcoded provider: background resolves configured default when unset.
    provider: selectedProvider,
  })) as {
    success?: boolean;
    address?: string;
    inbox?: { address?: string };
    error?: string | { message?: string };
  };
  const address = result?.inbox?.address || result?.address;
  if (result?.success && address) {
    fillAllEmailFields(form, address, inputField as HTMLInputElement);
    fillInputValue(inputField as HTMLInputElement, address);
    await updateAndCopyCredentials({ email: address });
    return true;
  }
  const errMsg =
    typeof result?.error === 'string'
      ? result.error
      : result?.error?.message || (await t('contentAutofill.generateFailed'));
  await showTooltip(inputField as HTMLInputElement, errMsg, true);
  return false;
}

/** Extension logo mark for in-field buttons (resolved via background to keep icon-svg.ts out of content bundle). */
let _extLogoSvg: Promise<string> | null = null;
function getExtLogoSvg(): Promise<string> {
  if (!_extLogoSvg) {
    _extLogoSvg = getIconSvgViaBg('logoMark', { size: 14, color: 'currentColor' });
  }
  return _extLogoSvg;
}

async function openExtensionForReason(
  reason: AutofillBlockReason | 'create-identity' | 'edit-identity' | string,
  hint: string,
  extra?: { identityId?: string }
): Promise<void> {
  try {
    await sendMessageViaBg({
      type: 'openExtensionUi',
      reason: reason || 'setup',
      hint,
      identityId: extra?.identityId || '',
    });
  } catch (e) {
    logError('Failed to open extension UI', e);
  }
}

async function ensureAutofillReady(inputField?: HTMLElement): Promise<boolean> {
  const block = await getAutofillBlockReason();
  if (!block) return true;
  const key =
    block === 'setup'
      ? 'contentAutofill.setupRequired'
      : block === 'expired'
        ? 'contentAutofill.addressExpired'
        : 'contentAutofill.noActiveAddress';
  const msg = await t(key);
  if (inputField) {
    try {
      await showTooltip(inputField as HTMLInputElement, msg, true);
    } catch {
      /* ignore */
    }
  }
  await openExtensionForReason(block, msg);
  // Flag so UI can show “return to form after setup”
  try {
    await setStorageViaBg({
      pendingAutofillReturn: true,
      pendingAutofillUrl: typeof location !== 'undefined' ? location.href : '',
      pendingAutofillAt: Date.now(),
    });
  } catch {
    /* ignore */
    try {
      await setStorageViaBg({
        pendingAutofillReturn: true,
        pendingAutofillUrl: typeof location !== 'undefined' ? location.href : '',
        pendingAutofillAt: Date.now(),
      });
    } catch {
      /* ignore */
    }
  }
  return false;
}

function appendSvgIcon(target: HTMLElement | null, svgMarkup: string): void {
  if (!target || !(target instanceof Element) || !target.isConnected) return;
  const voidElements = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'embed', 'area']);
  if (voidElements.has(target.tagName.toLowerCase())) return;

  try {
    // innerHTML is more reliable across CSPs than DOMParser for tiny SVGs
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;align-items:center;justify-content:center;line-height:0;';
    wrap.innerHTML = svgMarkup;
    if (wrap.firstChild) {
      target.appendChild(wrap);
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    const doc = new DOMParser().parseFromString(svgMarkup, 'image/svg+xml');
    const svg = doc.documentElement;
    if (svg && svg.nodeName.toLowerCase() === 'svg' && !(svg instanceof HTMLUnknownElement)) {
      target.appendChild(document.importNode(svg, true));
      return;
    }
  } catch {
    /* ignore */
  }
  // Last resort glyph so the control is never empty
  target.textContent = '1C';
}

let activePopupInfo: {
  element: HTMLDivElement;
  cleanup: () => void;
} | null = null;

function closeActivePopup(): void {
  if (activePopupInfo) {
    if (activePopupInfo.element.parentNode) {
      activePopupInfo.element.parentNode.removeChild(activePopupInfo.element);
    }
    activePopupInfo.cleanup();
    activePopupInfo = null;
  }
}

function positionPopupBelowField(rect: DOMRect): { top: number; left: number; visible: boolean } {
  return {
    top: rect.bottom + 4,
    left: Math.max(8, rect.left),
    visible: true,
  };
}

if (typeof document !== 'undefined') {
  document.addEventListener(
    'mousedown',
    (e: MouseEvent) => {
      if (!activePopupInfo) return;
      // Closed shadow DOM retargets e.target to the host — use composedPath()
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
      const insidePopup = path.includes(activePopupInfo.element);
      const onFieldBtn = path.some(
        (n) =>
          n instanceof Element &&
          (n.classList?.contains(BUTTON_CLASS) || n.classList?.contains(CONTAINER_CLASS))
      );
      if (insidePopup || onFieldBtn) return;
      closeActivePopup();
    },
    true
  );
}

async function showAutofillPopup(
  inputField: HTMLInputElement | HTMLSelectElement,
  form: HTMLElement,
  isEmail: boolean,
  isPassword: boolean,
  isPhone: boolean,
  isUsername: boolean,
  isFirstName: boolean,
  isLastName: boolean,
  isFullName: boolean,
  isWebsite: boolean,
  isCheckbox: boolean,
  isSelect: boolean,
  updateAndCopyCredentials: (creds: Record<string, string>) => Promise<void>
): Promise<void> {
  closeActivePopup();

  // Setup / live-address gate before building menu
  if (!(await ensureAutofillReady(inputField))) {
    return;
  }

  const popupDiv = document.createElement('div');
  popupDiv.className = POPUP_CLASS;
  popupDiv.style.cssText = `
    position: fixed;
    z-index: ${CONTENT_Z.popup};
    pointer-events: auto;
    background-color: var(--md-surface-container);
    border: 1px solid var(--md-outline-variant);
    border-radius: 12px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
    padding: 8px 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 13px;
    min-width: 240px;
    max-width: 320px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    font-weight: 600;
    color: var(--md-on-surface);
    border-bottom: 1px solid var(--md-outline-variant);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  `;
  const logoSvg = await getIconSvgViaBg('logoMark', {
    size: 16,
    color: 'var(--md-primary, #4c662b)',
  });
  const headerTitle = await t('contentAutofill.popupTitle');
  header.innerHTML = `${logoSvg}<span></span>`;
  const titleSpan = header.querySelector('span');
  if (titleSpan) titleSpan.textContent = headerTitle;
  popupDiv.appendChild(header);

  const addItem = (
    label: string,
    iconSvg: string,
    onClick: () => Promise<void>,
    isHighlighted = false
  ) => {
    const item = document.createElement('button');
    item.style.cssText = `
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      width: 100%;
      background: none;
      border: none;
      cursor: pointer;
      text-align: left;
      font-size: 13px;
      font-family: inherit;
      color: ${isHighlighted ? 'var(--md-primary)' : 'var(--md-on-surface-variant)'};
      font-weight: ${isHighlighted ? '500' : 'normal'};
      box-sizing: border-box;
      transition: background-color 0.15s;
    `;
    item.onmouseover = () => {
      item.style.backgroundColor = 'var(--md-surface-variant)';
    };
    item.onmouseout = () => {
      item.style.backgroundColor = 'transparent';
    };

    const iconSpan = document.createElement('span');
    iconSpan.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      color: ${isHighlighted ? 'var(--md-primary)' : 'var(--md-on-surface-variant)'};
      fill: currentColor;
    `;
    iconSpan.innerHTML = iconSvg;
    item.appendChild(iconSpan);

    const labelSpan = document.createElement('span');
    labelSpan.style.cssText = `
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    `;
    labelSpan.innerText = label;
    item.appendChild(labelSpan);

    item.addEventListener(
      'click',
      trustedClick(async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await onClick();
        } catch (err) {
          logError('Popup item action error:', err);
        } finally {
          closeActivePopup();
        }
      })
    );

    popupDiv.appendChild(item);
    return item;
  };

  // Build options list
  if (isEmail) {
    const { activeInboxId, inboxes = [] } = (await getStorageViaBg([
      'activeInboxId',
      'inboxes',
    ])) as {
      activeInboxId?: string;
      inboxes?: Array<{
        id: string;
        address: string;
        status?: string;
        accountStatus?: string;
        expiresAt?: number;
      }>;
    };

    const now = Date.now();
    const liveInboxes = inboxes.filter((i) => {
      if (i.accountStatus === 'archived' || i.accountStatus === 'deleted') return false;
      if (i.status === 'archived' || i.status === 'deleted' || i.status === 'expired') return false;
      if (i.expiresAt && i.expiresAt > 0 && i.expiresAt <= now) return false;
      return !!i.address;
    });

    const activeInbox = liveInboxes.find((i) => i.id === activeInboxId) || liveInboxes[0] || null;

    if (activeInbox) {
      addItem(
        activeInbox.address,
        await getIconSvgViaBg('mailSolid', { size: 16 }),
        async () => {
          if (await isEmailUsedInSavedLogins(activeInbox.address)) {
            showConflictChip(
              inputField as HTMLInputElement,
              await t('contentAutofill.emailAlreadyUsedChip')
            );
            await generateAndFillNewEmail(form, inputField, updateAndCopyCredentials);
            return;
          }
          // Always refresh email + confirm-email twins together
          fillAllEmailFields(form, activeInbox.address, inputField as HTMLInputElement);
          await updateAndCopyCredentials({ email: activeInbox.address });
        },
        true
      );
    }

    const otherInboxes = liveInboxes.filter((i) => i.id !== activeInbox?.id);
    for (const inbox of otherInboxes.slice(0, 3)) {
      addItem(inbox.address, await getIconSvgViaBg('mailSolid', { size: 16 }), async () => {
        if (await isEmailUsedInSavedLogins(inbox.address)) {
          showConflictChip(
            inputField as HTMLInputElement,
            await t('contentAutofill.emailAlreadyUsedChip')
          );
          await generateAndFillNewEmail(form, inputField, updateAndCopyCredentials);
          return;
        }
        fillAllEmailFields(form, inbox.address, inputField as HTMLInputElement);
        await updateAndCopyCredentials({ email: inbox.address });
      });
    }

    const hr = document.createElement('div');
    hr.style.cssText = 'height: 1px; background-color: var(--md-outline-variant); margin: 4px 0;';
    popupDiv.appendChild(hr);

    addItem(
      await t('contentAutofill.generateNewEmail'),
      await getIconSvgViaBg('plus', { size: 16 }),
      async () => {
        await generateAndFillNewEmail(form, inputField, updateAndCopyCredentials);
      }
    );
  } else if (isPassword) {
    addItem(
      await t('contentAutofill.generatePassword'),
      await getIconSvgViaBg('lock', { size: 16 }),
      async () => {
        const password = await getPasswordToFill(inputField as HTMLInputElement, form);
        fillInputValue(inputField as HTMLInputElement, password);
        // Confirm password twin fields
        try {
          const twins = form.querySelectorAll<HTMLInputElement>(
            'input[type="password"], input[name*="password" i], input[id*="password" i]'
          );
          for (const el of Array.from(twins)) fillInputValue(el, password);
        } catch {
          /* ignore */
        }
        await updateAndCopyCredentials({ password });
      },
      true
    );
  } else if (isPhone) {
    addItem(
      await t('contentAutofill.generatePhone'),
      await getIconSvgViaBg('phone', { size: 16 }),
      async () => {
        const phone = await generateIdentityViaBg('phoneNumber');
        fillInputValue(inputField as HTMLInputElement, phone);
        await updateAndCopyCredentials({ phone });
      },
      true
    );
  } else if (isUsername) {
    addItem(
      await t('contentAutofill.generateUsername'),
      await getIconSvgViaBg('user', { size: 16 }),
      async () => {
        const username = await generateIdentityViaBg('username');
        fillInputValue(inputField as HTMLInputElement, username);
        await updateAndCopyCredentials({ username });
      },
      true
    );
  } else if (isFirstName || isLastName || isFullName) {
    const label = isFirstName
      ? await t('contentAutofill.fillFirstName')
      : isLastName
        ? await t('contentAutofill.fillLastName')
        : await t('contentAutofill.fillFullName');
    addItem(
      label,
      await getIconSvgViaBg('user', { size: 16 }),
      async () => {
        const names = await getNamesToFill();
        const value = isFirstName ? names.firstName : isLastName ? names.lastName : names.fullName;
        fillInputValue(inputField as HTMLInputElement, value);
        await updateAndCopyCredentials({ name: names.fullName });
      },
      true
    );
  } else if (isWebsite) {
    addItem(
      await t('contentAutofill.generateWebsite'),
      await getIconSvgViaBg('globe', { size: 16 }),
      async () => {
        const website = await generateIdentityViaBg('websiteUrl');
        fillInputValue(inputField as HTMLInputElement, website);
        await updateAndCopyCredentials({ website });
      },
      true
    );
  } else if (isSelect || isCheckbox) {
    // Generic fill via entire form for selects/checkboxes
    addItem(
      await t('contentAutofill.autofillEntireForm'),
      await getExtLogoSvg(),
      async () => {
        if (!(await ensureAutofillReady(inputField))) return;
        const { identities = [], selectedIdentityId } = (await getStorageViaBg([
          'identities',
          'selectedIdentityId',
        ])) as {
          identities?: Array<{
            id: string;
            firstNames: string;
            lastNames: string;
            useRandomPassword: boolean;
            customPassword?: string;
            phone?: string;
            pin?: string;
            preferredEmail?: string | null;
            gender?: string | null;
            dateOfBirth?: string | null;
            country?: string | null;
          }>;
          selectedIdentityId?: string;
        };
        const selectedIdentity = identities.find((i) => i.id === selectedIdentityId);
        await fillSignupForm(form, updateAndCopyCredentials, selectedIdentity);
      },
      true
    );
  }

  if (!isCheckbox && !isSelect) {
    addItem(
      await t('contentAutofill.autofillEntireForm'),
      await getIconSvgViaBg('autofillForm', { size: 16 }),
      async () => {
        if (!(await ensureAutofillReady(inputField))) return;
        const { identities = [], selectedIdentityId } = (await getStorageViaBg([
          'identities',
          'selectedIdentityId',
        ])) as {
          identities?: Array<{
            id: string;
            firstNames: string;
            lastNames: string;
            useRandomPassword: boolean;
            customPassword?: string;
            phone?: string;
            pin?: string;
            preferredEmail?: string | null;
            gender?: string | null;
            dateOfBirth?: string | null;
            country?: string | null;
          }>;
          selectedIdentityId?: string;
        };
        const selectedIdentity = identities.find((i) => i.id === selectedIdentityId);
        const ok = await fillSignupForm(form, updateAndCopyCredentials, selectedIdentity);
        if (!ok) {
          await showTooltip(
            inputField as HTMLInputElement,
            await t('contentAutofill.generateFailed'),
            true
          );
        }
      }
    );
  }

  getOrCreateShadowRoot()?.appendChild(popupDiv);

  const { cleanup } = trackElementPosition(
    popupDiv,
    inputField as HTMLElement,
    positionPopupBelowField,
    []
  );

  activePopupInfo = {
    element: popupDiv,
    cleanup,
  };
}

export async function injectAutoFillButtons(
  form: HTMLFormElement | HTMLElement,
  injectedButtons: HTMLElement[],
  updatePositionListeners: Array<() => void>,
  autoFillButtonsInjected: { value: boolean },
  updateAndCopyCredentials: (creds: Record<string, string>) => Promise<void>
): Promise<void> {
  if (autoFillButtonsInjected.value) return;
  removeInjectedButtons(injectedButtons, updatePositionListeners);

  // ── Disposable-identity replay for this site ────────────────────────
  // Site profile + saved logins for domain (any inbox). Best-effort.
  let replayCredential: ReusableCredential | null = null;
  try {
    const { activeInboxId } = (await getStorageViaBg(['activeInboxId'])) as {
      activeInboxId?: string;
    };
    const response = (await sendMessageViaBg({
      action: 'findSiteReplay',
      domain: window.location.hostname,
      inboxId: activeInboxId || '',
    })) as {
      found?: boolean;
      credential?: ReusableCredential;
      lastEmail?: string;
      lastInboxId?: string;
    };
    if (response?.found && response.credential) {
      replayCredential = response.credential;
    }
    // If we have a known last inbox for this site, prefer it as active for OTP wait
    if (response?.lastInboxId && response.lastInboxId !== activeInboxId) {
      try {
        await setStorageViaBg({ activeInboxId: response.lastInboxId });
      } catch {
        /* ignore */
      }
    }
  } catch {
    // Background may not be ready, or message failed - silently fall back
  }

  const inputFields = form.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"]), select, textarea, ' +
      '[name*="email" i], [id*="email" i], [name*="username" i], [id*="username" i], ' +
      '[name*="name" i], [id*="name" i], [name*="phone" i], [id*="phone" i], [name*="mobile" i], [id*="mobile" i], ' +
      '[autocomplete="email"], [autocomplete="username"], [autocomplete="tel"], [autocomplete="name"], ' +
      '[autocomplete="given-name"], [autocomplete="family-name"], [autocomplete="new-password"], [autocomplete="current-password"]'
  );

  const fieldButtonTitle = await t('contentAutofill.fieldButtonTitle');

  for (const inputField of Array.from(inputFields)) {
    const isSelect = inputField.tagName.toLowerCase() === 'select';
    const isCheckbox = !isSelect && (inputField as HTMLInputElement).type === 'checkbox';
    const isInput = !isSelect;
    const el = inputField as HTMLInputElement;
    const name = safeName(el).toLowerCase();
    const id = safeId(el).toLowerCase();
    const ph = safePlaceholder(el).toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
    const blob = `${name} ${id} ${ph} ${ac} ${aria}`;

    const isEmail =
      isInput &&
      el.type !== 'password' &&
      (el.type === 'email' ||
        ac === 'email' ||
        ac === 'username email' ||
        /email|e-mail|correo|courriel|メール|邮箱/.test(blob));

    // Password ONLY when type/autocomplete/name clearly say password — never username/handle
    const isPassword =
      isInput &&
      !/user\s*name|username|userid|user_id|handle|nickname/.test(blob) &&
      (el.type === 'password' ||
        ac === 'new-password' ||
        ac === 'current-password' ||
        (/password|passwd|\bpwd\b|passcode|new-password|current-password/.test(blob) &&
          el.type !== 'email' &&
          el.type !== 'tel'));

    const isPhone =
      isInput &&
      !isEmail &&
      !isPassword &&
      (el.type === 'tel' ||
        ac === 'tel' ||
        ac.startsWith('tel-') ||
        /phone|mobile|cellphone|cell/.test(blob));

    // Real username/handle only — autocomplete=username alone is often login EMAIL
    const isUsername =
      isInput &&
      !isEmail &&
      !isPassword &&
      el.type !== 'password' &&
      el.type !== 'email' &&
      (/user\s*name|username|userid|user_id|user-name|nickname|handle|login\s*name|account\s*name/.test(
        blob
      ) ||
        (ac === 'username' &&
          /user|handle|nick|login/.test(`${name} ${id} ${ph} ${aria}`) &&
          !/email|mail|phone|mobile/.test(blob)));

    const isFirstName =
      isInput &&
      (ac === 'given-name' ||
        /firstname|first_name|fname|givenname|given-name|first name/.test(blob));

    const isLastName =
      isInput &&
      (ac === 'family-name' ||
        /lastname|last_name|lname|surname|familyname|family-name|last name/.test(blob));

    const isFullName =
      isInput &&
      !isFirstName &&
      !isLastName &&
      !isUsername &&
      (ac === 'name' ||
        /fullname|full_name|full-name|display.?name/.test(blob) ||
        (/\bname\b/.test(blob) && !/user|file|company|org|brand/.test(blob)));

    const isWebsite =
      isInput &&
      (el.type === 'url' || ac === 'url' || /website|homepage|web.?site|\burl\b/.test(blob));

    // Reserve space inside the field so the icon sits in-field (cleaner UI)
    try {
      if (isInput && !isCheckbox) {
        const el = inputField as HTMLInputElement;
        const prevPad = el.style.paddingInlineEnd || '';
        el.dataset.ocPadEnd = prevPad;
        const computed = Number.parseFloat(getComputedStyle(el).paddingInlineEnd || '0') || 0;
        el.style.paddingInlineEnd = `${Math.max(computed, 28)}px`;
      }
    } catch {
      /* ignore */
    }

    const buttonContainer = document.createElement('div');
    buttonContainer.className = CONTAINER_CLASS;
    buttonContainer.style.cssText = `
      position: fixed;
      z-index: ${CONTENT_Z.button};
      pointer-events: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: ${BUTTON_OPACITY_DEFAULT};
      transition: opacity 0.2s;
    `;
    buttonContainer.onmouseover = () => {
      buttonContainer.style.opacity = String(BUTTON_OPACITY_HOVER);
    };
    buttonContainer.onmouseout = () => {
      buttonContainer.style.opacity = String(BUTTON_OPACITY_DEFAULT);
    };

    // Compact in-field extension icon (transparent bg — logo only, not a solid color chip)
    const autoFillButton = document.createElement('button');
    autoFillButton.className = BUTTON_CLASS;
    autoFillButton.type = 'button';
    autoFillButton.title = fieldButtonTitle;
    autoFillButton.setAttribute('aria-label', fieldButtonTitle);
    autoFillButton.style.cssText = `
      background: transparent;
      color: var(--md-primary, #4c662b);
      border: none;
      border-radius: 4px;
      width: 22px;
      height: 22px;
      min-width: 22px;
      min-height: 22px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      padding: 0;
      box-shadow: none;
      opacity: 0.92;
    `;
    autoFillButton.onmouseover = () => {
      autoFillButton.style.opacity = '1';
      autoFillButton.style.background = 'var(--md-primary-container, rgba(76,102,43,0.12))';
    };
    autoFillButton.onmouseout = () => {
      autoFillButton.style.opacity = '0.92';
      autoFillButton.style.background = 'transparent';
    };
    autoFillButton.onmousedown = () => {
      autoFillButton.style.transform = 'scale(0.94)';
    };
    autoFillButton.onmouseup = () => {
      autoFillButton.style.transform = 'scale(1)';
    };
    appendSvgIcon(autoFillButton, await getExtLogoSvg());

    autoFillButton.addEventListener('click', async (event: MouseEvent) => {
      if (!event.isTrusted) {
        logWarn('Blocked synthetic click event on autofill button');
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      // Toggle popup if already open for this field
      if (activePopupInfo?.element.parentNode) {
        closeActivePopup();
        return;
      }

      // Known single-value fields: fill immediately (more reliable than menu-only)
      try {
        if (isPassword) {
          const password = await getPasswordToFill(inputField as HTMLInputElement, form);
          fillInputValue(inputField as HTMLInputElement, password);
          try {
            const twins = form.querySelectorAll<HTMLInputElement>(
              'input[type="password"], input[name*="password" i], input[id*="password" i]'
            );
            for (const el of Array.from(twins)) fillInputValue(el, password);
          } catch {
            /* ignore */
          }
          await updateAndCopyCredentials({ password });
          await showTooltip(
            inputField as HTMLElement,
            await t('contentAutofill.fillSuccess'),
            false
          );
          return;
        }
        if (isPhone) {
          const phone = await generateIdentityViaBg('phoneNumber');
          fillInputValue(inputField as HTMLInputElement, phone);
          await updateAndCopyCredentials({ phone });
          await showTooltip(
            inputField as HTMLElement,
            await t('contentAutofill.fillSuccess'),
            false
          );
          return;
        }
        if (isUsername) {
          const username = await generateIdentityViaBg('username');
          fillInputValue(inputField as HTMLInputElement, username);
          await updateAndCopyCredentials({ username });
          await showTooltip(
            inputField as HTMLElement,
            await t('contentAutofill.fillSuccess'),
            false
          );
          return;
        }
        if (isFirstName || isLastName || isFullName) {
          const names = await getNamesToFill();
          const value = isFirstName
            ? names.firstName
            : isLastName
              ? names.lastName
              : names.fullName;
          fillInputValue(inputField as HTMLInputElement, value);
          await updateAndCopyCredentials({ name: names.fullName });
          await showTooltip(
            inputField as HTMLElement,
            await t('contentAutofill.fillSuccess'),
            false
          );
          return;
        }
        if (isWebsite) {
          const website = await generateIdentityViaBg('websiteUrl');
          fillInputValue(inputField as HTMLInputElement, website);
          await updateAndCopyCredentials({ website });
          await showTooltip(
            inputField as HTMLElement,
            await t('contentAutofill.fillSuccess'),
            false
          );
          return;
        }
      } catch (err) {
        logError('Direct field fill failed', err);
      }

      // Email (multi-choice) / unknown / select / checkbox → menu
      await showAutofillPopup(
        inputField,
        form,
        isEmail,
        isPassword,
        isPhone,
        isUsername,
        isFirstName,
        isLastName,
        isFullName,
        isWebsite,
        isCheckbox,
        isSelect,
        updateAndCopyCredentials
      );
    });

    buttonContainer.appendChild(autoFillButton);
    trackElementPosition(
      buttonContainer,
      inputField as HTMLElement,
      positionAtEndOfField,
      updatePositionListeners
    );
    getOrCreateShadowRoot()?.appendChild(buttonContainer);
    injectedButtons.push(buttonContainer);
  }

  await addFillAllButton(
    form,
    injectedButtons,
    updatePositionListeners,
    updateAndCopyCredentials,
    replayCredential
  );
  autoFillButtonsInjected.value = true;
}

type IdentityFill = {
  id: string;
  name?: string;
  firstNames: string;
  lastNames: string;
  useRandomPassword: boolean;
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
};

async function runFillAll(
  form: HTMLFormElement | HTMLElement,
  updateAndCopyCredentials: (creds: Record<string, string>) => Promise<void>,
  identityForFill: IdentityFill | undefined,
  replayCredential: ReusableCredential | null,
  anchorEl: HTMLElement,
  onSuccessLabel?: (label: string) => void
): Promise<void> {
  if (!(await ensureAutofillReady(form))) return;

  const planDomain = typeof location !== 'undefined' ? location.hostname : '';
  let usedReplay = !!replayCredential;
  let planIdentityId: string | null = identityForFill?.id || null;
  let identity = identityForFill;
  let formScore: import('@/features/intelligence/types.js').FormScore | null = null;

  // Smart settings + multi-level undo
  try {
    const smart = (await loadSmartAutofillSettingsViaBg()) as { undoStackDepth: number };
    const stack = getFormUndoStack(form, smart.undoStackDepth);
    stack.push(form, 'pre-autofill');
  } catch {
    /* optional */
  }

  // Freshness: prefer unused identity+email for generate path
  if (!replayCredential && !identity) {
    try {
      const { identities = [], inboxes = [] } = (await getStorageViaBg([
        'identities',
        'inboxes',
      ])) as {
        identities?: IdentityFill[];
        inboxes?: Array<{ address?: string; status?: string; accountStatus?: string }>;
      };
      const live = (inboxes || [])
        .filter(
          (i) =>
            i.address &&
            i.accountStatus !== 'archived' &&
            i.accountStatus !== 'deleted' &&
            i.status !== 'expired'
        )
        .map((i) => i.address as string);
      const pick = (await pickFreshestIdentityViaBg(
        planDomain,
        identities as unknown as import('@/utils/types.js').Identity[],
        live
      )) as { identity: import('@/utils/types.js').Identity; identityId: string } | null;
      if (pick) {
        identity = pick.identity as unknown as IdentityFill;
        planIdentityId = pick.identityId;
      }
    } catch {
      /* optional */
    }
  }

  try {
    const plan = await buildAutofillPlan(form, {
      domain: planDomain,
      replayCredential,
      selectedIdentityId: identityForFill?.id || identity?.id,
    });
    formScore = plan.formScore;
    usedReplay = plan.useReplay && !!replayCredential;
    if (!identity && plan.identityId) {
      const { identities = [] } = (await getStorageViaBg(['identities'])) as {
        identities?: IdentityFill[];
      };
      identity = identities.find((i) => i.id === plan.identityId);
      planIdentityId = plan.identityId;
    }
  } catch {
    /* intelligence optional */
  }

  // Dry-run preview (optional)
  try {
    const smart = (await loadSmartAutofillSettingsViaBg()) as { dryRunPreview: boolean } | null;
    if (smart?.dryRunPreview && !usedReplay) {
      const meta = await getActiveInboxMetaViaBg();
      const ok = await showDryRunPreview({
        title: await t('contentAutofill.dryRunTitle'),
        confirmLabel: await t('contentAutofill.dryRunConfirm'),
        cancelLabel: await t('contentAutofill.dryRunCancel'),
        rows: [
          {
            label: await t('messages.identity'),
            value: identity?.name || (await t('contentAutofill.dryRunEmpty')),
          },
          {
            label: await t('messages.email'),
            value:
              meta?.address || identity?.preferredEmail || (await t('contentAutofill.dryRunEmpty')),
          },
          {
            label: await t('messages.name'),
            value:
              `${identity?.firstNames || ''} ${identity?.lastNames || ''}`.trim() ||
              (await t('contentAutofill.dryRunEmpty')),
          },
          {
            label: await t('messages.phone'),
            value: identity?.phone || (await t('contentAutofill.dryRunAutoMode')),
            kind: 'phone',
          },
          { label: await t('messages.password'), value: '••••••••', kind: 'password' },
        ],
      });
      if (!ok) return;
    }
  } catch {
    /* optional */
  }

  try {
    // Human-like pause before fill starts
    try {
      await maybeHumanDelay();
    } catch {
      /* ignore */
    }

    const success = await fillSignupForm(
      form,
      updateAndCopyCredentials,
      usedReplay ? undefined : identity,
      usedReplay ? (replayCredential ?? undefined) : undefined
    );

    try {
      const meta = await getActiveInboxMetaViaBg();
      if (meta) {
        void recordAutofillOutcomeViaBg({
          domain: planDomain,
          success,
          identityId: planIdentityId || identity?.id,
          inboxId: meta?.inboxId,
          email: meta.address,
          formScore: formScore as unknown,
          usedReplay,
        });
      }
      if (success) {
        void recordAutofillSuccessViaBg(planDomain);
        // detectWizardStepFromPage is inlined in content-bg-bridge (DOM access needed)
        void upsertWizardSessionViaBg({
          domain: planDomain,
          step: detectWizardStepFromPage() === 'otp' ? 'otp' : 'form',
          email: meta?.address ?? null,
          identityId: planIdentityId || identity?.id,
          inboxId: meta?.inboxId ?? null,
          paths: [location.pathname],
          filled: { email: meta?.address || '' },
        });
      } else {
        const fail = await recordAutofillFailureViaBg(planDomain);
        if (fail?.shouldSuggestBlock) {
          void showTooltip(
            anchorEl,
            await t('contentAutofill.suggestBlockSite', { domain: planDomain }),
            true
          );
        }
      }
    } catch {
      /* ignore memory write */
    }

    if (success && onSuccessLabel) {
      onSuccessLabel(await t('contentAutofill.reuseIdentity'));
    }
    if (success) {
      try {
        const meta = await getActiveInboxMetaViaBg();
        const email =
          meta?.address ||
          (usedReplay ? replayCredential?.email : null) ||
          identity?.preferredEmail ||
          '';
        const idName = identity?.name || '';
        const provider = meta?.providerDisplay || meta?.provider || '';
        const statusText = await t('contentAutofill.fillMicroStatus', {
          identity: idName || '—',
          email: email || '—',
          provider: provider || '—',
        });
        showFillMicroStatus(anchorEl, statusText);

        // Smart OTP attach
        try {
          const smart = (await loadSmartAutofillSettingsViaBg()) as {
            smartOtpAttach: boolean;
          } | null;
          if (smart?.smartOtpAttach) {
            void showWaitOtpPanel({
              email: email || null,
              autoFill: true,
              skipIfNotVerificationPage: true,
            });
          }
        } catch {
          /* ignore */
          void showWaitOtpPanel({
            email: email || null,
            autoFill: true,
            skipIfNotVerificationPage: true,
          });
        }

        // Conflict watch → auto new inbox
        try {
          watchEmailConflict(form, () => {
            void (async () => {
              const fresh = await createFreshInboxAddress();
              if (fresh) {
                fillAllEmailFields(form, fresh);
                await updateAndCopyCredentials({ email: fresh });
                await showTooltip(
                  anchorEl,
                  await t('contentAutofill.conflictNewEmail', { email: fresh }),
                  false
                );
              }
            })();
          });
        } catch {
          /* optional */
        }

        // Only treat as signup success after Continue/Sign up is clicked (auto-click + watch)
        try {
          armSignupOutcomeAfterSubmit(planDomain, form, {
            autoClick: true,
            timeoutMs: 90_000,
          });
        } catch {
          /* optional */
        }

        // Multi-step SPA: email → name → OTP (generic — no site hardcoding)
        try {
          void startMultiStepOtpWatch({ email: email || null });
        } catch {
          /* optional */
        }
      } catch {
        /* ignore */
        await showTooltip(anchorEl, await t('contentAutofill.fillSuccess'), false);
      }
    } else {
      await showTooltip(anchorEl, await t('contentAutofill.generateFailed'), true);
    }
  } catch (error: unknown) {
    try {
      void recordAutofillOutcomeViaBg({
        domain: planDomain,
        success: false,
        identityId: planIdentityId || identity?.id,
        formScore: formScore as unknown,
        usedReplay,
      });
    } catch {
      /* ignore */
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await showTooltip(anchorEl, errorMessage, true);
  }
}

async function addFillAllButton(
  form: HTMLFormElement | HTMLElement,
  injectedButtons: HTMLElement[],
  updatePositionListeners: Array<() => void>,
  updateAndCopyCredentials: (creds: Record<string, string>) => Promise<void>,
  replayCredential: ReusableCredential | null
): Promise<void> {
  // Autofill All: high-confidence signup OR progressive multi-step OR sign-in
  let formIntent: ReturnType<typeof classifyFormIntent> = 'unknown';
  try {
    if (form instanceof HTMLFormElement) {
      formIntent = classifyFormIntent(form);
    } else {
      // Non-form progressive containers (email → continue) count as signup path
      formIntent = 'signup';
    }
    const score = scoreSignupForm(form);
    // Progressive SPA / social signup steps often score 30–54
    if (score < 32 && formIntent !== 'signin' && formIntent !== 'signup') return;
    // Explicit signup intent or progressive container always show Autofill All
    if (score < 28 && formIntent === 'unknown') return;
  } catch {
    /* ignore */
    return;
  }

  const isSignin =
    form instanceof HTMLFormElement && (formIntent === 'signin' || isSigninForm(form));
  const isSignup =
    !isSignin &&
    (formIntent === 'signup' || (form instanceof HTMLFormElement && isSignupForm(form)));
  // Reuse identity ONLY on sign-in pages — never on signup
  const isReplay = !!(replayCredential && isSignin);
  // Signup + existing site credential → suggest a different / new identity
  const hasExistingCredsOnSignup = !!(replayCredential && isSignup && !isSignin);

  const buttonContainer = document.createElement('div');
  buttonContainer.className = `${CONTAINER_CLASS} fill-all-container`;
  buttonContainer.style.cssText = `
    position: fixed !important;
    z-index: ${CONTENT_Z.tooltip} !important;
    pointer-events: auto !important;
    display: inline-flex !important;
    align-items: center;
    opacity: 0.95 !important;
    visibility: visible !important;
    transition: opacity 0.2s;
    border-radius: 20px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
    white-space: nowrap;
    flex-shrink: 0;
    min-width: fit-content;
    flex-wrap: nowrap;
  `;

  const fillAllButton = document.createElement('button');
  fillAllButton.type = 'button';
  fillAllButton.className = `${BUTTON_CLASS} fill-all-button`;
  fillAllButton.title = isReplay
    ? await t('contentAutofill.reuseTitle')
    : hasExistingCredsOnSignup
      ? await t('contentAutofill.existingCredsSignupTitle')
      : await t('contentAutofill.fillAllTitle');
  fillAllButton.style.cssText = `
    background-color: var(--md-primary, #4c662b);
    color: var(--md-on-primary, #fff);
    border: none;
    border-radius: 0;
    padding: 7px 12px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    font-family: system-ui, sans-serif;
    white-space: nowrap;
    flex-shrink: 0;
  `;
  appendSvgIcon(fillAllButton, await getExtLogoSvg());
  const labelSpan = document.createElement('span');
  labelSpan.textContent = isReplay
    ? await t('contentAutofill.reuseIdentity')
    : hasExistingCredsOnSignup
      ? await t('contentAutofill.newIdentityFill')
      : await t('contentAutofill.autofillAll');
  fillAllButton.appendChild(labelSpan);

  // Pre-fill snapshot for Reset after Autofill All
  let preFillSnapshot: FieldSnapshot[] | null = null;

  // Chevron opens identity picker
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = BUTTON_CLASS;
  menuBtn.title = await t('contentAutofill.chooseIdentity');
  menuBtn.setAttribute('aria-label', await t('contentAutofill.chooseIdentity'));
  menuBtn.style.cssText = `
    background-color: var(--md-primary, #4c662b);
    color: var(--md-on-primary, #fff);
    border: none;
    border-inline-start: 1px solid rgba(255,255,255,0.25);
    padding: 0 8px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    font-size: 12px;
    flex-shrink: 0;
  `;
  menuBtn.innerHTML = await getIconSvgViaBg('chevronDown', { size: 14, color: 'currentColor' });
  const chevronIconSpan = menuBtn.querySelector('span');
  if (chevronIconSpan) {
    chevronIconSpan.style.flexShrink = '0';
  }

  const setFillLabel = (text: string) => {
    labelSpan.textContent = text;
    fillAllButton.title = text;
  };

  // Wait for OTP chip — revealed after successful fill or matching manual email entry
  const waitOtpBtn = document.createElement('button');
  waitOtpBtn.type = 'button';
  waitOtpBtn.className = BUTTON_CLASS;
  waitOtpBtn.title = await t('contentAutofill.waitForOtpTitle');
  waitOtpBtn.style.cssText = `
    background-color: var(--md-secondary-container, #dce7c8);
    color: var(--md-on-secondary-container, #404a33);
    border: none;
    border-inline-start: 1px solid rgba(0,0,0,0.08);
    padding: 7px 10px;
    cursor: pointer;
    display: none;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    font-family: system-ui, sans-serif;
    white-space: nowrap;
  `;
  waitOtpBtn.textContent = await t('contentAutofill.waitForOtpShort');
  waitOtpBtn.addEventListener('click', async (event: MouseEvent) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const meta = await getActiveInboxMetaViaBg();
      await showWaitOtpPanel({
        email: meta?.address || replayCredential?.email || null,
        autoFill: true,
      });
    } catch {
      /* ignore */
    }
  });

  const showWaitOtpButton = () => {
    waitOtpBtn.style.display = 'flex';
  };

  const showResetButton = () => {
    resetBtn.style.display = 'flex';
  };

  const runWithIdentity = async (id?: IdentityFill, forceGenerate = false) => {
    // Snapshot once before first fill so Reset can undo incomplete signups
    if (!preFillSnapshot) preFillSnapshot = snapshotFormFields(form);
    // Reuse only on sign-in; signup always generates (even if site has saved creds)
    const replay =
      isReplay && !forceGenerate && !hasExistingCredsOnSignup ? replayCredential : null;
    await runFillAll(form, updateAndCopyCredentials, id, replay, fillAllButton, setFillLabel);
    showResetButton();
    // After Autofill All, reveal Wait-for-OTP if form now has a known extension email
    try {
      if (await formEmailMatchesExtensionInbox(form)) showWaitOtpButton();
    } catch {
      /* ignore */
    }
  };

  fillAllButton.addEventListener('click', async (event: MouseEvent) => {
    if (!event.isTrusted) {
      logWarn('Blocked synthetic click event on fill all button');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Signup already has credentials for this site → open identity menu path
    if (hasExistingCredsOnSignup) {
      try {
        await showTooltip(fillAllButton, await t('contentAutofill.existingCredsSignupHint'), false);
      } catch {
        /* ignore */
      }
    }
    // Identity routing (sticky / domain hints / selected / default)
    try {
      const { identities = [], selectedIdentityId } = (await getStorageViaBg([
        'identities',
        'selectedIdentityId',
      ])) as { identities?: IdentityFill[]; selectedIdentityId?: string };
      let selected: IdentityFill | undefined;
      if (hasExistingCredsOnSignup && identities.length > 1) {
        // Prefer a different identity than the one last used for this domain
        const lastId = (replayCredential as { identityId?: string } | null)?.identityId;
        selected =
          identities.find((i) => i.id !== lastId && i.id !== selectedIdentityId) ||
          identities.find((i) => i.id !== lastId) ||
          identities.find((i) => i.id !== selectedIdentityId) ||
          identities[0];
      } else {
        const routed = (await routeIdentityForDomainViaBg(
          window.location.hostname,
          identities as unknown as import('@/utils/types.js').Identity[],
          selectedIdentityId
        )) as { identity: IdentityFill | null; identityId: string | null } | null;
        selected =
          routed?.identity || identities.find((i) => i.id === selectedIdentityId) || identities[0];
      }
      // Reuse only on sign-in; signup always generate
      await runWithIdentity(isReplay ? undefined : selected, hasExistingCredsOnSignup);
    } catch {
      /* ignore */
      const { identities = [], selectedIdentityId } = (await getStorageViaBg([
        'identities',
        'selectedIdentityId',
      ])) as { identities?: IdentityFill[]; selectedIdentityId?: string };
      const selected = identities.find((i) => i.id === selectedIdentityId) || identities[0];
      await runWithIdentity(isReplay ? undefined : selected, hasExistingCredsOnSignup);
    }
  });

  menuBtn.addEventListener(
    'click',
    async (event: MouseEvent) => {
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      closeActivePopup();

      const { identities = [], selectedIdentityId } = (await getStorageViaBg([
        'identities',
        'selectedIdentityId',
      ])) as { identities?: IdentityFill[]; selectedIdentityId?: string };

      const menu = document.createElement('div');
      menu.className = POPUP_CLASS;
      menu.style.cssText = `
      position: fixed;
      z-index: ${CONTENT_Z.popup};
      min-width: 220px;
      max-width: 300px;
      max-height: min(70vh, 360px);
      overflow-y: auto;
      pointer-events: auto;
      background: var(--md-surface-container, #eeefe3);
      color: var(--md-on-surface, #1a1c16);
      border: 1px solid var(--md-outline-variant, #c5c8ba);
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.18);
      padding: 6px 0;
      font-family: system-ui, sans-serif;
      font-size: 13px;
    `;

      const identityFallback = await t('messages.identity');
      const editLabel = await t('common.edit');
      const editIdentityLabel = await t('contentAutofill.editIdentity');

      const addIdentityRow = (id: IdentityFill, selected: boolean) => {
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;gap:4px;padding:2px 6px 2px 0;width:100%;box-sizing:border-box;';
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.textContent = `${selected ? '✓ ' : ''}${id.name || identityFallback}`;
        pick.style.cssText = `
        flex:1;min-width:0;text-align:start;padding:8px 10px 8px 14px;border:0;background:transparent;
        cursor:pointer;font:inherit;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      `;
        pick.onmouseover = () => {
          pick.style.background = 'var(--md-surface-variant, #e1e4d5)';
        };
        pick.onmouseout = () => {
          pick.style.background = 'transparent';
        };
        const runPick = (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          closeActivePopup();
          void setStorageViaBg({ selectedIdentityId: id.id });
          // Always generate with chosen identity on signup (never silent reuse)
          void runWithIdentity(id, hasExistingCredsOnSignup || !isReplay);
        };
        pick.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        pick.addEventListener('click', trustedClick(runPick));

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.title = editLabel;
        edit.setAttribute('aria-label', editIdentityLabel);
        edit.textContent = '✎';
        edit.style.cssText = `
        flex-shrink:0;width:32px;height:32px;border:0;border-radius:8px;background:transparent;
        cursor:pointer;font-size:14px;color:inherit;display:flex;align-items:center;justify-content:center;
      `;
        edit.onmouseover = () => {
          edit.style.background = 'var(--md-surface-variant, #e1e4d5)';
        };
        edit.onmouseout = () => {
          edit.style.background = 'transparent';
        };
        edit.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        edit.addEventListener(
          'click',
          trustedClick((e) => {
            e.preventDefault();
            e.stopPropagation();
            closeActivePopup();
            // Background owns storage + open (app tab with query + navigateView).
            // Do not pre-write storage here — it races with open UIs that clear flags.
            void openExtensionForReason('edit-identity', 'edit-identity', { identityId: id.id });
          })
        );

        row.appendChild(pick);
        row.appendChild(edit);
        menu.appendChild(row);
      };

      const addRow = (text: string, onClick: () => void, bold = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.style.cssText = `
        display:block;width:100%;text-align:start;padding:10px 14px;border:0;background:transparent;
        cursor:pointer;font:inherit;color:inherit;font-weight:${bold ? '600' : '400'};
        pointer-events:auto;
      `;
        b.onmouseover = () => {
          b.style.background = 'var(--md-surface-variant, #e1e4d5)';
        };
        b.onmouseout = () => {
          b.style.background = 'transparent';
        };
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        b.addEventListener(
          'click',
          trustedClick((e) => {
            e.preventDefault();
            e.stopPropagation();
            closeActivePopup();
            onClick();
          })
        );
        menu.appendChild(b);
      };

      if (hasExistingCredsOnSignup) {
        const hint = document.createElement('div');
        hint.style.cssText =
          'padding:8px 14px;font-size:11px;line-height:1.35;color:var(--md-on-surface-variant,#444);opacity:0.95;';
        hint.textContent = await t('contentAutofill.existingCredsSignupMenuHint');
        menu.appendChild(hint);
      }

      addRow(
        isReplay
          ? await t('contentAutofill.reuseIdentity')
          : await t('contentAutofill.autofillAll'),
        () => {
          const selected = identities.find((i) => i.id === selectedIdentityId) || identities[0];
          void runWithIdentity(selected, hasExistingCredsOnSignup);
        },
        true
      );

      for (const id of identities.slice(0, 12)) {
        addIdentityRow(id, id.id === selectedIdentityId);
      }

      addRow(await t('contentAutofill.createIdentity'), () => {
        void openExtensionForReason('create-identity', 'create-identity');
      });

      // Prevent document capture handler from treating menu as outside
      menu.addEventListener(
        'mousedown',
        (e) => {
          e.stopPropagation();
        },
        true
      );
      menu.addEventListener(
        'pointerdown',
        (e) => {
          e.stopPropagation();
        },
        true
      );

      getOrCreateShadowRoot()?.appendChild(menu);

      const { cleanup } = trackElementPosition(
        menu,
        menuBtn,
        (btnRect) => {
          const menuH = Math.min(360, window.innerHeight * 0.7);
          let top = btnRect.bottom + 4;
          if (top + 120 > window.innerHeight) top = Math.max(8, btnRect.top - menuH - 4);
          return {
            top,
            left: Math.max(8, Math.min(btnRect.left, window.innerWidth - 240)),
            visible: true,
          };
        },
        updatePositionListeners
      );

      activePopupInfo = {
        element: menu,
        cleanup,
      };
    },
    true
  );

  // Reset — undo Autofill All when signup was not completed
  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = BUTTON_CLASS;
  resetBtn.title = await t('contentAutofill.resetFillTitle');
  resetBtn.style.cssText = `
    background-color: var(--md-surface-variant, #e1e4d5);
    color: var(--md-on-surface-variant, #44483e);
    border: none;
    border-inline-start: 1px solid rgba(0,0,0,0.08);
    padding: 7px 10px;
    cursor: pointer;
    display: none;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 600;
    font-family: system-ui, sans-serif;
    white-space: nowrap;
  `;
  resetBtn.textContent = await t('contentAutofill.resetFillShort');
  resetBtn.addEventListener('click', async (event: MouseEvent) => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    // Multi-level undo stack first; fall back to single pre-fill snapshot
    let undid = false;
    try {
      const stack = getFormUndoStack(form);
      undid = stack.undo();
      if (stack.canUndo()) {
        // Keep reset visible for further undos
        resetBtn.style.display = 'flex';
      } else {
        resetBtn.style.display = 'none';
        preFillSnapshot = null;
      }
    } catch {
      /* fall through */
    }
    if (!undid && preFillSnapshot) {
      restoreFormFields(preFillSnapshot);
      preFillSnapshot = null;
      resetBtn.style.display = 'none';
      undid = true;
    }
    if (undid) {
      setFillLabel(
        isReplay
          ? await t('contentAutofill.reuseIdentity')
          : hasExistingCredsOnSignup
            ? await t('contentAutofill.newIdentityFill')
            : await t('contentAutofill.autofillAll')
      );
      try {
        await showTooltip(fillAllButton, await t('contentAutofill.resetFillDone'), false);
      } catch {
        /* ignore */
      }
    }
  });

  // Scan email inputs: show OTP when user manually types a known extension email
  const emailInputs = Array.from(
    form.querySelectorAll<HTMLInputElement>(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="email"]'
    )
  );
  const onEmailInputScan = () => {
    void formEmailMatchesExtensionInbox(form).then((ok) => {
      if (ok) showWaitOtpButton();
    });
  };
  for (const input of emailInputs) {
    input.addEventListener('input', onEmailInputScan);
    input.addEventListener('change', onEmailInputScan);
    input.addEventListener('blur', onEmailInputScan);
  }
  onEmailInputScan();

  buttonContainer.appendChild(fillAllButton);
  buttonContainer.appendChild(menuBtn);
  buttonContainer.appendChild(waitOtpBtn);
  buttonContainer.appendChild(resetBtn);

  // Place after create-account heading / first field (not floating at random form coords)
  const anchor = findAutofillAllAnchor(form);
  trackElementPosition(buttonContainer, anchor, positionAfterElement, updatePositionListeners);

  getOrCreateShadowRoot()?.appendChild(buttonContainer);
  injectedButtons.push(buttonContainer);

  updatePositionListeners.push(() => {
    for (const input of emailInputs) {
      input.removeEventListener('input', onEmailInputScan);
      input.removeEventListener('change', onEmailInputScan);
      input.removeEventListener('blur', onEmailInputScan);
    }
  });
}

/** True when any email-like field in the form holds a live extension inbox address */
async function formEmailMatchesExtensionInbox(form: ParentNode): Promise<boolean> {
  try {
    const { inboxes = [] } = (await getStorageViaBg(['inboxes'])) as {
      inboxes?: Array<{ address?: string }>;
    };
    const known = new Set(
      (inboxes || []).map((i) => (i.address || '').trim().toLowerCase()).filter(Boolean)
    );
    if (known.size === 0) return false;
    const fields = form.querySelectorAll<HTMLInputElement>(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="email"], input[type="text"]'
    );
    for (const el of Array.from(fields)) {
      const v = (el.value || '').trim().toLowerCase();
      if (v && known.has(v)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function removeInjectedButtons(
  injectedButtons: HTMLElement[],
  updatePositionListeners: Array<() => void>
): void {
  closeActivePopup();
  updatePositionListeners.forEach((cleanup) => {
    void cleanup();
  });
  updatePositionListeners.length = 0;

  injectedButtons.forEach((button: HTMLElement) => {
    if (button.parentNode) button.parentNode.removeChild(button);
  });
  injectedButtons.length = 0;
}
