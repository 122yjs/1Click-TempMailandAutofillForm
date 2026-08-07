/**
 * Auto-Extend & Renewal Rule Presets module for 1Click Temp Mail.
 */
import { browser } from 'wxt/browser';
import { logDebug, logError } from '@/utils/logger.js';
import type { Account, Email } from '@/utils/types.js';

export type AutoExtendRulePreset = {
  extendOnOtpArrival: boolean;
  extendDurationMinutes: number; // e.g. 60 min
  autoRenewBeforeExpiry: boolean;
  renewThresholdMinutes: number; // e.g. 5 min
};

export const DEFAULT_INBOX_RULES: AutoExtendRulePreset = {
  extendOnOtpArrival: true,
  extendDurationMinutes: 60,
  autoRenewBeforeExpiry: true,
  renewThresholdMinutes: 5,
};

export async function getInboxRules(): Promise<AutoExtendRulePreset> {
  try {
    const { inboxRules } = (await browser.storage.local.get(['inboxRules'])) as {
      inboxRules?: AutoExtendRulePreset;
    };
    return { ...DEFAULT_INBOX_RULES, ...inboxRules };
  } catch {
    /* ignore */
    return DEFAULT_INBOX_RULES;
  }
}

export async function saveInboxRules(rules: Partial<AutoExtendRulePreset>): Promise<void> {
  try {
    const current = await getInboxRules();
    const updated = { ...current, ...rules };
    await browser.storage.local.set({ inboxRules: updated });
  } catch (err: unknown) {
    logError(
      'Failed to save inbox rules',
      undefined,
      err instanceof Error ? err : new Error(String(err))
    );
  }
}

/**
 * Evaluates whether an incoming message should trigger auto-extension on its associated inbox.
 */
export async function processAutoExtendRules(inbox: Account, email: Email): Promise<boolean> {
  const rules = await getInboxRules();
  if (!rules.extendOnOtpArrival) return false;

  const isVerificationEmail =
    email.isOtp ||
    /verify|verification|code|otp|confirm|activation/i.test(email.subject || '') ||
    /verify|verification|code|otp|confirm|activation/i.test(email.body || '');

  if (isVerificationEmail && inbox.status === 'active') {
    logDebug('Auto-extend rule triggered by verification email for inbox:', inbox.address);
    return true;
  }

  return false;
}
