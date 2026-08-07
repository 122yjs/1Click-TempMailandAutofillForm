import type { ToastType } from '@/ui/blocks/feedback/Toast.svelte';
import { loadProviderConfig, tryLoadProviderConfig } from '@/utils/email-service.js';
// loadProviderConfig kept for canRenew and other call sites below
import { getErrorMessage } from '@/utils/errors.js';
import { t } from '@/utils/i18n-utils.js';
import { detectIconFromMessage } from '@/utils/iconMapping.js';
import { logError } from '@/utils/logger.js';
import { getInboxes, setInboxes } from '@/utils/storage-keys.js';
import type { Account, Email } from '@/utils/types.js';

export interface ManagementState {
  selectedEmail: string;
  emails: Email[];
  loading: boolean;
}

export interface ManagementSetters {
  setSelectedEmail: (email: string) => void;
  setEmails: (emails: Email[]) => void;
  setLoading: (loading: boolean) => void;
  setShowToast: (
    toast:
      | {
          message: string;
          type?: ToastType;
          icon?: ToastType;
        }
      | string,
    type?: ToastType,
    undoAction?: (() => void | Promise<void>) | null
  ) => void;
  loadInboxes: (skipEmailSelection?: boolean) => Promise<void>;
  setDropdownOpen: (open: boolean) => void;
  setArchivedSectionOpen?: (open: boolean) => Promise<void>;
  showOnboarding?: () => void;
  setAllInboxes?: (inboxes: Account[] | ((prev: Account[]) => Account[])) => void;
}

/**
 * Toggle auto-extend for an account
 * @param ext - Browser extension API
 * @param account - Account to toggle auto-extend for
 * @param setters - Management setter functions
 */
export async function toggleAutoExtend(ext: Browser, account: Account, setters: ManagementSetters) {
  try {
    const inboxes = await getInboxes();
    const newAutoExtendValue = !account.autoExtend;
    const updated = inboxes.map((i: Account) =>
      i.id === account.id ? { ...i, autoExtend: newAutoExtendValue } : i
    );
    await setInboxes(updated);
    // Immediately update reactive state for UI reactivity using functional update to preserve computed fields
    if (setters.setAllInboxes) {
      setters.setAllInboxes((prev) =>
        prev.map((acc) =>
          acc.id === account.id ? { ...acc, autoExtend: newAutoExtendValue } : acc
        )
      );
    }
    await setters.loadInboxes(true);

    // Enabling auto-renew on an already-expired renewable address must renew now
    // (dismissing the renew strip previously left the flag on without extending).
    if (newAutoExtendValue) {
      const now = Date.now();
      const isNearingOrExpired =
        account.expiresAt > 0 &&
        (account.expiresAt <= now || account.expiresAt - now <= 10 * 60 * 1000);
      if (isNearingOrExpired && (await canRenew(account.provider))) {
        try {
          setters.setShowToast(await t('toasts.extendingExpiry'));
          const renewResult = await ext.runtime.sendMessage({
            type: 'renewInbox',
            inboxId: account.id,
          });
          if (renewResult?.success) {
            await setters.loadInboxes(true);
            setters.setShowToast({
              message: await t('toasts.autoExtendRenewed', { address: account.address }),
              type: 'success',
            });
            return;
          }
          setters.setShowToast({
            message: await t('toasts.autoExtendRenewFailed', { address: account.address }),
            type: 'warning',
          });
          return;
        } catch (renewErr) {
          logError(
            'toggleAutoExtend renew error:',
            undefined,
            renewErr instanceof Error ? renewErr : new Error(String(renewErr))
          );
          setters.setShowToast({
            message: await t('toasts.autoExtendRenewFailed', { address: account.address }),
            type: 'warning',
          });
          return;
        }
      }
    }

    const toggleMsg = newAutoExtendValue
      ? await t('toasts.autoExtendEnabled', { address: account.address })
      : await t('toasts.autoExtendDisabled', { address: account.address });
    const iconType = detectIconFromMessage(toggleMsg);
    setters.setShowToast({
      message: toggleMsg,
      type: iconType,
    });
  } catch (_e) {
    setters.setShowToast({ message: await t('toasts.autoExtendToggleFailed'), type: 'error' });
  }
}

/**
 * Remove an account from storage
 * @param ext - Browser extension API
 * @param account - Account to remove
 * @param state - Management state
 * @param setters - Management setter functions
 */
export async function removeAccount(
  ext: Browser,
  account: Account,
  state: ManagementState,
  setters: ManagementSetters
) {
  const acct = account;
  if (!acct) return;

  // Capture pre-deletion state from the active accounts list.
  const { inboxes: allAccounts = [] } = (await ext.storage.local.get(['inboxes'])) as {
    inboxes?: Account[];
  };
  const activeAccountsBefore = allAccounts.filter(
    (a: Account) => a.accountStatus !== 'archived' && a.accountStatus !== 'deleted'
  );
  const currentIndex = activeAccountsBefore.findIndex((a: Account) => a.address === acct.address);
  // Only navigate if the account being deleted was active (not already archived/deleted)
  const wasActiveAndSelected =
    state.selectedEmail === acct.address &&
    acct.accountStatus !== 'archived' &&
    acct.accountStatus !== 'deleted';

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

    const result = await ext.runtime.sendMessage({
      type: 'deleteInbox',
      inboxId: acct.id,
      preserveEmails: false,
    });

    if (!result?.success) {
      throw new Error(result?.error || 'Delete failed');
    }

    await setters.loadInboxes();

    // Handle navigation after deletion - only if it was the active selected account
    if (wasActiveAndSelected) {
      const { inboxes: updatedInboxes = [] } = (await ext.storage.local.get(['inboxes'])) as {
        inboxes?: Account[];
      };
      const activeAccountsAfter = updatedInboxes.filter(
        (a: Account) => a.accountStatus !== 'archived' && a.accountStatus !== 'deleted'
      );
      const archivedAccounts = updatedInboxes.filter(
        (a: Account) => a.accountStatus === 'archived' || a.accountStatus === 'deleted'
      );

      if (activeAccountsAfter.length > 0) {
        const nextCandidate =
          activeAccountsAfter[currentIndex] ?? activeAccountsAfter[currentIndex - 1];
        setters.setSelectedEmail(nextCandidate.address);
        setters.setEmails([]);
        setters.setDropdownOpen(true);
      } else if (archivedAccounts.length > 0 && setters.setArchivedSectionOpen) {
        // No active accounts left - open dropdown showing inactive tab
        setters.setSelectedEmail('');
        setters.setEmails([]);
        await setters.setArchivedSectionOpen(true);
      } else if (setters.showOnboarding) {
        // No accounts at all - show onboarding
        setters.setSelectedEmail('');
        setters.setEmails([]);
        setters.setDropdownOpen(false);
        setters.showOnboarding();
      } else {
        setters.setSelectedEmail('');
        setters.setEmails([]);
        setters.setDropdownOpen(true);
      }
    }
    // If account was already inactive (archived→deleted), keep current view - no navigation needed
    setters.setShowToast(
      { message: `Address ${acct.address} deleted`, type: 'success', icon: 'deleted' },
      undefined,
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

        const restoredInboxes = current.inboxes || [];
        if (!restoredInboxes.some((inbox) => inbox.id === acct.id)) {
          const originalAccount =
            storageSnapshot.inboxes?.find((inbox) => inbox.id === acct.id) || acct;
          restoredInboxes.push(originalAccount);
        }

        const storedEmails = current.storedEmails || {};
        const archivedEmails = current.archivedEmails || {};
        if (storageSnapshot.storedEmails?.[acct.address]) {
          storedEmails[acct.address] = storageSnapshot.storedEmails[acct.address];
        }
        if (storageSnapshot.archivedEmails?.[acct.address]) {
          archivedEmails[acct.address] = storageSnapshot.archivedEmails[acct.address];
        }

        const seenEmailIds = current.seenEmailIds || {};
        if (storageSnapshot.seenEmailIds?.[acct.address]) {
          seenEmailIds[acct.address] = storageSnapshot.seenEmailIds[acct.address];
        }

        const lastMessageTimestamps = current.lastMessageTimestamps || {};
        if (storageSnapshot.lastMessageTimestamps?.[acct.id] !== undefined) {
          lastMessageTimestamps[acct.id] = storageSnapshot.lastMessageTimestamps[acct.id];
        }

        // Merge read/star state per-id so undoing this inbox's delete doesn't
        // clobber read/star changes that happened in other inboxes meanwhile.
        const readEmails = { ...(current.readEmails || {}) };
        if (storageSnapshot.readEmails) {
          // Restore only the read-state keys that belong to the deleted inbox:
          // compound keys `${address}_${id}` plus the bare ids of its stored emails.
          const deletedReadKeys = new Set<string>();
          const prefix = `${acct.address}_`;
          for (const key of Object.keys(storageSnapshot.readEmails)) {
            if (key.startsWith(prefix)) deletedReadKeys.add(key);
          }
          for (const email of storageSnapshot.storedEmails?.[acct.address] || []) {
            deletedReadKeys.add(email.id);
          }
          for (const [k, v] of Object.entries(storageSnapshot.readEmails)) {
            if (deletedReadKeys.has(k)) readEmails[k] = v;
          }
        }
        const starredEmails = [
          ...new Set([...(current.starredEmails || []), ...(storageSnapshot.starredEmails || [])]),
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
        await setters.loadInboxes(true);
        setters.setShowToast(await t('toasts.deleteUndone'));
      }
    );
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    setters.setShowToast({
      message: await t('toasts.deleteInboxFailed', { msg }),
      type: 'error',
    });
  }
}

/**
 * Archive an account
 * @param ext - Browser extension API
 * @param account - Account to archive
 * @param _accounts - List of all accounts (unused)
 * @param state - Management state
 * @param setters - Management setter functions
 */
export async function archiveAccount(
  ext: Browser,
  account: Account,
  _accounts: Account[],
  state: ManagementState,
  setters: ManagementSetters
) {
  try {
    // Only navigate if account was active before archiving (not already deleted→archived)
    const wasActiveAndSelected =
      state.selectedEmail === account.address && account.accountStatus !== 'deleted';
    await ext.runtime.sendMessage({ type: 'archiveInbox', inboxId: account.id });
    await setters.loadInboxes();

    // If the active selected account was archived, navigate to next active account
    if (wasActiveAndSelected) {
      const { inboxes: updatedInboxes = [] } = (await ext.storage.local.get(['inboxes'])) as {
        inboxes?: Account[];
      };
      const activeAccounts = updatedInboxes.filter(
        (a: Account) => a.accountStatus !== 'archived' && a.accountStatus !== 'deleted'
      );

      if (activeAccounts.length > 0) {
        setters.setSelectedEmail(activeAccounts[0].address);
        setters.setDropdownOpen(true);
      } else {
        setters.setSelectedEmail('');
        if (setters.setArchivedSectionOpen) {
          await setters.setArchivedSectionOpen(true);
        } else {
          setters.setDropdownOpen(true);
        }
      }
    }
    // If already inactive (deleted→archived), keep current view as-is

    setters.setShowToast(
      {
        message: await t('toasts.addressArchived', { address: account.address }),
        type: 'success',
        icon: 'archived',
      },
      undefined,
      async () => {
        await ext.runtime.sendMessage({ type: 'unarchiveInbox', inboxId: account.id });
        await setters.loadInboxes(true);
        setters.setShowToast(await t('toasts.archiveUndone'));
      }
    );
  } catch (e) {
    logError('archiveAccount error:', undefined, e instanceof Error ? e : new Error(String(e)));
    setters.setShowToast({ message: await t('toasts.archiveFailed'), type: 'error' });
  }
}

/**
 * Unarchive an account
 * @param ext - Browser extension API
 * @param account - Account to unarchive
 * @param setters - Management setter functions
 */
export async function unarchiveAccount(ext: Browser, account: Account, setters: ManagementSetters) {
  try {
    await ext.runtime.sendMessage({ type: 'unarchiveInbox', inboxId: account.id });
    await setters.loadInboxes();
    // Switch back to live tab
    if (setters.setArchivedSectionOpen) {
      await setters.setArchivedSectionOpen(false);
    }
    const unarchivedMsg = await t('toasts.addressUnarchived', { address: account.address });
    const iconType = detectIconFromMessage(unarchivedMsg);
    setters.setShowToast({
      message: unarchivedMsg,
      type: iconType,
    });
  } catch (e) {
    logError('unarchiveAccount error:', undefined, e instanceof Error ? e : new Error(String(e)));
    setters.setShowToast({ message: await t('toasts.unarchiveFailed'), type: 'error' });
  }
}

/**
 * Restore a deleted account
 * @param ext - Browser extension API
 * @param account - Account to restore
 * @param setters - Management setter functions
 */
export async function restoreAccount(ext: Browser, account: Account, setters: ManagementSetters) {
  try {
    await ext.runtime.sendMessage({ type: 'restoreInbox', inboxId: account.id });
    await setters.loadInboxes();
    // Switch back to live tab
    if (setters.setArchivedSectionOpen) {
      await setters.setArchivedSectionOpen(false);
    }
    const restoredMsg = await t('toasts.addressRestored', { address: account.address });
    const iconType = detectIconFromMessage(restoredMsg);
    setters.setShowToast({
      message: restoredMsg,
      type: iconType,
    });
  } catch (e) {
    logError('restoreAccount error:', undefined, e instanceof Error ? e : new Error(String(e)));
    setters.setShowToast({ message: await t('toasts.restoreFailed'), type: 'error' });
  }
}

/**
 * Check if an account can be unarchived (JSON-driven via providers.jsonc ui.canUnarchive).
 * Expired non-renewable addresses cannot be unarchived (nothing to renew into).
 * Never throws — unknown/missing provider → false.
 */
export function canUnarchive(account: Account): boolean {
  const config = tryLoadProviderConfig(account.provider);
  if (!config) return false;

  const isExpired =
    (typeof account.expiresAt === 'number' &&
      account.expiresAt > 0 &&
      account.expiresAt <= Date.now()) ||
    account.status === 'expired';
  const renewable = !!(config.expiry?.renewable || config.capabilities?.supportsRenew);
  // Expired + non-renewable: keep archived; Unarchive would be meaningless
  if (isExpired && !renewable) return false;

  const canUnarchiveRule = config.ui?.canUnarchive;
  if (canUnarchiveRule === 'ifNotExpired') {
    // Prefer accountStatus (storage), then display status
    const currentStatus = account.accountStatus || account.status;
    return currentStatus !== 'expired' && !isExpired;
  }
  // Explicit true only (avoid treating random strings as allow)
  return canUnarchiveRule === true;
}

async function canRenew(providerId: string): Promise<boolean> {
  const config = loadProviderConfig(providerId);
  return config.expiry?.renewable || false;
}

/**
 * Extend an account's expiry time
 * @param ext - Browser extension API
 * @param account - Account to extend
 * @param setters - Management setter functions
 */
export async function extendAccount(ext: Browser, account: Account, setters: ManagementSetters) {
  try {
    if (!(await canRenew(account.provider))) {
      setters.setShowToast(await t('toasts.extendNotAvailable'), 'error');
      return;
    }

    setters.setShowToast(await t('toasts.extendingExpiry'));

    const result = await ext.runtime.sendMessage({
      type: 'renewInbox',
      inboxId: account.id,
    });

    if (result.success) {
      await setters.loadInboxes();
      const successMsg = await t('toasts.expiryExtended');
      const iconType = detectIconFromMessage(successMsg);
      setters.setShowToast(successMsg, iconType);
    } else {
      setters.setShowToast(await t('toasts.expiryExtendFailed'), 'error');
    }
  } catch (e) {
    logError('extendAccount error:', undefined, e instanceof Error ? e : new Error(String(e)));
    setters.setShowToast(await t('toasts.expiryExtendFailed'), 'error');
  }
}
