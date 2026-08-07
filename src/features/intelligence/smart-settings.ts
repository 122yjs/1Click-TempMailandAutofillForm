/**
 * User-tunable smart autofill settings (local storage).
 */

import { browser } from 'wxt/browser';
import { withLock } from '@/utils/mutex.js';

export interface SmartAutofillSettings {
  /** Mimic human behavior while filling forms (keystroke micro-delays & realistic events) */
  humanLikeFilling: boolean;
  /** Stagger field fills with small random delays (anti-bot) */
  humanLikeTiming: boolean;
  /** Min/max ms between field fills when humanLikeTiming is on */
  timingMinMs: number;
  timingMaxMs: number;
  /** Show dry-run overlay before committing Autofill All */
  dryRunPreview: boolean;
  /** Auto-open Wait-for-OTP after successful email fill */
  smartOtpAttach: boolean;
  /** Prefer page language for names/phones/addresses */
  localeAwareData: boolean;
  /** Failures before suggesting domain block */
  blockSuggestAfterFailures: number;
  /** Multi-level undo depth */
  undoStackDepth: number;
  /** Automatically click the form submit button after autofill */
  autoClickSubmitButtons: boolean;
}

export const DEFAULT_SMART_AUTOFILL: SmartAutofillSettings = {
  humanLikeFilling: true,
  humanLikeTiming: true,
  timingMinMs: 40,
  timingMaxMs: 180,
  dryRunPreview: false,
  smartOtpAttach: true,
  localeAwareData: true,
  blockSuggestAfterFailures: 3,
  undoStackDepth: 5,
  autoClickSubmitButtons: true,
};

const KEY = 'smartAutofillSettings';

export async function loadSmartAutofillSettings(): Promise<SmartAutofillSettings> {
  try {
    const res = (await browser.storage.local.get([KEY])) as {
      smartAutofillSettings?: Partial<SmartAutofillSettings>;
    };

    // Deep merge function
    const isObject = (item: unknown): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item));
    const mergeDeep = (
      target: Record<string, unknown>,
      source: Record<string, unknown>
    ): Record<string, unknown> => {
      const output = Object.assign({}, target);
      if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach((key) => {
          if (isObject(source[key])) {
            if (!(key in target)) Object.assign(output, { [key]: source[key] });
            else
              output[key] = mergeDeep(
                (target[key] || {}) as Record<string, unknown>,
                (source[key] || {}) as Record<string, unknown>
              );
          } else {
            Object.assign(output, { [key]: source[key] });
          }
        });
      }
      return output;
    };

    const loaded = mergeDeep(
      DEFAULT_SMART_AUTOFILL as unknown as Record<string, unknown>,
      (res.smartAutofillSettings || {}) as Record<string, unknown>
    ) as unknown as SmartAutofillSettings;
    loaded.timingMinMs = Math.max(
      10,
      Math.min(500, Number(loaded.timingMinMs) || DEFAULT_SMART_AUTOFILL.timingMinMs)
    );
    loaded.timingMaxMs = Math.max(
      loaded.timingMinMs + 10,
      Math.min(2000, Number(loaded.timingMaxMs) || DEFAULT_SMART_AUTOFILL.timingMaxMs)
    );
    return loaded;
  } catch {
    /* ignore */
    return { ...DEFAULT_SMART_AUTOFILL };
  }
}

export async function saveSmartAutofillSettings(
  partial: Partial<SmartAutofillSettings>
): Promise<SmartAutofillSettings> {
  return withLock('smart_settings_lock', async () => {
    const next = { ...(await loadSmartAutofillSettings()), ...partial };
    next.timingMaxMs = Math.max(next.timingMaxMs, next.timingMinMs + 10);
    await browser.storage.local.set({ [KEY]: next });
    return next;
  });
}
