/**
 * check-hardcoded-english.ts
 *
 * Pre-commit / CI guard that stops hardcoded user-facing English from
 * regrowing in .svelte files. Flags:
 *
 *   1. Literal values in user-facing attributes (placeholder, aria-label,
 *      ariaLabel, title, label, alt) that don't use $t() / {…} / @-directives.
 *   2. toastStore.success/error/info/warning('…') calls with plain string
 *      literals instead of locale keys.
 *   3. window.prompt/confirm/alert('…') literals shown directly to users.
 *   4. `$t('…') || 'Literal fallback'` expressions — English fallbacks that
 *      show while a locale key is missing.
 *   5. Script-side object literals with user-facing properties
 *      (label/title/placeholder/description/ariaLabel/alt/hint/subtitle) whose
 *      values are plain English strings instead of $t() calls — e.g. dropdown
 *      option lists, DATE_PRESETS radio labels, notification configs.
 *      Identifier-like values (locale keys, config tokens such as
 *      "expiredSkip" or "keyboardShortcuts.fixedFocusSearch") are skipped.
 *   6. Visible text nodes — both single-line (<button>Save</button>) and
 *      multi-line (prose alone on its own line *between an open tag and its
 *      closing tag*, e.g. a button label spanning lines). Bare attributes,
 *      CSS class lists, identifiers, and HTML comment text on their own lines
 *      are not mistaken for text. Trailing prose punctuation (".!?%)…") is
 *      accepted so strings like "Auto-Delete Marketing/Promo (24h)" are
 *      caught.
 *
 * All checks are suppressed inside <script>/<style> blocks and HTML comments
 * except the ones that are *meant* to live in script (toast, prompt, $t
 * fallback, option-property literals).
 *
 * Intentional holds (brand names, keycaps, format badges, abbreviations,
 * search-pill syntax, shell commands, examples) are allowlisted below. Known
 * debt files can be listed in `.hardcoded-english-ignore` (one path per line)
 * — migrate those files and remove the entry so the whole repo stays green.
 *
 * Usage: bun scripts/check-hardcoded-english.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_DIR = join(process.cwd(), 'src');
const IGNORE_FILE = join(process.cwd(), '.hardcoded-english-ignore');

/** Trailing char class: alphanumerics plus common prose punctuation. */
const TEXT_END = 'A-Za-z0-9).!?%…';

/** User-facing attributes whose literal values should be localized. */
const ATTR_RE =
  /\b(placeholder|aria-label|ariaLabel|title|label|alt)\s*=\s*(?:"([^"]*)"|`([^`]*)`)/g;

/** toastStore.success('…') / .error('…') / .info('…') / .warning('…') literals. */
const TOAST_RE = /toastStore\.(?:success|error|info|warning)\(\s*(['"`])([^'"`]*)\1/g;

/** window.prompt/confirm/alert('…') literals — user-visible dialogs. */
const PROMPT_RE = /(?:window\.)?(?:prompt|confirm|alert)\(\s*(['"`])([^'"`]*)\1/g;

/** $t('…') || 'Literal fallback' — English shown while a locale key is missing. */
const T_FALLBACK_RE = /\$t\([^)]*\)\s*\|\|\s*(['"`])([^'"`]*)\1/g;

/**
 * Script-side (or inline template) object literals carrying user-facing text:
 * { label: 'Save' }, { title: 'Export' }, { description: '…' }, … These drive
 * dropdown options, radio labels, hints, and notification configs — all need
 * locale keys. Property values that are $t(...) calls, bindings, or
 * identifier-like tokens (locale keys, config constants) don't match.
 */
const OPTION_PROP_RE =
  /\b(label|title|placeholder|description|ariaLabel|alt|hint|subtitle)\s*:\s*(['"`])([^'"`]*)\2/g;

/** Visible text node on one line: >Text< where Text is 2+ ASCII chars. */
const TEXT_NODE_RE = new RegExp(`>([A-Za-z][A-Za-z0-9 ,'’\\-–…()+/]*[${TEXT_END}])<\\s*`, 'g');

/**
 * Multi-line text node: a line whose whole trimmed content is prose (no
 * markup, no braces, no quotes, no interpolation). Only treated as text when
 * it sits between an open tag (previous non-empty line ends with '>') and a
 * closing tag (next non-empty line starts with '<'), so bare attributes, class
 * lists, identifiers, and comment lines are never mistaken for user-facing
 * copy. Example:
 *
 *   <button …>
 *     Generate Random
 *   </button>
 */
const TEXT_LINE_RE = new RegExp(`^[A-Za-z][A-Za-z0-9 ,'’\\-–…()+/]*[${TEXT_END}]$`);

/** Exact-match allowlist for intentional single tokens. */
const ALLOWLIST = new Set([
  // Keycaps (never localized)
  'Esc',
  'Enter',
  'Escape',
  'Tab',
  'Shift',
  'Alt',
  'Ctrl',
  'Cmd',
  'Ctrl+K',
  'Delete',
  'Backspace',
  'Space',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  '⌘',
  // Format badges
  'JSON',
  'EML',
  'MBOX',
  'PDF',
  'CSV',
  'MD',
  // Abbreviations / brand fragments
  'QR',
  'OTP',
  'Autofill',
  'Autofill Form',
  'Mail',
  'Temp',
  'FAQs',
  'ID',
  // Fixed shortcut labels rendered as keys ("J"/"K" are single chars — never matched)
  'Ctrl + K / Cmd + K',
  'Ctrl + Shift + P',
  'Ctrl + A / Cmd + A',
  'Ctrl + Shift + S',
  'Ctrl + Shift + F',
  'Shift + Click',
  'Shift + Drag',
]);

/** Substrings that mark a value as intentionally non-prose (examples, syntax). */
function isIntentional(value: string): boolean {
  const v = value.trim();
  if (ALLOWLIST.has(v)) return true;
  if (/^(https?:\/\/|\/|www\.)/i.test(v)) return true; // URLs / paths
  if (/[{}]$/.test(v) || v.startsWith('{')) return true; // bound expressions
  if (/\$\{/.test(v) || /\$t\(/.test(v)) return true; // template / i18n calls
  if (/^@/.test(v)) return true; // svelte directives
  if (/(^|\s)(tag|domain|country|from|to|label|site|is):/i.test(v)) return true; // search-pill syntax
  if (/(\d{1,2})\s?(AM|PM)/i.test(v)) return true; // heatmap axis labels
  if (/\.(com|io|org|net|dev|app|ru|de)\b/i.test(v)) return true; // example domains
  if (/^Mozilla\/5\.0/i.test(v)) return true; // UA strings
  if (/^Chrome \(|^Custom User-Agent|^Default Browser|^User-Agent/i.test(v)) return true; // UA options
  if (/^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v)) return true; // email addresses
  if (/^(bunx|bun|npm|npx|pnpm|yarn|node|python|pip)\s+\S/.test(v)) return true; // shell commands
  return false;
}

function collectSvelteFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectSvelteFiles(full, out);
    } else if (entry.endsWith('.svelte')) {
      out.push(full);
    }
  }
}

function loadIgnoreList(): string[] {
  try {
    return readFileSync(IGNORE_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

const findings: string[] = [];

function report(file: string, lineNo: number, kind: string, value: string): void {
  findings.push(`${relative(process.cwd(), file)}:${lineNo}: ${kind}: ${value}`);
}

/** Index of the nearest non-empty line before/after `i` (or -1). */
function prevNonEmpty(lines: string[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (lines[j].trim()) return j;
  }
  return -1;
}

function nextNonEmpty(lines: string[], i: number): number {
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim()) return j;
  }
  return -1;
}

function scanFile(file: string): void {
  const lines = readFileSync(file, 'utf8').split('\n');
  // Region tracking: bare tokens inside <script>/<style>/comments are code or
  // docs, not visible text. Script-side checks (toast, prompt, $t fallback,
  // option properties) intentionally still run inside <script>.
  let inScript = false;
  let inStyle = false;
  let inComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opensScript = /<script\b/.test(line) && !/<\/script>/.test(line);
    const opensStyle = /<style\b/.test(line) && !/<\/style>/.test(line);
    const opensComment = /<!--/.test(line) && !/-->/.test(line);
    if (opensScript) inScript = true;
    if (opensStyle) inStyle = true;
    if (opensComment) inComment = true;

    // Checks that live in markup OR script (never inside styles/comments)
    const inMarkupOrScript = !inStyle && !inComment;
    if (inMarkupOrScript) {
      // Attribute literals (double-quoted and backtick forms)
      for (const m of line.matchAll(ATTR_RE)) {
        const value = (m[2] ?? m[3] ?? '').trim();
        if (!value || !/^[A-Za-z]/.test(value)) continue;
        if (isIntentional(value)) continue;
        report(file, i + 1, 'attribute', `${m[1]}="${value}"`);
      }

      // Script-side user-facing option/config string literals
      for (const m of line.matchAll(OPTION_PROP_RE)) {
        const value = m[3].trim();
        if (!value || !/^[A-Za-z]/.test(value) || isIntentional(value)) continue;
        // Skip identifier-like values: locale keys, config tokens, prop names.
        if (/^[a-z][a-zA-Z0-9.]*$/.test(value)) continue;
        report(file, i + 1, 'option', `${m[1]}: "${value}"`);
      }

      // Visible text nodes — skip control-flow / script-expression lines
      // and any region where a bare token is code, not copy.
      if (!inScript) {
        // Single-line text nodes
        if (/{@|{#|\{:/g.test(line)) continue;
        // Skip lines mixing script expressions with markup (unreliable heuristic)
        if (/\{.*\}[^>]*>[^<]*</.test(line)) continue;
        for (const m of line.matchAll(TEXT_NODE_RE)) {
          const value = m[1].trim();
          if (!value || value.length < 2 || isIntentional(value)) continue;
          report(file, i + 1, 'text', `>${value}<`);
        }

        // Multi-line text nodes: prose alone on its own line between an open
        // tag ('>') and a closing tag ('<'). Without this context, bare
        // attributes, class lists, and identifiers would be reported as text.
        const prev = prevNonEmpty(lines, i);
        const next = nextNonEmpty(lines, i);
        const betweenTags =
          prev >= 0 &&
          next >= 0 &&
          lines[prev].trimEnd().endsWith('>') &&
          /^\s*</.test(lines[next]);
        if (betweenTags) {
          const trimmed = line.trim();
          if (trimmed.length >= 2 && trimmed.length <= 120 && TEXT_LINE_RE.test(trimmed)) {
            if (/[a-z][A-Z]/.test(trimmed)) continue; // camelCase identifier
            if (isIntentional(trimmed)) continue;
            report(file, i + 1, 'text', `>${trimmed}<`);
          }
        }
      }
    }

    // Script-only checks — intended to live inside <script> blocks.
    if (inScript) {
      // toastStore literals
      for (const m of line.matchAll(TOAST_RE)) {
        const value = m[2].trim();
        if (!value || !/^[A-Za-z]/.test(value) || isIntentional(value)) continue;
        report(file, i + 1, 'toast', `toastStore.*("${value}")`);
      }

      // prompt/confirm/alert literals
      for (const m of line.matchAll(PROMPT_RE)) {
        const value = m[2].trim();
        if (!value || !/^[A-Za-z]/.test(value) || isIntentional(value)) continue;
        report(file, i + 1, 'prompt', m[0].replace(/\s+/g, ' '));
      }

      // $t('…') || 'Literal fallback' expressions
      for (const m of line.matchAll(T_FALLBACK_RE)) {
        const value = m[2].trim();
        if (!value || !/^[A-Za-z]/.test(value) || isIntentional(value)) continue;
        report(file, i + 1, 'fallback', `$t(...) || "${value}"`);
      }
    }

    if (/<\/script>/.test(line)) inScript = false;
    if (/<\/style>/.test(line)) inStyle = false;
    if (/-->/.test(line)) inComment = false;
  }
}

function main(): void {
  const ignored = new Set(loadIgnoreList().map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')));
  const files: string[] = [];
  collectSvelteFiles(SRC_DIR, files);

  for (const file of files) {
    const rel = relative(process.cwd(), file).replace(/\\/g, '/');
    if (ignored.has(rel) || ignored.has(file.replace(/\\/g, '/'))) continue;
    scanFile(file);
  }

  if (findings.length > 0) {
    console.error(`Hardcoded user-facing English detected (${findings.length}):`);
    for (const f of findings) console.error(`  ${f}`);
    console.error('\nLocalize with locale keys ($t) or add the file to .hardcoded-english-ignore.');
    process.exit(1);
  }
  console.log('No hardcoded user-facing English found in .svelte files.');
}

main();
