/**
 * Per-site field maps — remember which selectors worked for each field kind.
 */

import { browser } from 'wxt/browser';
import { normalizeDomain } from './storage.js';
import type { FormFieldKind } from './types.js';

export interface FieldMapEntry {
  kind: FormFieldKind;
  /** Relative CSS selector that worked */
  selector: string;
  /** Success count for ranking */
  hits: number;
  lastUsedAt: number;
}

export interface SiteFieldMap {
  domain: string;
  entries: FieldMapEntry[];
  updatedAt: number;
}

const KEY = 'siteFieldMaps_v1';
const MAX_DOMAINS = 100;
const MAX_ENTRIES = 40;

export async function loadAllFieldMaps(): Promise<Record<string, SiteFieldMap>> {
  try {
    const res = (await browser.storage.local.get([KEY])) as {
      [KEY]?: Record<string, SiteFieldMap>;
    };
    return res[KEY] || {};
  } catch {
    /* ignore */
    return {};
  }
}

export async function getFieldMap(domain: string): Promise<SiteFieldMap | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  const all = await loadAllFieldMaps();
  return all[d] || null;
}

/** Build a stable-ish selector for an element (id > name > autocomplete > path). */
export function buildSelectorHint(el: Element): string {
  if (!(el instanceof HTMLElement)) return el.tagName.toLowerCase();
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${CSS.escape(el.id)}`;
  const name = el.getAttribute('name');
  if (name) return `${tag}[name="${CSS.escape(name)}"]`;
  const ac = el.getAttribute('autocomplete');
  if (ac) return `${tag}[autocomplete="${CSS.escape(ac)}"]`;
  const aria = el.getAttribute('aria-label');
  if (aria && aria.length < 40) return `${tag}[aria-label="${CSS.escape(aria)}"]`;
  // Short path from form
  const form = el.closest('form');
  if (form) {
    const inputs = Array.from(form.querySelectorAll(tag));
    const idx = inputs.indexOf(el);
    if (idx >= 0) return `form ${tag}:nth-of-type(${idx + 1})`;
  }
  return tag;
}

export async function recordFieldMapHit(
  domain: string,
  kind: FormFieldKind,
  el: Element
): Promise<void> {
  const d = normalizeDomain(domain);
  if (!d || kind === 'unknown') return;
  const selector = buildSelectorHint(el);
  const all = await loadAllFieldMaps();
  const map: SiteFieldMap = all[d] || { domain: d, entries: [], updatedAt: Date.now() };
  const existing = map.entries.find((e) => e.kind === kind && e.selector === selector);
  if (existing) {
    existing.hits += 1;
    existing.lastUsedAt = Date.now();
  } else {
    map.entries.push({ kind: kind as FormFieldKind, selector, hits: 1, lastUsedAt: Date.now() });
  }
  map.entries.sort((a, b) => b.hits - a.hits || b.lastUsedAt - a.lastUsedAt);
  map.entries = map.entries.slice(0, MAX_ENTRIES);
  map.updatedAt = Date.now();
  all[d] = map;
  // Cap domains by recency
  const sorted = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmed: Record<string, SiteFieldMap> = {};
  for (const m of sorted.slice(0, MAX_DOMAINS)) trimmed[m.domain] = m;
  await browser.storage.local.set({ [KEY]: trimmed });
}

/** Record a field map hit by selector string (for background handler — no DOM access needed). */
export async function recordFieldMapHitBySelector(
  domain: string,
  kind: string,
  selector: string
): Promise<void> {
  const d = normalizeDomain(domain);
  if (!d || kind === 'unknown') return;
  const all = await loadAllFieldMaps();
  const map: SiteFieldMap = all[d] || { domain: d, entries: [], updatedAt: Date.now() };
  const existing = map.entries.find((e) => e.kind === kind && e.selector === selector);
  if (existing) {
    existing.hits += 1;
    existing.lastUsedAt = Date.now();
  } else {
    map.entries.push({ kind: kind as FormFieldKind, selector, hits: 1, lastUsedAt: Date.now() });
  }
  map.entries.sort((a, b) => b.hits - a.hits || b.lastUsedAt - a.lastUsedAt);
  map.entries = map.entries.slice(0, MAX_ENTRIES);
  map.updatedAt = Date.now();
  all[d] = map;
  // Cap domains by recency
  const sorted = Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);
  const trimmed: Record<string, SiteFieldMap> = {};
  for (const m of sorted.slice(0, MAX_DOMAINS)) trimmed[m.domain] = m;
  await browser.storage.local.set({ [KEY]: trimmed });
}

/** Resolve best known element for a kind on this domain within a root. */
export function resolveMappedField(
  root: ParentNode,
  map: SiteFieldMap | null,
  kind: FormFieldKind
): HTMLElement | null {
  if (!map) return null;
  const candidates = map.entries.filter((e) => e.kind === kind).sort((a, b) => b.hits - a.hits);
  for (const c of candidates) {
    try {
      const el = root.querySelector(c.selector);
      if (el instanceof HTMLElement) {
        // Must be fillable-ish
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
        ) {
          return el;
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'SyntaxError') {
        /* invalid selector */
        continue;
      }
      throw e;
    }
  }
  return null;
}
