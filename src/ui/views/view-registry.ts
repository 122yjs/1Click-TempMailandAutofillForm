/**
 * View registry — declarative metadata for each view.
 *
 * Single source of truth for split-pane routing: AppLayout never hardcodes
 * view names. Secondary pages (message detail, email detail, settings
 * subpages, identity create/edit) open in the split pane whenever a split
 * layout is active, docked into their host primary view. Primary pages
 * (main, addresses, settings hub, organize, …) stay in the main pane.
 */
import type { View } from '@/features/types/view-types.js';

/** The primary view that hosts a secondary (split-pane) view's split pane. */
export type SplitHost = 'mailbox' | 'addresses' | 'settings' | 'autofill';

/**
 * For each secondary (split-pane) view, which primary view hosts its split
 * pane:
 *   - mailView        → docks into the mailbox ('mailbox')
 *   - addressView     → docks into addresses ('addresses')
 *   - settings subpages (keybindings, mailProvider, storagePerformance,
 *     constantsSettings, diagnostics) → dock into the settings hub
 *   - identities / autofill → identity create/edit docks into the autofill hub
 */
export const SPLIT_HOST: Readonly<Partial<Record<View, SplitHost>>> = {
  mailView: 'mailbox',
  addressView: 'addresses',
  mailProvider: 'settings',
  keybindings: 'settings',
  constantsSettings: 'settings',
  diagnostics: 'settings',
  storagePerformance: 'settings',
  identities: 'autofill',
  autofill: 'autofill',
};

/** Views that open in the split pane (derived from SPLIT_HOST). */
export const SPLIT_PANE_VIEWS: ReadonlySet<View> = new Set<View>(Object.keys(SPLIT_HOST) as View[]);

/** True when the given view should render in the split pane (secondary page). */
export function isSplitPaneView(view: View): boolean {
  return SPLIT_PANE_VIEWS.has(view);
}

/** The primary view hosting this secondary view's split pane (undefined if none). */
export function getSplitHost(view: View): SplitHost | undefined {
  return SPLIT_HOST[view];
}

/** True when the view is a settings subpage that docks into the settings hub. */
export function isSettingsSplitView(view: View): boolean {
  return SPLIT_HOST[view] === 'settings';
}

/**
 * Per-view `splitPane` meta (derived from SPLIT_HOST) — a plain boolean map
 * for consumers that want one. Kept in sync automatically.
 */
export const VIEW_SPLIT_PANE_META: Record<string, boolean> = Object.fromEntries(
  (Object.keys(SPLIT_HOST) as View[]).map((v) => [v, true])
);
