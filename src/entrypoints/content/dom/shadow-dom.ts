// Shared module to manage closed Shadow DOM host and root
import { getStorageViaBg } from '@/utils/content-bg-bridge.js';
import { CONTENT_Z } from '@/utils/portal-layers.js';
import { DEFAULT_THEME_SEED, generateThemeColorsSync } from '@/utils/theme-generator.js';

let shadowRoot: ShadowRoot | null = null;
const hostId = `oc-host-${Math.random().toString(36).substring(2, 15)}`;

// Session-randomized classes to avoid fingerprinting / page scraping
export const BUTTON_CLASS = `oc-btn-${Math.random().toString(36).substring(2, 8)}`;
export const CONTAINER_CLASS = `oc-container-${Math.random().toString(36).substring(2, 8)}`;
export const POPUP_CLASS = `oc-popup-${Math.random().toString(36).substring(2, 8)}`;

/**
 * Default light-standard palette derived from the theme seed at runtime
 * (no hardcoded hex values). Stays in sync with scripts/generate-theme.ts
 * and src/utils/theme-generator.ts (DEFAULT_THEME_SEED).
 */
const DEFAULT_THEME_COLORS: Record<string, string> = generateThemeColorsSync(
  DEFAULT_THEME_SEED,
  false,
  0
);

const HOST_STYLE =
  'position:fixed!important;inset:0!important;width:0!important;height:0!important;overflow:visible!important;border:none!important;margin:0!important;padding:0!important;pointer-events:none!important;z-index:' +
  CONTENT_Z.tooltip +
  '!important;opacity:1!important;visibility:visible!important;display:block!important;transform:none!important;clip:auto!important;clip-path:none!important;filter:none!important;';

let hostGuardObserver: MutationObserver | null = null;
let hostEl: HTMLElement | null = null;

function applyHostStyle(host: HTMLElement): void {
  host.style.cssText = HOST_STYLE;
  // Re-apply critical props that aggressive sites may override via stylesheet
  host.style.setProperty('z-index', String(CONTENT_Z.tooltip), 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  host.style.setProperty('opacity', '1', 'important');
  host.style.setProperty('visibility', 'visible', 'important');
  host.style.setProperty('display', 'block', 'important');
}

function ensureHostInBody(host: HTMLElement): void {
  try {
    if (!document.body) return;
    if (host.parentElement !== document.body) {
      document.body.appendChild(host);
    }
  } catch {
    /* ignore */
  }
}

function startHostGuard(host: HTMLElement): void {
  if (hostGuardObserver || typeof document === 'undefined') return;
  hostGuardObserver = new MutationObserver(() => {
    if (!host.isConnected) {
      try {
        document.body?.appendChild(host);
        applyHostStyle(host);
      } catch {
        /* ignore */
      }
    } else {
      // Re-assert styles if site stripped them
      try {
        if (host.style.display === 'none' || host.style.visibility === 'hidden') {
          applyHostStyle(host);
        }
      } catch {
        /* ignore */
      }
    }
  });
  try {
    hostGuardObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* ignore */
  }
}

/** Re-assert host on top of SPA DOM churn (Canva etc.). */
export function protectShadowHost(): void {
  const root = getOrCreateShadowRoot();
  if (!root || !hostEl) return;
  ensureHostInBody(hostEl);
  applyHostStyle(hostEl);
}

export function getOrCreateShadowRoot(): ShadowRoot | null {
  if (typeof document === 'undefined') return null;

  // Recover if host was removed from DOM (SPA frameworks)
  let host = hostEl?.isConnected ? hostEl : document.getElementById(hostId);
  if (!host?.isConnected) {
    shadowRoot = null;
    host = document.createElement('div');
    host.id = hostId;
    host.setAttribute('data-oc-ui-host', '1');
    applyHostStyle(host);

    // Apply theme tokens immediately (sync defaults) so first paint is never unstyled
    for (const [key, value] of Object.entries(DEFAULT_THEME_COLORS)) {
      host.style.setProperty(key, value);
    }
    void (async () => {
      try {
        const result = await getStorageViaBg(['themeColors']);
        const colors = (result.themeColors || DEFAULT_THEME_COLORS) as Record<string, string>;
        for (const [key, value] of Object.entries(colors)) {
          host.style.setProperty(key, value);
        }
      } catch {
        /* keep defaults */
      }
    })();

    ensureHostInBody(host);
    hostEl = host;
    startHostGuard(host);
  } else {
    hostEl = host as HTMLElement;
    applyHostStyle(hostEl);
    ensureHostInBody(hostEl);
    startHostGuard(hostEl);
  }

  if (!shadowRoot) {
    try {
      shadowRoot = host.attachShadow({ mode: 'closed' });
    } catch {
      // biome-ignore lint/suspicious/noExplicitAny: access private _shadowRoot fallback
      shadowRoot = (host as any)._shadowRoot || null;
      if (!shadowRoot) {
        try {
          // Host may already have shadow — recreate host
          host.remove();
          hostEl = null;
          shadowRoot = null;
          return getOrCreateShadowRoot();
        } catch {
          /* ignore */
          return null;
        }
      }
    }
  }
  return shadowRoot;
}
