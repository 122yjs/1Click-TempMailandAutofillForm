/**
 * Email storage management: store, archive, retrieve, and clean up emails
 */

import { browser } from 'wxt/browser';
import { addActivityEvent } from '@/utils/activity-tracker.js';
import { DEBUG, MAX_ARCHIVED_EMAILS, MAX_STORED_EMAILS_PER_INBOX } from '@/utils/constants.js';
import { tSync } from '@/utils/i18n-utils.js';
import { log, logError } from '@/utils/logger.js';
import { withLock } from '@/utils/mutex.js';
import {
  getAnalyticsRecord,
  getEmailMaps,
  getEmailRetentionDays,
  getStoredEmailsMap,
} from '@/utils/storage-keys.js';
import { safeStorageSet } from '@/utils/storageMonitor.js';
import { toMs } from '@/utils/time.js';
import { timeAgo } from '@/utils/time-format.js';
import type { Account, Email, EmailFilters, NotificationSettings } from '@/utils/types.js';

/**
 * Play a notification sound using Web Audio API
 */
function playNotificationSound() {
  try {
    // We only initialize audio context if we are in a DOM environment (popup/sidepanel).
    // Service workers do not have access to window or AudioContext.
    if (
      typeof AudioContext === 'undefined' &&
      typeof (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ===
        'undefined'
    )
      return;
    const AudioContextClass =
      typeof AudioContext !== 'undefined'
        ? AudioContext
        : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;

    const audioContext = new AudioContextClass();

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800; // Hz
    oscillator.type = 'sine';
    gainNode.gain.value = 0.1; // Volume

    const cleanup = () => {
      try {
        if (audioContext.state !== 'closed') {
          void audioContext.close();
        }
      } catch {
        /* ignore cleanup errors */
      }
    };

    oscillator.onended = cleanup;
    setTimeout(cleanup, 500);

    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.2); // 200ms beep
  } catch (e) {
    if (DEBUG) log('Failed to play notification sound:', e);
  }
}

// Check if storage quota is exceeded
async function isQuotaExceeded(error: unknown): Promise<boolean> {
  if (error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.code === 22;
  }
  if (error instanceof Error && error.message.includes('quota')) {
    return true;
  }
  return false;
}

/** Resolve bag for an address with case-insensitive key match. */
function bagForAddress(storedEmails: Record<string, Email[]>, inboxAddress: string): Email[] {
  if (!inboxAddress) return [];
  if (storedEmails[inboxAddress]) return storedEmails[inboxAddress] || [];
  const lower = inboxAddress.toLowerCase();
  for (const [k, list] of Object.entries(storedEmails)) {
    if (k.toLowerCase() === lower) return list || [];
  }
  return [];
}

export async function getStoredEmails(inboxAddress: string, _isRetry = false): Promise<Email[]> {
  try {
    const storedEmails = await getStoredEmailsMap();
    return bagForAddress(storedEmails, inboxAddress);
  } catch (error: unknown) {
    if (await isQuotaExceeded(error)) {
      if (_isRetry) {
        logError('Storage quota still exceeded after cleanup', { inboxAddress });
        throw new Error('Storage quota exceeded. Please free up space.');
      }
      logError('Storage quota exceeded, attempting to clean up old emails', { inboxAddress });
      const emailRetentionDays = await getEmailRetentionDays();
      await cleanupOldStoredEmails(emailRetentionDays, emailRetentionDays * 3);
      return getStoredEmails(inboxAddress, true);
    }
    throw error;
  }
}

function enforceMaxArchivedEmailsLimit(archivedEmails: Record<string, Email[]>): void {
  const allArchived = Object.values(archivedEmails).flat();
  if (allArchived.length > MAX_ARCHIVED_EMAILS) {
    allArchived.sort((a, b) => {
      const tA = (a as Email & { archived_at?: number }).archived_at || toMs(a.received_at);
      const tB = (b as Email & { archived_at?: number }).archived_at || toMs(b.received_at);
      return tB - tA;
    });
    const keptIds = new Set(allArchived.slice(0, MAX_ARCHIVED_EMAILS).map((e) => e.id));
    for (const address of Object.keys(archivedEmails)) {
      const kept = archivedEmails[address].filter((e) => keptIds.has(e.id));
      if (kept.length > 0) {
        archivedEmails[address] = kept;
      } else {
        delete archivedEmails[address];
      }
    }
  }
}

export async function clearStoredEmails(inboxAddress: string): Promise<void> {
  async function doArchive(): Promise<void> {
    await withLock('emails_storage_lock', async () => {
      const { storedEmails, archivedEmails } = await getEmailMaps();
      let archivedCount = 0;
      if (storedEmails[inboxAddress] && storedEmails[inboxAddress].length > 0) {
        if (!archivedEmails[inboxAddress]) archivedEmails[inboxAddress] = [];
        const emailsToArchive = storedEmails[inboxAddress].map((email: Email) => ({
          ...email,
          archived: true,
          archived_at: Date.now(),
          original_inbox: inboxAddress,
        }));
        archivedEmails[inboxAddress].push(...emailsToArchive);
        archivedCount = emailsToArchive.length;
        delete storedEmails[inboxAddress];
      }
      enforceMaxArchivedEmailsLimit(archivedEmails);
      await browser.storage.local.set({ storedEmails, archivedEmails });
      if (archivedCount > 0)
        log(`Archived ${archivedCount} emails for expired inbox: ${inboxAddress}`);
    });
  }

  try {
    await doArchive();
  } catch (error: unknown) {
    if (await isQuotaExceeded(error)) {
      logError('Storage quota exceeded during archive, attempting cleanup', { inboxAddress });
      const emailRetentionDays = await getEmailRetentionDays();
      await cleanupOldStoredEmails(emailRetentionDays, emailRetentionDays * 3);
      await doArchive();
    } else {
      throw error;
    }
  }
}

/**
 * Move emails from archivedEmails back into storedEmails when an inbox is
 * unarchived / restored / renewed, so Offline Saved history remains available.
 */
export async function restoreArchivedEmailsToStored(inboxAddress: string): Promise<void> {
  await withLock('emails_storage_lock', async () => {
    const { storedEmails, archivedEmails } = await getEmailMaps();
    const archived = archivedEmails[inboxAddress] || [];
    if (archived.length === 0) return;

    const existing = storedEmails[inboxAddress] || [];
    const seen = new Set(existing.map((e) => e.id));
    const merged = [...existing];
    for (const email of archived) {
      if (seen.has(email.id)) continue;
      seen.add(email.id);
      const {
        archived: _a,
        archived_at: _at,
        ...rest
      } = email as Email & {
        archived?: boolean;
        archived_at?: number;
      };
      merged.push({
        ...rest,
        local_only: true,
        local_only_since:
          rest.local_only_since || rest.local_deleted_at || rest.stored_at || Date.now(),
        original_inbox: rest.original_inbox || inboxAddress,
      });
    }
    storedEmails[inboxAddress] = merged;
    delete archivedEmails[inboxAddress];
    await browser.storage.local.set({ storedEmails, archivedEmails });
    log(`Restored ${archived.length} archived emails for inbox: ${inboxAddress}`);
  });
}

export async function getArchivedEmails(inboxAddress?: string): Promise<Email[]> {
  const { archivedEmails } = await getEmailMaps();

  if (inboxAddress) {
    return (archivedEmails[inboxAddress] || []).sort(
      (a: Email, b: Email) =>
        ((b as Email & { archived_at?: number }).archived_at || toMs(b.received_at) || 0) -
        ((a as Email & { archived_at?: number }).archived_at || toMs(a.received_at) || 0)
    );
  }

  const allArchived: Email[] = [];
  for (const emails of Object.values(archivedEmails)) {
    allArchived.push(...emails);
  }

  return allArchived.sort(
    (a: Email, b: Email) =>
      ((b as Email & { archived_at?: number }).archived_at || 0) -
      ((a as Email & { archived_at?: number }).archived_at || 0)
  );
}

export async function cleanupOldStoredEmails(
  activeRetentionDays: number = 30,
  archivedRetentionDays: number = 90,
  skipLock: boolean = false
): Promise<void> {
  // If retention is 0, never delete
  if (activeRetentionDays === 0 && archivedRetentionDays === 0) {
    return;
  }

  const task = async () => {
    const { storedEmails, archivedEmails } = await getEmailMaps();

    const activeThreshold =
      activeRetentionDays === 0 ? 0 : Date.now() - activeRetentionDays * 24 * 60 * 60 * 1000;
    const archivedThreshold =
      archivedRetentionDays === 0 ? 0 : Date.now() - archivedRetentionDays * 24 * 60 * 60 * 1000;
    let totalCleaned = 0;

    for (const [address, emails] of Object.entries(storedEmails)) {
      const filteredEmails = emails.filter((email: Email & { stored_at?: number }) => {
        const emailAge = email.stored_at || toMs(email.received_at);
        return emailAge > activeThreshold;
      });

      if (filteredEmails.length !== emails.length) {
        storedEmails[address] = filteredEmails;
        totalCleaned += emails.length - filteredEmails.length;
      }
    }

    for (const [address, emails] of Object.entries(archivedEmails)) {
      const filteredEmails = emails.filter(
        (email: Email & { archived_at?: number; stored_at?: number }) => {
          const emailAge =
            (email as Email & { archived_at?: number }).archived_at || toMs(email.received_at);
          return emailAge > archivedThreshold;
        }
      );

      if (filteredEmails.length !== emails.length) {
        archivedEmails[address] = filteredEmails;
        totalCleaned += emails.length - filteredEmails.length;
      }
    }

    const originalCount = Object.values(archivedEmails).flat().length;
    enforceMaxArchivedEmailsLimit(archivedEmails);
    const newCount = Object.values(archivedEmails).flat().length;
    if (originalCount !== newCount) {
      totalCleaned += originalCount - newCount;
    }

    if (totalCleaned > 0) {
      await safeStorageSet(browser, { storedEmails, archivedEmails });
      log(`Cleaned up ${totalCleaned} old/excess emails`);
    }
  };

  if (skipLock) {
    await task();
  } else {
    await withLock('emails_storage_lock', task);
  }
}

export async function storeNewMessages(inboxAddress: string, newMessages: Email[]): Promise<void> {
  await withLock('emails_storage_lock', async () => {
    const { storedEmails = {}, archivedEmails = {} } = await getEmailMaps();
    if (!storedEmails[inboxAddress]) {
      storedEmails[inboxAddress] = [];
    }

    // Deduplicate per-inbox only: same message ID may appear in different inboxes
    // (e.g. same sender sends to multiple addresses). Checking across ALL inboxes
    // would incorrectly suppress a message in inbox B just because it exists in inbox A.
    const existingIds = new Set<string>();
    const inboxStored = storedEmails[inboxAddress] || [];
    const inboxArchived = (archivedEmails as Record<string, Email[]>)[inboxAddress] || [];
    for (const e of inboxStored) if (e.id) existingIds.add(String(e.id));
    for (const e of inboxArchived) if (e.id) existingIds.add(String(e.id));

    const uniqueNewMessages = newMessages.filter((msg: Email) => !existingIds.has(String(msg.id)));

    if (uniqueNewMessages.length > 0) {
      for (const msg of uniqueNewMessages) {
        if (!msg.original_inbox) msg.original_inbox = inboxAddress;
      }
      storedEmails[inboxAddress].push(...uniqueNewMessages);
      storedEmails[inboxAddress].sort((a: Email, b: Email) => b.received_at - a.received_at);

      if (storedEmails[inboxAddress].length > MAX_STORED_EMAILS_PER_INBOX) {
        storedEmails[inboxAddress] = storedEmails[inboxAddress].slice(
          0,
          MAX_STORED_EMAILS_PER_INBOX
        );
      }

      let success = await safeStorageSet(browser, { storedEmails });
      if (!success) {
        logError('Storage quota exceeded, attempting cleanup before retry', { inboxAddress });
        const emailRetentionDays = await getEmailRetentionDays();
        await cleanupOldStoredEmails(emailRetentionDays, emailRetentionDays * 3, true);

        // Re-read stored emails after cleanup so we merge our new messages into the cleaned list
        const refreshedMaps = await getEmailMaps();
        const refreshedStored = refreshedMaps.storedEmails;
        if (!refreshedStored[inboxAddress]) refreshedStored[inboxAddress] = [];
        // Dedup against cleaned list again
        const currentIds = new Set(refreshedStored[inboxAddress].map((e: Email) => e.id));
        const refreshedUnique = newMessages.filter((msg: Email) => !currentIds.has(msg.id));
        refreshedStored[inboxAddress].push(...refreshedUnique);
        refreshedStored[inboxAddress].sort((a: Email, b: Email) => b.received_at - a.received_at);
        if (refreshedStored[inboxAddress].length > MAX_STORED_EMAILS_PER_INBOX) {
          refreshedStored[inboxAddress] = refreshedStored[inboxAddress].slice(
            0,
            MAX_STORED_EMAILS_PER_INBOX
          );
        }

        success = await safeStorageSet(browser, { storedEmails: refreshedStored });
        if (!success) {
          // Last resort: aggressively trim the newest-message inbox (drop the
          // OLDEST emails beyond a small floor) so newly-received mail is never
          // silently dropped on quota exhaustion. Prefer dropping old mail over
          // losing the brand-new message the user is waiting for.
          logError('Storage quota exceeded after retention cleanup — trimming oldest emails', {
            inboxAddress,
          });
          const floor = Math.min(MAX_STORED_EMAILS_PER_INBOX, 20);
          let trimmedStored = refreshedStored[inboxAddress] || [];
          if (trimmedStored.length > floor) {
            trimmedStored = trimmedStored.slice(0, floor);
            refreshedStored[inboxAddress] = trimmedStored;
          }
          success = await safeStorageSet(browser, { storedEmails: refreshedStored });
          if (!success) {
            logError('Failed to store new messages even after trimming', { inboxAddress });
          }
        }
      }
      if (DEBUG && success)
        log(`Stored ${uniqueNewMessages.length} new emails for ${inboxAddress}`);

      // Process side effects for new messages
      await processNewMessages(inboxAddress, uniqueNewMessages);
    }
  });
}

export function filterMessages(messages: Email[], filters: EmailFilters = {}): Email[] {
  // Return a new array of fresh copies to avoid mutating input objects in place
  let filteredMessages = messages.map((msg) => ({
    ...msg,
    stored_at: msg.stored_at || Date.now(),
  }));

  if (filters.searchQuery?.trim()) {
    const query = filters.searchQuery.toLowerCase().trim();
    filteredMessages = filteredMessages.filter((msg: Email) => {
      const subjectMatch = msg.subject?.toLowerCase().includes(query);
      const fromMatch = msg.from_name?.toLowerCase().includes(query);
      const bodyMatch = msg.body_plain?.toLowerCase().includes(query);
      return subjectMatch || fromMatch || bodyMatch;
    });
  }

  if (filters.hasOTP) {
    filteredMessages = filteredMessages.filter(
      (msg: Email) => msg.otp && msg.otp.trim().length > 0
    );
  }

  if (filters.senderDomain?.trim()) {
    const senderDomain = filters.senderDomain.toLowerCase().trim();
    filteredMessages = filteredMessages.filter((msg: Email) => {
      const sender = msg.from || msg.from_name || '';
      return sender.toLowerCase().includes(senderDomain);
    });
  }

  if (filters.recipient?.trim()) {
    const recipient = filters.recipient.toLowerCase().trim();
    filteredMessages = filteredMessages.filter((msg: Email) => {
      const originalInbox = msg.original_inbox || '';
      return originalInbox.toLowerCase().includes(recipient);
    });
  }

  if (filters.dateFrom) {
    const fromTime =
      typeof filters.dateFrom === 'string'
        ? new Date(filters.dateFrom).getTime()
        : filters.dateFrom;
    filteredMessages = filteredMessages.filter((msg: Email) => toMs(msg.received_at) >= fromTime);
  }

  if (filters.dateTo) {
    const toTime =
      typeof filters.dateTo === 'string'
        ? new Date(filters.dateTo).getTime() + 24 * 60 * 60 * 1000 - 1
        : filters.dateTo;
    filteredMessages = filteredMessages.filter((msg: Email) => toMs(msg.received_at) <= toTime);
  }

  return filteredMessages;
}

export async function applyFiltersAndProcessMessages(
  messages: Email[],
  filters: EmailFilters = {},
  _inbox?: Account
): Promise<Email[]> {
  // Backward compatibility wrapper
  return filterMessages(messages, filters);
}

async function processNewMessages(inboxAddress: string, uniqueNewMessages: Email[]): Promise<void> {
  if (uniqueNewMessages.length === 0) return;

  try {
    const { inboxes = [], lastMessageTimestamps = {} } = (await browser.storage.local.get([
      'inboxes',
      'lastMessageTimestamps',
    ])) as {
      inboxes?: Account[];
      lastMessageTimestamps?: Record<string, number>;
    };

    const inbox = inboxes.find((i) => i.address === inboxAddress);

    // 1. Send OTP from new messages to active tab
    const latestNewMessageWithOtp = uniqueNewMessages
      .filter((msg: Email) => msg.otp)
      .sort((a: Email, b: Email) => b.received_at - a.received_at)[0];

    if (latestNewMessageWithOtp?.otp) {
      try {
        // Broadcast OTP to ALL tabs (not just active) so wait-OTP panels on
        // other tabs receive the code via cross-tab propagation.
        void browser.runtime
          .sendMessage({
            type: 'fillOTP',
            otp: latestNewMessageWithOtp.otp,
            sender: latestNewMessageWithOtp.from,
            senderName: latestNewMessageWithOtp.from_name,
            subject: latestNewMessageWithOtp.subject,
          })
          .catch(() => {});
      } catch {
        /* ignore broadcast failure */
      }

      // M5: Update latestOtp cache in storage
      const latestOtpRecord = {
        otp: latestNewMessageWithOtp.otp,
        sender: latestNewMessageWithOtp.from || '',
        senderName: latestNewMessageWithOtp.from_name || '',
        context: [
          latestNewMessageWithOtp.from_name ? `From: ${latestNewMessageWithOtp.from_name}` : '',
          timeAgo(toMs(latestNewMessageWithOtp.received_at)),
        ]
          .filter(Boolean)
          .join(' | '),
        received_at: latestNewMessageWithOtp.received_at,
        recipient: inboxAddress,
      };
      const currentLatestOtp = (
        (await browser.storage.local.get('latestOtp')) as {
          latestOtp?: { received_at: number };
        }
      ).latestOtp;
      const currentReceived = currentLatestOtp?.received_at || 0;
      if (latestNewMessageWithOtp.received_at > currentReceived) {
        await safeStorageSet(browser, { latestOtp: latestOtpRecord });
      }
    }

    // 2. Track activity events for new emails
    if (inbox) {
      for (const msg of uniqueNewMessages) {
        await addActivityEvent('email_received', {
          inboxAddress: inbox.address,
          emailId: msg.id,
          sender: msg.from_name || msg.from,
          subject: msg.subject,
        });

        if (msg.otp) {
          await addActivityEvent('otp_detected', {
            inboxAddress: inbox.address,
            emailId: msg.id,
            otp: '••••',
            sender: msg.from_name || msg.from,
            subject: msg.subject,
          });
        }
      }
    }

    // 3. Update last message timestamp
    if (inbox) {
      let maxTimestamp = lastMessageTimestamps[inbox.id] || 0;
      for (const msg of uniqueNewMessages) {
        const ts = msg.received_at * 1000;
        if (ts > maxTimestamp) maxTimestamp = ts;
      }
      lastMessageTimestamps[inbox.id] = maxTimestamp;
      await safeStorageSet(browser, { lastMessageTimestamps });
    }

    // 4. Tally analytics deltas; applied under analytics_lock at the end so a
    //    concurrent recordEmailRead / incrementAnalytic can't be clobbered.
    const emailsReceivedDelta = uniqueNewMessages.length;
    const newOtpCount = uniqueNewMessages.filter((msg: Email) => msg.otp).length;
    let notificationsSentDelta = 0;

    // 5. Send notifications for new messages
    const result = (await browser.storage.local.get(['notificationSettings'])) as {
      notificationSettings?: NotificationSettings;
    };
    const notificationSettings: NotificationSettings = result.notificationSettings ?? {
      enabled: true,
      soundEnabled: true,
      expiryWarningThreshold: 60 * 60 * 1000,
    };

    if (notificationSettings.enabled && inbox) {
      // Per-address snooze: skip OS notifications while muted for this mailbox
      let snoozedUntil = 0;
      try {
        const snoozeRes = (await browser.storage.local.get(['notificationSnoozeByAddress'])) as {
          notificationSnoozeByAddress?: Record<string, number>;
        };
        const map = snoozeRes.notificationSnoozeByAddress || {};
        snoozedUntil = map[inbox.address] || map[inbox.address.toLowerCase()] || 0;
      } catch {
        /* ignore */
        snoozedUntil = 0;
      }
      if (snoozedUntil > Date.now()) {
        // Still track analytics? Skip notifications only
      } else {
        // Intelligence: quiet hours / OTP-only / muted senders / digest
        let toNotify = uniqueNewMessages;
        let useDigest = false;
        try {
          const { filterEmailsForNotification } = await import(
            '@/features/intelligence/notification-policy.js'
          );
          const decision = await filterEmailsForNotification(uniqueNewMessages);
          if (!decision.allow) {
            toNotify = [];
          } else {
            toNotify = decision.emails;
            useDigest = decision.digest;
          }
        } catch {
          /* ignore */
          toNotify = uniqueNewMessages;
        }

        if (toNotify.length > 0) {
          if (notificationSettings.soundEnabled) {
            playNotificationSound();
          }

          if (useDigest && toNotify.length > 1) {
            const otpN = toNotify.filter((m) => m.otp || m.isOtp).length;
            const notificationId = `email-digest:${inbox.id}:${Date.now()}`;
            browser.notifications.create(notificationId, {
              type: 'basic',
              iconUrl: 'icons/icon48.png',
              title: tSync('notifications.digestTitle', {
                count: toNotify.length,
                address: inbox.address,
              }),
              message:
                otpN > 0
                  ? tSync('notifications.digestMessageOtp', {
                      otp: otpN,
                      other: toNotify.length - otpN,
                    })
                  : toNotify
                      .slice(0, 3)
                      .map((m) => m.subject || m.from_name || tSync('notifications.mail'))
                      .join(' · '),
              priority: 0,
              contextMessage: tSync('notifications.clickToOpenMailbox'),
              // Respect the soundEnabled toggle: mute the OS notification chime
              // when the user disabled sounds (custom AudioContext sound doesn't
              // run in the service worker anyway).
              silent: !notificationSettings.soundEnabled,
            });
            notificationsSentDelta += 1;
            await addActivityEvent('notification_sent', {
              inboxAddress: inbox.address,
              message: `digest:${toNotify.length}`,
            });
          } else {
            toNotify.forEach((msg: Email) => {
              const magicUrl =
                msg.magicLinks?.[0]?.url || (msg as { magicLinkUrl?: string }).magicLinkUrl;
              const notificationId = magicUrl
                ? `magiclink:${msg.id}:${inbox.id}:${encodeURIComponent(magicUrl)}`
                : `email:${msg.id}:${inbox.id}`;
              browser.notifications.create(notificationId, {
                type: 'basic',
                iconUrl: 'icons/icon48.png',
                title: magicUrl
                  ? tSync('notifications.magicLinkTitle', { address: inbox.address })
                  : tSync('notifications.newEmailTitle', { address: inbox.address }),
                message: `${msg.from_name || tSync('notifications.unknownSender')}: ${
                  msg.subject || tSync('notifications.noSubject')
                }`,
                priority: 0,
                contextMessage: magicUrl
                  ? tSync('notifications.clickToOpenMagicLink')
                  : tSync('notifications.clickToViewEmail'),
                // Respect the soundEnabled toggle: mute the OS notification chime.
                silent: !notificationSettings.soundEnabled,
              });
            });
            notificationsSentDelta += toNotify.length;
            for (const msg of toNotify) {
              await addActivityEvent('notification_sent', {
                inboxAddress: inbox.address,
                emailId: msg.id,
                sender: msg.from_name || msg.from,
                subject: msg.subject,
              });
            }
          }
        }
      } // end not-snoozed

      // Lifecycle: mail signals for this inbox
      try {
        const { recordInboxMailSignals } = await import(
          '@/features/intelligence/inbox-lifecycle.js'
        );
        await recordInboxMailSignals(inbox.id, inbox.address, uniqueNewMessages);
      } catch {
        /* ignore */
      }
    }

    // Apply the tallied deltas under the analytics lock so concurrent
    // recordEmailRead / incrementAnalytic mutations aren't clobbered.
    await withLock('analytics_lock', async () => {
      const analytics = await getAnalyticsRecord();
      analytics.emailsReceived = (analytics.emailsReceived || 0) + emailsReceivedDelta;
      if (newOtpCount > 0) {
        analytics.otpsDetected = (analytics.otpsDetected || 0) + newOtpCount;
      }
      if (notificationsSentDelta > 0) {
        analytics.notificationsSent = (analytics.notificationsSent || 0) + notificationsSentDelta;
      }
      await safeStorageSet(browser, { analytics });
    });
  } catch (error: unknown) {
    logError('Error processing new messages side effects:', error);
  }
}

export async function getStorageUsage(): Promise<{
  totalBytes: number;
  totalMB: number;
  breakdown: Record<string, number>;
  categories: { emails: number; settings: number; cached: number; other: number };
}> {
  const result = await browser.storage.local.get(null);
  let totalBytes = 0;
  const breakdown: Record<string, number> = {};
  let emailsBytes = 0;
  let settingsBytes = 0;
  let cachedBytes = 0;
  let otherBytes = 0;

  for (const [key, value] of Object.entries(result)) {
    const size = new Blob([JSON.stringify(value)]).size;
    totalBytes += size;
    breakdown[key] = size;

    // Categorize by key prefix
    if (key === 'storedEmails' || key === 'archivedEmails' || key === 'readEmails') {
      emailsBytes += size;
    } else if (
      key.startsWith('settings_') ||
      key === 'identities' ||
      key === 'selectedIdentityId' ||
      key === 'autoCopy' ||
      key === 'autoRenew' ||
      key === 'selectedProvider' ||
      key === 'developerSettings' ||
      key === 'enableLogging' ||
      key === 'emailRetentionDays' ||
      key === 'useCustomPassword' ||
      key === 'customPassword' ||
      key === 'useCustomName' ||
      key === 'customFirstName' ||
      key === 'customLastName' ||
      key === 'customColor' ||
      key === 'contrastLevel'
    ) {
      settingsBytes += size;
    } else if (key === 'favicon_success_cache' || key === 'providerInstances') {
      cachedBytes += size;
    } else {
      otherBytes += size;
    }
  }

  return {
    totalBytes,
    totalMB: totalBytes / (1024 * 1024),
    breakdown,
    categories: {
      emails: emailsBytes / (1024 * 1024),
      settings: settingsBytes / (1024 * 1024),
      cached: cachedBytes / (1024 * 1024),
      other: otherBytes / (1024 * 1024),
    },
  };
}

export async function getEmailsToBeDeleted(
  retentionDays: number
): Promise<{ activeEmails: number; archivedEmails: number; totalEmails: number }> {
  // If retention is 0, no emails will be deleted
  if (retentionDays === 0) {
    return { activeEmails: 0, archivedEmails: 0, totalEmails: 0 };
  }

  const { storedEmails, archivedEmails } = await getEmailMaps();

  const threshold = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let activeEmailsToDelete = 0;
  let archivedEmailsToDelete = 0;

  for (const [_address, emails] of Object.entries(storedEmails)) {
    const filteredEmails = emails.filter((email: Email & { stored_at?: number }) => {
      const emailAge = email.stored_at || toMs(email.received_at);
      return emailAge <= threshold;
    });
    activeEmailsToDelete += filteredEmails.length;
  }

  for (const [_address, emails] of Object.entries(archivedEmails)) {
    const filteredEmails = emails.filter((email: Email & { archived_at?: number }) => {
      const emailAge =
        (email as Email & { archived_at?: number }).archived_at || toMs(email.received_at);
      return emailAge <= threshold;
    });
    archivedEmailsToDelete += filteredEmails.length;
  }

  return {
    activeEmails: activeEmailsToDelete,
    archivedEmails: archivedEmailsToDelete,
    totalEmails: activeEmailsToDelete + archivedEmailsToDelete,
  };
}

export async function clearAllOtps(): Promise<void> {
  await withLock('emails_storage_lock', async () => {
    const storedEmails = await getStoredEmailsMap();
    for (const msgs of Object.values(storedEmails)) {
      for (const m of msgs) {
        m.otp = null;
      }
    }
    await browser.storage.local.set({ storedEmails });
    await browser.storage.local.remove('latestOtp');
  });
}
