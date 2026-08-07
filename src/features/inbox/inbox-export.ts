import type { Browser } from 'wxt/browser';
import { getIconSvg } from '@/ui/components/icons/icon-svg.js';
import { t, tSync } from '@/utils/i18n-utils.js';
import { logError } from '@/utils/logger.js';
import { PORTAL_Z } from '@/utils/portal-layers.js';
import { toMs } from '@/utils/time.js';
import type { Account, Email } from '@/utils/types.js';

export interface ExportState {
  selectedEmail: string;
}

export interface ExportSetters {
  setShowToast: (message: string, type?: 'success' | 'error' | 'warning') => void;
  loadInboxes: () => Promise<void>;
}

/**
 * Export account emails
 * @param ext - Browser extension API
 * @param account - Account to export emails for
 * @param setters - Export setter functions
 */
export async function exportAccountEmails(ext: Browser, account: Account, setters: ExportSetters) {
  try {
    const response = await ext.runtime.sendMessage({
      type: 'checkEmails',
      inboxId: account.id,
      filters: {},
    });
    const msgs = response?.messages || [];

    // Show export format dialog
    const format = await showExportFormatDialog();
    if (!format) return;

    await exportEmailsWithFormat(account, msgs, format);
  } catch (e: unknown) {
    logError(
      'exportAccountEmails failed',
      undefined,
      e instanceof Error ? e : new Error(String(e))
    );
    setters.setShowToast(await t('toasts.exportFailed'), 'error');
  }
}

/**
 * Show export format dialog
 * @returns Promise that resolves to selected format or null if cancelled
 */
export function showExportFormatDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', tSync('selectExportFormat'));
    dialog.style.cssText =
      'position:fixed;inset:0;z-index:' +
      String(PORTAL_Z.dialog) +
      ';display:flex;align-items:center;justify-content:center;';

    // Backdrop
    const backdrop = document.createElement('div');
    backdrop.style.cssText =
      'position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(2px);';
    backdrop.addEventListener('click', () => {
      dialog.remove();
      resolve(null);
    });

    // Panel
    const panel = document.createElement('div');
    panel.style.cssText =
      'position:relative;z-index:1;background:var(--md-surface,#fff);border-radius:20px;padding:24px;width:320px;box-shadow:0 24px 48px rgba(0,0,0,0.18);display:flex;flex-direction:column;gap:20px;';

    // Close button (top-right of panel)
    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('aria-label', tSync('close'));
    closeBtn.style.cssText =
      'position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;border:none;background:var(--md-surface-variant,#e7e0ec);cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--md-on-surface,#1c1b1f);transition:background 0.15s;';
    closeBtn.innerHTML = getIconSvg('x', { size: 16 });
    closeBtn.addEventListener('click', () => {
      dialog.remove();
      resolve(null);
    });

    // Heading
    const heading = document.createElement('h3');
    heading.style.cssText =
      'margin:0;font-size:16px;font-weight:700;color:var(--md-on-surface,#1c1b1f);padding-right:32px;';
    heading.textContent = tSync('backup.selectExportFormat');

    // Sub-label
    const sub = document.createElement('p');
    sub.style.cssText =
      'margin:0;margin-top:-12px;font-size:12px;color:var(--md-on-surface-variant,#49454f);';
    sub.textContent = tSync('backup.chooseFormatHint');

    // Format buttons row
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';

    const formats: [string, string, string][] = [
      ['json', 'JSON', 'application/json'],
      ['eml', 'Email', 'message/rfc822'],
      ['mbox', 'MBOX', 'application/mbox'],
    ];

    for (const [format, label] of formats) {
      const btn = document.createElement('button');
      btn.style.cssText =
        'flex:1;padding:10px 4px;font-size:13px;font-weight:600;border-radius:12px;border:1.5px solid var(--md-outline-variant,#cac4d0);background:transparent;color:var(--md-on-surface,#1c1b1f);cursor:pointer;transition:background 0.15s,border-color 0.15s;';
      btn.textContent = label;
      btn.setAttribute('aria-label', `Export as ${label}`);
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'var(--md-secondary-container,#e8def8)';
        btn.style.borderColor = 'var(--md-primary,#6750a4)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'transparent';
        btn.style.borderColor = 'var(--md-outline-variant,#cac4d0)';
      });
      btn.addEventListener('click', () => {
        dialog.remove();
        resolve(format);
      });
      row.appendChild(btn);
    }

    panel.append(closeBtn, heading, sub, row);
    dialog.append(backdrop, panel);
    document.body.appendChild(dialog);

    // Close on Escape
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dialog.remove();
        resolve(null);
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  });
}

/**
 * Exports emails from an account in the specified format.
 *
 * Supported formats:
 * - json: Exports as a JSON file containing address, provider, and message data
 * - eml: Exports as EML format (single email) or ZIP (multiple emails)
 * - mbox: Exports as MBOX format for email clients
 *
 * @param account - The account containing the email address and provider info
 * @param msgs - Array of email messages to export
 * @param format - The export format ('json', 'eml', or 'mbox')
 * @throws Error if export fails
 */
export async function exportEmailsWithFormat(account: Account, msgs: Email[], format: string) {
  try {
    let content = '';
    // Sanitize the local part for a filesystem-safe download name (same rule as
    // the ZIP path): strip everything except alphanumerics and spaces.
    const localPart = (account.address.split('@')[0] || 'emails')
      .replace(/[^a-zA-Z0-9\s]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    let filename = `${localPart}-emails`;
    let mimeType = 'text/plain';

    switch (format) {
      case 'json':
        content = JSON.stringify(buildJsonExportPayload(account, msgs), null, 2);
        filename += '.json';
        mimeType = 'application/json';
        break;
      case 'eml':
        if (msgs.length === 0) {
          content = '# No emails to export';
          filename += '.eml';
        } else if (msgs.length === 1) {
          content = generateSingleEMLContent(account, msgs[0]);
          filename += '.eml';
        } else {
          // Multiple emails - export as ZIP
          await exportMultipleEMLAsZip(account, msgs, filename);
          return;
        }
        mimeType = 'message/rfc822';
        break;
      case 'mbox':
        content = generateMBOXContent(account, msgs);
        filename += '.mbox';
        mimeType = 'application/mbox';
        break;
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    logError('Error exporting emails', e);
    throw e;
  }
}

/** Sanitizes values that end up inside MIME headers (filename / mimeType) to
 * prevent header injection from provider-supplied metadata. */
function sanitizeHeaderToken(value: string): string {
  return value.replace(/[\r\n"\\]/g, '_');
}

/**
 * Generates a single EML message. When the email carries attachment metadata
 * (filenames/MIME types), the message is built as `multipart/mixed` with one
 * MIME part per attachment so that metadata survives backup/import — the file
 * data itself was never downloaded, so each attachment part carries a short
 * note instead of bytes. Emails without attachments are a single-part message
 * whose Content-Type honestly reflects the body: `text/html` when an HTML body
 * exists, otherwise `text/plain`. Labeling HTML as text/plain would make every
 * email client render the raw markup as plain text.
 */
export function generateSingleEMLContent(account: Account, message: Email): string {
  // When the provider exposed the untouched raw MIME source (e.g. Guerrilla
  // Mail's `get_email_source`), emit it verbatim — headers, multipart
  // structure, original styling, and all. This is pixel-faithful; the
  // synthesized fallback below only applies to legacy stored emails.
  if (message.raw_source) {
    const source = message.raw_source.endsWith('\n')
      ? message.raw_source
      : `${message.raw_source}\n`;
    return source;
  }

  // Prefer the actual sender address; from_name is a display name and must
  // never stand in for the address in From/Return-Path headers.
  const fromEmail = message.from || message.from_name || 'unknown@example.com';
  const subject = message.subject || 'No Subject';
  const date = new Date(toMs(message.received_at || Date.now() / 1000)).toUTCString();
  const bodyPlain = message.body_plain || message.body || 'No content';
  const bodyHtml = message.body_html;
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];

  const header =
    `Return-Path: <${fromEmail}>\n` +
    `Delivered-To: ${account.address}\n` +
    `From: ${fromEmail}\n` +
    `To: ${account.address}\n` +
    `Subject: ${subject}\n` +
    `Date: ${date}\n` +
    `Message-ID: <${message.id || Date.now()}@${account.address}>\n` +
    `MIME-Version: 1.0\n`;

  if (attachments.length === 0) {
    // Single-part EML. The Content-Type must match the body actually written:
    // HTML bodies labeled text/plain (as the source emails sometimes are) show
    // as raw markup in every email client, so write text/html when we have it.
    const body = bodyHtml || bodyPlain;
    const contentType = bodyHtml ? 'text/html' : 'text/plain';
    return `${header}Content-Type: ${contentType}; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n\n${body}\n`;
  }

  const boundary = `_scout_bnd_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 12)}`;
  const lines: string[] = [];
  lines.push(`${header}Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');
  lines.push(`--${boundary}`);
  // Body part (HTML when available, otherwise plain text)
  lines.push(
    bodyHtml ? 'Content-Type: text/html; charset=UTF-8' : 'Content-Type: text/plain; charset=UTF-8'
  );
  lines.push('Content-Transfer-Encoding: 8bit');
  lines.push('');
  lines.push(bodyHtml || bodyPlain);
  // Attachment parts — metadata only (file bytes were not captured)
  for (const att of attachments) {
    const filename = sanitizeHeaderToken(att.filename || 'attachment');
    const mimeType = sanitizeHeaderToken(att.mimeType || 'application/octet-stream');
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${mimeType}; name="${filename}"`);
    lines.push(`Content-Disposition: attachment; filename="${filename}"`);
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(
      `[Attachment metadata preserved from backup export — filename: ${filename}, type: ${mimeType}]`
    );
  }
  lines.push('');
  lines.push(`--${boundary}--`);
  lines.push('');
  return lines.join('\n');
}

/** JSON export payload — embeds an explicit `attachments` manifest (message
 * id + filename + MIME type per file) alongside the full messages so attachment
 * metadata survives backup independent of walking the message array. */
export interface JsonExportPayload {
  address: string;
  provider: string;
  messages: Email[];
  attachments: {
    messageId: string;
    subject: string;
    from: string;
    receivedAt: number;
    filename: string;
    mimeType: string;
    partNumber?: string;
    downloadUrl?: string | null;
  }[];
}

export function buildJsonExportPayload(account: Account, msgs: Email[]): JsonExportPayload {
  const attachments = msgs.flatMap((m) =>
    (Array.isArray(m.attachments) ? m.attachments : []).map((att) => ({
      messageId: m.id,
      subject: m.subject || '',
      from: m.from || '',
      receivedAt: m.received_at,
      filename: att.filename,
      mimeType: att.mimeType,
      partNumber: att.partNumber,
      downloadUrl: att.downloadUrl ?? null,
    }))
  );
  return {
    address: account.address,
    provider: account.provider,
    messages: msgs,
    attachments,
  };
}

/**
 * Generates MBOX format content from an array of email messages.
 * MBOX is a standard format for storing email messages that can be imported by most email clients.
 * Each message is separated by a "From " line followed by the message content.
 *
 * @param account - The account containing the email address
 * @param messages - Array of email messages to convert to MBOX format
 * @returns A string containing the MBOX formatted email data
 */
export function generateMBOXContent(account: Account, messages: Email[]): string {
  const blocks: string[] = [];
  messages.forEach((message) => {
    const fromEmail = (message.from || 'unknown@example.com').replace(/[\r\n]/g, ' ');
    const date = new Date(toMs(message.received_at || Date.now() / 1000)).toUTCString();
    // Reuse the EML builder so attachment metadata (filenames/MIME types)
    // survives MBOX backups too — multipart/mixed when attachments exist.
    const eml = generateSingleEMLContent(account, message);
    // Escape lines starting with "From " anywhere in the message (mboxrd
    // format) so embedded quotes/bodies can't fake the MBOX separator.
    const escaped = eml.replace(/^From /gm, '>From ');
    blocks.push(`From ${fromEmail} ${date}\n${escaped}`);
  });
  // Blocks already end with a newline, so a single '\n' join yields exactly
  // one blank line between messages (MBOX message separation).
  return blocks.join('\n');
}

export async function exportMultipleEMLAsZip(
  account: Account,
  messages: Email[],
  baseFilename: string
) {
  try {
    // Import fflate dynamically
    const { zipSync, strToU8 } = await import('fflate');
    const files: Record<string, Uint8Array> = {};
    let fileIndex = 1;

    messages.forEach((message) => {
      const emlContent = generateSingleEMLContent(account, message);
      const subject = (message.subject || 'No Subject')
        .replace(/[^a-zA-Z0-9\s]/g, '_')
        .substring(0, 50);
      const sanitizedAddress = account.address.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `${fileIndex.toString().padStart(3, '0')}_${sanitizedAddress}_${subject}.eml`;
      files[filename] = strToU8(emlContent);
      fileIndex++;
    });

    const zipped = zipSync({ files });
    const blob = new Blob([zipped as unknown as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseFilename}_emails.zip`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    logError('Error creating ZIP file', e);
    // Fallback to text format if fflate fails
    let archiveContent = '# EML Archive - Multiple Email Export\n';
    archiveContent += `# Generated on: ${new Date().toISOString()}\n`;
    archiveContent += '# Note: ZIP creation failed, using text format\n\n';

    let fileIndex = 1;
    messages.forEach((message) => {
      const emlContent = generateSingleEMLContent(account, message);
      const subject = (message.subject || 'No Subject')
        .replace(/[^a-zA-Z0-9\s]/g, '_')
        .substring(0, 50);
      const filename = `${fileIndex.toString().padStart(3, '0')}_${account.address}_${subject}.eml`;
      archiveContent += `=== FILE: ${filename} ===\n`;
      archiveContent += emlContent;
      archiveContent += '\n=== END OF FILE ===\n\n';
      fileIndex++;
    });

    const blob = new Blob([archiveContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseFilename}_emails.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
