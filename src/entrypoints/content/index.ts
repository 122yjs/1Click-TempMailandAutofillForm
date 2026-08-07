import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { queryAllDeep } from '@/features/intelligence/dom-pierce.js';
import {
  advanceWizardStepViaBg,
  clearWizardSessionViaBg,
  detectWizardStepFromPage,
  getStorageViaBg,
  getWizardSessionViaBg,
  loadSmartAutofillSettingsViaBg,
  markLatestCredentialVerifiedViaBg,
  sendMessageViaBg,
} from '@/utils/content-bg-bridge.js';
import { getErrorMessage } from '@/utils/content-errors.js';
import { logError } from '@/utils/logger.js';
import { CONTENT_Z } from '@/utils/portal-layers.js';
import { injectAutoFillButtons, removeInjectedButtons } from './autofill/autofill-buttons.js';
import { findSignupForm } from './autofill/form-detector.js';
import { activeNameCorrectionTimers, fillSignupForm } from './autofill/form-filler.js';
import { attachDisposableHint } from './disposable/disposable-detector.js';
import { getOrCreateShadowRoot, protectShadowHost } from './dom/shadow-dom.js';
import { fillOtp } from './otp/otp-handler.js';
import { getActiveWaitOtpPanel, showWaitOtpPanel } from './otp/wait-otp-panel.js';

// -- Lightweight helpers inlined to avoid pulling heavy deps into content script --
// getRootDomain, getDomainName, isDomainBlocked are inlined here
// instead of importing from favicon.ts / storage-keys.ts / tldts
// to avoid pulling ~150 KB of transitive deps into the content bundle.

const MLEVEL_TLDS = new Set([
  'co.uk',
  'co.jp',
  'co.in',
  'co.il',
  'co.za',
  'co.kr',
  'co.nz',
  'co.id',
  'com.br',
  'com.mx',
  'com.au',
  'com.ar',
  'com.sg',
  'com.my',
  'com.ph',
  'net.au',
  'net.br',
  'org.uk',
  'org.au',
  'org.br',
  'gov.uk',
  'gov.au',
  'ac.uk',
  'ac.jp',
  'sch.uk',
  'k12.ca.us',
]);

function getRootDomain(domain: string): string {
  if (!domain) return '';
  const parts = domain.toLowerCase().split('.').filter(Boolean);
  if (parts.length >= 3) {
    const tld2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (MLEVEL_TLDS.has(tld2)) return parts.slice(-3).join('.');
  }
  if (parts.length >= 2) return parts.slice(-2).join('.');
  return domain;
}
async function getAutofillBlocklist(): Promise<string[]> {
  const { autofillBlocklist = [] } = (await getStorageViaBg(['autofillBlocklist'])) as {
    autofillBlocklist?: string[];
  };
  return autofillBlocklist;
}

async function isDomainBlocked(domain: string): Promise<boolean> {
  const blocklist = await getAutofillBlocklist();
  return blocklist.includes(domain);
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_end',
  main() {
    sendMessageViaBg({ type: 'clearSessionCredentials' }).catch((e: Error) =>
      logError('Could not send clear session message', e)
    );

    const autoFillButtonsInjected = { value: false };
    const injectedButtons: HTMLElement[] = [];
    const updatePositionListeners: Array<() => void> = [];
    const disposableTrackers = new Set<{ cleanup: () => void }>();
    let initialScanTimer: ReturnType<typeof setTimeout> | null = null;
    let rescanTimer: ReturnType<typeof setTimeout> | null = null;
    let currentUrl = window.location.href;
    /** Gate scans until the correct locale pack is loaded */
    let localeReady: Promise<void> = Promise.resolve();

    async function ensureLocaleReady(): Promise<void> {
      // Locale initialized at module scope via initLocale()
    }

    // MUST complete before injecting any UI so labels are not English by default
    localeReady = ensureLocaleReady();

    // Multi-step wizard resume + post-submit verify (best-effort)
    void localeReady.then(async () => {
      try {
        const domain = window.location.hostname;
        const session = (await getWizardSessionViaBg(domain)) as {
          email?: string | null;
        } | null;
        if (!session) return;
        const step = detectWizardStepFromPage();

        if (step === 'otp') {
          await advanceWizardStepViaBg(domain, 'otp', { paths: [location.pathname] });
          const smart = (await loadSmartAutofillSettingsViaBg()) as {
            smartOtpAttach: boolean;
          } | null;
          if (smart?.smartOtpAttach && session.email) {
            void showWaitOtpPanel({
              email: session.email,
              autoFill: true,
              skipIfNotVerificationPage: true,
            });
          }
        } else if (step === 'done') {
          await markLatestCredentialVerifiedViaBg(domain);
          await clearWizardSessionViaBg(domain);
        } else if (step === 'profile') {
          await advanceWizardStepViaBg(domain, 'profile', { paths: [location.pathname] });
        }
      } catch {
        /* optional intelligence */
      }
    });

    async function updateAndCopyCredentials(
      credentialsToUpdate: Record<string, string>
    ): Promise<void> {
      try {
        await sendMessageViaBg({
          type: 'updateSessionCredentials',
          credentials: credentialsToUpdate,
        });
      } catch (error: unknown) {
        logError('Error sending update credentials message', error);
      }
    }

    async function isAutofillFeatureEnabled(): Promise<boolean> {
      try {
        const { autofillFeatureEnabled } = (await getStorageViaBg(['autofillFeatureEnabled'])) as {
          autofillFeatureEnabled?: boolean;
        };
        // Default ON when unset
        return autofillFeatureEnabled !== false;
      } catch {
        /* ignore */
        return true;
      }
    }

    async function scanForFormsAndInjectButtons(force = false): Promise<void> {
      try {
        await localeReady;
        if (!(await isAutofillFeatureEnabled())) {
          clearInjectedUi();
          return;
        }
        // Check if current domain is blocked from autofill
        const currentDomain = window.location.hostname;
        if (await isDomainBlocked(currentDomain)) {
          return;
        }

        // Keep shadow host alive against SPA DOM rewrites
        getOrCreateShadowRoot();
        protectShadowHost();

        // Field icons: lower bar; Autofill All uses score gate inside inject
        // Progressive SPA steps (email-only) need low minScore
        const form = await findSignupForm(30);
        if (form) {
          // Force re-inject when SPA replaced form or buttons were detached
          if (force || !autoFillButtonsInjected.value) {
            if (force) {
              clearInjectedUi();
            }
            await injectAutoFillButtons(
              form,
              injectedButtons,
              updatePositionListeners,
              autoFillButtonsInjected,
              updateAndCopyCredentials
            );
          } else {
            // Buttons exist — re-assert host + visibility only
            try {
              protectShadowHost();
              for (const el of injectedButtons) {
                if (el?.style) {
                  el.style.setProperty('opacity', '0.95', 'important');
                  el.style.setProperty('visibility', 'visible', 'important');
                  el.style.setProperty(
                    'display',
                    el.style.display === 'none' ? 'flex' : el.style.display || 'flex',
                    'important'
                  );
                  el.style.setProperty('pointer-events', 'auto', 'important');
                  el.style.setProperty('z-index', String(CONTENT_Z.tooltip), 'important');
                }
              }
            } catch {
              /* ignore */
            }
          }
        }
      } catch (error: unknown) {
        logError('Error scanning for forms', error);
      }
    }

    let idleCallbackId: number | null = null;
    let disposableIdleId: number | null = null;
    let disposableTimerId: ReturnType<typeof setTimeout> | null = null;

    function scheduleScan(delay = 0): void {
      if (rescanTimer) clearTimeout(rescanTimer);
      if (idleCallbackId !== null) {
        if ('cancelIdleCallback' in window) {
          window.cancelIdleCallback(idleCallbackId);
        }
        idleCallbackId = null;
      }

      if (delay > 0) {
        rescanTimer = setTimeout(() => {
          rescanTimer = null;
          triggerScan();
        }, delay);
      } else {
        triggerScan();
      }
    }

    function triggerScan(): void {
      if ('requestIdleCallback' in window) {
        idleCallbackId = window.requestIdleCallback(
          () => {
            idleCallbackId = null;
            void scanForFormsAndInjectButtons();
          },
          { timeout: 500 }
        );
      } else {
        void scanForFormsAndInjectButtons();
      }
    }

    function clearInjectedUi(): void {
      void (async () => {
        removeInjectedButtons(injectedButtons, updatePositionListeners);
      })();
      autoFillButtonsInjected.value = false;
      disposableTrackers.forEach((t) => {
        try {
          t.cleanup();
        } catch (error: unknown) {
          logError('Failed to clean up disposable tracker', error);
        }
      });
      disposableTrackers.clear();
      activeNameCorrectionTimers.forEach(clearInterval);
      activeNameCorrectionTimers.clear();
    }

    function scheduleDisposableScan(): void {
      if (disposableTimerId) clearTimeout(disposableTimerId);
      if (disposableIdleId !== null) {
        if ('cancelIdleCallback' in window) {
          window.cancelIdleCallback(disposableIdleId);
        }
        disposableIdleId = null;
      }

      disposableTimerId = setTimeout(() => {
        disposableTimerId = null;
        if ('requestIdleCallback' in window) {
          disposableIdleId = window.requestIdleCallback(
            () => {
              disposableIdleId = null;
              scanForDisposableHints();
            },
            { timeout: 500 }
          );
        } else {
          scanForDisposableHints();
        }
      }, 100);
    }

    function scanForDisposableHints(): void {
      void localeReady.then(async () => {
        const emailFields = queryAllDeep<HTMLInputElement>(
          document,
          'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="email"]'
        );
        emailFields.forEach((field: HTMLInputElement) => {
          if (disposableTrackers.size >= 50) return;
          void (async () => {
            const tracker = attachDisposableHint(field, updatePositionListeners);
            if (tracker) disposableTrackers.add(tracker);
          })();
        });
      });
    }

    // Re-inject translated UI when user changes extension language;
    // also re-scan when inboxes become available (create on another tab).

    function handlePageLoad(): void {
      scheduleScan(0);
    }

    function handleSpaNavigation(): void {
      if (window.location.href === currentUrl) return;
      currentUrl = window.location.href;
      clearInjectedUi();
      if (formWatchTimer) {
        clearInterval(formWatchTimer);
        formWatchTimer = null;
      }
      scheduleScan(50);
      scheduleDisposableScan();
      // Tell extension UI form may have gone
      try {
        void sendMessageViaBg({ type: 'formPresence', formDetected: false }).catch(() => {});
      } catch {
        /* ignore */
      }
    }

    let isExtensionActive = true;
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      if (isExtensionActive) handleSpaNavigation();
      return result;
    };
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      if (isExtensionActive) handleSpaNavigation();
      return result;
    };

    window.addEventListener('load', handlePageLoad);
    window.addEventListener('popstate', handleSpaNavigation);
    window.addEventListener('hashchange', handleSpaNavigation);

    const navListener = () => {
      setTimeout(handleSpaNavigation, 0);
    };
    try {
      const nav = (window as unknown as { navigation?: EventTarget }).navigation;
      nav?.addEventListener?.('navigate', navListener);
    } catch {
      /* Navigation API optional */
    }
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') scheduleScan(100);
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', teardown);
    window.addEventListener('unload', teardown);
    scheduleScan(0);
    scheduleDisposableScan();
    initialScanTimer = setTimeout(() => {
      initialScanTimer = null;
      scheduleScan(0);
      scheduleDisposableScan();
    }, 1000);

    // Soft re-check: keep UI alive on SPA; only clear if no auth form for a while
    let missingFormTicks = 0;
    let formWatchTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
      void (async () => {
        getOrCreateShadowRoot();
        protectShadowHost();
        const form = await findSignupForm(30);
        if (!form) {
          missingFormTicks += 1;
          // Multi-step SPA may briefly have no form between steps — wait ~12s
          if (autoFillButtonsInjected.value && missingFormTicks >= 3) {
            clearInjectedUi();
            missingFormTicks = 0;
            try {
              void sendMessageViaBg({ type: 'formPresence', formDetected: false }).catch(() => {});
            } catch {
              /* ignore */
            }
          }
          return;
        }
        missingFormTicks = 0;
        // Form present but buttons lost (host removed) → force re-inject
        if (!autoFillButtonsInjected.value || injectedButtons.some((b) => !b.isConnected)) {
          clearInjectedUi();
          scheduleScan(50);
        }
      })();
    }, 4000);

    let mutationTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingMutations: MutationRecord[] = [];
    const observer = new MutationObserver((mutations: MutationRecord[]) => {
      pendingMutations.push(...mutations);
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        const muts = pendingMutations;
        pendingMutations = [];
        mutationTimer = null;
        let mightHaveAddedForm = false;
        let mightHaveRemovedForm = false;
        for (const mutation of muts) {
          if (mutation.addedNodes.length > 0) {
            for (const node of Array.from(mutation.addedNodes)) {
              if (node.nodeType !== 1) continue;
              const el = node as Element;
              if (
                el.classList?.contains('oneclick-autofill-btn') ||
                el.id?.includes('oneclick') ||
                el.hasAttribute?.('data-oneclick-injected')
              ) {
                continue;
              }
              if (el.nodeName === 'FORM' || el.querySelector?.('form, input[type="email"]')) {
                mightHaveAddedForm = true;
              }
            }
          }
          if (mutation.removedNodes.length > 0 && autoFillButtonsInjected.value) {
            for (const node of Array.from(mutation.removedNodes)) {
              if (node.nodeType !== 1) continue;
              const el = node as Element;
              if (el.nodeName === 'FORM' || el.querySelector?.('form, input[type="email"]')) {
                mightHaveRemovedForm = true;
              }
            }
          }
        }
        if (mightHaveAddedForm) {
          // SPA step change (email → name → OTP): force re-inject on new fields
          if (autoFillButtonsInjected.value && mightHaveRemovedForm) {
            clearInjectedUi();
          }
          // Force scan so multi-step containers get Autofill All again
          if (rescanTimer) clearTimeout(rescanTimer);
          rescanTimer = setTimeout(() => {
            rescanTimer = null;
            void scanForFormsAndInjectButtons(true);
          }, 150);
        } else if (mightHaveRemovedForm) {
          void (async () => {
            const form = await findSignupForm(30);
            if (!form) {
              // Early disconnect to prevent event spam while waiting
              updatePositionListeners.forEach((fn) => {
                try {
                  fn();
                } catch {
                  /* intentional: position listener teardown */
                }
              });
              updatePositionListeners.length = 0;
              // Defer clear — multi-step transition may be mid-flight
              setTimeout(() => {
                void (async () => {
                  const f2 = await findSignupForm(30);
                  if (!f2) clearInjectedUi();
                  else {
                    clearInjectedUi();
                    void scanForFormsAndInjectButtons(true);
                  }
                })();
              }, 400);
            } else {
              clearInjectedUi();
              void scanForFormsAndInjectButtons(true);
            }
          })();
        }
      }, 100);
    });

    const disposableObserver = new MutationObserver((mutations: MutationRecord[]) => {
      const shouldRescan = mutations.some(
        (mutation: MutationRecord) =>
          mutation.addedNodes.length > 0 &&
          Array.from(mutation.addedNodes).some((node: Node) => {
            if (node.nodeType !== 1) return false;
            const el = node as Element;
            return !el.classList?.contains('oneclick-autofill-btn');
          })
      );
      if (shouldRescan) {
        scheduleDisposableScan();
      }
    });
    disposableObserver.observe(document.body, { childList: true, subtree: true });

    observer.observe(document.body, { childList: true, subtree: true });

    function teardown(): void {
      if (initialScanTimer) clearTimeout(initialScanTimer);
      if (rescanTimer) clearTimeout(rescanTimer);
      if (disposableTimerId) clearTimeout(disposableTimerId);
      if (formWatchTimer) {
        clearInterval(formWatchTimer);
        formWatchTimer = null;
      }

      if (idleCallbackId !== null && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleCallbackId);
      }
      if (disposableIdleId !== null && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(disposableIdleId);
      }

      try {
      } catch {
        /* ignore */
      }
      observer.disconnect();
      disposableObserver.disconnect();
      clearInjectedUi();
      window.removeEventListener('load', handlePageLoad);
      window.removeEventListener('popstate', handleSpaNavigation);
      window.removeEventListener('hashchange', handleSpaNavigation);
      try {
        const nav = (window as unknown as { navigation?: EventTarget }).navigation;
        nav?.removeEventListener?.('navigate', navListener);
      } catch {
        /* intentional: navigation API teardown */
      }

      // Restore history methods
      if (history.pushState !== originalPushState) {
        history.pushState = originalPushState;
      }
      if (history.replaceState !== originalReplaceState) {
        history.replaceState = originalReplaceState;
      }

      window.removeEventListener('pagehide', teardown);
      window.removeEventListener('unload', teardown);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      isExtensionActive = false;
    }

    window.addEventListener('pagehide', teardown);

    browser.runtime.onMessage.addListener(
      (message: unknown, _sender: unknown, sendResponse: (r: unknown) => void) => {
        if (typeof message !== 'object' || message === null) return false;
        const runtimeMessage = message as Record<string, unknown>;
        if (runtimeMessage.action === 'startSignup') {
          (async () => {
            try {
              // Check if current domain is blocked from autofill
              const currentDomain = window.location.hostname;
              if (await isDomainBlocked(currentDomain)) {
                sendMessageViaBg({
                  status: 'Autofill is disabled for this website',
                  isError: true,
                }).catch(logError);
                return;
              }

              const form = await findSignupForm();
              if (!form) {
                sendMessageViaBg({
                  status: 'No signup form found on this page',
                  isError: true,
                }).catch(logError);
                return;
              }

              // Load selected identity from storage
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

              const success = await fillSignupForm(
                form,
                updateAndCopyCredentials,
                selectedIdentity
              );
              if (success) {
                const hasPasswordField = form.querySelector(
                  'input[type="password"], input[name*="password"], input[id*="password"]'
                );
                sendMessageViaBg({
                  status: hasPasswordField
                    ? 'Form filled successfully. Please review and submit.'
                    : 'Email-only form filled successfully. Please review and submit.',
                  isError: false,
                }).catch(logError);
              } else {
                sendMessageViaBg({ status: 'Failed to fill form', isError: true }).catch(logError);
              }
            } catch (error: unknown) {
              sendMessageViaBg({
                status: `Error during signup process: ${getErrorMessage(error)}`,
                isError: true,
              }).catch(logError);
            }
          })();
          return true;
        }

        if (runtimeMessage.type === 'fillOTP') {
          (async () => {
            try {
              const currentDomain = window.location.hostname;
              const isBlocked = await isDomainBlocked(currentDomain);
              if (isBlocked) {
                return;
              }

              const otp = typeof runtimeMessage.otp === 'string' ? runtimeMessage.otp : '';
              const sender = typeof runtimeMessage.sender === 'string' ? runtimeMessage.sender : '';
              const senderName =
                typeof runtimeMessage.senderName === 'string' ? runtimeMessage.senderName : '';
              const subject =
                typeof runtimeMessage.subject === 'string' ? runtimeMessage.subject : '';

              // Always feed the Wait-for-OTP panel when open (user opted in by starting wait)
              const waitPanel = getActiveWaitOtpPanel();
              if (waitPanel && otp) {
                await waitPanel.notifyOtp(otp, { sender, subject });
                return;
              }

              // Verify the current site is opted-in for OTP auto-fill (defaults to off)
              const { otpOptInList = [] } = (await getStorageViaBg(['otpOptInList'])) as {
                otpOptInList?: string[];
              };
              const domainKey = currentDomain.replace(/^www\./, '').toLowerCase();
              const isOptedIn = otpOptInList.some(
                (d) => typeof d === 'string' && d.toLowerCase() === domainKey
              );
              if (!isOptedIn) {
                return;
              }

              if (!isTabRelatedToOtp(currentDomain, sender, senderName, subject)) {
                return;
              }

              await fillOtp(otp);
            } catch (error: unknown) {
              logError('Error filling OTP', error);
            }
          })();
          sendResponse({ success: true });
          return true;
        }

        if (runtimeMessage.type === 'ping') {
          sendResponse({ ok: true });
          return true;
        }

        if (runtimeMessage.type === 'checkFormDetected') {
          (async () => {
            try {
              const form = await findSignupForm();
              const detected = !!form;
              sendResponse({ formDetected: detected });
              try {
                void sendMessageViaBg({ type: 'formPresence', formDetected: detected }).catch(
                  () => {}
                );
              } catch {
                /* ignore */
              }
            } catch (error: unknown) {
              logError('Error checking whether a signup form is present', error);
              sendResponse({ formDetected: false });
            }
          })();
          return true;
        }

        if (runtimeMessage.type === 'rescanForms') {
          (async () => {
            try {
              clearInjectedUi();
              await scanForFormsAndInjectButtons();
              const form = await findSignupForm();
              sendResponse({ ok: true, formDetected: !!form });
              try {
                void sendMessageViaBg({ type: 'formPresence', formDetected: !!form }).catch(
                  () => {}
                );
              } catch {
                /* ignore */
              }
            } catch (error: unknown) {
              logError('rescanForms failed', error);
              sendResponse({ ok: false, formDetected: false });
            }
          })();
          return true;
        }

        if (runtimeMessage.type === 'autofillForm') {
          scheduleScan(0);
          return true;
        }

        if (runtimeMessage.type === 'refillSavedLogin') {
          (async () => {
            try {
              const cred = (
                runtimeMessage as { credential?: Record<string, string | null | undefined> }
              ).credential;
              if (!cred) {
                sendResponse({ success: false });
                return;
              }
              const form = await findSignupForm();
              if (!form) {
                sendResponse({ success: false, error: 'no form' });
                return;
              }
              await fillSignupForm(form, async () => {}, undefined, {
                email: String(cred.email || ''),
                password: String(cred.password || ''),
                username: (cred.username as string | null | undefined) ?? null,
                name: (cred.name as string | null | undefined) ?? null,
                phone: (cred.phone as string | null | undefined) ?? null,
                website: (cred.website as string | null | undefined) ?? null,
              });
              sendResponse({ success: true });
            } catch (e) {
              logError('refillSavedLogin error', e);
              sendResponse({ success: false });
            }
          })();
          return true;
        }

        if (runtimeMessage.type === 'autofillBlocklistChanged') {
          (async () => {
            const currentDomain = window.location.hostname;
            const blocked = await isDomainBlocked(currentDomain);
            if (blocked) {
              // Remove any injected buttons if domain was just blocked
              clearInjectedUi();
            } else {
              // Re-scan and inject buttons if domain was just unblocked
              clearInjectedUi();
              scheduleScan(0);
            }
          })();
          return true;
        }
      }
    );
  },
});

export function getDomainName(hostname: string): string {
  const root = getRootDomain(hostname);
  if (!root) return hostname.split('.')[0] || hostname;
  const parts = root.split('.');
  // For multi-level TLDs like co.uk, co.jp — strip 2 parts to get just the name
  if (parts.length >= 3) {
    const tld2 = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (MLEVEL_TLDS.has(tld2)) return parts.slice(0, parts.length - 2).join('.') || root;
  }
  return parts.slice(0, -1).join('.') || root;
}

export function isTabRelatedToOtp(
  currentDomain: string,
  senderEmail: string,
  senderName: string,
  subject: string
): boolean {
  const domainLower = currentDomain.toLowerCase();
  const domainName = getDomainName(domainLower);
  if (!domainName) return false;

  const senderEmailLower = senderEmail.toLowerCase();
  const senderNameLower = senderName.toLowerCase();
  const subjectLower = subject.toLowerCase();

  // Use word boundaries for domain name matching to avoid false positive matches on substrings.
  const escapedDomainName = domainName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const domainRegex = new RegExp(`\\b${escapedDomainName}\\b`, 'i');

  // 1. Exact registered-domain comparison (handles subdomains + multi-level TLDs).
  //    e.g. sub.github.com vs noreply@github.com -> both root to "github.com".
  const currentRoot = getRootDomain(domainLower);
  const emailDomainMatch = senderEmailLower.match(/@([^>\s]+)/);
  if (emailDomainMatch) {
    const emailRoot = getRootDomain(emailDomainMatch[1]);
    if (currentRoot && emailRoot && currentRoot === emailRoot) {
      return true;
    }
  }

  // 2. Brand-name word-boundary match against the sender email.
  //    Works for any brand length (e.g. "github" in noreply@github.com).
  if (domainRegex.test(senderEmailLower)) {
    return true;
  }

  // 3. Brand-name word-boundary match against sender name and subject -- but
  //    only for brand names longer than 2 characters, to prevent
  //    false-positives from short/common words (e.g. "it", "co", "in").
  if (domainName.length > 2) {
    if (domainRegex.test(senderNameLower)) {
      return true;
    }
    if (domainRegex.test(subjectLower)) {
      return true;
    }
  }

  // 4. Fallback: exact brand-name (getDomainName) equality between the
  //    current domain and the sender email's domain.
  if (emailDomainMatch) {
    const emailDomainName = getDomainName(emailDomainMatch[1]);
    if (emailDomainName && emailDomainName === domainName) {
      return true;
    }
  }

  return false;
}
