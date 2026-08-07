/**
 * Active inbox metadata resolution — extracted from autofill-plan.ts to keep
 * the content-script bundle clean (the content script uses the
 * getActiveInboxMetaViaBg bridge instead and never calls this directly).
 */

import { browser } from 'wxt/browser';

export async function getActiveInboxMeta(): Promise<{
  inboxId: string | null;
  address: string | null;
  provider: string | null;
  providerDisplay: string | null;
}> {
  try {
    const { activeInboxId, inboxes = [] } = (await browser.storage.local.get([
      'activeInboxId',
      'inboxes',
    ])) as {
      activeInboxId?: string;
      inboxes?: Array<{
        id: string;
        address: string;
        provider?: string;
        providerName?: string;
      }>;
    };
    const inbox = inboxes.find((i) => i.id === activeInboxId) || inboxes[0];
    if (!inbox) {
      return { inboxId: null, address: null, provider: null, providerDisplay: null };
    }
    let providerDisplay = inbox.providerName || null;
    if (!providerDisplay && inbox.provider) {
      try {
        const response = (await browser.runtime
          .sendMessage({ type: 'getProviderDisplayName', provider: inbox.provider })
          .catch(() => null)) as { success?: boolean; displayName?: string } | null;
        providerDisplay = response?.success
          ? (response.displayName ?? inbox.provider)
          : inbox.provider;
      } catch {
        providerDisplay = inbox.provider;
      }
    }
    return {
      inboxId: inbox.id || null,
      address: inbox.address || null,
      provider: inbox.provider || null,
      providerDisplay,
    };
  } catch {
    /* ignore */
    return { inboxId: null, address: null, provider: null, providerDisplay: null };
  }
}
