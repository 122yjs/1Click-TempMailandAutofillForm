/**
 * Runtime message handler - routes incoming messages to the appropriate module functions
 */

import {
  generatePassword,
  generatePhoneNumber,
  generateRandomName,
  generateUsername,
  generateWebsiteUrl,
} from '@/entrypoints/content/autofill/generators.js';
import { matchKindFromText } from '@/features/intelligence/a11y-fields.js';
import { getActiveInboxMeta } from '@/features/intelligence/active-inbox-meta.js';
import {
  recordAutofillFailure,
  recordAutofillSuccess,
} from '@/features/intelligence/blocklist-learn.js';
import {
  CONFLICT_RE,
  OTP_FAIL_RE,
  USERNAME_CONFLICT_RE,
} from '@/features/intelligence/conflict-regexes.js';
import { resolveDomainFieldOverrides } from '@/features/intelligence/domain-field-overrides.js';
import { getFieldMap, recordFieldMapHitBySelector } from '@/features/intelligence/field-maps.js';
import { pickFreshestIdentity } from '@/features/intelligence/freshness.js';
import { routeIdentityForDomain } from '@/features/intelligence/identity-router.js';
import {
  localeAwareAddressExtras,
  localeAwarePhone,
  localeToCountryHint,
} from '@/features/intelligence/locale-fill.js';
import { markLatestCredentialVerified } from '@/features/intelligence/post-submit.js';
import { recordAutofillOutcome, shouldPreferReplay } from '@/features/intelligence/site-memory.js';
import { loadSmartAutofillSettings } from '@/features/intelligence/smart-settings.js';
import type { WizardSession, WizardStep } from '@/features/intelligence/wizard-session.js';
import {
  advanceWizardStep,
  clearWizardSession,
  getWizardSession,
  upsertWizardSession,
} from '@/features/intelligence/wizard-session.js';
import { domainMatchesHost, findSiteReplayForDomain } from '@/features/login-info/login-crypto.js';
import type { IconSvgName } from '@/ui/components/icons/icon-svg.js';
import { getIconSvg } from '@/ui/components/icons/icon-svg.js';
import { copyToClipboardAndSchedulePurge } from '@/utils/clipboard.js';
import { FORCE_NEW_SESSIONS_AUTO_CLEAR_MS } from '@/utils/constants.js';
import { decrypt, encrypt } from '@/utils/crypto.js';
import {
  DEFAULT_PROVIDER,
  EmailService,
  getAllProviderConfigs,
  loadProviderConfig,
} from '@/utils/email-service.js';
import { getErrorMessage } from '@/utils/errors.js';
import {
  consumePendingGestureToken,
  validateAndConsumeGestureToken,
} from '@/utils/gesture-token.js';
import { t } from '@/utils/i18n-utils.js';
import {
  addCustomProviderInstance,
  getProviderInstancesWithCustom,
  getSelectedProviderInstance,
  initializeDefaultProvider,
  removeCustomProviderInstance,
  setDisabledInstances,
  setProviderInstance,
} from '@/utils/instance-manager.js';
import {
  isSafeFetchUrl,
  validateCustomInstanceName,
  validateCustomInstanceUrl,
} from '@/utils/instance-validation.js';
import { randomAdultDob } from '@/utils/locale-profile.js';
import { logError, logInfo, logWarn } from '@/utils/logger.js';
import { withInboxLock, withLock } from '@/utils/mutex.js';
import { deriveInboxTiming } from '@/utils/provider-expiry.js';
import { getInboxes, getSelectedProvider, setInboxes } from '@/utils/storage-keys.js';
import type {
  Account,
  CredentialsHistoryItem,
  EmailFilters,
  ProviderInstance,
  RuntimeMessageSender,
  SessionCredentials,
} from '@/utils/types.js';
import { handleUpdateSessionCredentials } from '../credentials/session-credentials.js';
import {
  getAnalytics,
  recordEmailRead,
  recordExtensionOpen,
  recordPageVisit,
  recordUIRenderTime,
  resetAnalyticsData,
} from '../inbox/analytics.js';
import {
  cleanupOldStoredEmails,
  clearAllOtps,
  clearStoredEmails,
  getArchivedEmails,
  getEmailsToBeDeleted,
  getStorageUsage,
  restoreArchivedEmailsToStored,
  storeNewMessages,
} from '../inbox/email-storage.js';
import {
  checkNewEmails,
  createInbox,
  deleteInbox,
  ensureBadgeCountdownAlarm,
  setupInboxExpiryCheck,
  setupPeriodicEmailCheck,
} from '../inbox/inbox-manager.js';
import { updateRefreshAlarm } from '../inbox/periodic-checks.js';

export interface RuntimeMessage {
  [key: string]: unknown;
  type?: string;
  action?: string;
  activeRetentionDays?: number;
  archivedRetentionDays?: number;
  color?: string;
  credentials?: Partial<SessionCredentials>;
  domain?: string;
  emailUser?: string;
  filters?: EmailFilters;
  func?: string;
  inboxAddress?: string;
  inboxId?: string;
  instance?: Omit<ProviderInstance, 'id' | 'isCustom'>;
  instanceId?: string;
  /** Disabled-instance blacklist for a provider (checkbox instance pool). */
  disabledInstances?: string[];
  intervalMs?: number;
  params?: Record<string, unknown>;
  preserveEmails?: boolean;
  provider?: string;
  renderTime?: number;
  retentionDays?: number;
  sidToken?: string;
  tag?: string;
  text?: string;
  fieldType?: string;
  locale?: string;
  purgeAfterMs?: number;
  url?: string;
}

type HandlerFn = (
  message: RuntimeMessage,
  sender: RuntimeMessageSender,
  sendResponse: (response: unknown) => void
) => Promise<void>;

export function requireString(message: RuntimeMessage, key: keyof RuntimeMessage): string {
  const value = message[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required message field: ${String(key)}`);
  }
  return value;
}

export function requireNumber(message: RuntimeMessage, key: keyof RuntimeMessage): number {
  const value = message[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing required message field: ${String(key)}`);
  }
  return value;
}

/** Hostname from a content-script tab sender (null when unavailable). */
export function senderTabHostname(sender: RuntimeMessageSender): string | null {
  const tabUrl = sender.tab?.url;
  if (!tabUrl) return null;
  try {
    return new URL(tabUrl).hostname;
  } catch {
    /* ignore */
    return null;
  }
}

/** Content scripts must only query credentials for the page they are injected on. */
export function isDomainAllowedForSender(domain: string, sender: RuntimeMessageSender): boolean {
  const host = senderTabHostname(sender);
  if (!host) return false;
  return domainMatchesHost(domain, host);
}

function isExtensionSender(sender: RuntimeMessageSender): boolean {
  const senderUrl = sender.url || '';
  return (
    senderUrl.startsWith('chrome-extension://') ||
    senderUrl.startsWith('moz-extension://') ||
    senderUrl.startsWith('extension://')
  );
}

const SIGNUP_STATUS_VALUES = new Set<CredentialsHistoryItem['signupStatus']>([
  'pending_submit',
  'submitted',
  'verified',
  'undetected',
  'failed',
]);

/** Whitelist credential fields persisted from content-script autofill. */
export function normalizeSavedLoginCredential(
  raw: Record<string, unknown>
): CredentialsHistoryItem | null {
  const domain = String(raw.domain || raw.site || raw.website || '').trim();
  const emailOrUsername = String(raw.email || raw.username || '').trim();
  if (!domain || !emailOrUsername) return null;

  const credential: CredentialsHistoryItem = {
    domain: domain.toLowerCase(),
    timestamp:
      typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
        ? raw.timestamp
        : Date.now(),
    email: raw.email != null ? String(raw.email) : null,
    username: raw.username != null ? String(raw.username) : null,
  };

  for (const key of ['name', 'phone', 'website', 'password', 'inboxId', 'identityId'] as const) {
    if (typeof raw[key] === 'string' && raw[key]) {
      credential[key] = raw[key];
    }
  }
  for (const key of ['country', 'gender', 'dateOfBirth', 'pin'] as const) {
    if (typeof raw[key] === 'string') {
      credential[key] = raw[key];
    }
  }
  if (Array.isArray(raw.policyUrls)) {
    credential.policyUrls = raw.policyUrls
      .filter((u): u is string => typeof u === 'string')
      .slice(0, 20);
  }
  if (Array.isArray(raw.filledFields)) {
    credential.filledFields = raw.filledFields
      .filter((f): f is string => typeof f === 'string')
      .slice(0, 50);
  }
  if (
    typeof raw.signupStatus === 'string' &&
    SIGNUP_STATUS_VALUES.has(raw.signupStatus as CredentialsHistoryItem['signupStatus'])
  ) {
    credential.signupStatus = raw.signupStatus as CredentialsHistoryItem['signupStatus'];
  }
  if (typeof raw.verified === 'boolean') credential.verified = raw.verified;
  if (typeof raw.verifiedAt === 'number' && Number.isFinite(raw.verifiedAt)) {
    credential.verifiedAt = raw.verifiedAt;
  }
  if (typeof raw.submittedAt === 'number' && Number.isFinite(raw.submittedAt)) {
    credential.submittedAt = raw.submittedAt;
  }
  return credential;
}

/**
 * Core inbox-creation logic shared by `createInbox` (extension-page caller)
 * and `createInboxWithGesture` (content-script caller with a valid gesture
 * token). Extracts the provider health-pick + failover + conflict-recovery
 * logic so both entry points stay in sync.
 */
async function createInboxInternal(
  message: RuntimeMessage,
  sendResponse: (response: unknown) => void
): Promise<void> {
  const allIds = getAllProviderConfigs().map((p) => p.id);
  const selected = await getSelectedProvider();
  const msg = message as RuntimeMessage & {
    provider?: string;
    instanceId?: string;
    emailUser?: string;
    domain?: string;
    skipHealthPick?: boolean;
  };

  // Healthy provider auto-pick (+ site rule) when user didn't pin a provider
  let provider = msg.provider || selected || DEFAULT_PROVIDER;
  let pickReason: string = msg.provider ? 'explicit' : 'prefer';

  if (!msg.skipHealthPick) {
    try {
      const { resolveCreateProvider, getProviderFailoverOrder, recordProviderCreate } =
        await import('@/features/intelligence/provider-health.js');
      const resolved = await resolveCreateProvider({
        providerIds: allIds,
        explicitProviderId: msg.provider || null,
        domain: msg.domain || null,
        preferProviderId: selected || DEFAULT_PROVIDER,
        forceHealthPick: !msg.provider,
      });
      if (resolved.providerId) {
        provider = resolved.providerId;
        pickReason = resolved.reason;
      }

      const order = msg.provider
        ? [provider]
        : [provider, ...(await getProviderFailoverOrder(allIds, [provider])).slice(0, 3)];
      const tried = new Set<string>();
      let lastError: unknown;
      for (const pid of order) {
        if (!pid || tried.has(pid)) continue;
        tried.add(pid);
        const t0 = Date.now();
        try {
          const inbox = await createInbox(pid, msg.instanceId, msg.emailUser);
          void recordProviderCreate(pid, true, Date.now() - t0);
          // Surface provider-level auto-failover to the user: either the health
          // pick deviated from the user's default provider, or the first pick
          // failed and a retry succeeded elsewhere. UI reads `lastProviderFailover`.
          const requestedBase = msg.provider || selected || DEFAULT_PROVIDER;
          if (pid !== requestedBase) {
            const down = pid !== provider ? provider : requestedBase;
            const reason = pid !== provider ? 'retry' : 'health';
            await browser.storage.local
              .set({
                lastProviderFailover: {
                  requested: down,
                  used: pid,
                  at: Date.now(),
                  reason,
                },
              })
              .catch(() => {
                /* ignore */
              });
          }
          sendResponse({
            success: true,
            inbox,
            providerId: pid,
            healthPick: pickReason === 'health' || pickReason === 'rule',
            pickReason,
          });
          return;
        } catch (err: unknown) {
          lastError = err;
          void recordProviderCreate(pid, false, Date.now() - t0, getErrorMessage(err));
          const e = err as { context?: { reason?: string } };
          if (
            e?.context?.reason === 'duplicate_live' ||
            e?.context?.reason === 'duplicate_inactive'
          ) {
            throw err;
          }
          // Explicit provider: no failover
          if (msg.provider) throw err;
        }
      }
      throw lastError || new Error('All providers failed');
    } catch (healthErr: unknown) {
      // Conflicts always bubble; other errors from health path also bubble
      // (failover already exhausted). Fallback only if intelligence module failed to load.
      const msgText = getErrorMessage(healthErr);
      if (
        healthErr &&
        typeof healthErr === 'object' &&
        ((healthErr as { context?: { reason?: string } }).context?.reason ||
          !msgText.includes('Cannot find module'))
      ) {
        throw healthErr;
      }
    }
  }

  const inbox = await createInbox(provider, msg.instanceId, msg.emailUser);
  sendResponse({ success: true, inbox, providerId: provider, pickReason });
}

/**
 * Fast field text classification — runs multilingual regex patterns
 * that have been offloaded from the content script bundle (~900 bytes of
 * regex patterns live here instead).
 */
function classifyFieldFast(text: string): {
  isUsername: boolean;
  isEmailish: boolean;
} {
  const t = text.toLowerCase();
  // Multilingual username signals (offloaded from findUsernameField)
  const isUsername =
    /(?:\s|^)(?:user\s*name|username|userid|user_id|user-name|handle|login\s*name|account\s*name|ユーザー名|用户名|nombre\s*de\s*usuario|nom\s*d['']utilisateur|benutzername|ชื่อผู้ใช้|اسم\s*المستخدم)(?:\s|$)/i.test(
      t
    );
  // Multilingual email signals (offloaded from looksLikeEmailField)
  const isEmailish =
    /(?:e-?mail|mail|correo|courriel|メール|邮箱|بريد|e-mail)/i.test(t) ||
    /(?:email|e-mail|correo|courriel).{0,16}(?:or|\/|ou|o|oder|または|或).{0,16}(?:phone|mobile|tel|handy|携帯|手机|هاتف)/i.test(
      t
    ) ||
    /(?:confirm|reenter|re-enter|repeat|verify).{0,30}(?:mail|email|correo)/i.test(t);
  return { isUsername, isEmailish };
}

const handlers: Record<string, HandlerFn> = {
  /**
   * Open extension UI from content script (setup / renew / identity create-edit).
   *
   * Root-cause notes for identity handoff failures:
   * 1) `action.openPopup()` often fails without a preserved user gesture after
   *    async storage writes from a content-script message.
   * 2) Storage-only handoff races: an already-open UI can consume + clear flags
   *    before a newly opened popup mounts.
   * Fix: full storage payload + live `navigateView` broadcast with create/edit
   * extras + always fall back to `app.html` query params (cold-start safe).
   */
  openExtensionUi: async (message, _sender, sendResponse) => {
    try {
      const reason = String((message as { reason?: string }).reason || 'setup');
      const hint = String((message as { hint?: string }).hint || '');
      const identityId = String((message as { identityId?: string }).identityId || '');
      const isCreate = reason === 'create-identity' || hint === 'create-identity';
      const isEdit = reason === 'edit-identity' || hint === 'edit-identity';
      const isIdentityHandoff = isCreate || isEdit;

      const viewPayload: Record<string, unknown> = {
        openExtensionReason: reason,
        openExtensionHint: hint,
        openExtensionAt: Date.now(),
        openViewAt: Date.now(),
      };
      if (isIdentityHandoff) {
        viewPayload.openView = 'autofill';
        viewPayload.autofillTab = 'profiles';
        viewPayload.openIdentityCreate = isCreate;
        viewPayload.openIdentityEditId = isEdit && identityId ? identityId : '';
      } else if (reason === 'setup' || reason === 'expired' || reason === 'no-active') {
        viewPayload.openView = 'mailbox';
      }

      // SECURITY: Issue a signed gesture token when the user is being directed
      // to the UI for address creation. This token proves the user interacted
      // with the extension UI and allows the content script to subsequently
      // call createInboxWithGesture (which is in the allowlist).
      if (reason === 'autofill-create-address' || hint === 'create-address') {
        try {
          const { generateGestureToken, storePendingGestureToken } = await import(
            '@/utils/gesture-token.js'
          );
          const gt = await generateGestureToken('autofill-create-address');
          await storePendingGestureToken(gt);
        } catch {
          /* token issuance is best-effort; UI will still open */
        }
      }

      try {
        await browser.storage.session.set(viewPayload);
      } catch {
        /* session may fail */
      }
      try {
        await browser.storage.local.set(viewPayload);
      } catch {
        /* ignore */
      }

      // Live UIs: apply create/edit directly (do not rely on storage alone)
      try {
        await browser.runtime.sendMessage({
          type: 'navigateView',
          view: (viewPayload.openView as string) || 'autofill',
          openView: viewPayload.openView,
          autofillTab: viewPayload.autofillTab,
          openIdentityCreate: !!viewPayload.openIdentityCreate,
          openIdentityEditId: String(viewPayload.openIdentityEditId || ''),
          openExtensionReason: reason,
        });
      } catch {
        /* no UI listener yet — cold open below */
      }

      const qs = new URLSearchParams();
      if (viewPayload.openView) qs.set('view', String(viewPayload.openView));
      if (viewPayload.autofillTab) qs.set('tab', String(viewPayload.autofillTab));
      if (viewPayload.openIdentityCreate) qs.set('identityCreate', '1');
      if (viewPayload.openIdentityEditId)
        qs.set('identityEdit', String(viewPayload.openIdentityEditId));
      if (reason) qs.set('reason', reason);
      const getURL = (browser.runtime as unknown as { getURL: (p: string) => string }).getURL;
      const appUrl = getURL(`/app.html?${qs.toString()}`);

      // Identity handoffs: open app tab first (reliable; no gesture needed).
      // Also try popup/sidepanel so toolbar users still get the familiar surface.
      if (isIdentityHandoff) {
        await browser.tabs.create({ url: appUrl });
        try {
          const action = (browser as unknown as { action?: { openPopup?: () => Promise<void> } })
            .action;
          if (action?.openPopup) await action.openPopup();
        } catch {
          /* optional */
        }
        sendResponse({ success: true, opened: 'tab' });
        return;
      }

      try {
        const action = (browser as unknown as { action?: { openPopup?: () => Promise<void> } })
          .action;
        if (action?.openPopup) {
          await action.openPopup();
          sendResponse({ success: true, opened: 'popup' });
          return;
        }
      } catch {
        /* openPopup may be unavailable / no gesture */
      }
      try {
        const anyBrowser = browser as typeof browser & {
          sidePanel?: { open?: (opts: { windowId?: number }) => Promise<void> };
        };
        if (anyBrowser.sidePanel?.open) {
          const win = await browser.windows.getCurrent();
          if (win.id != null) {
            await anyBrowser.sidePanel.open({ windowId: win.id });
            sendResponse({ success: true, opened: 'sidepanel' });
            return;
          }
        }
      } catch {
        /* side panel optional */
      }
      await browser.tabs.create({ url: appUrl });
      sendResponse({ success: true, opened: 'tab' });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  createInbox: async (message, _sender, sendResponse) => {
    try {
      // Demo mode is fully client-side — refuse real provider creates
      const { demoMode } = (await browser.storage.local.get(['demoMode'])) as {
        demoMode?: boolean;
      };
      if (demoMode) {
        sendResponse({
          success: false,
          error: 'Demo mode is active — use the UI demo create path',
        });
        return;
      }

      await createInboxInternal(message, sendResponse);
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  /**
   * createInboxWithGesture — security-hardened variant of createInbox.
   *
   * Content scripts (injected on every web page) are NO LONGER allowed to
   * call `createInbox` directly. Instead they must present a signed gesture
   * token that was issued by the extension UI (popup / sidepanel / app tab)
   * when the user explicitly interacted with it.
   *
   * The token is:
   *   • HMAC-SHA256 signed with a key derived from the extension runtime ID
   *   • Single-use (nonce tracked in session storage)
   *   • Time-limited (5-second expiry window)
   *
   * If no valid token is present the handler falls back to opening the
   * extension UI so the user can interact with it, then signals the content
   * script to retry.
   *
   * SECURITY: A malicious web page that programmatically triggers the content
   * script's click handler cannot forge a valid token — the signing key is
   * derived from the extension ID, not accessible to page script.
   */
  createInboxWithGesture: async (message, _sender, sendResponse) => {
    try {
      // Demo mode is fully client-side — refuse real provider creates
      const { demoMode } = (await browser.storage.local.get(['demoMode'])) as {
        demoMode?: boolean;
      };
      if (demoMode) {
        sendResponse({
          success: false,
          error: 'Demo mode is active — use the UI demo create path',
        });
        return;
      }

      const msg = message as RuntimeMessage & {
        provider?: string;
        instanceId?: string;
        emailUser?: string;
        domain?: string;
        gestureToken?: string;
        skipHealthPick?: boolean;
      };

      // 1) If caller presents a valid gesture token → proceed directly
      if (msg.gestureToken) {
        const ok = await validateAndConsumeGestureToken(
          msg.gestureToken,
          'autofill-create-address'
        );
        if (!ok) {
          sendResponse({
            success: false,
            error: 'Invalid or expired gesture token',
            needsUserInteraction: true,
          });
          return;
        }
        // Valid token — delegate to the internal createInbox logic
        await createInboxInternal(msg, sendResponse);
        return;
      }

      // 2) No token — try consuming a pending token from session storage
      //    (set when the extension UI was opened with reason autofill-create-address)
      const pendingToken = await consumePendingGestureToken('autofill-create-address');
      if (pendingToken) {
        const ok = await validateAndConsumeGestureToken(pendingToken, 'autofill-create-address');
        if (ok) {
          await createInboxInternal(msg, sendResponse);
          return;
        }
      }

      // 3) No valid token — open extension UI so user can interact
      try {
        await browser.runtime.sendMessage({
          type: 'openExtensionUi',
          reason: 'autofill-create-address',
          hint: 'create-address',
        });
        sendResponse({
          success: false,
          error: 'User interaction required — extension UI opened',
          needsUserInteraction: true,
          opened: true,
        });
      } catch (openErr) {
        sendResponse({
          success: false,
          error: getErrorMessage(openErr),
          needsUserInteraction: true,
        });
      }
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  getStorageViaBg: async (message, _sender, sendResponse) => {
    try {
      const { keys } = message as RuntimeMessage & { keys: string | string[] };
      const data = (await browser.storage.local.get(keys)) as Record<string, unknown>;
      sendResponse({ success: true, data });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  setStorageViaBg: async (message, _sender, sendResponse) => {
    try {
      const { items } = message as RuntimeMessage & { items: Record<string, unknown> };
      await browser.storage.local.set(items);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  checkEmails: async (message, _sender, sendResponse) => {
    try {
      const inboxId = requireString(message, 'inboxId');
      // Demo: return stored bag only, never hit real providers
      const {
        demoMode,
        storedEmails = {},
        inboxes = [],
      } = (await browser.storage.local.get(['demoMode', 'storedEmails', 'inboxes'])) as {
        demoMode?: boolean;
        storedEmails?: Record<string, import('@/utils/types.js').Email[]>;
        inboxes?: import('@/utils/types.js').Account[];
      };
      const demoInbox = inboxes.find((i) => i.id === inboxId);
      if (demoMode || demoInbox?.provider === 'demo') {
        const addr = demoInbox?.address || '';
        const bag = (addr && storedEmails[addr]) || [];
        sendResponse({ success: true, messages: bag });
        return;
      }

      const messages = await checkNewEmails(inboxId, message.filters);

      const liveInboxes = await getInboxes();
      const inbox = liveInboxes.find((i) => i.id === inboxId);
      if (inbox && messages.length > 0) {
        const apiMsgs = messages.filter((m) => !m.local_only);
        if (apiMsgs.length > 0) {
          await storeNewMessages(inbox.address, apiMsgs);
        }
      }

      sendResponse({ success: true, messages });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  deleteInbox: async (message, _sender, sendResponse) => {
    try {
      const result = await deleteInbox(
        requireString(message, 'inboxId'),
        message.preserveEmails ?? false
      );
      sendResponse(result);
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  restoreInbox: async (message, _sender, sendResponse) => {
    try {
      const inboxes = await getInboxes();
      const inbox = inboxes.find((i) => i.id === message.inboxId);
      if (!inbox) {
        sendResponse({ success: false, error: 'Inbox not found' });
        return;
      }
      await restoreArchivedEmailsToStored(inbox.address);
      await setInboxes(
        inboxes.map((i) =>
          i.id === message.inboxId ? { ...i, accountStatus: 'active' as const } : i
        )
      );
      sendResponse({ success: true });
    } catch (e) {
      logError('restoreInbox error:', e);
      sendResponse({ success: false, error: 'Failed to restore inbox' });
    }
  },

  getInboxes: async (_message, _sender, sendResponse) => {
    try {
      const inboxes = await getInboxes();
      sendResponse({ success: true, inboxes });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  setProvider: async (message, _sender, sendResponse) => {
    try {
      await browser.storage.local.set({ selectedProvider: message.provider as string });
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  updateInboxTag: async (message, _sender, sendResponse) => {
    try {
      await withInboxLock(async () => {
        const inboxes = await getInboxes();
        const inboxIndex = inboxes.findIndex((i) => i.id === message.inboxId);
        if (inboxIndex === -1) {
          sendResponse({ success: false, error: 'Inbox not found' });
          return;
        }
        // Prefer full multi-tag list when provided; otherwise set/clear a single primary tag.
        const tagsPayload = (message as { tags?: Array<{ name: string; color: string }> }).tags;
        const updatedInboxes = inboxes.map((i) => {
          if (i.id !== message.inboxId) return i;
          if (Array.isArray(tagsPayload)) {
            const cleaned = tagsPayload
              .filter((t) => t?.name?.trim())
              .map((t) => ({ name: t.name.trim(), color: t.color || '#6750a4' }));
            const first = cleaned[0];
            return {
              ...i,
              tags: cleaned,
              tag: first?.name,
              tagColor: first?.color,
            };
          }
          const hasTagField = 'tag' in message;
          const name = message.tag == null ? '' : String(message.tag).trim();
          if (hasTagField && !name) {
            return {
              ...i,
              tags: [],
              tag: undefined,
              tagColor: undefined,
            };
          }
          if (!name) {
            return i;
          }
          const color = (message.color as string) || i.tagColor || '#6750a4';
          // Merge into existing multi-tag list (add/update color by name)
          const prev =
            Array.isArray(i.tags) && i.tags.length > 0
              ? [...i.tags]
              : i.tag
                ? [{ name: i.tag, color: i.tagColor || '#6750a4' }]
                : [];
          const idx = prev.findIndex((t) => t.name.toLowerCase() === name.toLowerCase());
          const next =
            idx >= 0
              ? prev.map((t, j) => (j === idx ? { name, color } : t))
              : [...prev, { name, color }];
          const first = next[0];
          return {
            ...i,
            tags: next,
            tag: first?.name,
            tagColor: first?.color,
          };
        });
        await setInboxes(updatedInboxes);
        sendResponse({ success: true });
      });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  archiveInbox: async (message, _sender, sendResponse) => {
    try {
      await withInboxLock(async () => {
        const inboxes = await getInboxes();
        const inbox = inboxes.find((i) => i.id === message.inboxId);
        if (!inbox) {
          sendResponse({ success: false, error: 'Inbox not found' });
          return;
        }
        await clearStoredEmails(inbox.address);
        await setInboxes(
          inboxes.map((i) =>
            i.id === message.inboxId ? { ...i, accountStatus: 'archived' as const } : i
          )
        );
        sendResponse({ success: true });
      });
    } catch (e) {
      logError('archiveInbox error:', e);
      sendResponse({ success: false, error: 'Failed to archive inbox' });
    }
  },

  unarchiveInbox: async (message, _sender, sendResponse) => {
    try {
      await withInboxLock(async () => {
        const inboxes = await getInboxes();
        const inbox = inboxes.find((i) => i.id === message.inboxId);
        if (!inbox) {
          sendResponse({ success: false, error: 'Inbox not found' });
          return;
        }
        // Bring Offline Saved history back into the live bag before marking active
        await restoreArchivedEmailsToStored(inbox.address);
        await setInboxes(
          inboxes.map((i) =>
            i.id === message.inboxId ? { ...i, accountStatus: 'active' as const } : i
          )
        );
        sendResponse({ success: true });
      });
    } catch (e) {
      logError('unarchiveInbox error:', e);
      sendResponse({ success: false, error: 'Failed to unarchive inbox' });
    }
  },

  getProvider: async (_message, _sender, sendResponse) => {
    try {
      const selectedProvider = await getSelectedProvider();
      sendResponse({ success: true, provider: selectedProvider });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  clearSessionCredentials: async (_message, _sender, sendResponse) => {
    try {
      await browser.storage.session.remove('sessionCredentials');
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  updateSessionCredentials: async (message, sender, sendResponse) => {
    try {
      const result = await handleUpdateSessionCredentials(
        {
          type: 'updateSessionCredentials',
          credentials: message.credentials ?? {},
        },
        sender
      );
      sendResponse(result);
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  /** Persist a filled signup credential from the content script */
  saveLoginCredential: async (message, sender, sendResponse) => {
    try {
      const raw = message.credential as Record<string, unknown> | undefined;
      if (!raw || typeof raw !== 'object') {
        sendResponse({ success: false, error: 'Missing credential' });
        return;
      }
      const credential = normalizeSavedLoginCredential(raw);
      if (!credential) {
        sendResponse({ success: false, error: 'Invalid credential' });
        return;
      }
      if (!isExtensionSender(sender) && !isDomainAllowedForSender(credential.domain, sender)) {
        sendResponse({ success: false, error: 'Domain mismatch' });
        return;
      }
      await withLock('login_info_lock', async () => {
        const result = (await browser.storage.local.get(['loginInfo'])) as {
          loginInfo?: CredentialsHistoryItem[];
        };
        let loginInfo = Array.isArray(result.loginInfo) ? [...result.loginInfo] : [];
        const credEmail = (credential.email || credential.username || '').toLowerCase();
        const credDomain = credential.domain.toLowerCase();
        if (credEmail && credDomain) {
          loginInfo = loginInfo.filter((item) => {
            const itemEmail = (item.email || item.username || '').toString().toLowerCase();
            const itemDomain = (item.domain || '').toString().toLowerCase();
            return !(itemEmail === credEmail && itemDomain === credDomain);
          });
        }
        loginInfo.unshift(credential);
        if (loginInfo.length > 50) loginInfo.length = 50;
        await browser.storage.local.set({ loginInfo });
        sendResponse({ success: true, count: loginInfo.length });
      });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  getAnalytics: async (_message, _sender, sendResponse) => {
    try {
      const analytics = await getAnalytics();
      sendResponse({ success: true, analytics });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  resetAnalytics: async (_message, _sender, sendResponse) => {
    try {
      await resetAnalyticsData();
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  recordExtensionOpen: async (_message, _sender, sendResponse) => {
    try {
      await recordExtensionOpen();
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  recordPageVisit: async (message, _sender, sendResponse) => {
    try {
      const viewId = String((message as { viewId?: string }).viewId || '');
      await recordPageVisit(viewId);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  recordEmailRead: async (_message, _sender, sendResponse) => {
    try {
      await recordEmailRead();
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  recordUIRenderTime: async (message, _sender, sendResponse) => {
    try {
      await recordUIRenderTime(requireNumber(message, 'renderTime'));
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  getArchivedEmails: async (message, _sender, sendResponse) => {
    try {
      const archivedEmails = await getArchivedEmails(message.inboxAddress);
      sendResponse({ success: true, archivedEmails });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  getStorageUsage: async (_message, _sender, sendResponse) => {
    try {
      const usage = await getStorageUsage();
      sendResponse({ success: true, usage });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  getEmailsToBeDeleted: async (message, _sender, sendResponse) => {
    try {
      const count = await getEmailsToBeDeleted(message.retentionDays || 30);
      sendResponse({ success: true, count });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  cleanupOldStoredEmails: async (message, _sender, sendResponse) => {
    try {
      await cleanupOldStoredEmails(
        message.activeRetentionDays || 30,
        message.archivedRetentionDays || 90
      );
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  hardReset: async (_message, _sender, sendResponse) => {
    try {
      try {
        await browser.alarms.clearAll();
      } catch (alarmErr) {
        logWarn('Non-fatal error clearing alarms during hard reset:', alarmErr);
      }
      await browser.storage.session.clear();
      try {
        if (self.caches) {
          const cacheNames = await self.caches.keys();
          for (const cacheName of cacheNames) {
            await self.caches.delete(cacheName);
          }
        }
      } catch {
        /* non-critical */
      }
      await browser.storage.local.set({ lastHardReset: Date.now(), forceNewSessions: true });
      setTimeout(async () => {
        try {
          await browser.storage.local.remove('forceNewSessions');
        } catch {
          // Ignore clear errors (e.g. storage closed)
        }
      }, FORCE_NEW_SESSIONS_AUTO_CLEAR_MS);
      setupPeriodicEmailCheck(checkNewEmails);
      setupInboxExpiryCheck();
      // hardReset cleared all alarms — restore the near-expiry badge countdown.
      await ensureBadgeCountdownAlarm();
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  getProviderInstances: async (message, _sender, sendResponse) => {
    try {
      const provider = message.provider || DEFAULT_PROVIDER;
      const instances = await getProviderInstancesWithCustom(provider);
      sendResponse({ success: true, instances });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  translate: async (message, _sender, sendResponse) => {
    try {
      const key = requireString(message, 'key');
      const vars = message.vars as Record<string, string | number> | undefined;
      const result = await t(key, vars);
      sendResponse({ success: true, translated: result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  renewInbox: async (message, _sender, sendResponse) => {
    try {
      const inboxes = await getInboxes();
      const inbox = inboxes.find((i) => i.id === message.inboxId);
      if (!inbox) {
        sendResponse({ success: false, error: 'Inbox not found' });
        return;
      }
      const providerConfig = loadProviderConfig(inbox.provider);
      if (!providerConfig.expiry?.renewable) {
        sendResponse({ success: false, error: 'This provider does not support inbox renewal' });
        return;
      }
      const config = loadProviderConfig(inbox.provider);
      const service = new EmailService(config, browser);
      const token = inbox.token || inbox.sidToken;
      if (!token) {
        sendResponse({ success: false, error: 'No token available for renewal' });
        return;
      }
      const currentUser = inbox.emailUser || inbox.address.split('@')[0];
      // Measure actual renewal latency for the adaptive auto-renew window.
      const renewalStart = Date.now();
      let renewalResponse: Record<string, unknown> = {};
      if (providerConfig.expiry?.renewalMethod) {
        renewalResponse = await service.executeOperation(providerConfig.expiry.renewalMethod, {
          auth: { token },
          variables: { emailUser: currentUser },
        });
      }
      const measuredLatencyMs = Date.now() - renewalStart;
      await withInboxLock(async () => {
        const inboxes = await getInboxes();
        const inboxIndex = inboxes.findIndex((i: Account) => i.id === inbox.id);
        if (inboxIndex !== -1) {
          // Ensure offline history is in the live bag after renew (e.g. post-expiry archive)
          await restoreArchivedEmailsToStored(inbox.address);

          // NOTE: We do NOT eagerly mark stored messages as `local_only` here —
          // for providers that keep messages on renewal (e.g. Guerrilla Mail's
          // set_email_user with the same username), those messages are still live.
          // The `checkNewEmails` merge logic marks a message `local_only` only when
          // its ID is absent from the latest API response, which is correct for both
          // Model 2 (independent retention) and Model 3 (post-expiry renewal reset).

          const expiryConfig = loadProviderConfig(inbox.provider);
          const newSidToken =
            typeof renewalResponse.token === 'string'
              ? renewalResponse.token
              : inboxes[inboxIndex].sidToken;
          // BUG FIX: force renewal base to now so the new window is always future.
          const timing = deriveInboxTiming(renewalResponse, expiryConfig, Date.now(), {
            renewalBaseNow: true,
          });
          const prevCount = inboxes[inboxIndex].renewalCount ?? 0;
          inboxes[inboxIndex] = {
            ...inboxes[inboxIndex],
            token: newSidToken,
            sidToken: newSidToken,
            emailUser: currentUser,
            expiresAt: timing.expiresAt,
            expiryNotified: false,
            renewalCount: prevCount + 1,
            renewalLatencyMs: measuredLatencyMs,
            lastRenewalAt: Date.now(),
            renewalFailCount: 0,
            accountStatus: 'active',
            status: 'active',
          };
          await setInboxes(inboxes);
          sendResponse({ success: true, renewalCount: prevCount + 1 });
        } else {
          sendResponse({ success: false, error: 'Inbox disappeared during renewal' });
        }
      });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  addCustomInstance: async (message, _sender, sendResponse) => {
    try {
      const instance = message.instance as Omit<ProviderInstance, 'id' | 'isCustom'>;
      validateCustomInstanceName(instance.name);
      await validateCustomInstanceUrl(instance.apiUrl);
      const provider = await getSelectedProvider();
      await addCustomProviderInstance(provider, instance);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  removeCustomInstance: async (message, _sender, sendResponse) => {
    try {
      const provider = await getSelectedProvider();
      await removeCustomProviderInstance(provider, message.instanceId as string);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  getSelectedInstance: async (_message, _sender, sendResponse) => {
    try {
      const provider = await getSelectedProvider();
      const instance = await getSelectedProviderInstance(provider);
      sendResponse({ success: true, instance });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  setSelectedInstance: async (message, _sender, sendResponse) => {
    try {
      const provider = await getSelectedProvider();
      // Legacy single-pin API — backed by the enabled/disabled pool:
      // 'random' clears the blacklist (all enabled); an id pins only that one.
      await setProviderInstance(provider, message.instanceId as string);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  setDisabledInstances: async (message, _sender, sendResponse) => {
    try {
      const provider = message.provider as string;
      if (!provider) throw new Error('Missing required message field: provider');
      const disabled = Array.isArray(message.disabledInstances)
        ? (message.disabledInstances as string[])
        : [];
      await setDisabledInstances(provider, disabled);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  initializeDefaultProvider: async (_message, _sender, sendResponse) => {
    try {
      await initializeDefaultProvider();
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  providerApiCall: async (message, _sender, sendResponse) => {
    try {
      const config = loadProviderConfig(requireString(message, 'provider'));
      const service = new EmailService(config, browser);
      const data = await service.executeOperation(requireString(message, 'func'), {
        auth: message.sidToken ? { token: message.sidToken } : undefined,
        variables: message.params || {},
      });
      sendResponse({ success: true, data });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  fetchFavicon: async (message, _sender, sendResponse) => {
    try {
      const { url } = message as { url: string };
      logInfo('fetchFavicon requested', { url });

      const parsedUrl = new URL(url);
      const safeUrl = isSafeFetchUrl(parsedUrl.toString());
      if (!safeUrl.ok) throw new Error(safeUrl.error || 'Favicon URL is not allowed');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 seconds timeout

      const response = await fetch(parsedUrl.toString(), { signal: controller.signal });
      clearTimeout(timeoutId);

      logInfo('fetchFavicon response status', { status: response.status });
      if (!response.ok) {
        sendResponse({ success: false, error: `HTTP ${response.status}` });
        return;
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > 5 * 1024 * 1024) {
        throw new Error('Favicon too large');
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 5 * 1024 * 1024) {
        throw new Error('Favicon too large');
      }
      const uint8 = new Uint8Array(buffer);
      logInfo('fetchFavicon buffer size', { size: uint8.length });
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
      let binary = '';
      const CHUNK_SIZE = 0x8000;
      for (let i = 0; i < uint8.length; i += CHUNK_SIZE) {
        binary += String.fromCharCode.apply(null, Array.from(uint8.subarray(i, i + CHUNK_SIZE)));
      }
      const base64 = btoa(binary);
      const contentType = response.headers.get('content-type') || 'image/x-icon';
      logInfo('fetchFavicon success, sending response');
      sendResponse({ success: true, base64, contentType, hash });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logError('fetchFavicon error', msg);
      sendResponse({ success: false, error: msg });
    }
  },

  updateRefreshInterval: async (message, _sender, sendResponse) => {
    try {
      const ms = message.intervalMs as number;
      if (typeof ms !== 'number' || ms < 10000 || ms > 3600000) {
        throw new Error('Refresh interval must be between 10s and 1hr');
      }
      await updateRefreshAlarm(ms);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  findReusableIdentity: async (message, sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      if (!isExtensionSender(sender) && !isDomainAllowedForSender(domain, sender)) {
        sendResponse({ found: false, error: 'Domain mismatch' });
        return;
      }
      const inboxId =
        typeof (message as { inboxId?: string }).inboxId === 'string'
          ? (message as { inboxId: string }).inboxId
          : '';
      const replay = await findSiteReplayForDomain(domain, inboxId || null);
      sendResponse({
        found: !!replay.credential,
        credential: replay.credential,
        lastEmail: replay.lastEmail,
        lastInboxId: replay.lastInboxId,
        lastIdentityId: replay.lastIdentityId,
        fromSiteProfile: replay.fromSiteProfile,
      });
    } catch (error: unknown) {
      sendResponse({ found: false, error: getErrorMessage(error) });
    }
  },

  findSiteReplay: async (message, sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      if (!isExtensionSender(sender) && !isDomainAllowedForSender(domain, sender)) {
        sendResponse({ success: false, found: false, error: 'Domain mismatch' });
        return;
      }
      const inboxId =
        typeof (message as { inboxId?: string }).inboxId === 'string'
          ? (message as { inboxId: string }).inboxId
          : null;
      const replay = await findSiteReplayForDomain(domain, inboxId);
      sendResponse({ success: true, ...replay, found: !!replay.credential });
    } catch (error: unknown) {
      sendResponse({ success: false, found: false, error: getErrorMessage(error) });
    }
  },

  clearAllOtps: async (_message, _sender, sendResponse) => {
    try {
      await clearAllOtps();
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  /** UI/content: ensure active tab has content script + form scan (post-install / after create). */
  ensureActiveTabAutofill: async (_message, _sender, sendResponse) => {
    try {
      const { ensureActiveTabAutofill } = await import('../tab-autofill.js');
      const status = await ensureActiveTabAutofill({ notifyIfRefreshNeeded: true });
      sendResponse({ success: true, status });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  formPresence: async (message, sender, sendResponse) => {
    try {
      const detected = !!(message as { formDetected?: boolean }).formDetected;
      const tabId = sender.tab?.id;
      if (typeof tabId === 'number') {
        const { setFormBadge } = await import('../tab-autofill.js');
        await setFormBadge(tabId, detected);
      }
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },

  autofillStatusNotice: async (message, _sender, sendResponse) => {
    try {
      const status =
        typeof (message as { status?: string }).status === 'string'
          ? (message as { status: string }).status
          : '';
      const isError = !!(message as { isError?: boolean }).isError;
      if (isError) {
        logWarn('Autofill status notice error:', { status });
      } else {
        logInfo('Autofill status notice:', { status });
      }
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  generateIdentityField: async (message, _sender, sendResponse) => {
    try {
      const fieldType = requireString(message, 'fieldType');
      const locale = message.locale as string | undefined;
      let value = '';
      switch (fieldType) {
        case 'phoneNumber':
          value = generatePhoneNumber(locale);
          break;
        case 'username':
          value = generateUsername();
          break;
        case 'websiteUrl':
          value = generateWebsiteUrl();
          break;
        case 'randomName':
          value = generateRandomName();
          break;
        case 'smartPassword':
          value = generatePassword();
          break;
        default:
          throw new Error(`Unknown fieldType: ${fieldType}`);
      }
      sendResponse({ success: true, value });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  encryptData: async (message, _sender, sendResponse) => {
    try {
      const text = requireString(message, 'text');
      const encrypted = await encrypt(text);
      sendResponse({ success: true, encrypted });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  decryptData: async (message, _sender, sendResponse) => {
    try {
      const text = requireString(message, 'text');
      const decrypted = await decrypt(text);
      sendResponse({ success: true, decrypted });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  copyToClipboard: async (message, _sender, sendResponse) => {
    try {
      const text = requireString(message, 'text');
      const purgeAfterMs = message.purgeAfterMs ? Number(message.purgeAfterMs) : undefined;
      await copyToClipboardAndSchedulePurge(text, purgeAfterMs);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  getProviderDisplayName: async (message, _sender, sendResponse) => {
    try {
      const provider = requireString(message, 'provider');
      const config = loadProviderConfig(provider);
      sendResponse({ success: true, displayName: config?.displayName ?? provider });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  generateLocaleExtras: async (message, _sender, sendResponse) => {
    try {
      const locale = (message as { locale?: string }).locale || undefined;
      let country = localeToCountryHint(locale || 'en');
      const extras = localeAwareAddressExtras(locale);
      country = extras.country;
      const dob = randomAdultDob(21, 55);
      sendResponse({ success: true, country, city: extras.city, pin: extras.pin, dob });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  generateLocaleAwarePhone: async (message, _sender, sendResponse) => {
    try {
      const locale = (message as { locale?: string }).locale || undefined;
      const phone = localeAwarePhone(locale);
      sendResponse({ success: true, phone });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  getIconSvg: async (message, _sender, sendResponse) => {
    try {
      const name = requireString(message, 'name') as string;
      const opts = message as { size?: number; color?: string };
      const svg = getIconSvg(name as IconSvgName, { size: opts.size, color: opts.color });
      sendResponse({ success: true, svg });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  recordAutofillSuccess: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      await recordAutofillSuccess(domain);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  recordAutofillFailure: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      const result = await recordAutofillFailure(domain);
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  loadSmartAutofillSettings: async (_message, _sender, sendResponse) => {
    try {
      const settings = await loadSmartAutofillSettings();
      sendResponse({ success: true, settings });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  routeIdentityForDomain: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      const msg = message as { identities?: unknown; selectedIdentityId?: string | null };
      const result = await routeIdentityForDomain(
        domain,
        msg.identities as Parameters<typeof routeIdentityForDomain>[1],
        msg.selectedIdentityId
      );
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  recordAutofillOutcome: async (message, _sender, sendResponse) => {
    try {
      const opts = (message as { opts?: Record<string, unknown> }).opts || {};
      await recordAutofillOutcome(opts as Parameters<typeof recordAutofillOutcome>[0]);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  shouldPreferReplay: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      const result = await shouldPreferReplay(domain);
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  pickFreshestIdentity: async (message, _sender, sendResponse) => {
    try {
      const opts = message as { domain?: string; identities?: unknown; liveEmails?: string[] };
      const result = await pickFreshestIdentity(
        opts.domain || '',
        (opts.identities || []) as Parameters<typeof pickFreshestIdentity>[1],
        opts.liveEmails || []
      );
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  getActiveInboxMeta: async (_message, _sender, sendResponse) => {
    try {
      const result = await getActiveInboxMeta();
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  markLatestCredentialVerified: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      const result = await markLatestCredentialVerified(domain);
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  getWizardSession: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      const result = await getWizardSession(domain);
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  upsertWizardSession: async (message, _sender, sendResponse) => {
    try {
      const partial = (message as { partial?: unknown }).partial;
      const result = await upsertWizardSession(
        partial as unknown as Partial<WizardSession> & { domain: string }
      );
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  advanceWizardStep: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      const step = requireString(message, 'step');
      const extra = (message as { extra?: unknown }).extra;
      const result = await advanceWizardStep(
        domain,
        step as WizardStep,
        extra as Partial<WizardSession>
      );
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  clearWizardSession: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      await clearWizardSession(domain);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  testConflictText: async (message, _sender, sendResponse) => {
    try {
      const text = requireString(message, 'text');
      let result = null;
      if (CONFLICT_RE.test(text)) result = 'email';
      else if (USERNAME_CONFLICT_RE.test(text)) result = 'username';
      else if (OTP_FAIL_RE.test(text)) result = 'otp';
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  resolveDomainFieldOverrides: async (message, _sender, sendResponse) => {
    try {
      const identity = (message as { identity?: unknown }).identity;
      const domain = requireString(message, 'domain');
      const result = resolveDomainFieldOverrides(
        identity as Parameters<typeof resolveDomainFieldOverrides>[0],
        domain
      );
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  getFieldMap: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      const result = await getFieldMap(domain);
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  recordFieldMapHit: async (message, _sender, sendResponse) => {
    try {
      const domain = requireString(message, 'domain');
      const kind = requireString(message, 'kind');
      const selector = requireString(message, 'selector');
      await recordFieldMapHitBySelector(domain, kind, selector);
      sendResponse({ success: true });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  matchKindFromText: async (message, _sender, sendResponse) => {
    try {
      const text = requireString(message, 'text');
      const result = await matchKindFromText(text);
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
  classifyFieldFast: async (message, _sender, sendResponse) => {
    try {
      const text = requireString(message, 'text');
      const result = classifyFieldFast(text);
      sendResponse({ success: true, result });
    } catch (error: unknown) {
      sendResponse({ success: false, error: getErrorMessage(error) });
    }
  },
};
export const HANDLER_KEYS = Object.keys(handlers);

/**
 * Handlers callable from content scripts (injected on web pages).
 * Extension pages may call any handler. When adding a handler, decide explicitly.
 */
export const CONTENT_SCRIPT_ALLOWED_HANDLERS = new Set<string>([
  'createInboxWithGesture',
  'autofillStatusNotice',
  'openExtensionUi',
  'updateSessionCredentials',
  'clearSessionCredentials',
  'getInboxes',
  'getProvider',
  'recordPageVisit',
  'recordEmailRead',
  'recordExtensionOpen',
  'translate',
  'saveLoginCredential',
  'findSiteReplay',
  'findReusableIdentity',
  'getProviderDisplayName',
  'generateLocaleExtras',
  'generateLocaleAwarePhone',
  'getIconSvg',
  'recordAutofillSuccess',
  'recordAutofillFailure',
  'loadSmartAutofillSettings',
  'routeIdentityForDomain',
  'recordAutofillOutcome',
  'shouldPreferReplay',
  'pickFreshestIdentity',
  'getActiveInboxMeta',
  'markLatestCredentialVerified',
  'getWizardSession',
  'upsertWizardSession',
  'advanceWizardStep',
  'clearWizardSession',
  'testConflictText',
  'resolveDomainFieldOverrides',
  'getFieldMap',
  'recordFieldMapHit',
  'matchKindFromText',
  'classifyFieldFast',
  'getStorageViaBg',
  'setStorageViaBg',
]);

// Aliases - multiple message keys can map to the same handler
export const aliases: Record<string, string> = {
  removeCustomProviderInstance: 'removeCustomInstance',
  addCustomProviderInstance: 'addCustomInstance',
  getSelectedProviderInstance: 'getSelectedInstance',
  setSelectedProviderInstance: 'setSelectedInstance',
  setInstance: 'setSelectedInstance',
  setDisabledProviderInstances: 'setDisabledInstances',
};

export function resolveHandlerKey(message: RuntimeMessage): string | undefined {
  if (message.type && handlers[message.type]) return message.type;
  if (message.action && aliases[message.action] && handlers[aliases[message.action]])
    return aliases[message.action];
  if (message.action && handlers[message.action]) return message.action;
  return undefined;
}

export function registerMessageHandler(): void {
  browser.runtime.onMessage.addListener(
    (message: unknown, sender: RuntimeMessageSender, sendResponse: (response: unknown) => void) => {
      if (sender.id !== browser.runtime.id) {
        logWarn('Rejected message from unauthorized sender:', { senderId: sender.id });
        return false;
      }

      if (typeof message !== 'object' || message === null) return false;
      const runtimeMessage = message as RuntimeMessage;
      // Redact sensitive credential fields before logging
      const safeMsg = { ...runtimeMessage } as Record<string, unknown>;
      if ('credential' in safeMsg) safeMsg.credential = '[REDACTED]';
      if ('sessionCredentials' in safeMsg) safeMsg.sessionCredentials = '[REDACTED]';
      logInfo('Received message:', { message: safeMsg });
      browser.storage.session.set({ _last_vault_activity: Date.now() }).catch(() => {});

      const handlerKey = resolveHandlerKey(runtimeMessage);
      if (handlerKey) {
        // SECURITY: Allowlist model — ONLY the handlers listed below are
        // callable from content scripts (injected on web pages). ALL other
        // handlers require the message to originate from an extension page
        // (popup, sidepanel, app tab — i.e. a chrome-extension:// URL).
        //
        // RATIONALE: The old blocklist (hardReset + updateRefreshInterval) left
        // deleteInbox, createInbox, saveLoginCredential, resetAnalytics, etc.
        // callable from content scripts, which run on every web page.
        //
        // When adding a new handler, explicitly decide whether it belongs in
        // this allowlist. If in doubt, do NOT add it — extension-page-only is
        // the safe default.
        const isExtensionContext = isExtensionSender(sender);

        if (!isExtensionContext && !CONTENT_SCRIPT_ALLOWED_HANDLERS.has(handlerKey)) {
          logWarn('Blocked restricted message call from content script:', {
            handlerKey,
            senderUrl: sender.url || '',
          });
          sendResponse({ success: false, error: 'Unauthorized message caller' });
          return true;
        }
        handlers[handlerKey](runtimeMessage, sender, sendResponse);
        return true;
      }

      logWarn('Unknown message type', { type: runtimeMessage.type, action: runtimeMessage.action });
      sendResponse({ success: false, error: 'Unknown message type' });
      return false;
    }
  );

  browser.commands.onCommand.addListener(async (command: string) => {
    if (command === 'autofill-form') {
      try {
        const { autofillActiveTab } = await import('../tab-autofill.js');
        await autofillActiveTab();
      } catch (error: unknown) {
        logError(
          'Error executing autofill command:',
          undefined,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  });
}
