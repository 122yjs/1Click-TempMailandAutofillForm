/**
 * Direct email printing without a popup window.
 *
 * `window.print()` must run inside a user gesture in Chrome (and is silently
 * ignored otherwise), and it always prints the *current* document. Extension
 * popups also close the moment the print dialog steals focus, so printing from
 * popup / sidepanel contexts is routed to the full app page
 * (`app.html?printInbox=..&printEmail=..`). The app tab then prints the message
 * through a hidden same-origin iframe whose `contentWindow.print()` call runs
 * inside the app tab's own user gesture.
 */

import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import { escapeHtmlText, initSanitize, sanitizeHtml } from './sanitize-html.js';
import { toMs } from './time.js';
import { formatFullDateTime } from './time-format.js';
import type { Email } from './types.js';

const PRINT_CSS = [
  'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; color: #0f172a; line-height: 1.6; }',
  '.print-header { border-bottom: 2px solid #cbd5e1; padding-bottom: 16px; margin-bottom: 24px; }',
  '.print-header h1 { margin: 0 0 10px 0; font-size: 22px; font-weight: 700; color: #0f172a; }',
  '.print-header div { font-size: 13px; color: #475569; margin-top: 4px; }',
  '.print-body { font-size: 14px; }',
  'img { max-width: 100%; height: auto; }',
  'table { border-collapse: collapse; max-width: 100%; }',
  'td, th { border: 1px solid #cbd5e1; padding: 6px 10px; }',
].join('\n');

/** Header (subject / from / date) + sanitized body markup for printing. */
export function buildEmailPrintHtml(msg: Email, bodyHtml: string): string {
  const subject = escapeHtmlText(msg.subject || get(t)('activity.noSubject'));
  const fromLine = escapeHtmlText(msg.from_name || msg.from || '');
  const fromEmail = escapeHtmlText(msg.from || '');
  const dateLine = escapeHtmlText(
    msg.received_at ? formatFullDateTime(toMs(msg.received_at)) : msg.time || ''
  );
  const fromLabel = escapeHtmlText(get(t)('activity.fromLabel'));
  const dateLabel = escapeHtmlText(get(t)('activity.dateLabel'));
  return (
    `<div class="print-header"><h1>${subject}</h1>` +
    `<div><strong>${fromLabel}:</strong> ${fromLine} &lt;${fromEmail}&gt;</div>` +
    `<div><strong>${dateLabel}:</strong> ${dateLine}</div></div>` +
    `<div class="print-body">${bodyHtml}</div>`
  );
}

/**
 * Open the browser's native print dialog for `html` directly, using a hidden
 * same-origin iframe. Must be called within a user gesture in Chrome.
 * Returns true when the print dialog was invoked.
 */
export function printHtmlDocument(html: string, title: string): boolean {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;margin:0;padding:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return false;
  }
  doc.title = title;
  const styleEl = doc.createElement('style');
  styleEl.textContent = PRINT_CSS;
  doc.head.appendChild(styleEl);
  const bodyWrap = doc.createElement('div');
  bodyWrap.innerHTML = html;
  doc.body.replaceChildren(bodyWrap);

  const win = iframe.contentWindow;
  if (!win) {
    iframe.remove();
    return false;
  }
  win.focus();
  win.print();
  // Keep the iframe alive while the print dialog is open, then clean up.
  setTimeout(() => {
    iframe.remove();
  }, 60_000);
  return true;
}

/**
 * Load an email from extension storage (active or archived) and prepare the
 * print-ready HTML. Returns null when the message cannot be found.
 */
export async function prepareEmailPrintFromStorage(
  inbox: string,
  messageId: string
): Promise<{ html: string; title: string } | null> {
  try {
    await initSanitize();
    const { storedEmails = {}, archivedEmails = {} } = (await browser.storage.local.get([
      'storedEmails',
      'archivedEmails',
    ])) as {
      storedEmails?: Record<string, Email[]>;
      archivedEmails?: Record<string, Email[]>;
    };
    const candidates = [
      ...(Array.isArray(storedEmails[inbox]) ? storedEmails[inbox] : []),
      ...(Array.isArray(archivedEmails[inbox]) ? archivedEmails[inbox] : []),
    ];
    const msg = candidates.find((m) => m.id === messageId || m.id === `${inbox}_${messageId}`);
    if (!msg) return null;
    const rawBody = msg.body_html || msg.body || '';
    const bodyContent = sanitizeHtml(rawBody);
    return {
      html: buildEmailPrintHtml(msg, bodyContent),
      title: msg.subject || get(t)('activity.noSubject'),
    };
  } catch {
    return null;
  }
}
