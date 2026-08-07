/**
 * Inbox expiry management
 * Handles inbox expiry checking, auto-renewal, and expiry notifications
 */

import { browser } from 'wxt/browser';
import { EmailService, loadProviderConfig } from '@/utils/email-service.js';
import { InboxCreationError } from '@/utils/errors.js';
import { tSync } from '@/utils/i18n-utils.js';
import { logError } from '@/utils/logger.js';
import { withInboxLock } from '@/utils/mutex.js';
import { computePreExpiryWindow, deriveInboxTiming } from '@/utils/provider-expiry.js';
import { getInboxes, setInboxes } from '@/utils/storage-keys.js';
import type { Account, NotificationSettings } from '@/utils/types.js';
import { clearStoredEmails } from './email-storage.js';

type NotificationType = 'expired' | 'renewed' | 'expiring-soon';

let expiryAlarmListenerRegistered = false;
/** Reentrancy guard: checkInboxExpiry is invoked from the immediate SW-start
 * pass, the checkInboxExpiry alarm, AND the checkEmails piggyback — overlapping
 * runs would double-renew and double-notify. Skip while one is in flight. */
let expiryCheckRunning = false;

function createInboxNotification(
  type: NotificationType,
  address: string,
  soundEnabled: boolean
): void {
  const messages: Record<NotificationType, { title: string; message: string }> = {
    expired: {
      title: tSync('notifications.inboxExpiredTitle'),
      message: tSync('notifications.inboxExpiredMessage', { address }),
    },
    renewed: {
      title: tSync('notifications.inboxRenewedTitle'),
      message: tSync('notifications.inboxRenewedMessage', { address }),
    },
    'expiring-soon': {
      title: tSync('notifications.inboxExpiringSoonTitle'),
      message: tSync('notifications.inboxExpiringSoonMessage', { address }),
    },
  };
  const { title, message } = messages[type];
  browser.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
    priority: 1,
    // Respect the soundEnabled toggle: mute the OS notification chime.
    silent: !soundEnabled,
  });
}

export async function checkInboxExpiry(): Promise<void> {
  if (expiryCheckRunning) return;
  expiryCheckRunning = true;
  try {
    const {
      inboxes = [],
      notificationSettings = {
        enabled: true,
        soundEnabled: true,
        expiryWarningThreshold: 60 * 60 * 1000,
      },
    } = (await browser.storage.local.get(['inboxes', 'notificationSettings'])) as {
      inboxes?: Account[];
      notificationSettings?: NotificationSettings;
    };

    if (inboxes.length === 0) return;

    const now = Date.now();
    const updatedInboxes = [...inboxes];
    const warningThreshold = notificationSettings.expiryWarningThreshold || 60 * 60 * 1000; // Default to 1 hour
    const modifiedInboxes = new Map<string, Partial<Account>>();

    for (let i = 0; i < updatedInboxes.length; i++) {
      const inbox = updatedInboxes[i];
      const notifyExpiredOnce = () => {
        if (notificationSettings?.enabled && !inbox.expiryNotified) {
          createInboxNotification(
            'expired',
            inbox.address,
            notificationSettings.soundEnabled !== false
          );
        }
        modifiedInboxes.set(inbox.id, { ...modifiedInboxes.get(inbox.id), expiryNotified: true });
        updatedInboxes[i] = { ...updatedInboxes[i], expiryNotified: true };
      };

      const isExpired = !!(inbox.expiresAt && inbox.expiresAt <= now);
      // Adaptive pre-expiry window: uses measured renewal latency (if available)
      // so auto-renew fires early enough to complete before the mailbox expires.
      const preExpiryWindow = computePreExpiryWindow(
        loadProviderConfig(inbox.provider),
        (inbox as Account & { renewalLatencyMs?: number }).renewalLatencyMs
      );
      const isNearingExpiry = !!(
        inbox.expiresAt &&
        inbox.autoExtend &&
        inbox.expiresAt - now <= preExpiryWindow
      );

      if (isExpired || isNearingExpiry) {
        if (inbox.autoExtend) {
          const providerConfig = loadProviderConfig(inbox.provider);
          if (!providerConfig.expiry?.renewable) {
            // Provider doesn't support renewal, keep as expired (don't auto-archive)
            if (isExpired) notifyExpiredOnce();
            continue;
          }
          try {
            // Auto-renew inbox using EmailService
            const config = loadProviderConfig(inbox.provider);
            const service = new EmailService(config, browser);

            if (!inbox.token && !inbox.sidToken) {
              throw new InboxCreationError(inbox.provider, {
                inboxId: inbox.id,
                reason: 'missing-token',
              });
            }

            const renewalConfig = loadProviderConfig(inbox.provider);
            const currentUser = inbox.emailUser || inbox.address.split('@')[0];

            // Measure actual renewal latency for the adaptive auto-renew window.
            const renewalStart = Date.now();
            let renewalResponse: Record<string, unknown> = {};

            if (renewalConfig.expiry?.renewalMethod) {
              renewalResponse = await service.executeOperation(renewalConfig.expiry.renewalMethod, {
                auth: { token: (inbox.token || inbox.sidToken) as string },
                variables: { emailUser: currentUser },
              });
            }
            const measuredLatencyMs = Date.now() - renewalStart;

            const newSidToken =
              typeof renewalResponse.token === 'string'
                ? renewalResponse.token
                : inbox.token || inbox.sidToken;
            // BUG FIX: force renewal base to now so the new window is always future.
            const timing = deriveInboxTiming(renewalResponse, providerConfig, Date.now(), {
              renewalBaseNow: true,
            });

            const prevCount = updatedInboxes[i].renewalCount ?? 0;
            const renewalUpdates = {
              token: newSidToken,
              sidToken: newSidToken,
              emailUser: currentUser,
              expiresAt: timing.expiresAt,
              expiryNotified: false,
              renewalCount: prevCount + 1,
              renewalLatencyMs: measuredLatencyMs,
              lastRenewalAt: Date.now(),
            };

            modifiedInboxes.set(inbox.id, {
              ...modifiedInboxes.get(inbox.id),
              ...renewalUpdates,
            });

            updatedInboxes[i] = {
              ...updatedInboxes[i],
              ...renewalUpdates,
            };

            if (notificationSettings?.enabled) {
              createInboxNotification(
                'renewed',
                inbox.address,
                notificationSettings.soundEnabled !== false
              );
            }
          } catch (renewError: unknown) {
            logError('Failed to auto-renew inbox', {
              inboxAddress: inbox.address,
              error: renewError,
            });
            // BUG FIX (zombie expiry): On repeated renewal failure, apply the user's
            // expiryAction (archive/delete) so the inbox does not stay in an ever-
            // retrying expired state. Only retry a few times before giving up.
            const failCount =
              (inbox as Account & { renewalFailCount?: number }).renewalFailCount ?? 0;
            const nextFailCount = failCount + 1;
            modifiedInboxes.set(inbox.id, {
              ...modifiedInboxes.get(inbox.id),
              renewalFailCount: nextFailCount,
            });
            updatedInboxes[i] = {
              ...updatedInboxes[i],
              renewalFailCount: nextFailCount,
            };
            if (nextFailCount >= 3) {
              // Give up after 3 consecutive failures — apply expiryAction.
              notifyExpiredOnce();
              try {
                const { expiryAction = 'archive' } = (await browser.storage.local.get([
                  'expiryAction',
                ])) as { expiryAction?: 'archive' | 'delete' };
                const actionStatus = expiryAction === 'delete' ? 'deleted' : 'archived';
                modifiedInboxes.set(inbox.id, {
                  ...modifiedInboxes.get(inbox.id),
                  accountStatus: actionStatus,
                  status: actionStatus,
                  expiryNotified: true,
                });
                updatedInboxes[i] = {
                  ...updatedInboxes[i],
                  accountStatus: actionStatus,
                  status: actionStatus,
                  expiryNotified: true,
                };
                await clearStoredEmails(inbox.address).catch((err) =>
                  logError('Failed to clear stored emails after renewal failure', err)
                );
              } catch {
                /* non-critical */
              }
            } else {
              notifyExpiredOnce();
            }
            continue;
          }
        } else {
          // Not auto-renewing: apply user preference (archive by default, or delete permanently)
          notifyExpiredOnce();
          try {
            const { expiryAction = 'archive' } = (await browser.storage.local.get([
              'expiryAction',
            ])) as { expiryAction?: 'archive' | 'delete' };
            if (expiryAction === 'delete') {
              modifiedInboxes.set(inbox.id, {
                ...modifiedInboxes.get(inbox.id),
                accountStatus: 'deleted',
                status: 'deleted',
                expiryNotified: true,
              });
              updatedInboxes[i] = {
                ...updatedInboxes[i],
                accountStatus: 'deleted',
                status: 'deleted',
                expiryNotified: true,
              };
            } else {
              // Default: archive after expiry
              modifiedInboxes.set(inbox.id, {
                ...modifiedInboxes.get(inbox.id),
                accountStatus: 'archived',
                status: 'archived',
                expiryNotified: true,
              });
              updatedInboxes[i] = {
                ...updatedInboxes[i],
                accountStatus: 'archived',
                status: 'archived',
                expiryNotified: true,
              };
            }
            await clearStoredEmails(inbox.address).catch((err) =>
              logError('Failed to clear stored emails', err)
            );
          } catch (err) {
            // Storage read failed — fall back to archive to prevent zombie expired state
            logError('Failed to read expiryAction from storage, defaulting to archive', err);
            modifiedInboxes.set(inbox.id, {
              ...modifiedInboxes.get(inbox.id),
              accountStatus: 'archived',
              status: 'archived',
              expiryNotified: true,
            });
            updatedInboxes[i] = {
              ...updatedInboxes[i],
              accountStatus: 'archived',
              status: 'archived',
              expiryNotified: true,
            };
            await clearStoredEmails(inbox.address).catch((e) =>
              logError('Failed to clear stored emails', e)
            );
          }
          continue;
        }
      }

      const currentInboxState = updatedInboxes[i];
      const timeLeft = currentInboxState.expiresAt ? currentInboxState.expiresAt - now : null;
      if (timeLeft !== null && timeLeft <= warningThreshold && !currentInboxState.expiryNotified) {
        if (notificationSettings?.enabled) {
          createInboxNotification(
            'expiring-soon',
            currentInboxState.address,
            notificationSettings.soundEnabled !== false
          );
        }
        modifiedInboxes.set(currentInboxState.id, {
          ...modifiedInboxes.get(currentInboxState.id),
          expiryNotified: true,
        });
        updatedInboxes[i] = { ...currentInboxState, expiryNotified: true };
      }
    }

    if (modifiedInboxes.size > 0) {
      await withInboxLock(async () => {
        const currentInboxes = await getInboxes();
        let changed = false;
        for (const [id, updates] of modifiedInboxes) {
          const idx = currentInboxes.findIndex((inb) => inb.id === id);
          if (idx !== -1) {
            currentInboxes[idx] = {
              ...currentInboxes[idx],
              ...updates,
            };
            changed = true;
          }
        }
        if (changed) {
          const MAX_ARCHIVED_INBOXES = 50;
          const archived = currentInboxes.filter((inb) => inb.accountStatus === 'archived');
          if (archived.length > MAX_ARCHIVED_INBOXES) {
            let toRemove = archived.length - MAX_ARCHIVED_INBOXES;
            for (let j = 0; j < currentInboxes.length && toRemove > 0; j++) {
              if (currentInboxes[j].accountStatus === 'archived') {
                currentInboxes.splice(j, 1);
                j--;
                toRemove--;
              }
            }
          }
          await setInboxes(currentInboxes);
        }
      });
    }
  } catch (error: unknown) {
    logError(
      'Error in inbox expiry check:',
      undefined,
      error instanceof Error ? error : new Error(String(error))
    );
  } finally {
    expiryCheckRunning = false;
  }
}

export function setupInboxExpiryCheck(): void {
  // Chrome MV3: minimum period is 1 minute for packed extensions; keep at 1 min
  // and always re-assert the alarm on SW wake so sleep doesn't drop renewals.
  const PERIOD_MINUTES = 1;

  (async () => {
    try {
      // Re-create every SW start — clears drifted / missing alarms after sleep
      await browser.alarms.clear('checkInboxExpiry');
      await browser.alarms.create('checkInboxExpiry', {
        delayInMinutes: 0.1,
        periodInMinutes: PERIOD_MINUTES,
      });
    } catch (e) {
      logError(
        'Failed to create checkInboxExpiry alarm:',
        undefined,
        e instanceof Error ? e : new Error(String(e))
      );
    }
  })();

  // Immediate pass on SW start (user opened extension / browser woke SW)
  void checkInboxExpiry();

  if (!expiryAlarmListenerRegistered) {
    browser.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === 'checkInboxExpiry') {
        await checkInboxExpiry();
      }
    });
    // Also run expiry when email check wakes the SW (piggyback)
    browser.alarms.onAlarm.addListener(async (alarm) => {
      if (alarm.name === 'checkEmails') {
        try {
          await checkInboxExpiry();
        } catch {
          /* ignore */
        }
      }
    });
    expiryAlarmListenerRegistered = true;
  }
}
