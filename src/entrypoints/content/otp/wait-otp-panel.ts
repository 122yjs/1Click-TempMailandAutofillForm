/**
 * On-page "Wait for OTP" panel — live countdown + fill when OTP arrives.
 * Uses closed shadow host (same as autofill buttons).
 */

import { watchOtpFailure } from '@/features/intelligence/conflict-watch.js';
import {
  copyToClipboardViaBg,
  getStorageViaBg,
  sendMessageViaBg,
} from '@/utils/content-bg-bridge.js';
import { t } from '@/utils/content-i18n.js';
import { logDebug } from '@/utils/logger.js';
import { CONTENT_Z } from '@/utils/portal-layers.js';
import { toMs } from '@/utils/time.js';
import { BUTTON_CLASS, getOrCreateShadowRoot } from '../dom/shadow-dom.js';
import { fillOtp, findOtpInputs } from './otp-handler.js';

const PANEL_ID = 'oc-wait-otp-panel';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const TICK_MS = 1000;

export interface WaitOtpPanelHandle {
  cleanup: () => void;
  notifyOtp: (otp: string, meta?: { sender?: string; subject?: string }) => Promise<void>;
}

let activeHandle: WaitOtpPanelHandle | null = null;

function formatMmSs(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/**
 * Detect whether current page requests email verification (OTP, Magic Link, Enter Code).
 */
export function isVerificationPage(root: ParentNode = document): boolean {
  try {
    const otcInput = root.querySelector(
      'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i]'
    );
    if (otcInput) return true;

    const text = (root instanceof Document ? root.body?.textContent : root.textContent) || '';
    const re =
      /\b(otp|verification code|one-time password|magic link|enter code|check your email|verify your email|confirmation code|passcode|رمز التحقق|كود التأكيد|código de verificación|code de vérification|bestätigungscode|認証コード|验证码|인증 Code)\b/i;
    return re.test(text);
  } catch {
    // On DOM access errors, err on the side of caution: assume it is NOT a
    // verification page to avoid unnecessary OTP panel injection.
    return false;
  }
}

/**
 * Show floating Wait-for-OTP / Verification Pending panel. Replaces any existing panel.
 */
export async function showWaitOtpPanel(opts?: {
  email?: string | null;
  timeoutMs?: number;
  autoFill?: boolean;
  skipIfNotVerificationPage?: boolean;
}): Promise<WaitOtpPanelHandle> {
  if (opts?.skipIfNotVerificationPage && !isVerificationPage()) {
    // Even if the page text doesn't mention verification, if we detect OTP
    // input fields (e.g. 6-digit digit boxes, autocomplete=one-time-code),
    // still show the panel so the OTP can be auto-filled when it arrives.
    const hasOtpInputs = findOtpInputs().length > 0;
    if (!hasOtpInputs) {
      return { cleanup: () => {}, notifyOtp: async () => {} };
    }
  }

  if (activeHandle) {
    activeHandle.cleanup();
    activeHandle = null;
  }

  const root = getOrCreateShadowRoot();
  if (!root) {
    return { cleanup: () => {}, notifyOtp: async () => {} };
  }

  const existing = root.getElementById(PANEL_ID);
  existing?.remove();

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const autoFill = opts?.autoFill !== false;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let filledOtp: string | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let _storageListener:
    | ((changes: Record<string, { newValue?: unknown }>, area: string) => void)
    | null = null;

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.setAttribute('role', 'status');
  panel.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: ${CONTENT_Z.overlay};
    pointer-events: auto;
    min-width: 260px;
    max-width: min(360px, calc(100vw - 32px));
    padding: 12px 14px;
    border-radius: 14px;
    background: var(--md-surface-container-high, #e8e9de);
    color: var(--md-on-surface, #1a1c16);
    box-shadow: 0 8px 28px rgba(0,0,0,0.22);
    font-family: system-ui, -apple-system, sans-serif;
    border: 1px solid var(--md-outline-variant, #c5c8ba);
  `;

  const title = document.createElement('div');
  title.style.cssText = 'font-size: 13px; font-weight: 700; margin-bottom: 4px;';
  title.textContent = await t('contentAutofill.waitForOtpTitle');

  const emailLine = document.createElement('div');
  emailLine.style.cssText =
    'font-size: 11px; opacity: 0.7; margin-bottom: 8px; word-break: break-all;';
  if (opts?.email) {
    emailLine.textContent = opts.email;
  } else {
    emailLine.style.display = 'none';
  }

  const status = document.createElement('div');
  status.style.cssText = 'font-size: 12px; margin-bottom: 8px;';
  status.textContent = await t('contentAutofill.waitForOtpWaiting');

  const countdown = document.createElement('div');
  countdown.style.cssText =
    'font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 0.04em; margin-bottom: 10px; color: var(--md-primary, #4c662b);';
  countdown.textContent = formatMmSs(timeoutMs);

  const otpDisplay = document.createElement('div');
  otpDisplay.style.cssText = `
    display: none;
    font-size: 20px;
    font-weight: 800;
    font-family: ui-monospace, monospace;
    letter-spacing: 0.12em;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--md-primary-container, #cdeda3);
    color: var(--md-on-primary-container, #354e16);
    text-align: center;
    margin-bottom: 10px;
    user-select: all;
  `;

  const actions = document.createElement('div');
  actions.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = BUTTON_CLASS;
  copyBtn.style.cssText = `
    flex: 1;
    min-width: 90px;
    padding: 7px 10px;
    border: none;
    border-radius: 10px;
    background: var(--md-primary, #4c662b);
    color: var(--md-on-primary, #fff);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    display: none;
  `;
  copyBtn.textContent = await t('contentAutofill.waitForOtpCopy');

  const fillBtn = document.createElement('button');
  fillBtn.type = 'button';
  fillBtn.className = BUTTON_CLASS;
  fillBtn.style.cssText = copyBtn.style.cssText;
  fillBtn.textContent = await t('contentAutofill.waitForOtpFill');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = BUTTON_CLASS;
  closeBtn.style.cssText = `
    padding: 7px 10px;
    border: 1px solid var(--md-outline-variant, #c5c8ba);
    border-radius: 10px;
    background: transparent;
    color: var(--md-on-surface, #1a1c16);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  `;
  closeBtn.textContent = await t('contentAutofill.waitForOtpDismiss');

  actions.appendChild(copyBtn);
  actions.appendChild(fillBtn);
  actions.appendChild(closeBtn);
  panel.appendChild(title);
  panel.appendChild(emailLine);
  panel.appendChild(status);
  panel.appendChild(countdown);
  panel.appendChild(otpDisplay);
  panel.appendChild(actions);
  root.appendChild(panel);

  // Keyboard navigation: ArrowLeft/ArrowRight navigate between buttons,
  // Enter/Space activate the focused button, Escape dismisses the panel.
  const focusableButtons: HTMLElement[] = [];
  // Only include copy/fill buttons (close stays reachable via Esc / tab)
  if (copyBtn) focusableButtons.push(copyBtn);
  if (fillBtn) focusableButtons.push(fillBtn);
  let focusIndex = 0;

  function focusButton(idx: number): void {
    focusIndex = (idx + focusableButtons.length) % focusableButtons.length;
    const btn = focusableButtons[focusIndex];
    btn?.focus();
  }

  panel.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.target !== panel && e.target !== document.body) return;
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        cleanup();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        focusButton(focusIndex - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        focusButton(focusIndex + 1);
        break;
      case 'Enter':
        if (document.activeElement instanceof HTMLElement && e.target === panel) {
          e.preventDefault();
          focusableButtons[focusIndex]?.click();
        }
        break;
    }
  });

  // Focus the first actionable button on mount for keyboard users
  if (filledOtp) {
    copyBtn?.focus();
  } else {
    closeBtn?.focus();
  }

  const cleanup = () => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    _storageListener = null;
    panel.remove();
    if (activeHandle?.cleanup === cleanup) activeHandle = null;
  };

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  });

  const applyOtp = async (otp: string, meta?: { sender?: string; subject?: string }) => {
    if (!otp || filledOtp === otp) return;
    filledOtp = otp;
    countdown.style.display = 'none';
    otpDisplay.style.display = 'block';
    otpDisplay.textContent = otp;
    copyBtn.style.display = 'block';
    fillBtn.style.display = 'block';
    focusIndex = 0;
    void copyBtn.focus();
    status.textContent = await t('contentAutofill.waitForOtpReceived');
    if (meta?.sender) {
      status.textContent += ` · ${meta.sender}`;
    }
    if (autoFill) {
      try {
        await fillOtp(otp);
        status.textContent = await t('contentAutofill.otpFilled');
        // If site rejects the code, prompt user to enter manually
        try {
          watchOtpFailure(document, () => {
            void (async () => {
              status.textContent = await t('contentAutofill.otpFailedManual');
              fillBtn.style.display = 'block';
              copyBtn.style.display = 'block';
              // Focus first OTP field for manual entry
              try {
                const inputs = findOtpInputs();
                inputs[0]?.focus();
                inputs[0]?.select?.();
              } catch {
                /* ignore */
              }
            })();
          });
        } catch {
          /* optional */
        }
      } catch (e) {
        logDebug(`Wait OTP auto-fill failed: ${String(e)}`);
        status.textContent = await t('contentAutofill.otpFailedManual');
      }
    }
  };

  copyBtn.addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    if (!filledOtp) return;
    try {
      await copyToClipboardViaBg(filledOtp);
      copyBtn.textContent = await t('contentAutofill.waitForOtpCopied');
    } catch {
      /* ignore */
      copyBtn.textContent = await t('contentAutofill.otpCopyFailed');
    }
  });

  fillBtn.addEventListener('click', async (e) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    if (!filledOtp) return;
    await fillOtp(filledOtp);
    status.textContent = await t('contentAutofill.otpFilled');
  });

  tickTimer = setInterval(async () => {
    if (filledOtp) return;
    const left = deadline - Date.now();
    countdown.textContent = formatMmSs(left);
    if (left <= 0) {
      status.textContent = await t('contentAutofill.waitForOtpTimeout');
      countdown.textContent = '0:00';
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    }
  }, TICK_MS);

  // Listen for latestOtp storage updates from background

  // Also check current latestOtp once (may already be waiting in storage)
  try {
    const { latestOtp } = (await getStorageViaBg(['latestOtp'])) as {
      latestOtp?: { otp?: string; sender?: string; received_at?: number };
    };
    if (
      latestOtp?.otp &&
      latestOtp.received_at &&
      toMs(latestOtp.received_at) >= startedAt - 2000
    ) {
      void applyOtp(latestOtp.otp, { sender: latestOtp.sender });
    }
  } catch {
    /* ignore */
  }

  // Ask background to refresh mail for active inbox (best-effort)
  try {
    const { activeInboxId } = (await getStorageViaBg(['activeInboxId'])) as {
      activeInboxId?: string;
    };
    if (activeInboxId) {
      void sendMessageViaBg({ type: 'checkEmails', inboxId: activeInboxId }).catch(() => {});
    }
  } catch {
    /* ignore */
  }

  const handle: WaitOtpPanelHandle = {
    cleanup,
    notifyOtp: applyOtp,
  };
  activeHandle = handle;
  return handle;
}

export function getActiveWaitOtpPanel(): WaitOtpPanelHandle | null {
  return activeHandle;
}

export function dismissWaitOtpPanel(): void {
  activeHandle?.cleanup();
  activeHandle = null;
}
