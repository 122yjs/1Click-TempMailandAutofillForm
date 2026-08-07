/**
 * Centralized HTML sanitization using DOMPurify.
 * Lazily loads DOMPurify on first use and caches the instance.
 */

import { browser } from 'wxt/browser';

let _dompurify: typeof import('dompurify')['default'] | null = null;
let _loading: Promise<void> | null = null;

/**
 * Dark-mode neutralization for email bodies: when the extension theme is dark,
 * emails that hardcode light backgrounds (white / very-light fills) become
 * invisible text-on-white blocks. This pass rewrites, at sanitize time:
 *   • light `background` / `background-color` values  → `transparent`
 *   • dark `color` values                           → `inherit` (theme on-surface)
 *   • light `bgcolor` attributes (table/td)         → removed
 *   • dark `<font color>` attributes                → removed (inherit)
 * Layout-affecting properties (padding, width, margins, display, …) are never
 * touched, and light text / dark backgrounds are left alone. Colors are
 * detected by luminance (hex, rgb()/rgba(), hsl()/hsla(), common named colors).
 */
const LIGHT_BG_LUMINANCE_THRESHOLD = 0.78;
const DARK_TEXT_LUMINANCE_THRESHOLD = 0.2;

/** Common named CSS colors used for email backgrounds/text (RGB values). */
const NAMED_CSS_COLORS: Record<string, [number, number, number]> = {
  white: [255, 255, 255],
  black: [0, 0, 0],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  lightgray: [211, 211, 211],
  lightgrey: [211, 211, 211],
  darkgray: [169, 169, 169],
  darkgrey: [169, 169, 169],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  gainsboro: [220, 220, 220],
  whitesmoke: [245, 245, 245],
  snow: [255, 250, 250],
  floralwhite: [255, 250, 240],
  ivory: [255, 255, 240],
  beige: [245, 245, 220],
  cornsilk: [255, 248, 220],
  linen: [250, 240, 230],
  honeydew: [240, 255, 240],
  mintcream: [245, 255, 250],
  lavender: [230, 230, 250],
  lavenderblush: [255, 240, 245],
  ghostwhite: [248, 248, 255],
  aliceblue: [240, 248, 255],
  azure: [240, 255, 255],
  seashell: [255, 245, 238],
  oldlace: [253, 245, 230],
  antiquewhite: [250, 235, 215],
  mistyrose: [255, 228, 225],
  peachpuff: [255, 218, 185],
  moccasin: [255, 228, 181],
  papayawhip: [255, 239, 213],
  lightyellow: [255, 255, 224],
  lightgoldenrodyellow: [250, 250, 210],
  lightcyan: [224, 255, 255],
  paleturquoise: [175, 238, 238],
  lightblue: [173, 216, 230],
  lightsteelblue: [176, 196, 222],
  powderblue: [176, 224, 230],
  thistle: [216, 191, 216],
  plum: [221, 160, 221],
  orchid: [218, 112, 214],
  pink: [255, 192, 203],
  lightpink: [255, 182, 193],
  gold: [255, 215, 0],
  khaki: [240, 230, 140],
  palegoldenrod: [238, 232, 170],
};

function clampChannel(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hPrime = ((((h % 360) + 360) % 360) / 60) % 6;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hPrime < 1) [r, g, b] = [c, x, 0];
  else if (hPrime < 2) [r, g, b] = [x, c, 0];
  else if (hPrime < 3) [r, g, b] = [0, c, x];
  else if (hPrime < 4) [r, g, b] = [0, x, c];
  else if (hPrime < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [clampChannel((r + m) * 255), clampChannel((g + m) * 255), clampChannel((b + m) * 255)];
}

/** Parse a tolerant CSS color → [r,g,b] or null (for layout-safe comparison). */
function parseCssColor(value: string): [number, number, number] | null {
  const v = value.trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'currentcolor' || v === 'inherit' || v === 'none') {
    return null;
  }
  // #rgb / #rgba / #rrggbb / #rrggbbaa
  let m = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }
  // rgb()/rgba() — tolerates comma or space syntax
  m = v.match(/^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/);
  if (m)
    return [clampChannel(Number(m[1])), clampChannel(Number(m[2])), clampChannel(Number(m[3]))];
  m = v.match(/^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/);
  if (m) return hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
  if (NAMED_CSS_COLORS[v]) return NAMED_CSS_COLORS[v];
  return null;
}

function colorLuminance(rgb: [number, number, number]): number {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

function isLightColor(value: string): boolean {
  const rgb = parseCssColor(value);
  return rgb !== null && colorLuminance(rgb) >= LIGHT_BG_LUMINANCE_THRESHOLD;
}

function isDarkColor(value: string): boolean {
  const rgb = parseCssColor(value);
  return rgb !== null && colorLuminance(rgb) <= DARK_TEXT_LUMINANCE_THRESHOLD;
}

/** Rewrite a `background`/`background-color` value: single color or a shorthand
 * whose leading token is a light color → `transparent` (layout/url kept). */
function neutralizeBackgroundValue(value: string): string {
  const v = value.trim();
  if (!v) return v;
  if (parseCssColor(v) !== null) return isLightColor(v) ? 'transparent' : v;
  const m = v.match(/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)\b(.*)$/);
  if (m && isLightColor(m[1])) {
    const rest = m[2].trim();
    return rest ? `transparent ${rest}` : 'transparent';
  }
  return v;
}

/** When dark mode is active, neutralize hardcoded light backgrounds / dark text
 * on a single element so email content stays readable on the dark surface. */
function neutralizeLightStyle(node: Element): void {
  try {
    // Old-school <table>/<td bgcolor="#ffffff"> — drop the fill (transparent).
    if (node.hasAttribute('bgcolor') && isLightColor(node.getAttribute('bgcolor') || '')) {
      node.removeAttribute('bgcolor');
    }
    // <font color="#000000"> — remove so text inherits the theme's color.
    if (node.tagName === 'FONT' && node.hasAttribute('color')) {
      const c = node.getAttribute('color') || '';
      const rgb = parseCssColor(c);
      if (rgb !== null && colorLuminance(rgb) <= DARK_TEXT_LUMINANCE_THRESHOLD) {
        node.removeAttribute('color');
      }
    }
    if (!node.hasAttribute('style')) return;
    const styleStr = node.getAttribute('style') || '';
    let out = '';
    let cursor = 0;
    let rewritten = false;
    const declRe = /([a-zA-Z-]+)\s*:\s*([^;]+);?/g;
    let m: RegExpExecArray | null;
    for (;;) {
      m = declRe.exec(styleStr);
      if (!m) break;
      const prop = m[1].trim().toLowerCase();
      const value = m[2].trim();
      out += styleStr.slice(cursor, m.index);
      if (prop === 'background' || prop === 'background-color') {
        const next = neutralizeBackgroundValue(value);
        if (next !== value) rewritten = true;
        out += `${m[1].trim()}: ${next};`;
      } else if (prop === 'color') {
        const next = isDarkColor(value) ? 'inherit' : value;
        if (next !== value) rewritten = true;
        out += `${m[1].trim()}: ${next};`;
      } else {
        out += m[0];
      }
      cursor = m.index + m[0].length;
    }
    out += styleStr.slice(cursor);
    if (rewritten) node.setAttribute('style', out);
  } catch {
    /* ignore */
  }
}

/** Set while sanitizing with `darkMode: true` so the shared DOMPurify hook can
 * neutralize hardcoded light colors (the hook is registered once globally). */
let activeDarkMode = false;

/**
 * CSS properties that let an email overlay or hijack the whole extension UI
 * (fixed-position phishing layers, full-viewport sheets, click-stealing).
 * Removed from every inline `style` attribute during sanitization.
 */
const FORBIDDEN_CSS_PROPS = [
  'position',
  'z-index',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'visibility',
  'pointer-events',
  'cursor',
  'opacity',
  'transform',
  'animation',
  'transition',
  'filter',
  'backdrop-filter',
  'clip',
  'clip-path',
];

/**
 * Document-level tags that must never survive into the email body. A <style> or
 * <link rel="stylesheet"> from an email would apply GLOBALLY to the extension
 * (restyling or hiding the whole app), and <meta>/<base>/<html>/<head>/<body>
 * wrappers leak document structure into the rendered fragment.
 *
 * Note: when `allowStyleBlocks` is on, <style> blocks are extracted and
 * sanitized BEFORE this regex runs (see sanitizeStyleBlockCss), so the regex
 * only ever sees (and strips) residual/unclosed <style> tags.
 */
const DOC_LEVEL_TAG_RE =
  /<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)\s*>|<!DOCTYPE[^>]*>|<\/?style\b[^>]*>|<\/?script\b[^>]*>|<\/?link\b[^>]*>|<\/?meta\b[^>]*>|<\/?base\b[^>]*>|<\/?title\b[^>]*>|<\/?html\b[^>]*>|<\/?body\b[^>]*>|<head\b[^>]*>[\s\S]*?<\/head\s*>|<\/?head\b[^>]*>/gi;

// ============================================================================
// SAFE SUBSET OF EMAIL <style> BLOCKS
// ============================================================================
// Email bodies are rendered inside an OPEN SHADOW DOM (EmailBody.svelte), so a
// <style> element injected into the shadow root is scoped to that shadow tree:
// its rules can never restyle/hide the extension UI. That makes a sanitized
// <style> block safe to render — BUT only in the shadow-DOM path (MailView).
// Light-DOM consumers (message window, print) keep stripping style blocks.
//
// The CSS itself is still filtered (fail-closed): only layout/content rules
// survive. Everything that could (a) load external resources (tracking pixels,
// exfiltration), (b) overlay/hijack clicks, (c) tamper with the app or cascade,
// or (d) target the shadow host is removed.

/** At-rules that are dropped wholesale (external loads, animation, cascade). */
const FORBIDDEN_STYLE_AT_RULES =
  /^(?:import|charset|namespace|font-face|keyframes|page|layer|property|container|starting-style|document)/i;

/** At-rules whose inner rules ARE kept (responsive layout + feature queries). */
const KEPT_STYLE_AT_RULES = /^(?:media|supports)\b/i;

/** Selectors that target the shadow host or the document root — dropped. */
const FORBIDDEN_STYLE_SELECTOR_RE =
  /(?:^|[\s>+~,:])(?::host(?:-context)?|:root)\b|expression\s*\(/i;

/** Strip `/* ... *\/` comments so they can't hide forbidden constructs. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Index of the first top-level `{` (outside quotes) — for finding rule bodies. */
function findRuleOpenBrace(css: string, from: number): number {
  let inStr: string | null = null;
  for (let i = from; i < css.length; i++) {
    const c = css[i];
    if (inStr) {
      if (c === inStr && css[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '{') return i;
  }
  return -1;
}

/** Index of the `}` matching the `{` at `openIdx` (brace-depth aware). */
function findRuleCloseBrace(css: string, openIdx: number): number {
  let depth = 1;
  let inStr: string | null = null;
  for (let i = openIdx + 1; i < css.length; i++) {
    const c = css[i];
    if (inStr) {
      if (c === inStr && css[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split declarations on `;` outside quotes. */
function splitDeclarations(block: string): string[] {
  const out: string[] = [];
  let inStr: string | null = null;
  let cur = '';
  for (let i = 0; i < block.length; i++) {
    const c = block[i];
    if (inStr) {
      cur += c;
      if (c === inStr && block[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      cur += c;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Normalize a CSS property name: lowercase, strip vendor prefixes. */
function normalizeCssProperty(prop: string): string {
  return prop
    .trim()
    .toLowerCase()
    .replace(/^-(?:webkit|moz|ms|o)-/, '');
}

/**
 * Sanitize a single `prop: value` declaration. Returns the sanitized
 * declaration (with original casing) or '' when it must be dropped.
 * When `darkMode` is set, hardcoded light backgrounds → `transparent` and dark
 * text → `inherit`, matching the inline-style neutralization pass so style
 * blocks behave identically to inline styles on dark themes.
 */
function sanitizeStyleDeclaration(decl: string, darkMode = false): string {
  const d = decl.trim();
  if (!d) return '';
  // External resource loads / scripting / imports — always dropped. url() would
  // let a CSS rule fire a request to an attacker's server (tracking pixel,
  // exfiltration) even when <img> rendering is disabled.
  if (/url\s*\(|expression\s*\(|behavior\s*:|@import/i.test(d)) return '';
  const colon = d.indexOf(':');
  if (colon <= 0) return '';
  const prop = d.slice(0, colon).trim();
  const value = d.slice(colon + 1).trim();
  if (!prop || !value) return '';
  // Custom properties can smuggle any value into later rules — drop them.
  if (prop.startsWith('--')) return '';
  const norm = normalizeCssProperty(prop);
  if (FORBIDDEN_CSS_PROPS.includes(norm)) return '';
  if (darkMode && (norm === 'background' || norm === 'background-color' || norm === 'color')) {
    if (norm === 'color') {
      const next = isDarkColor(value) ? 'inherit' : value;
      if (next !== value) return `${prop}: ${next}`;
    } else {
      const next = neutralizeBackgroundValue(value);
      if (next !== value) return `${prop}: ${next}`;
    }
  }
  return `${prop}: ${value}`;
}

/**
 * Sanitize a CSS rule body (`selector { declarations }`) — keeps layout/content
 * declarations only, and drops rules that target the shadow host / root.
 */
function sanitizeStyleRule(selector: string, decls: string, darkMode = false): string {
  const sel = selector.trim();
  if (!sel) return '';
  if (FORBIDDEN_STYLE_SELECTOR_RE.test(sel)) return '';
  const kept = splitDeclarations(decls)
    .map((d) => sanitizeStyleDeclaration(d, darkMode))
    .filter(Boolean);
  if (kept.length === 0) return '';
  return `${sel} { ${kept.join('; ')}; }`;
}

/**
 * Sanitize the CSS text inside an email <style> block into a safe subset:
 *
 *   KEPT      — @media rules + plain rules with layout/content declarations
 *   STRIPPED  — @import/@font-face/@keyframes/@page/@layer/etc., url(),
 *               expression(), behavior:, custom properties, overlay/hijack
 *               properties (position, z-index, transform, opacity, …), and
 *               :host / :root selectors.
 *
 * `darkMode` additionally neutralizes hardcoded light backgrounds / dark text
 * (same luminance rules as inline styles) so style-block colors don't paint
 * white boxes on dark themes.
 *
 * Fail-closed: unparseable input yields no rules. Returns '' when nothing
 * survives (callers then drop the <style> block entirely).
 */
export function sanitizeStyleBlockCss(css: string, options?: { darkMode?: boolean }): string {
  if (!css?.trim()) return '';
  const darkMode = options?.darkMode === true;
  const clean = stripCssComments(css);
  const out: string[] = [];
  let pos = 0;
  const len = clean.length;

  while (pos < len) {
    while (pos < len && /\s|;/.test(clean[pos])) pos += 1;
    if (pos >= len) break;

    if (clean[pos] === '@') {
      const at = /^@([a-zA-Z-]+)/.exec(clean.slice(pos))?.[1] || '';
      const open = findRuleOpenBrace(clean, pos);
      if (FORBIDDEN_STYLE_AT_RULES.test(at)) {
        // Drop the at-rule entirely. Statement-style at-rules (@import
        // url(...);) end at the next ';' — block-style ones (e.g. @font-face)
        // end at their matching close brace.
        if (open === -1) {
          const semi = clean.indexOf(';', pos);
          if (semi === -1) break;
          pos = semi + 1;
        } else {
          const close = findRuleCloseBrace(clean, open);
          if (close === -1) break;
          pos = close + 1;
        }
      } else if (KEPT_STYLE_AT_RULES.test(at)) {
        if (open === -1) break;
        const close = findRuleCloseBrace(clean, open);
        if (close === -1) break;
        const prelude = clean.slice(pos, open).trim();
        const inner = sanitizeStyleBlockCss(clean.slice(open + 1, close), { darkMode });
        if (inner) out.push(`${prelude} { ${inner} }`);
        pos = close + 1;
      } else {
        // Unknown at-rule: fail-closed, drop it.
        if (open === -1) {
          const semi = clean.indexOf(';', pos);
          if (semi === -1) break;
          pos = semi + 1;
        } else {
          const close = findRuleCloseBrace(clean, open);
          if (close === -1) break;
          pos = close + 1;
        }
      }
      continue;
    }

    // Plain rule: selector { declarations }
    const open = findRuleOpenBrace(clean, pos);
    if (open === -1) break;
    const close = findRuleCloseBrace(clean, open);
    if (close === -1) break;
    const selector = clean.slice(pos, open);
    const decls = clean.slice(open + 1, close);
    const safe = sanitizeStyleRule(selector, decls, darkMode);
    if (safe) out.push(safe);
    pos = close + 1;
  }

  return out.join('\n');
}

/**
 * Escape `</style` sequences inside sanitized CSS so the browser's HTML parser
 * can never terminate the injected <style> element early. A `</style` inside a
 * CSS string value (e.g. `content: "</style>"`) would otherwise close the tag
 * mid-block and let the remaining text parse as RAW UNSANITIZED HTML inside the
 * shadow root. `\/` is a valid CSS escape for `/` (inside strings it resolves
 * to `/`), so replacing `</style` → `<\/style` is CSS-semantics-preserving.
 */
function escapeStyleElementText(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

export function escapeHtmlText(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m] || m
  );
}

/**
 * Resolve a Window for DOMPurify factory init.
 * Browser: use real window. Node tests: JSDOM via createRequire (hidden from Vite
 * so the browser bundle never pulls in node:module).
 */
async function resolveDomWindow(): Promise<Window | null> {
  if (typeof window !== 'undefined' && window.document) {
    return window;
  }
  // Node / bun test only - @vite-ignore keeps this out of the extension graph
  const isNode =
    typeof process !== 'undefined' &&
    typeof (process as { versions?: { node?: string } }).versions?.node === 'string';
  if (!isNode) return null;
  try {
    const nodeModule = await import(/* @vite-ignore */ 'node:module');
    const requireFn = nodeModule.createRequire(import.meta.url);
    const { JSDOM } = requireFn('jsdom') as {
      JSDOM: new (html: string) => { window: Window };
    };
    return new JSDOM('').window;
  } catch {
    /* ignore */
    return null;
  }
}

async function ensureLoaded(): Promise<void> {
  if (_dompurify) return;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const m = await import('dompurify');
      let purify = m.default;
      // Factory build needs a Window; UMD/default may already expose .sanitize
      if (typeof purify === 'function' && !purify.sanitize) {
        const win = await resolveDomWindow();
        if (!win) {
          // No DOM (e.g. service worker) - strip-tags fallback in sanitizeHtml
          return;
        }
        // DOMPurify's WindowLike is a Pick of globalThis - cast is safe for real Window / JSDOM
        purify = purify(win as unknown as import('dompurify').WindowLike);
      }
      _dompurify = purify;
      _dompurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName === 'A') {
          node.setAttribute('rel', 'noopener noreferrer');
          node.setAttribute('target', '_blank');
        }
        // Layout-safety: strip overlay / click-hijack CSS from inline styles so
        // an email can never paint over the extension UI or intercept clicks.
        if (
          node.hasAttribute('style') &&
          typeof (node as HTMLElement).style?.removeProperty === 'function'
        ) {
          try {
            const elStyle = (node as HTMLElement).style;
            for (const prop of FORBIDDEN_CSS_PROPS) {
              if (elStyle.getPropertyValue(prop)) elStyle.removeProperty(prop);
            }
          } catch {
            /* ignore */
          }
        }
        // Dark-mode pass: neutralize hardcoded light backgrounds / dark text
        // (gated by the sanitizeHtml({ darkMode }) option).
        if (activeDarkMode) neutralizeLightStyle(node);
        if (node.tagName === 'IMG') {
          const src = node.getAttribute('src') || '';
          const w = (node.getAttribute('width') || '').trim();
          const h = (node.getAttribute('height') || '').trim();
          const style = (node.getAttribute('style') || '').toLowerCase().replace(/\s/g, '');

          const isZeroSize =
            w === '0' ||
            w === '1' ||
            w === '0px' ||
            w === '1px' ||
            h === '0' ||
            h === '1' ||
            h === '0px' ||
            h === '1px';

          const isHiddenStyle =
            style.includes('display:none') ||
            style.includes('visibility:hidden') ||
            style.includes('opacity:0') ||
            style.includes('width:0') ||
            style.includes('width:1px') ||
            style.includes('height:0') ||
            style.includes('height:1px');

          const isTrackingUrl =
            /(\/pixel|\/track|\/beacon|\/open\.php|\/t\.gif|pixel\.png|pixel\.gif|open\.gif|tracking)/i.test(
              src
            );

          if (isZeroSize || isHiddenStyle || (isTrackingUrl && (isZeroSize || isHiddenStyle))) {
            node.setAttribute(
              'src',
              'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
            );
            node.setAttribute('data-blocked-tracker', 'true');
            node.setAttribute('width', '1');
            node.setAttribute('height', '1');
          }
        }
      });
    } catch {
      /* ignore */
      _dompurify = null;
    }
  })();
  return _loading;
}

/**
 * Sanitize HTML to prevent XSS. Returns sanitized HTML string.
 * If DOMPurify hasn't loaded yet, falls back to stripping all tags (safe).
 * Call `await initSanitize()` on component mount to preload.
 */
export function sanitizeHtml(
  html: string,
  options?: { allowImages?: boolean; darkMode?: boolean; allowStyleBlocks?: boolean }
): string {
  if (!html) return '';

  const allowImages =
    options?.allowImages === true
      ? true
      : options?.allowImages === false
        ? false
        : cachedHtmlSettings.img !== false;

  // Style blocks are only safe when the output lands in the email's OPEN
  // SHADOW DOM (EmailBody) — there they are scoped to the shadow tree and can
  // never restyle the app. Light-DOM consumers (message window, print) must
  // NOT pass this flag. The CSS inside the blocks is still filtered through
  // sanitizeStyleBlockCss (fail-closed). Also respects the user's "styles"
  // rendering toggle — disabling inline styles disables style blocks too.
  const allowStyleBlocks = options?.allowStyleBlocks === true && cachedHtmlSettings.style !== false;

  // Unblock Guerrilla Mail proxy image resources (res.php) by decoding the original URLs from the 'q' parameter.
  // Handles both standard double/single quotes and HTML-encoded &quot; quotes.
  let unblockedHtml = html;

  // Match "/res.php?r=1&amp;n=img&amp;q=..." or "/res.php?r=1&n=img&q=..."
  const proxyRegex =
    /("|&quot;|')(?:\/|https?:\/\/(?:www\.)?guerrillamail(?:block)?\.(?:com|info|biz|de|net|org|la)\/)?res\.php\?r=1&amp;n=[a-z]{1,20}&amp;q=([^"'\s&]{1,2000})(?:&amp;[^"'\s>]{0,1000}?)?\1/gi;
  unblockedHtml = unblockedHtml.replace(proxyRegex, (match, quote, encodedUrl) => {
    try {
      const decodedUrl = decodeURIComponent(encodedUrl);
      return `${quote}${decodedUrl}${quote}`;
    } catch {
      /* ignore */
      return match;
    }
  });

  // Second pass regex for cases where the URL params might have different encoding or structure (e.g. using standard & instead of &amp;)
  const proxyRegexRawAmp =
    /("|&quot;|')(?:\/|https?:\/\/(?:www\.)?guerrillamail(?:block)?\.(?:com|info|biz|de|net|org|la)\/)?res\.php\?r=1&n=[a-z]{1,20}&q=([^"'\s&]{1,2000})(?:&[^"'\s>]{0,1000}?)?\1/gi;
  unblockedHtml = unblockedHtml.replace(proxyRegexRawAmp, (match, quote, encodedUrl) => {
    try {
      const decodedUrl = decodeURIComponent(encodedUrl);
      return `${quote}${decodedUrl}${quote}`;
    } catch {
      /* ignore */
      return match;
    }
  });

  if (!_dompurify && typeof window !== 'undefined') {
    initSanitize();
  }

  // Detect and decode HTML-entity encoded HTML (e.g. &lt;div style="..."&gt;)
  if (
    unblockedHtml &&
    (unblockedHtml.includes('&lt;') || unblockedHtml.includes('&gt;')) &&
    !unblockedHtml.includes('<')
  ) {
    unblockedHtml = unblockedHtml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  // When style blocks are allowed, extract them BEFORE the doc-level regex
  // runs (which would otherwise eat them along with <head>). Sanitize each
  // block's CSS to the safe subset and remember it for re-injection.
  const darkMode = options?.darkMode === true;
  let safeStyleBlocks = '';
  if (allowStyleBlocks) {
    unblockedHtml = unblockedHtml.replace(
      /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
      (_match, cssText: string) => {
        const safeCss = sanitizeStyleBlockCss(cssText, { darkMode });
        if (safeCss) {
          // escapeStyleElementText prevents a `</style` inside a CSS string
          // from closing the tag early and leaking raw HTML into the shadow
          // root (the re-injected block bypasses DOMPurify by construction).
          safeStyleBlocks += `\n<style>${escapeStyleElementText(safeCss)}</style>`;
        }
        return '';
      }
    );
  }

  // Strip document-level CSS/metadata tags (contents included) AFTER entity
  // decoding so neither raw nor encoded <style>/<link> can inject global CSS.
  unblockedHtml = unblockedHtml.replace(DOC_LEVEL_TAG_RE, '');

  if (!_dompurify) {
    return unblockedHtml.replace(/<[^>]*>/g, '') + safeStyleBlocks;
  }

  const baseAllowed = [
    'a',
    'b',
    'br',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    ...(allowImages ? ['img'] : []),
    'li',
    'ol',
    'p',
    'span',
    'strong',
    ...(cachedHtmlSettings.table !== false
      ? ['table', 'tbody', 'td', 'th', 'thead', 'tr', 'tfoot', 'colgroup', 'col', 'caption']
      : []),
    'ul',
    'pre',
    'code',
    'blockquote',
    'u',
    'i',
    's',
    'strike',
    'del',
    'ins',
    'sub',
    'sup',
    'small',
    'mark',
    'center',
    'font',
    'section',
    'article',
    'header',
    'footer',
    'main',
    'figure',
    'figcaption',
    'picture',
    'source',
    'dl',
    'dt',
    'dd',
    'details',
    'summary',
    ...(cachedHtmlSettings.svg ? ['svg', 'path', 'g', 'circle', 'rect'] : []),
    ...(cachedHtmlSettings.audio ? ['audio', 'source'] : []),
    ...(cachedHtmlSettings.video ? ['video', 'source'] : []),
    ...(cachedHtmlSettings.iframe ? ['iframe'] : []),
    ...(cachedHtmlSettings.object ? ['object', 'embed', 'param'] : []),
    ...(cachedHtmlSettings.form ? ['form', 'input', 'button', 'select', 'textarea', 'label'] : []),
  ];

  activeDarkMode = options?.darkMode === true;
  try {
    const sanitized = _dompurify.sanitize(unblockedHtml, {
      ALLOWED_TAGS: baseAllowed,
      ALLOWED_ATTR: [
        ...(cachedHtmlSettings.style !== false ? ['style'] : []),
        'href',
        'src',
        'srcset',
        'alt',
        'title',
        'width',
        'height',
        'target',
        'rel',
        'colspan',
        'rowspan',
        'align',
        'valign',
        'cellpadding',
        'cellspacing',
        'bgcolor',
        'background',
        'color',
        'face',
        'size',
        'border',
        'role',
        'dir',
        'lang',
        'aria-hidden',
        'aria-label',
        'type',
        'media',
      ],
      // SECURITY: Allow only image/font data URIs and cid/http/https/mailto schemes
      ALLOWED_URI_REGEXP: /^(?:https?|mailto|cid|data:image\/|data:font\/)/i,
      // Enable CSS sanitization so inline style attributes work safely without XSS.
      // <style> elements are never allowed — their rules would apply globally.
      FORCE_BODY: false,
    });
    // Re-inject sanitized (safe-subset) <style> blocks when requested. Only the
    // shadow-DOM rendering path (EmailBody) passes allowStyleBlocks, so these
    // rules stay scoped to the email's shadow tree.
    return sanitized + safeStyleBlocks;
  } finally {
    activeDarkMode = false;
  }
}

export interface HtmlRenderingSettings {
  img: boolean;
  style: boolean;
  table: boolean;
  svg: boolean;
  audio: boolean;
  video: boolean;
  iframe: boolean;
  object: boolean;
  form: boolean;
  [tag: string]: boolean | undefined;
}

export const DEFAULT_HTML_RENDERING_SETTINGS: HtmlRenderingSettings = {
  img: false,
  // Inline style attributes. When enabled, sanitized (safe-subset) <style>
  // blocks are also kept for shadow-DOM renderers; when disabled, both go.
  style: true,
  table: true,
  svg: true,
  audio: false,
  video: false,
  iframe: false,
  object: false,
  form: false,
};

let cachedHtmlSettings: HtmlRenderingSettings = { ...DEFAULT_HTML_RENDERING_SETTINGS };

export async function loadHtmlRenderingSettings(): Promise<HtmlRenderingSettings> {
  try {
    const res = (await browser.storage.local.get(['htmlRenderingSettings'])) as {
      htmlRenderingSettings?: Partial<HtmlRenderingSettings>;
    };
    if (res.htmlRenderingSettings) {
      cachedHtmlSettings = { ...DEFAULT_HTML_RENDERING_SETTINGS, ...res.htmlRenderingSettings };
    }
  } catch {
    /* ignore */
  }
  return cachedHtmlSettings;
}

export async function saveHtmlRenderingSettings(
  settings: HtmlRenderingSettings
): Promise<HtmlRenderingSettings> {
  cachedHtmlSettings = { ...settings };
  try {
    await browser.storage.local.set({ htmlRenderingSettings: settings });
  } catch {
    /* ignore */
  }
  return cachedHtmlSettings;
}

/**
 * Initialize DOMPurify loading. Call in onMount or at startup.
 * Subsequent calls are no-ops.
 */
export async function initSanitize(): Promise<void> {
  await ensureLoaded();
  await loadHtmlRenderingSettings();
}

/**
 * Extract safe plain text from an HTML string.
 * Uses DOMParser (DOM-backed) instead of regex tag stripping to avoid
 * producing executable text from <script> bodies or similar injections.
 * Falls back gracefully if DOMParser is unavailable (e.g. in service workers).
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  try {
    if (typeof DOMParser !== 'undefined') {
      return new DOMParser().parseFromString(html, 'text/html').body.textContent || '';
    }
  } catch {
    // DOMParser not available (e.g. background service worker)
  }
  // Fallback: strip tags with regex (safe enough when DOMParser is absent)
  // Strip <script> and <style> blocks completely before stripping other tags
  const noScripts = html.replace(/<(script|style)[\s\S]*?(?:<\/\1>|$)/gi, '');
  return noScripts.replace(/<[^>]*(?:>|$)/g, '');
}
