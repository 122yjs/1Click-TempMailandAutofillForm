import { browser } from 'wxt/browser';
import { loadClipboardPrivacy, purgeDurationMs } from './clipboard-settings.js';
import { logError, logInfo } from './logger.js';

let purgeTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * Clipboard purge record stored in extension storage so a background alarm
 * can clear sensitive data even if the page/context that initiated the copy
 * is unloaded before the page-scoped setTimeout fires.
 */
export interface ClipboardPurgeRecord {
  /** SHA-256 hex hash of the text that was copied (for content-matching) */
  hash: string;
  /** Epoch ms when the purge should execute */
  purgeAt: number;
}

const CLIPBOARD_PURGE_QUEUE_KEY = 'clipboardPurgeQueue';

/**
 * Hash text using SHA-256 (available in both page and background contexts).
 * Used to match clipboard content before purging without storing the secret.
 */
async function hashClipboardText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Register a purge record in extension storage so the background alarm
 * can clear the clipboard even if this page/context is destroyed.
 */
export async function scheduleBackgroundPurge(text: string, ms: number): Promise<void> {
  if (ms <= 0) return;
  try {
    const hash = await hashClipboardText(text);
    const record: ClipboardPurgeRecord = { hash, purgeAt: Date.now() + ms };
    const existing = (await browser.storage.local.get([CLIPBOARD_PURGE_QUEUE_KEY])) as {
      clipboardPurgeQueue?: ClipboardPurgeRecord[];
    };
    const queue = (existing.clipboardPurgeQueue || []).filter((r) => r.purgeAt > Date.now());
    queue.push(record);
    await browser.storage.local.set({ [CLIPBOARD_PURGE_QUEUE_KEY]: queue });
  } catch (err) {
    logError('Failed to schedule background clipboard purge', err);
  }
}

/**
 * Copy text to the clipboard and optionally schedule auto-clear
 * (duration from clipboard privacy settings, or explicit override).
 *
 * Pass durationMs = 0 to skip purge. Omit to use user settings.
 */
export async function copyToClipboardAndSchedulePurge(
  text: string,
  durationMs?: number
): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
    } else {
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.opacity = '0';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }

    let ms = durationMs;
    if (ms === undefined) {
      try {
        const settings = await loadClipboardPrivacy();
        ms = purgeDurationMs(settings);
      } catch {
        /* ignore */
        ms = 30000;
      }
    }

    if (purgeTimeoutId) {
      clearTimeout(purgeTimeoutId);
      purgeTimeoutId = null;
    }

    if (ms && ms > 0) {
      logInfo(`Copied to clipboard. Scheduled auto-purge in ${ms / 1000}s.`);
      // Also register in extension storage so a background alarm can purge
      // even if this page/context is destroyed before the timeout fires
      void scheduleBackgroundPurge(text, ms);
      purgeTimeoutId = setTimeout(async () => {
        purgeTimeoutId = null;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText('');
            logInfo('Auto-cleared sensitive data from clipboard.');
          }
        } catch (err) {
          logError('Failed to auto-clear clipboard', err);
        }
      }, ms);
    } else {
      logInfo('Copied to clipboard (auto-purge disabled).');
    }

    return true;
  } catch (error) {
    logError('Failed to copy to clipboard', error);
    return false;
  }
}

/**
 * Background alarm entry point: scan the purge queue, clear clipboard for
 * any entries whose purgeAt has passed, and prune expired records.
 * Runs in the service worker context (no navigator.clipboard), so uses
 * scripting.executeScript to inject a clipboard-clear call into an active tab.
 */
export async function processClipboardPurgeQueue(): Promise<void> {
  try {
    const existing = (await browser.storage.local.get([CLIPBOARD_PURGE_QUEUE_KEY])) as {
      clipboardPurgeQueue?: ClipboardPurgeRecord[];
    };
    const queue = existing.clipboardPurgeQueue || [];
    const now = Date.now();
    const due = queue.filter((r) => r.purgeAt <= now);
    const pending = queue.filter((r) => r.purgeAt > now);

    if (due.length > 0) {
      try {
        // Get the active tab to inject the clipboard-clear script
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (tabId !== undefined) {
          await browser.scripting.executeScript({
            target: { tabId },
            func: () => {
              navigator.clipboard.writeText('').catch(() => {
                /* ignore clipboard clear failure in background context */
              });
            },
          });
          logInfo(`Background alarm purged ${due.length} clipboard entr(y/ies).`);
        }
      } catch (err) {
        logError('Background clipboard purge failed', err);
      }
    }

    // Prune expired records from the queue
    await browser.storage.local.set({ [CLIPBOARD_PURGE_QUEUE_KEY]: pending });
  } catch (err) {
    logError('Failed to process clipboard purge queue', err);
  }
}
