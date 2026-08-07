<script lang="ts">
import { tick } from 'svelte';

/**
 * EmailBody — renders already-sanitized email HTML inside an OPEN Shadow DOM
 * root. This is the belt-and-braces second layer on top of `sanitize-html`
 * (which remains the security boundary: scripts, event attributes, style/link
 * tags and forbidden CSS props are stripped there).
 *
 * WHY SHADOW DOM
 *  - TOTAL style isolation: app/Tailwind CSS can never leak INTO the email
 *    content (no more `.email-body h1` descendant selectors competing with
 *    global utilities), and whatever styling an email carries can never leak
 *    OUT and restyle the extension UI.
 *  - CSS custom properties DO inherit across the boundary, so `--md-primary`,
 *    `--md-on-surface`, etc. keep working and the email follows the theme and
 *    dark mode for free. Inherited properties (font, color, line-height,
 *    direction) flow through too.
 *
 * TRADE-OFFS (documented)
 *  + Containment is absolute — no selector can cross the boundary in either
 *    direction, so email markup can never hide/shift/recolor the app.
 *  − Events inside the shadow are "composed" (they bubble up), but a document
 *    listener calling `target.closest()` cannot see past the boundary — code
 *    that needs to match elements inside the email must walk the shadow chain
 *    (getRootNode() → ShadowRoot.host). The global contextmenu lock in
 *    AppLayout was updated to do exactly that.
 *  − Content is inserted via shadowRoot fragments (bypassing Svelte {@html}),
 *    so the component must re-sync when the `html` prop changes — handled by
 *    the $effect below.
 *  − Browser find-in-page matches open shadow roots in modern Chrome/Firefox/
 *    Safari, but very old engines may skip the content.
 *  − Screen readers expose open shadow DOM fine, but assistive-tech bugs on
 *    legacy stacks are possible — the sanitizer stays the security boundary.
 *  − `user-select: none` rules from the light-DOM stylesheet no longer reach
 *    email tables — table text inside emails becomes selectable (desirable
 *    for copying), and the host keeps `data-selectable-text` so the global
 *    "allow native context menu" exception still matches.
 */

interface Props {
  /** Sanitized HTML to render (must NOT be passed raw/unsanitized input). */
  html?: string;
}

let { html = '' }: Props = $props();

let host: HTMLDivElement | null = $state(null);
let shadow: ShadowRoot | null = null;
let styleEl: HTMLStyleElement | null = null;
let lastHtml: string | null = null;

/** Email-body typography — lives INSIDE the shadow root so it can never
 * affect (or be affected by) the rest of the app. */
const EMAIL_BODY_CSS = `
:host {
  display: block;
  line-height: 1.55;
  word-break: break-word;
  overflow-wrap: anywhere;
  font-size: 0.875rem;
}
h1, h2, h3, h4, h5, h6 {
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-top: 1rem;
  margin-bottom: 0.5rem;
}
h1 { font-size: 1.5rem; }
h2 { font-size: 1.25rem; }
h3 { font-size: 1.125rem; }
h4 { font-size: 1rem; }
p { margin: 0 0 0.75rem 0; }
ul, ol { margin: 0 0 0.75rem 0; padding-inline-start: 1.5rem; }
li { margin: 0.15rem 0; }
img {
  max-width: 100%;
  height: auto;
  object-fit: contain;
  display: inline-block;
  border-radius: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
table { max-width: 100%; border-collapse: collapse; }
td, th { word-break: normal; }
a {
  color: var(--md-primary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.8125rem;
  background: color-mix(in srgb, var(--md-on-surface) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--md-outline-variant) 30%, transparent);
  border-radius: 8px;
  padding: 0.75rem;
  overflow-x: auto;
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.8125rem;
  background: color-mix(in srgb, var(--md-on-surface) 4%, transparent);
  padding: 0.1rem 0.3rem;
  border-radius: 4px;
  color: var(--md-on-surface);
}
blockquote {
  margin: 0.5rem 0;
  padding-inline-start: 0.75rem;
  border-inline-start: 3px solid color-mix(in srgb, var(--md-outline-variant) 70%, transparent);
  color: color-mix(in srgb, var(--md-on-surface) 70%, transparent);
}
hr {
  margin: 1rem 0;
  border: none;
  border-top: 1px solid color-mix(in srgb, var(--md-outline-variant) 30%, transparent);
}
.plain-text-email {
  font-size: 0.875rem;
  line-height: 1.6;
}
`;

async function syncShadow(next: string): Promise<void> {
  if (!host || typeof document === 'undefined') return;
  await tick();
  if (!host) return;
  if (!shadow) {
    shadow = host.attachShadow({ mode: 'open' });
    styleEl = document.createElement('style');
    styleEl.textContent = EMAIL_BODY_CSS;
    shadow.appendChild(styleEl);
  }
  if (next === lastHtml) return;
  lastHtml = next;
  // Keep the injected <style> as the first node; replace everything after it.
  let child = shadow.firstChild;
  while (child) {
    const sibling = child.nextSibling;
    if (child !== styleEl) shadow.removeChild(child);
    child = sibling;
  }
  if (next) {
    shadow.appendChild(document.createRange().createContextualFragment(next));
  }
}

// Reading `html` here registers the reactive dependency; the DOM sync is async.
$effect(() => {
  const next = html || '';
  void syncShadow(next);
});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={host}
  class="email-body text-sm text-md-on-surface break-words select-text cursor-text"
  data-selectable-text="true"
  style="margin-left: auto; margin-right: auto;"
></div>
