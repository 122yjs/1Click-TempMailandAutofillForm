import { isDarkThemeActive } from '@/features/theme/theme-actions.js';
import { tSync } from '@/utils/i18n-utils.js';
import { escapeHtmlText, initSanitize, sanitizeHtml } from '@/utils/sanitize-html.js';
import type { Email } from '@/utils/types.js';

export async function openMessageWindow(message: Email) {
  const width = 800;
  const height = 600;

  // Multi-monitor-aware centering relative to the active window coordinates
  const screenLeft = window.screenLeft ?? window.screenX ?? 0;
  const screenTop = window.screenTop ?? window.screenY ?? 0;
  const outerWidth = window.outerWidth ?? document.documentElement.clientWidth ?? 800;
  const outerHeight = window.outerHeight ?? document.documentElement.clientHeight ?? 600;

  const left = screenLeft + (outerWidth - width) / 2;
  const top = screenTop + (outerHeight - height) / 2;

  const win = window.open(
    '',
    '_blank',
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`
  );
  if (!win) {
    return false;
  }

  await initSanitize();

  const rawHtml = message.body_html || '';
  const rawText = message.body || message.body_plain || '';
  const isHtmlText = !rawHtml && /<[a-z][\s\S]*>/i.test(rawText);

  // The message window follows the opener's theme: neutralize hardcoded light
  // backgrounds / dark text when the opener is on a dark theme.
  const darkMode = isDarkThemeActive();
  let body = '';
  if (rawHtml) {
    body = sanitizeHtml(rawHtml, { darkMode });
  } else if (isHtmlText) {
    body = sanitizeHtml(rawText, { darkMode });
  } else if (rawText) {
    const escaped = escapeHtmlText(rawText);
    const linked = escaped.replace(
      /(https?:\/\/[^\s<>'"]+)/gi,
      '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:#2563eb;text-decoration:underline;">$1</a>'
    );
    body = `<div style="white-space:pre-wrap;word-break:break-word;line-height:1.6;font-size:14px;">${linked}</div>`;
  }
  // Add loading="lazy" to img tags for performance in popup window
  if (body) {
    body = body.replace(/<img(?![^>]*loading=)[^>]*>/gi, (match) => {
      return match.replace(/<img/, '<img loading="lazy"');
    });
  }
  const subject = message.subject || tSync('activity.noSubject');
  const from = message.from || tSync('activity.unknownSender');

  // Build document using innerHTML and standard APIs instead of deprecated document.write()
  win.document.title = subject;

  const styleEl = win.document.createElement('style');
  styleEl.textContent =
    'body{font-family:system-ui;padding:24px;line-height:1.6}h1{font-size:18px}img{max-width:100%;height:auto}';
  win.document.head.appendChild(styleEl);

  const titleEl = win.document.createElement('h1');
  titleEl.textContent = subject;
  const fromEl = win.document.createElement('p');
  const fromLabel = win.document.createElement('b');
  fromLabel.textContent = `${tSync('activity.fromLabel')}:`;
  fromEl.append(fromLabel, ` ${from}`);
  const divider = win.document.createElement('hr');
  const bodyEl = win.document.createElement('div');
  bodyEl.innerHTML = body;
  win.document.body.replaceChildren(titleEl, fromEl, divider, bodyEl);

  return true;
}
