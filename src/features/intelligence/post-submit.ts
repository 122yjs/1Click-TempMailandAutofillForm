/**
 * Post-submit outcome detection — only after a real submit/continue click.
 * Marks credentials: pending_submit → submitted → verified | undetected.
 */

import { browser } from 'wxt/browser';
import type { CredentialsHistoryItem } from '@/utils/types.js';
import { normalizeDomain } from './storage.js';

export type SignupOutcomeStatus =
  | 'pending_submit'
  | 'submitted'
  | 'verified'
  | 'undetected'
  | 'failed';

const SUCCESS_PATH =
  /(success|welcome|dashboard|home|account.?created|thank.?you|verified|complete|onboarding|getting.?started|\/app\b|\/home\b)/i;
const SUCCESS_TOAST =
  /(welcome|success|you.?re in|account created|signed up|registration complete|email verified|you.?re all set)/i;
const FAIL_TOAST =
  /(could not|unable to|failed to|something went wrong|try again|error creating|registration failed)/i;

export function looksLikeSignupSuccess(): boolean {
  try {
    const url = location.href.toLowerCase();
    if (
      SUCCESS_PATH.test(url) &&
      !/sign\s*up|register|log\s*in|sign\s*in|create.?account/.test(url)
    ) {
      return true;
    }
    const title = (document.title || '').toLowerCase();
    if (SUCCESS_PATH.test(title) && !/sign\s*up|register|login|sign\s*in/.test(title)) return true;
    for (const el of Array.from(
      document.querySelectorAll(
        '[role="status"], [role="alert"], .toast, .snackbar, .alert-success, .success, [class*="success" i]'
      )
    ).slice(0, 24)) {
      const t = (el.textContent || '').trim();
      if (t.length > 4 && t.length < 220 && SUCCESS_TOAST.test(t) && !FAIL_TOAST.test(t))
        return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function looksLikeSignupFailure(): boolean {
  try {
    for (const el of Array.from(
      document.querySelectorAll('[role="alert"], .error, .toast, [class*="error" i], [aria-live]')
    ).slice(0, 30)) {
      const t = (el.textContent || '').trim();
      if (t.length > 6 && t.length < 240 && FAIL_TOAST.test(t)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export async function markLatestCredentialStatus(
  domain: string,
  status: SignupOutcomeStatus
): Promise<boolean> {
  const d = normalizeDomain(domain);
  try {
    const { loginInfo = [] } = (await browser.storage.local.get(['loginInfo'])) as {
      loginInfo?: CredentialsHistoryItem[];
    };
    // Update most recent credential for this domain
    let idx = -1;
    let latest = 0;
    for (let i = 0; i < loginInfo.length; i++) {
      const ld = normalizeDomain(loginInfo[i]?.domain || '');
      const ts = loginInfo[i]?.timestamp || 0;
      if (ld === d && ts >= latest) {
        latest = ts;
        idx = i;
      }
    }
    if (idx < 0) return false;
    const cur = loginInfo[idx];
    if (!cur) return false;
    const next = [...loginInfo];
    next[idx] = {
      ...cur,
      signupStatus: status,
      verified: status === 'verified',
      verifiedAt: status === 'verified' ? Date.now() : cur.verifiedAt,
      submittedAt:
        status === 'submitted' || status === 'verified'
          ? Date.now()
          : (cur as { submittedAt?: number }).submittedAt,
    };
    await browser.storage.local.set({ loginInfo: next });
    return true;
  } catch {
    /* ignore */
    return false;
  }
}

/** @deprecated use markLatestCredentialStatus(..., 'verified') */
export async function markLatestCredentialVerified(domain: string): Promise<boolean> {
  return markLatestCredentialStatus(domain, 'verified');
}

/**
 * Shared global-patch registry.
 *
 * `watchPostSubmitSuccess` used to capture `window.fetch`, `XMLHttpRequest…open`,
 * and `history.pushState/replaceState` per-call and restore them in `stop()`.
 * If a second watcher armed while the first was still active (SPA re-inject or
 * content-script re-scan), the second call captured the *already-patched*
 * originals, so the outer `stop()` restored to a patched function — leaving
 * the page permanently monkeypatched. These helpers ref-count a single set of
 * true originals and a shared tick registry so patching is idempotent.
 */
let _patchRefCount = 0;
const _tickFns = new Set<() => void>();
let _trueFetch: typeof fetch | null = null;
let _trueXhrOpen: ((...args: unknown[]) => void) | null = null;
let _truePush: ((...args: unknown[]) => void) | null = null;
let _trueReplace: ((...args: unknown[]) => void) | null = null;

function notifyAllTicks(): void {
  for (const fn of _tickFns) {
    try {
      fn();
    } catch {
      /* one watcher's tick must not break the others */
    }
  }
}

/** Install global patches once; subsequent calls only bump the ref count. */
function armGlobalPatches(): void {
  if (_patchRefCount > 0) {
    _patchRefCount++;
    return;
  }
  _trueFetch = window.fetch;
  _trueXhrOpen = XMLHttpRequest.prototype.open as unknown as (...args: unknown[]) => void;
  _truePush = history.pushState as unknown as (...args: unknown[]) => void;
  _trueReplace = history.replaceState as unknown as (...args: unknown[]) => void;
  _patchRefCount = 1;

  history.pushState = function (...args) {
    (_truePush as unknown as History['pushState']).apply(this, args);
    notifyAllTicks();
  };
  history.replaceState = function (...args) {
    (_trueReplace as unknown as History['replaceState']).apply(this, args);
    notifyAllTicks();
  };
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    notifyAllTicks();
    return (_trueFetch as unknown as typeof fetch)(input, init);
  }) as typeof fetch;
  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ) {
    notifyAllTicks();
    const fn = _trueXhrOpen as unknown as XMLHttpRequest['open'];
    return fn.call(this, method, url, async ?? true, username ?? null, password ?? null);
  } as XMLHttpRequest['open'];
}

/** Decrement ref count; only restore the true originals when the last watcher stops. */
function disarmGlobalPatches(): void {
  if (_patchRefCount === 0) return;
  _patchRefCount--;
  if (_patchRefCount > 0) return;
  if (_trueFetch) window.fetch = _trueFetch;
  if (_trueXhrOpen) XMLHttpRequest.prototype.open = _trueXhrOpen as XMLHttpRequest['open'];
  if (_truePush) history.pushState = _truePush as History['pushState'];
  if (_trueReplace) history.replaceState = _trueReplace as History['replaceState'];
  _trueFetch = null;
  _trueXhrOpen = null;
  _truePush = null;
  _trueReplace = null;
}

/**
 * Watch for success only after submit was confirmed (requirePriorSubmit).
 * Does NOT mark verified on mere navigation without submit.
 */
export function watchPostSubmitSuccess(
  domain: string,
  opts?: {
    timeoutMs?: number;
    requirePriorSubmit?: boolean;
    onSuccess?: () => void;
    onTimeout?: () => void;
    onFailure?: () => void;
  }
): () => void {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  let stopped = false;
  // If requirePriorSubmit, caller already marked submitted
  const startPath = location.pathname;

  const tick = async () => {
    if (stopped) return;
    if (looksLikeSignupFailure()) {
      await markLatestCredentialStatus(domain, 'failed');
      opts?.onFailure?.();
      stop();
      return;
    }
    if (looksLikeSignupSuccess()) {
      await markLatestCredentialStatus(domain, 'verified');
      opts?.onSuccess?.();
      stop();
      return;
    }
    // Path change after submit is a weak success signal only if not still on auth pages
    if (location.pathname !== startPath) {
      const p = location.pathname.toLowerCase();
      if (
        !/log-?in|sign-?in|sign-?up|register|create|auth|otp|verify|password/.test(p) &&
        SUCCESS_PATH.test(p)
      ) {
        await markLatestCredentialStatus(domain, 'verified');
        opts?.onSuccess?.();
        stop();
      }
    }
  };

  const iv = setInterval(() => void tick(), 1200);
  const timer = setTimeout(() => {
    if (!stopped) {
      void markLatestCredentialStatus(domain, 'undetected').then(() => opts?.onTimeout?.());
      stop();
    }
  }, timeoutMs);

  const onVis = () => void tick();
  window.addEventListener('popstate', onVis);

  // Register this watcher's tick into the shared, ref-counted global patcher
  // (see armGlobalPatches/disarmGlobalPatches) so concurrent watchers never
  // capture patched originals and leave the page permanently monkeypatched.
  _tickFns.add(tick);
  armGlobalPatches();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(iv);
    clearTimeout(timer);
    window.removeEventListener('popstate', onVis);
    _tickFns.delete(tick);
    disarmGlobalPatches();
  }

  // First tick after short delay (SPA render)
  setTimeout(() => void tick(), 600);

  return stop;
}
