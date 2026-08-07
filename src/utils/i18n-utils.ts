/**
 * Translation utilities for non-Svelte contexts (background, content scripts, utilities).
 *
 * Locale strategy: English (`en.json`) is statically imported as the universal
 * fallback so tSync() always works — even if dynamic imports fail at runtime.
 * The other 7 locales are dynamically imported and code-split, so only the
 * active locale + English are loaded at startup (~155 KB vs ~640 KB if all
 * 8 were statically imported).
 *
 * IMPORTANT: Language is stored as both `preferredLanguage` (LanguageSwitcher legacy) and
 * `locale` (canonical). Always resolve via resolveStoredLocale().
 */

import { browser } from 'wxt/browser';
import en from '../locales/en.json';
import { logError } from './logger.js';

type LocaleTree = Record<string, unknown>;

/** Supported language codes shipped in the extension. */
export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de', 'ja', 'zh', 'ar', 'th'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Dynamic loaders for non-English locales. Using dynamic import() here means
 * Vite creates a separate chunk per locale and only loads the requested one.
 * English is statically imported as the fallback (see above).
 */
const LOCALE_LOADERS: Record<string, () => Promise<unknown>> = {
  es: () => import('../locales/es.json'),
  fr: () => import('../locales/fr.json'),
  de: () => import('../locales/de.json'),
  ja: () => import('../locales/ja.json'),
  zh: () => import('../locales/zh.json'),
  ar: () => import('../locales/ar.json'),
  th: () => import('../locales/th.json'),
};

/** Normalize Vite/JSON module shapes (`default` wrapper or plain object). */
function asTree(mod: unknown): LocaleTree {
  if (!mod || typeof mod !== 'object') return {};
  const m = mod as { default?: LocaleTree };
  if (m.default && typeof m.default === 'object') return m.default;
  return mod as LocaleTree;
}

// Cache for loaded translations
const translationCache = new Map<string, LocaleTree>();

/** Last known locale for tSync when locale arg is omitted. */
let cachedLocale = 'en';

/** Map any browser/storage locale string to a supported 2-letter code. */
export function mapToSupportedLocale(raw: string | null | undefined): string {
  const code = String(raw || '')
    .trim()
    .split(/[-_]/)[0]
    .toLowerCase();
  if (code && (LOCALE_LOADERS[code] || code === 'en')) return code;
  return 'en';
}

/**
 * Resolve the user's language from storage (or a storage snapshot).
 * Priority: preferredLanguage → locale → page/navigator language → en
 */
export function resolveStoredLocale(snap?: {
  locale?: string;
  preferredLanguage?: string;
}): string {
  const raw = snap?.preferredLanguage || snap?.locale || '';
  if (raw) return mapToSupportedLocale(raw);
  return '';
}

/**
 * Get the current locale from storage (extension preference).
 * Priority: preferredLanguage → locale → page/navigator language → en
 */
export async function getStoredLocaleAsync(): Promise<string> {
  try {
    const result = (await browser.storage.local.get(['locale', 'preferredLanguage'])) as {
      locale?: string;
      preferredLanguage?: string;
    };
    const stored = resolveStoredLocale(result);
    if (stored) return stored;

    // Page / browser language when user never set a preference
    if (typeof document !== 'undefined') {
      const docLang = document.documentElement?.lang || '';
      const navLang = typeof navigator !== 'undefined' ? navigator.language : '';
      const fromPage = mapToSupportedLocale(docLang || navLang);
      if (fromPage && (docLang || navLang)) {
        return fromPage;
      }
    } else if (typeof navigator !== 'undefined' && navigator.language) {
      return mapToSupportedLocale(navigator.language);
    }
    return 'en';
  } catch {
    /* ignore */
    return 'en';
  }
}

/**
 * Persist language preference under both storage keys used in the codebase.
 */
export async function persistLocale(langCode: string): Promise<string> {
  const code = mapToSupportedLocale(langCode);
  cachedLocale = code;
  try {
    await browser.storage.local.set({ locale: code, preferredLanguage: code });
  } catch (e) {
    logError('Failed to persist locale', e);
  }
  return code;
}

/**
 * The English locale is always statically available as a fallback.
 * Non-English locales are loaded lazily via dynamic import.
 */
const EN_TREE: LocaleTree = asTree(en);

/**
 * Load translations for a specific locale (dynamic import — only loads
 * the requested locale chunk, not all locales).
 */
async function loadTranslations(locale: string): Promise<LocaleTree> {
  const code = mapToSupportedLocale(locale);

  // English is always available via static import
  if (code === 'en') {
    if (!translationCache.has('en')) {
      translationCache.set('en', EN_TREE);
    }
    return translationCache.get('en') ?? EN_TREE;
  }

  // Check cache first
  if (translationCache.has(code)) {
    return translationCache.get(code) ?? {};
  }

  // Ensure English fallback is cached
  if (!translationCache.has('en')) {
    translationCache.set('en', EN_TREE);
  }

  try {
    const loader = LOCALE_LOADERS[code];
    if (!loader) {
      return EN_TREE;
    }
    const mod = await loader();
    const tree = asTree(mod);
    translationCache.set(code, tree);
    return tree;
  } catch (e) {
    logError(`Failed to load locale pack for ${code}`, e);
    return EN_TREE;
  }
}

/**
 * Substitute {var} placeholders in a string with values from a record.
 */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  );
}

function lookupInTree(translations: LocaleTree, key: string): string | undefined {
  const keys = key.split('.');
  let value: unknown = translations;
  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = (value as LocaleTree)[k];
    } else {
      return undefined;
    }
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Get a translated string by key path (e.g., "errors.apiCallFailed")
 * Supports nested keys with dot notation and {var} interpolation.
 */
export async function t(
  key: string,
  vars?: Record<string, string | number>,
  locale?: string
): Promise<string> {
  const targetLocale = mapToSupportedLocale(locale || (await getStoredLocaleAsync()));
  cachedLocale = targetLocale;
  const translations = await loadTranslations(targetLocale);

  let found = lookupInTree(translations, key);
  if (found === undefined && targetLocale !== 'en') {
    found = lookupInTree(await loadTranslations('en'), key);
  }
  if (found !== undefined) return interpolate(found, vars);
  return key;
}

/** Hardcoded English fallbacks so UI never flashes raw keys like `time.hoursAgo`. */
const EN_SYNC_FALLBACKS: Record<string, string> = {
  'time.justNow': 'Just now',
  'time.secondsAgo': '{n}s ago',
  'time.minutesAgo': '{n}m ago',
  'time.hoursAgo': '{n}h ago',
  'time.daysAgo': '{n}d ago',
  'time.daysAgoLong': '{n} days ago',
  'time.today': 'Today',
  'time.yesterday': 'Yesterday',
  'time.never': 'Never',
  'time.expired': 'Expired',
};

/**
 * Get a translated string synchronously (uses cached translations).
 */
export function tSync(
  key: string,
  vars?: Record<string, string | number>,
  locale?: string
): string {
  const targetLocale = mapToSupportedLocale(locale || cachedLocale || 'en');
  const translations =
    translationCache.get(targetLocale) ||
    (targetLocale !== 'en' ? translationCache.get('en') : undefined);

  if (translations) {
    const found = lookupInTree(translations, key);
    if (found !== undefined) return interpolate(found, vars);
  }

  // English is always statically available; check cache first, then EN_SYNC_FALLBACKS
  const fallback = EN_SYNC_FALLBACKS[key];
  if (fallback) return interpolate(fallback, vars);

  return key;
}

/**
 * Remember the active locale for synchronous helpers.
 */
export function setCachedLocale(locale: string): void {
  cachedLocale = mapToSupportedLocale(locale);
}

/**
 * Preload translations for a locale (call this on startup)
 */
export async function preloadTranslations(locale: string): Promise<void> {
  const code = mapToSupportedLocale(locale);
  cachedLocale = code;
  if (code !== 'en') {
    await loadTranslations('en');
  }
  await loadTranslations(code);
}

/**
 * Clear translation cache (useful for locale changes)
 */
export function clearTranslationCache(): void {
  translationCache.clear();
}

// Keep content/background UIs in sync when user changes language
try {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.locale && !changes.preferredLanguage) return;
    const nextRaw =
      (changes.preferredLanguage?.newValue as string | undefined) ||
      (changes.locale?.newValue as string | undefined) ||
      'en';
    const next = mapToSupportedLocale(nextRaw);
    clearTranslationCache();
    setCachedLocale(next);
    void preloadTranslations(next).catch((e: unknown) =>
      logError('Failed to reload translations after locale change', e)
    );
  });
} catch {
  /* storage may be unavailable in some test contexts */
}
