/**
 * Lightweight background messaging bridge for content scripts.
 *
 * Provides thin wrappers around `browser.runtime.sendMessage` for operations
 * that have been offloaded to the background script (crypto, identity
 * generation, clipboard) — keeping heavy modules like `crypto.ts` (~18 KB)
 * and `clipboard.ts` out of the content-script bundle.
 */

import { browser } from 'wxt/browser';
import type { FormFieldKind } from '@/features/intelligence/types.js';
import { logError } from '@/utils/logger.js';

/** Encrypt text via background. */
export async function encryptViaBg(text: string): Promise<string> {
  const resp = await browser.runtime.sendMessage({ type: 'encryptData', text }).catch(logError);
  return (resp as { success: true; encrypted: string } | undefined)?.encrypted ?? '';
}

/** Decrypt text via background. */
export async function decryptViaBg(text: string): Promise<string> {
  const resp = await browser.runtime.sendMessage({ type: 'decryptData', text }).catch(logError);
  return (resp as { success: true; decrypted: string } | undefined)?.decrypted ?? '';
}

/** Generate a random identity field via background. */
export async function generateIdentityViaBg(fieldType: string): Promise<string> {
  const resp = await browser.runtime
    .sendMessage({ type: 'generateIdentityField', fieldType })
    .catch(logError);
  return (resp as { success: true; value: string } | undefined)?.value ?? '';
}

/** Copy text to clipboard via background with optional auto-purge. */
export async function copyToClipboardViaBg(text: string, purgeAfterMs?: number): Promise<void> {
  await browser.runtime
    .sendMessage({ type: 'copyToClipboard', text, purgeAfterMs })
    .catch(logError);
}

/** Generate locale-aware address extras (country, city, pin, dob) via background. */
export async function generateLocaleExtrasViaBg(locale?: string): Promise<{
  country: string;
  city: string;
  pin: string;
  dob: string;
} | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'generateLocaleExtras', locale })
    .catch(logError)) as
    | { success: true; country: string; city: string; pin: string; dob: string }
    | undefined;
  if (resp?.success)
    return { country: resp.country, city: resp.city, pin: resp.pin, dob: resp.dob };
  return null;
}

/** Generate a locale-aware phone number via background. */
export async function generateLocalePhoneViaBg(locale?: string): Promise<string> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'generateLocaleAwarePhone', locale })
    .catch(logError)) as { success: true; phone: string } | undefined;
  return resp?.success ? resp.phone : '';
}

/** Get an icon SVG via background (keeps icon-svg.ts out of content bundle). */
export async function getIconSvgViaBg(
  name: string,
  opts?: { size?: number; color?: string }
): Promise<string> {
  const resp = await browser.runtime
    .sendMessage({ type: 'getIconSvg', name, ...opts })
    .catch(logError);
  if (resp?.success) return resp.svg as string;
  return '';
}

/** Record a successful autofill via background (offloads blocklist-learn.ts). */
export async function recordAutofillSuccessViaBg(domain: string): Promise<void> {
  await browser.runtime.sendMessage({ type: 'recordAutofillSuccess', domain }).catch(logError);
}

/** Record a failed autofill via background; returns failure tracking info. */
export async function recordAutofillFailureViaBg(domain: string): Promise<{
  count: number;
  shouldSuggestBlock: boolean;
} | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'recordAutofillFailure', domain })
    .catch(logError)) as
    | { success: true; result: { count: number; shouldSuggestBlock: boolean } }
    | undefined;
  return resp?.success ? resp.result : null;
}

/** Load smart autofill settings via background (offloads smart-settings.ts + storage.ts). */
export async function loadSmartAutofillSettingsViaBg(): Promise<unknown | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'loadSmartAutofillSettings' })
    .catch(logError)) as { success: true; settings: unknown } | undefined;
  return resp?.success ? resp.settings : null;
}

/** Route identity for a domain via background (offloads identity-router.ts + storage.ts). */
export async function routeIdentityForDomainViaBg(
  domain: string,
  identities?: unknown,
  selectedIdentityId?: string | null
): Promise<unknown | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'routeIdentityForDomain', domain, identities, selectedIdentityId })
    .catch(logError)) as { success: true; result: unknown } | undefined;
  return resp?.success ? resp.result : null;
}

/** Record an autofill outcome via background (offloads site-memory.ts). */
export async function recordAutofillOutcomeViaBg(opts: {
  domain: string;
  success: boolean;
  identityId?: string | null;
  inboxId?: string | null;
  email?: string | null;
  formScore?: unknown;
  policyUrls?: string[];
  usedReplay?: boolean;
}): Promise<void> {
  await browser.runtime.sendMessage({ type: 'recordAutofillOutcome', opts }).catch(logError);
}

/** Check if replay should be preferred for a domain via background. */
export async function shouldPreferReplayViaBg(domain: string): Promise<boolean> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'shouldPreferReplay', domain })
    .catch(logError)) as { success: true; result: boolean } | undefined;
  return resp?.success ? resp.result : false;
}

/** Pick the freshest identity for signup via background (offloads freshness.ts). */
export async function pickFreshestIdentityViaBg(
  domain: string,
  identities?: unknown,
  liveEmails?: string[]
): Promise<unknown | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'pickFreshestIdentity', domain, identities, liveEmails })
    .catch(logError)) as { success: true; result: unknown } | undefined;
  return resp?.success ? resp.result : null;
}

/** Get active inbox metadata via background (offloads autofill-plan.ts). */
export async function getActiveInboxMetaViaBg(): Promise<{
  inboxId: string | null;
  address: string | null;
  provider: string | null;
  providerDisplay: string | null;
} | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'getActiveInboxMeta' })
    .catch(logError)) as
    | {
        success: true;
        result: {
          inboxId: string | null;
          address: string | null;
          provider: string | null;
          providerDisplay: string | null;
        };
      }
    | undefined;
  return resp?.success ? resp.result : null;
}

/** Mark latest credential verified via background (offloads post-submit.ts). */
export async function markLatestCredentialVerifiedViaBg(domain: string): Promise<boolean> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'markLatestCredentialVerified', domain })
    .catch(logError)) as { success: true; result: boolean } | undefined;
  return resp?.success ? resp.result : false;
}

/** Get wizard session for a domain via background (offloads wizard-session.ts storage). */
export async function getWizardSessionViaBg(domain: string): Promise<unknown | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'getWizardSession', domain })
    .catch(logError)) as { success: true; result: unknown } | undefined;
  return resp?.success ? resp.result : null;
}

/** Upsert a wizard session via background (offloads wizard-session.ts storage). */
export async function upsertWizardSessionViaBg(
  partial: Record<string, unknown> & { domain: string }
): Promise<unknown | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'upsertWizardSession', partial })
    .catch(logError)) as { success: true; result: unknown } | undefined;
  return resp?.success ? resp.result : null;
}

/** Advance wizard step via background (offloads wizard-session.ts storage). */
export async function advanceWizardStepViaBg(
  domain: string,
  step: string,
  extra?: Record<string, unknown>
): Promise<void> {
  await browser.runtime
    .sendMessage({ type: 'advanceWizardStep', domain, step, extra })
    .catch(logError);
}

/** Clear wizard session via background (offloads wizard-session.ts storage). */
export async function clearWizardSessionViaBg(domain: string): Promise<void> {
  await browser.runtime.sendMessage({ type: 'clearWizardSession', domain }).catch(logError);
}

/** Detect wizard step from current page (must run in content script — needs DOM). */
export function detectWizardStepFromPage(): 'form' | 'otp' | 'profile' | 'done' {
  try {
    const path =
      `${location.pathname} ${location.search} ${location.hash} ${document.title}`.toLowerCase();
    if (
      /(success|welcome|dashboard|home|complete|verified)/.test(path) &&
      !/sign\s*up|register/.test(path)
    ) {
      return 'done';
    }
    if (/(otp|2fa|mfa|verify|verification|confirm.?email|enter.?code)/.test(path)) return 'otp';
    if (/(profile|details|about.?you|personal|address|complete.?profile)/.test(path))
      return 'profile';
  } catch {
    /* ignore */
  }
  return 'form';
}

/** Resolve domain field overrides via background (offloads domain-field-overrides.ts + JSONC config). */
export async function resolveDomainFieldOverridesViaBg(
  identity: unknown,
  domain: string
): Promise<Record<string, unknown>> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'resolveDomainFieldOverrides', identity, domain })
    .catch(logError)) as { success: true; result: Record<string, unknown> } | undefined;
  return resp?.success ? resp.result : {};
}

/** Build a stable selector for an element (inlined from field-maps.ts to avoid
 * pulling the storage module into the content bundle). */
export function buildSelectorHint(el: Element): string {
  if (!(el instanceof HTMLElement)) return el.tagName.toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${CSS.escape(el.id)}`;
  const name = el.getAttribute('name');
  if (name) return `${tag}[name="${CSS.escape(name)}"]`;
  const ac = el.getAttribute('autocomplete');
  if (ac) return `${tag}[autocomplete="${CSS.escape(ac)}"]`;
  const aria = el.getAttribute('aria-label');
  if (aria && aria.length < 40) return `${tag}[aria-label="${CSS.escape(aria)}"]`;
  const form = el.closest('form');
  if (form) {
    const inputs = Array.from(form.querySelectorAll(tag));
    const idx = inputs.indexOf(el);
    if (idx >= 0) return `form ${tag}:nth-of-type(${idx + 1})`;
  }
  return tag;
}

/** Get a field map for a domain via background (offloads field-maps.ts storage). */
export async function getFieldMapViaBg(domain: string): Promise<unknown | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'getFieldMap', domain })
    .catch(logError)) as { success: true; result: unknown } | undefined;
  return resp?.success ? resp.result : null;
}

/** Record a field map hit via background (offloads field-maps.ts storage). */
export async function recordFieldMapHitViaBg(
  domain: string,
  kind: string,
  selector: string
): Promise<void> {
  await browser.runtime
    .sendMessage({ type: 'recordFieldMapHit', domain, kind, selector })
    .catch(logError);
}

/** Test text against multilingual conflict regexes via background.
 * Offloads the ~64K of multilingual regex patterns from conflict-watch.ts. */
export async function testConflictTextViaBg(
  text: string
): Promise<'email' | 'username' | 'otp' | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'testConflictText', text })
    .catch(logError)) as { success: true; result: 'email' | 'username' | 'otp' | null } | undefined;
  return resp?.success ? resp.result : null;
}

/** Classify field text via background — offloads ~64K of multilingual regex from a11y-fields.ts. */
export async function matchKindFromTextViaBg(
  text: string
): Promise<{ kind: FormFieldKind; confidence: number } | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'matchKindFromText', text })
    .catch(logError)) as
    | { success: true; result: { kind: FormFieldKind; confidence: number } | null }
    | undefined;
  return resp?.success ? resp.result : null;
}

/** Classify field metadata text via background — offloads ~900 bytes of
 * multilingual regex patterns from findUsernameField in form-filler.ts. */
export async function classifyFieldFastViaBg(text: string): Promise<{
  isUsername: boolean;
  isEmailish: boolean;
}> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'classifyFieldFast', text })
    .catch(logError)) as
    | { success: true; result: { isUsername: boolean; isEmailish: boolean } }
    | undefined;
  return resp?.success ? resp.result : { isUsername: false, isEmailish: false };
}

/** Create a fresh inbox address via background (offloads browser.storage + runtime). */
export async function createFreshInboxAddressViaBg(): Promise<string | null> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'createInboxWithGesture' })
    .catch(logError)) as
    | { success: true; address?: string; inbox?: { address?: string } }
    | undefined;
  return resp?.success ? resp.inbox?.address || resp.address || null : null;
}

/** Generic runtime message bridge (offloads browser.runtime from content scripts). */
export async function sendMessageViaBg<T = unknown>(
  message: Record<string, unknown>
): Promise<T | undefined> {
  return (await browser.runtime.sendMessage(message).catch(logError)) as T | undefined;
}

/** Get storage values via background (offloads browser.storage from content). */
export async function getStorageViaBg(keys: string | string[]): Promise<Record<string, unknown>> {
  const resp = (await browser.runtime
    .sendMessage({ type: 'getStorageViaBg', keys })
    .catch(logError)) as { success: true; data?: Record<string, unknown> } | undefined;
  return resp?.data || {};
}

/** Set storage values via background (offloads browser.storage from content). */
export async function setStorageViaBg(items: Record<string, unknown>): Promise<void> {
  await browser.runtime.sendMessage({ type: 'setStorageViaBg', items }).catch(logError);
}
