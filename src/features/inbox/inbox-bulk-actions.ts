import type { Browser } from 'wxt/browser';
import { t } from '@/utils/i18n-utils.js';
import { logError } from '@/utils/logger.js';
import { withInboxLock } from '@/utils/mutex.js';
import { getInboxes, setInboxes } from '@/utils/storage-keys.js';
import type { Account, Email } from '@/utils/types.js';
import { canUnarchive } from './inbox-management.js';

export interface BulkActionsState {
  selectedAddresses: Set<string>;
  accounts: Account[];
  allInboxes: Account[];
}

export interface BulkActionsSetters {
  setSelectedAddresses: (addresses: Set<string>) => void;
  setShowToast: (
    message: string,
    type?: 'success' | 'error' | 'warning',
    undoAction?: (() => void | Promise<void>) | null
  ) => void;
  loadInboxes: () => Promise<void>;
  showConfirm: (message: string, onConfirm: () => void) => void;
  closeConfirm: () => void;
}

export function toggleSelectAll(
  mgmtAccounts: Account[],
  selectedAddresses: Set<string>
): Set<string> {
  const allSelected =
    mgmtAccounts.length > 0 && mgmtAccounts.every((a) => selectedAddresses.has(a.id));
  if (allSelected) return new Set();
  return new Set(mgmtAccounts.map((a) => a.id));
}

export function toggleSelect(selectedAddresses: Set<string>, id: string): Set<string> {
  const next = new Set(selectedAddresses);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export async function archiveSelected(
  _ext: Browser,
  state: BulkActionsState,
  setters: BulkActionsSetters
) {
  try {
    const count = state.selectedAddresses.size;
    let archivedInboxes: Account[] = [];
    await withInboxLock(async () => {
      const inboxes = await getInboxes();
      archivedInboxes = inboxes.filter((i: Account) => state.selectedAddresses.has(i.id));
      const updated = inboxes.map((i) =>
        state.selectedAddresses.has(i.id) ? { ...i, accountStatus: 'archived' as const } : i
      );
      await setInboxes(updated);
    });
    await setters.loadInboxes();
    setters.setSelectedAddresses(new Set());
    setters.setShowToast(await t('toasts.emailsArchivedCount', { count }), 'success', async () => {
      // Undo: restore archived inboxes
      await withInboxLock(async () => {
        const currentInboxes = await getInboxes();
        const restored = currentInboxes.map((i: Account) => {
          const wasArchived = archivedInboxes.find((a) => a.id === i.id);
          return wasArchived ? { ...i, accountStatus: 'active' as const } : i;
        });
        await setInboxes(restored);
      });
      await setters.loadInboxes();
      setters.setShowToast(await t('toasts.archiveUndone'));
    });
  } catch (e) {
    logError('Bulk archiving of selected inboxes failed', e);
    setters.setShowToast(await t('toasts.archiveFailed'), 'error');
  }
}

export async function unarchiveSelected(
  _ext: Browser,
  state: BulkActionsState,
  setters: BulkActionsSetters
) {
  try {
    const count = state.selectedAddresses.size;
    let actualUnarchivedCount = 0;
    let showUnarchiveFailed = false;
    let showWarning = false;
    let warningCount = 0;

    await withInboxLock(async () => {
      const inboxes = await getInboxes();

      // Filter out expired emails that cannot be unarchived
      const canUnarchiveIds = new Set<string>();
      for (const id of state.selectedAddresses) {
        const inbox = inboxes.find((i) => i.id === id);
        if (inbox && canUnarchive(inbox)) {
          canUnarchiveIds.add(id);
        }
      }

      if (canUnarchiveIds.size === 0) {
        showUnarchiveFailed = true;
        return;
      }

      if (canUnarchiveIds.size < state.selectedAddresses.size) {
        showWarning = true;
        warningCount = canUnarchiveIds.size;
      }

      const updated = inboxes.map((i) =>
        canUnarchiveIds.has(i.id) ? { ...i, accountStatus: 'active' as const } : i
      );
      await setInboxes(updated);
      actualUnarchivedCount = canUnarchiveIds.size;
    });

    if (showUnarchiveFailed) {
      setters.setShowToast(await t('toasts.noEmailsCanBeUnarchived'), 'error');
      return;
    }

    if (showWarning) {
      setters.setShowToast(
        await t('toasts.someEmailsCanBeUnarchived', { unarchivedCount: warningCount, count }),
        'warning'
      );
    }

    if (actualUnarchivedCount > 0) {
      await setters.loadInboxes();
      setters.setSelectedAddresses(new Set());
      setters.setShowToast(
        await t('toasts.emailsUnarchivedCount', { count: actualUnarchivedCount }),
        'success'
      );
    }
  } catch (e) {
    logError('Bulk unarchiving of selected inboxes failed', e);
    setters.setShowToast(await t('toasts.unarchiveFailed'), 'error');
  }
}

export async function deleteSelected(
  ext: Browser,
  state: BulkActionsState,
  setters: BulkActionsSetters
) {
  const count = state.selectedAddresses.size;
  const confirmMsg = await t('toasts.deleteConfirmMessage', { count });
  setters.showConfirm(confirmMsg, async () => {
    try {
      const storageSnapshot = (await ext.storage.local.get([
        'inboxes',
        'storedEmails',
        'archivedEmails',
        'readEmails',
        'starredEmails',
        'seenEmailIds',
        'lastMessageTimestamps',
      ])) as {
        inboxes?: Account[];
        storedEmails?: Record<string, Email[]>;
        archivedEmails?: Record<string, Email[]>;
        readEmails?: Record<string, boolean>;
        starredEmails?: string[];
        seenEmailIds?: Record<string, string[]>;
        lastMessageTimestamps?: Record<string, number>;
      };
      // Transactional delete: attempt every selected id, collect per-id
      // results so a mid-loop failure doesn't leave a half-deleted state with
      // no undo path for the ones that actually succeeded.
      const totalCount = state.selectedAddresses.size;
      const succeededIds: string[] = [];
      let failedCount = 0;
      for (const id of state.selectedAddresses) {
        try {
          const result = await ext.runtime.sendMessage({
            type: 'deleteInbox',
            inboxId: id,
            preserveEmails: false,
          });
          if (result?.success) {
            succeededIds.push(id);
          } else {
            failedCount++;
          }
        } catch {
          /* ignore */
          failedCount++;
        }
      }
      // Only the inboxes actually deleted server-side are eligible for undo.
      const deletedInboxes = (storageSnapshot.inboxes || []).filter((inbox) =>
        succeededIds.includes(inbox.id)
      );
      await setters.loadInboxes();

      if (succeededIds.length === 0) {
        setters.setShowToast(await t('toasts.deleteFailed'), 'error');
        return;
      }
      setters.setShowToast(
        await t('toasts.inboxesDeletedCount', { count: succeededIds.length }),
        'success',
        async () => {
          const current = (await ext.storage.local.get([
            'inboxes',
            'storedEmails',
            'archivedEmails',
            'readEmails',
            'starredEmails',
            'seenEmailIds',
            'lastMessageTimestamps',
          ])) as {
            inboxes?: Account[];
            storedEmails?: Record<string, Email[]>;
            archivedEmails?: Record<string, Email[]>;
            readEmails?: Record<string, boolean>;
            starredEmails?: string[];
            seenEmailIds?: Record<string, string[]>;
            lastMessageTimestamps?: Record<string, number>;
          };

          const restoredInboxes = [...(current.inboxes || [])];
          for (const inbox of deletedInboxes) {
            if (!restoredInboxes.some((existing) => existing.id === inbox.id)) {
              restoredInboxes.push(inbox);
            }
          }

          const storedEmails = current.storedEmails || {};
          const archivedEmails = current.archivedEmails || {};
          const seenEmailIds = current.seenEmailIds || {};
          const lastMessageTimestamps = current.lastMessageTimestamps || {};

          for (const inbox of deletedInboxes) {
            if (storageSnapshot.storedEmails?.[inbox.address]) {
              storedEmails[inbox.address] = storageSnapshot.storedEmails[inbox.address];
            }
            if (storageSnapshot.archivedEmails?.[inbox.address]) {
              archivedEmails[inbox.address] = storageSnapshot.archivedEmails[inbox.address];
            }
            if (storageSnapshot.seenEmailIds?.[inbox.address]) {
              seenEmailIds[inbox.address] = storageSnapshot.seenEmailIds[inbox.address];
            }
            if (storageSnapshot.lastMessageTimestamps?.[inbox.id] !== undefined) {
              lastMessageTimestamps[inbox.id] = storageSnapshot.lastMessageTimestamps[inbox.id];
            }
          }

          // Merge read/star state per-id: restore the deleted inboxes' snapshot
          // entries WITHOUT clobbering read/star changes that happened in other
          // (non-deleted) inboxes between the delete and the undo.
          const readEmails = { ...(current.readEmails || {}) };
          if (storageSnapshot.readEmails) {
            // Build the set of read-state keys that belong to the deleted inboxes:
            // compound keys `${address}_${id}` for each deleted address, plus the
            // bare ids of the emails stored in those deleted inboxes.
            const deletedReadKeys = new Set<string>();
            for (const inbox of deletedInboxes) {
              const prefix = `${inbox.address}_`;
              for (const key of Object.keys(storageSnapshot.readEmails)) {
                if (key.startsWith(prefix)) deletedReadKeys.add(key);
              }
              for (const email of storageSnapshot.storedEmails?.[inbox.address] || []) {
                deletedReadKeys.add(email.id);
              }
            }
            for (const [k, v] of Object.entries(storageSnapshot.readEmails)) {
              if (deletedReadKeys.has(k)) readEmails[k] = v;
            }
          }
          const starredEmails = [
            ...new Set([
              ...(current.starredEmails || []),
              ...(storageSnapshot.starredEmails || []),
            ]),
          ];

          await ext.storage.local.set({
            inboxes: restoredInboxes,
            storedEmails,
            archivedEmails,
            readEmails,
            starredEmails,
            seenEmailIds,
            lastMessageTimestamps,
          });
          await setters.loadInboxes();
          setters.setShowToast(await t('toasts.deleteUndone'));
        }
      );
      setters.setSelectedAddresses(new Set());
      setters.closeConfirm();

      if (failedCount > 0) {
        setters.setShowToast(
          await t('toasts.deletePartialFailed', { failed: failedCount, total: totalCount }),
          'warning'
        );
      }
    } catch (e) {
      logError('Bulk deletion of selected inboxes failed', e);
      setters.setShowToast(await t('toasts.deleteFailed'), 'error');
    }
  });
}

export async function exportSelected(
  accounts: Account[],
  selectedAddresses: Set<string>,
  exportAccountEmails: (account: Account | Account[]) => Promise<void>
) {
  const selectedList = accounts.filter((a) => selectedAddresses.has(a.id));
  if (selectedList.length === 1) {
    await exportAccountEmails(selectedList[0]);
  } else if (selectedList.length > 1) {
    await exportAccountEmails(selectedList);
  }
}
