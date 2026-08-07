/**
 * Multi-step signup (Canva-style): after email is entered, site may advance to
 * name → OTP without a full page reload. Keep Wait-for-OTP attached and fill
 * when OTP fields appear + latestOtp arrives.
 */

import { getStorageViaBg } from '@/utils/content-bg-bridge.js';
import { logDebug } from '@/utils/logger.js';
import { getOrCreateShadowRoot, protectShadowHost } from '../dom/shadow-dom.js';
import { fillOtp, findOtpInputs } from './otp-handler.js';
import { getActiveWaitOtpPanel, showWaitOtpPanel } from './wait-otp-panel.js';

let multiStepCleanup: (() => void) | null = null;

/**
 * Start watching for OTP step after an email was filled on this page.
 * Safe to call multiple times — replaces previous watcher.
 */
export async function startMultiStepOtpWatch(opts?: { email?: string | null }): Promise<void> {
  multiStepCleanup?.();
  multiStepCleanup = null;

  const email = opts?.email || null;
  let stopped = false;
  let lastFilled = '';

  // Ensure wait panel is visible for the rest of the flow
  try {
    if (!getActiveWaitOtpPanel()) {
      await showWaitOtpPanel({ email, autoFill: true, timeoutMs: 10 * 60 * 1000 });
    }
  } catch {
    /* ignore */
  }

  const tryFillFromStorage = async () => {
    if (stopped) return;
    try {
      const { latestOtp } = (await getStorageViaBg(['latestOtp'])) as {
        latestOtp?: { otp?: string; received_at?: number };
      };
      const otp = latestOtp?.otp;
      if (!otp || otp === lastFilled) return;
      const inputs = findOtpInputs();
      if (inputs.length === 0) return;
      lastFilled = otp;
      await fillOtp(otp);
      const panel = getActiveWaitOtpPanel();
      if (panel) void panel.notifyOtp(otp);
      logDebug('Multi-step OTP auto-filled');
    } catch (e) {
      logDebug(`Multi-step OTP fill failed: ${String(e)}`);
    }
  };

  const onMut = () => {
    if (stopped) return;
    // When OTP fields appear (SPA step), try fill immediately
    if (findOtpInputs().length > 0) void tryFillFromStorage();
  };

  const observer = new MutationObserver(onMut);
  try {
    observer.observe(document.body, { childList: true, subtree: true });
  } catch {
    /* ignore */
  }

  // Periodic poll for SPA that don't mutate heavily (Canva OTP step)
  const poll = setInterval(() => {
    if (stopped) return;
    const found = findOtpInputs();
    if (found.length > 0) {
      // Ensure wait panel still mounted (sites may wipe shadow host)
      void (async () => {
        try {
          getOrCreateShadowRoot();
          protectShadowHost();
          if (!getActiveWaitOtpPanel()) {
            await showWaitOtpPanel({ email, autoFill: true, timeoutMs: 10 * 60 * 1000 });
          }
        } catch {
          /* ignore */
        }
      })();
      void tryFillFromStorage();
    }
  }, 1200);

  // Initial check + delayed retries after Continue transitions
  void tryFillFromStorage();
  setTimeout(() => void tryFillFromStorage(), 800);
  setTimeout(() => void tryFillFromStorage(), 2500);
  setTimeout(() => void tryFillFromStorage(), 6000);

  multiStepCleanup = () => {
    stopped = true;
    observer.disconnect();
    clearInterval(poll);
    try {
    } catch {
      /* ignore */
    }
    if (multiStepCleanup) multiStepCleanup = null;
  };

  // Auto-stop after 20 minutes (multi-step can be slow)
  setTimeout(() => multiStepCleanup?.(), 20 * 60 * 1000);
}

export function stopMultiStepOtpWatch(): void {
  multiStepCleanup?.();
  multiStepCleanup = null;
}
