/**
 * Multi-step signup wizard session — track step 1 → OTP → profile and resume.
 */

import { browser } from 'wxt/browser';
import { normalizeDomain } from './storage.js';

export type WizardStep = 'form' | 'otp' | 'profile' | 'done';

export interface WizardSession {
  domain: string;
  step: WizardStep;
  email?: string | null;
  identityId?: string | null;
  inboxId?: string | null;
  /** Values already filled (no passwords in long-term if sensitive — password optional) */
  filled: Record<string, string>;
  startedAt: number;
  updatedAt: number;
  /** Path patterns seen */
  paths: string[];
}

const KEY = 'autofillWizardSessions_v1';
const MAX = 30;
const TTL_MS = 2 * 60 * 60 * 1000; // 2h

export async function loadWizardSessions(): Promise<Record<string, WizardSession>> {
  try {
    const res = (await browser.storage.session
      .get([KEY])
      .catch(() => browser.storage.local.get([KEY]))) as { [KEY]?: Record<string, WizardSession> };
    const all = res[KEY] || {};
    const now = Date.now();
    const kept: Record<string, WizardSession> = {};
    for (const [k, v] of Object.entries(all)) {
      if (now - (v.updatedAt || 0) < TTL_MS) kept[k] = v;
    }
    return kept;
  } catch {
    /* ignore */
    return {};
  }
}

async function saveAll(map: Record<string, WizardSession>): Promise<void> {
  const entries = Object.values(map).sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmed: Record<string, WizardSession> = {};
  for (const s of entries.slice(0, MAX)) trimmed[s.domain] = s;
  try {
    await browser.storage.session.set({ [KEY]: trimmed });
  } catch {
    /* ignore */
    await browser.storage.local.set({ [KEY]: trimmed });
  }
}

export async function getWizardSession(domain: string): Promise<WizardSession | null> {
  const d = normalizeDomain(domain);
  const all = await loadWizardSessions();
  return all[d] || null;
}

export async function upsertWizardSession(
  partial: Partial<WizardSession> & { domain: string }
): Promise<WizardSession> {
  const d = normalizeDomain(partial.domain);
  const all = await loadWizardSessions();
  const prev = all[d];
  const next: WizardSession = {
    domain: d,
    step: partial.step || prev?.step || 'form',
    email: partial.email !== undefined ? partial.email : prev?.email,
    identityId: partial.identityId !== undefined ? partial.identityId : prev?.identityId,
    inboxId: partial.inboxId !== undefined ? partial.inboxId : prev?.inboxId,
    filled: { ...(prev?.filled || {}), ...(partial.filled || {}) },
    startedAt: prev?.startedAt || Date.now(),
    updatedAt: Date.now(),
    paths: [...new Set([...(prev?.paths || []), ...(partial.paths || [])])].slice(-12),
  };
  // Strip password from long-lived filled bag after a while is safer — keep short-lived only
  all[d] = next;
  await saveAll(all);
  return next;
}

export async function advanceWizardStep(
  domain: string,
  step: WizardStep,
  extra?: Partial<WizardSession>
): Promise<void> {
  await upsertWizardSession({ domain, step, ...extra });
}

export function detectWizardStepFromPage(): WizardStep {
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

export async function clearWizardSession(domain: string): Promise<void> {
  const d = normalizeDomain(domain);
  const all = await loadWizardSessions();
  delete all[d];
  await saveAll(all);
}
