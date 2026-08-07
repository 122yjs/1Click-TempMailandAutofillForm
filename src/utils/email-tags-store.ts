/**
 * Single subscription for `emailTags` storage — avoids duplicate loaders across
 * MailboxView, EmailList, MessageDetail, and AppLayout.
 */
import { browser } from 'wxt/browser';
import { getEmailTagsMap, setEmailTagsMap } from '@/utils/storage-keys.js';

export function sanitizeEmailTagsMap(
  raw: Record<string, string[]> | undefined | null
): Record<string, string[]> {
  const sanitized: Record<string, string[]> = {};
  const source = raw || {};
  for (const [k, v] of Object.entries(source)) {
    sanitized[k] = Array.isArray(v) ? v : [];
  }
  return sanitized;
}

class EmailTagsStore {
  private map: Record<string, string[]> = {};
  private listeners = new Set<(map: Record<string, string[]>) => void>();
  private initPromise: Promise<void> | null = null;
  private listenerAttached = false;

  subscribe(listener: (map: Record<string, string[]>) => void): () => void {
    this.listeners.add(listener);
    listener(this.map);
    void this.init();
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.map);
    }
  }

  private attachStorageListener() {
    if (this.listenerAttached) return;
    this.listenerAttached = true;
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.emailTags) {
        this.map = sanitizeEmailTagsMap(
          changes.emailTags.newValue as Record<string, string[]> | undefined
        );
        this.notify();
      }
    });
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.refresh();
    }
    return this.initPromise;
  }

  async refresh(): Promise<void> {
    try {
      const loaded = await getEmailTagsMap();
      this.map = sanitizeEmailTagsMap(loaded);
      this.notify();
      this.attachStorageListener();
    } catch {
      /* ignore */
      this.map = {};
      this.notify();
    }
  }

  async replaceMap(next: Record<string, string[]>): Promise<void> {
    this.map = sanitizeEmailTagsMap(next);
    await setEmailTagsMap(this.map);
    this.notify();
  }

  getSnapshot(): Record<string, string[]> {
    return this.map;
  }
}

export const emailTagsStore = new EmailTagsStore();
