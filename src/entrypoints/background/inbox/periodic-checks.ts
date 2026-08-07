import { clearArchiveSchedule, getDueArchiveInboxIds } from '@/features/intelligence/site-rules.js';
import { DEBUG } from '@/utils/constants.js';
import { log, logDebug, logError } from '@/utils/logger.js';
import { withInboxLock } from '@/utils/mutex.js';
import { runStorageHygiene } from '@/utils/storage-hygiene.js';
import { getEmailRetentionDays, getInboxes, setInboxes } from '@/utils/storage-keys.js';
import type { Alarm, Email, EmailFilters } from '@/utils/types.js';
import { cleanupOldStoredEmails, storeNewMessages } from './email-storage.js';

export async function updateRefreshAlarm(intervalMs: number): Promise<void> {
  await browser.alarms.clear('checkEmails');
  const periodInMinutes = Math.max(1, Math.round(intervalMs / 60000));
  await browser.alarms.create('checkEmails', { periodInMinutes });
}

let registeredCheckFn: ((inboxId: string, filters: EmailFilters) => Promise<Email[]>) | null = null;

export function setupPeriodicEmailCheck(
  checkNewEmailsFn: (inboxId: string, filters: EmailFilters) => Promise<Email[]>
): void {
  registeredCheckFn = checkNewEmailsFn;
  if (DEBUG) log('=== SETTING UP PERIODIC EMAIL CHECK ===');

  (async () => {
    try {
      const emailAlarm = await browser.alarms.get('checkEmails');
      if (!emailAlarm) {
        if (DEBUG) log('Creating periodic alarm checkEmails (interval: 1 min)');
        await browser.alarms.create('checkEmails', {
          periodInMinutes: 1,
          delayInMinutes: 0.1,
        });
      }

      const cleanupAlarm = await browser.alarms.get('cleanupStoredEmails');
      if (!cleanupAlarm) {
        if (DEBUG) log('Creating periodic alarm cleanupStoredEmails (interval: 360 min)');
        await browser.alarms.create('cleanupStoredEmails', {
          periodInMinutes: 360,
          delayInMinutes: 5,
        });
      }
    } catch (e) {
      logError(
        'Failed to create periodic alarms:',
        undefined,
        e instanceof Error ? e : new Error(String(e))
      );
    }
  })().catch(() => {
    /* ignore in test environments */
  });

  if (DEBUG) log('=== ALARMS CREATED ===');
}

let isCheckRunning = false;
try {
  browser.alarms?.onAlarm?.addListener(async (alarm: Alarm) => {
    if (DEBUG) logDebug(`=== ALARM FIRED: ${alarm.name} ===`);

    if (alarm.name === 'checkEmails') {
      if (isCheckRunning) return;
      isCheckRunning = true;
      try {
        if (!registeredCheckFn) return;
        if (DEBUG) log('=== PERIODIC EMAIL CHECK STARTED ===');
        // Site-rule auto-archive due inboxes
        try {
          const due = await getDueArchiveInboxIds();
          if (due.length > 0) {
            // Wrap the inboxes read-modify-write in the inbox lock so a
            // concurrent expiry-renewal or createInbox doesn't lose updates.
            await withInboxLock(async () => {
              const inboxes = await getInboxes();
              let changed = false;
              const next = inboxes.map((i) => {
                if (due.includes(i.id)) {
                  changed = true;
                  return { ...i, accountStatus: 'archived' as const };
                }
                return i;
              });
              if (changed) {
                await setInboxes(next);
              }
            });
            for (const id of due) {
              await clearArchiveSchedule(id);
            }
          }
        } catch {
          /* optional */
        }

        const inboxes = await getInboxes();
        const activeInboxes = inboxes.filter(
          (i) => i.accountStatus !== 'deleted' && i.accountStatus !== 'archived'
        );

        if (activeInboxes.length === 0) {
          if (DEBUG) log('No active inboxes, skipping periodic email check');
          return;
        }

        // Concurrency limit of 3 inboxes at a time to prevent rate limits
        const concurrency = 3;

        for (let i = 0; i < activeInboxes.length; i += concurrency) {
          const chunk = activeInboxes.slice(i, i + concurrency);
          await Promise.allSettled(
            chunk.map(async (inbox) => {
              try {
                if (DEBUG) log(`Checking emails for inbox: ${inbox.address}`);

                if (!registeredCheckFn) return;
                const messages = await registeredCheckFn(inbox.id, {});
                if (DEBUG) log(`Fetched ${messages.length} messages for ${inbox.address}`);

                // Store fetched emails so UI can read them from storage
                if (messages.length > 0) {
                  await storeNewMessages(inbox.address, messages);
                  if (DEBUG) log(`Stored ${messages.length} messages for ${inbox.address}`);
                }
              } catch (error: unknown) {
                logError(
                  `Error checking emails for ${inbox.address}:`,
                  undefined,
                  error instanceof Error ? error : new Error(String(error))
                );
              }
            })
          );
        }

        if (DEBUG) log('=== PERIODIC EMAIL CHECK COMPLETED ===');
      } catch (error: unknown) {
        logError(
          'Error in periodic email check:',
          undefined,
          error instanceof Error ? error : new Error(String(error))
        );
      } finally {
        isCheckRunning = false;
      }
    } else if (alarm.name === 'cleanupStoredEmails') {
      try {
        const emailRetentionDays = await getEmailRetentionDays();
        await cleanupOldStoredEmails(emailRetentionDays, emailRetentionDays * 3); // Archived retention is 3x active retention
        // Cap bags / favicons / oversized avatars (quota hygiene)
        try {
          await runStorageHygiene();
        } catch {
          /* optional */
        }
      } catch (error: unknown) {
        logError(
          'Error in stored emails cleanup:',
          undefined,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  });
} catch {
  /* ignore in test environments */
}
