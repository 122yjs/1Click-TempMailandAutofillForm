/**
 * Single source of truth for overlay stacking (extension UI).
 * Always portal dialogs to document.body when they must sit above AccountSelector
 * or any transform-containing ancestor.
 *
 * Scale (low → high):
 *  nav / more menus < account selector < toast < modal dialogs < tour
 *
 * ── Content script overlays (page context) ────────────────────────────────
 * Content scripts inject UI into the *page* DOM, not the extension popup DOM.
 * The page may have arbitrary z-index values, so content-script overlays use
 * a very high z-index to guarantee visibility above all page content:
 *
 *   CONTENT_Z  = 2147483645   (wait-otp-panel.ts overlay)
 *   CONTENT_Z_TOOLTIP = 2147483646  (autofill hint tooltips)
 *
 * These are intentionally near the browser's max safe z-index (2147483647)
 * to defeat even aggressive page-level stacking contexts (e.g. fixed headers
 * with z-index: 999999). They do NOT participate in the extension UI scale
 * above because they render in a separate document context (the page's DOM).
 */
export const CONTENT_Z = {
  /** Autofill button containers (small icons next to form fields) */
  button: 10000,
  /** Wait-for-OTP panel and other injected floating panels (shadow DOM) */
  overlay: 2147483645,
  /** Autofill hint tooltips, conflict chips, and fill-all variant containers */
  tooltip: 2147483646,
  /** Autofill popup menus and button containers (highest content-script layer) */
  popup: 2147483647,
  /** Inline suggestion/warning chips (absolute, relative to form field) */
  chip: 10001,
} as const;

export const PORTAL_Z = {
  /** Floating more-menu / nav popovers */
  navMenu: 100,
  /** Account selector overlay (must stay below dialogs) */
  accountSelector: 40,
  /** Account card ⋮ menus (fixed, still below dialogs) */
  accountMenu: 110,
  /** Offline banner */
  offlineBanner: 2000,
  /** Transient print-intent action bar (fixed top; below toasts & dialogs) */
  printBar: 5000,
  /** Toasts (bottom-right; below modal dialogs so confirms stay readable) */
  toast: 9000,
  /** Confirm / Tag / Export / Import dialogs (body-portaled) */
  dialog: 10000,
  /** Dropdown menus opened INSIDE a body-portaled dialog/overlay (z-10000).
   * The menu is itself portaled to body, so it must stack above the dialog
   * surface; stays below the product tour. Pass via <Dropdown zIndex={...}>. */
  dialogMenu: 10001,
  /** Product tour */
  tour: 10050,
  /** Native-feeling tooltips at app root */
  tooltip: 100000,
} as const;

/** Tailwind-friendly class fragments for common layers */
export const PORTAL_Z_CLASS = {
  navMenu: 'z-[100]',
  accountSelector: 'z-[40]',
  accountMenu: 'z-[110]',
  printBar: 'z-[5000]',
  toast: 'z-[9000]',
  dialog: 'z-[10000]',
  tour: 'z-[10050]',
} as const;

/**
 * Move an element to document.body if not already there.
 * Returns cleanup that re-parents or removes when appropriate.
 */
export function portalToBody(el: HTMLElement | null | undefined): () => void {
  if (!el || typeof document === 'undefined') return () => {};
  if (el.parentElement !== document.body) {
    document.body.appendChild(el);
  }
  return () => {
    try {
      if (el.parentElement === document.body) el.remove();
    } catch {
      /* ignore */
    }
  };
}

/**
 * Svelte `use:` action form of portalToBody.
 *
 * Returns the `{ destroy }` object form so it satisfies Svelte 5's
 * `Action` return contract (`void | ActionReturn`), which a bare
 * `() => void` cleanup does not. Use on blocking-dialog overlay roots:
 *   `<div use:portalDialogAction class="fixed inset-0 z-[10000]" ...>`
 */
export function portalDialogAction(node: HTMLElement): { destroy: () => void } {
  const cleanup = portalToBody(node);
  return { destroy: cleanup };
}

/**
 * Splitpane-aware portal action: portals to trigger's splitpane container if invoked inside splitpane,
 * else defaults to document.body.
 */
export function portalToTriggerContainer(
  node: HTMLElement,
  triggerElement?: HTMLElement | null
): { destroy: () => void } {
  if (!node || typeof document === 'undefined') return { destroy: () => {} };
  const targetContainer =
    (triggerElement?.closest(
      '#splitpane-container, .splitpane-pane, [data-splitpane-container]'
    ) as HTMLElement | null) || document.body;
  if (node.parentElement !== targetContainer) {
    targetContainer.appendChild(node);
  }
  return {
    destroy: () => {
      try {
        if (node.parentElement === targetContainer) node.remove();
      } catch {
        /* ignore */
      }
    },
  };
}
