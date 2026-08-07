# Architecture

## Directory Layout

```
src/
├── features/             Domain business logic & types (one folder per domain)
│   ├── account/          Tag actions
│   ├── analytics/        Activity tracking
│   ├── archived-mail/    Archived email actions
│   ├── identities/       Identity profile management
│   ├── inbox/            Email filters, inbox actions, bulk actions, export, management
│   ├── keyboard-shortcuts/  Shortcut handling
│   ├── login-info/       Saved-login actions + shared credential crypto
│   ├── message-window/   Message window actions
│   ├── onboarding/       Onboarding actions
│   ├── qr/               QR code generation
│   ├── settings/         Settings load/save, import/export, custom instances
│   ├── theme/            Theme mode, custom color, contrast
│   └── types/            Shared View & view registry types
├── config/              Provider DSL configuration
│   ├── providers.jsonc          Main provider config (JSONC - comments allowed)
│   ├── providers.schema.jsonc   Schema (documentation; not runtime-enforced)
│   └── providers-standard-example.json
├── entrypoints/         Extension entry points
│   ├── app/             Full-page app (app.html)
│   ├── background/      MV3 service worker
│   ├── content/         Content script (injected into web pages)
│   ├── popup/           Toolbar popup (popup.html)
│   └── sidepanel/       Browser side panel (sidepanel.html)
├── locales/             Translation files (en, ar, de, es, fr, ja, zh, th)
├── styles.css + styles/theme.css  App CSS entry + generated MD3 colors
├── ui/                  User Interface components & views
│   ├── blocks/          Modular layout, card, and composite blocks
│   │   ├── account/     AccountSelectorBar, AccountCard
│   │   ├── dialogs/     ConfirmDialog, CreateInboxDialog, QrDialog, TagDialog
│   │   ├── layout/      AppLayout, Header, Footer, SidebarNav, ErrorBoundary
│   │   ├── mail/        EmailList, FilterList, SelectionToolbar, ArchivedEmails
│   │   └── overlays/    CommandPalette, KeyboardShortcutsCheatSheet, ProductTour, Onboarding
│   ├── components/      Reusable UI primitives & composites
│   │   ├── composites/  CopyButton, EmptyState, SearchFilterHeader, Tabs
│   │   ├── icons/       AppLogo, Icon (40+ SVG icons)
│   │   └── primitives/  AutoRenewToggle, Badge, FaviconImage, Skeleton, TagPill, Toggle
│   └── views/           Page-level Svelte view components
│       ├── addresses/   AddressesView (list), AddressView (detail)
│       ├── autofill/    AutofillView (hub), IdentitiesView (profiles), GeneratedAccountsView (vault)
│       ├── mailbox/     MailboxView (list), MailView (reader)
│       ├── settings/    ExtensionSettingsView subpages (8 specialized settings sub-views)
│       ├── AboutView.svelte
│       ├── ActivityView.svelte
│       ├── ExtensionSettingsView.svelte
│       ├── OrganizeView.svelte
│       └── PlaygroundView.svelte
└── utils/               Utility functions and shared services
    ├── dsl/              Email-fetcher DSL (request building, response parsing)
    ├── email-service.ts  Generic provider API client (config-driven)
    ├── email-threads.ts  Subject normalization + conversation grouping
    ├── portal-layers.ts  Single source of truth for overlay z-index scale
    ├── sidebar-fab.ts    Floating Action Button kind mapping
    ├── storage-keys.ts   Typed storage accessors + helpers
    ├── types.ts          Shared TypeScript types (single source of truth)
    └── view-display-names.ts i18n view display labels
```

### Architecture Pattern

**Hybrid:** feature-based for business logic (`features/`), component/block structure for UI (`src/ui/`), type-based for utilities (`utils/`), entrypoint-based for extension contexts (`entrypoints/`). All three UI surfaces share a single root shell component (`AppLayout.svelte`).

---

## UI Surfaces

| Surface | Entry point | When used |
|---------|-------------|-----------|
| Popup | `src/entrypoints/popup/` | Toolbar icon click |
| Sidepanel | `src/entrypoints/sidepanel/` | Browser side panel |
| App (full page) | `src/entrypoints/app/` | "Expand" from header, or notification click |

All three mount `AppLayout` with a `context` prop (`'popup' | 'sidepanel' | 'app'`).

---

## Layout System & Responsive Breakdown

The application shell (`AppLayout.svelte`) dynamically adapts to container width and entrypoint context across **3 primary layout modes**:

```
┌──────────────────────────────────────────────────────────────────────────┐
│                             RESPONSIVE MODES                              │
├──────────────────────────┬────────────────────────┬──────────────────────┤
│ COMPACT POPUP            │ WIDE DUAL PANE         │ DESKTOP SPLIT VIEW   │
│ (width < 800px)          │ (800px <= w < 1280px) │ (width >= 1280px)    │
│ Single view stack        │ Vertical list + detail │ Resizable horizontal │
│ Navigation via Footer    │ Responsive sidebar     │ split list & detail  │
└──────────────────────────┴────────────────────────┴──────────────────────┤
```

### 1. Compact Layout (`context === 'popup'` or container width < 800px)
* **Single Container Stack**: Displays one primary view (`currentView`) at a time.
* **Footer Navigation**: Primary view switching driven by bottom nav bar (`Footer.svelte`).
* **Header Navigation**: Header displays logo, theme toggle, and expand-to-app button.

### 2. Wide Dual-Pane Layout (`context !== 'popup'` & 800px $\le$ container width < 1280px)
* **Responsive Sidebar Nav**: Replaces compact footer with collapsible left sidebar (`SidebarNav.svelte`).
* **Vertical Split Pane (`layoutVerticalSplit`)**: List view renders on top with detail pane docked below.
* **Automatic Migration**: Transitioning window size automatically shifts views between single-stack and vertical split.

### 3. Desktop Split-View Layout (`context !== 'popup'` & container width $\ge$ 1280px)
* **Horizontal Dual-Pane Container (`layoutSplit`)**: Side-by-side List Pane (left) + Resizable Detail Pane (right).
* **Resizable Split Handle**: Draggable split divider allows adjusting pane width (`splitListWidthPx`, 360px–640px) with local storage persistence.
* **Collapsible Detail Pane**: Toggle button allows collapsing/expanding detail pane on demand (`splitPaneCollapsed`).
* **Secondary Settings Docking**: Secondary settings subpages (`isSettingsSplitView(currentView)`) automatically dock into the right split pane while maintaining the Settings hub on the left.

### View Handoff & Active View Resolution (`activeViewForExpand`)
When the user clicks "Open in App" or toggles responsive split mode:
* `activeViewForExpand` inspects live state (`selectedThread`, `currentEmailDetail`, `splitSecondaryView`) to preserve the exact reading context during entrypoint handoff.

### Action Button Layout & Typography Rules (P0 $\rightarrow$ P1 $\rightarrow$ P2)
For action button rows across Mailbox, Address cards, and Selection strips (`use-action-btn-cascade.js`):
1. **No Truncation**: Button labels enforce single-line text (`whitespace-nowrap`).
2. **Priority Cascade**:
   * **P0 (Equal Width + Equal Height + MD3 12px)**: Active when labels fit equal shares (`flex-1`, `h-8.5`/`h-9`).
   * **P1 (Content-Adjusted Widths + MD3 12px)**: Switches to `flex-auto` if equal width causes text overflow.
   * **P2 (Proportionally Reduced Font & Icons)**: Reduces font size and scaled SVG icons in unison via `--action-btn-font` if container width is constrained.

### Overlay & Portal Z-Index Scale
Single source of truth: `src/utils/portal-layers.ts` (`PORTAL_Z`).

| Layer | z-index | Purpose |
|-------|--------:|---------|
| Account selector overlay | **40** | Popover account picker |
| Nav / subpage menus | ~100 | Navigation overlays |
| Toasts | **9000** | Non-blocking toast notifications |
| Confirm / Tag / Export dialogs | **10000** | Body-portaled modal dialogs |
| Product tour | 10050 | Onboarding guidance overlay |
| App tooltips | 100000 | Global mouseover tooltips |

---

## Canonical View Registry

View identifiers are strictly governed by `View` in `src/features/types/view-types.ts` and `SPLIT_HOST` in `src/ui/views/view-registry.ts`.

| Canonical View Key | Directory / File Path | Purpose | Split Host |
|-------------------|-----------------------|---------|------------|
| `mailbox` | `src/ui/views/mailbox/MailboxView.svelte` | Primary mailbox email thread list | `mailbox` |
| `mailView` | `src/ui/views/mailbox/MailView.svelte` | Email message body reader & thread viewer | `mailbox` |
| `addresses` | `src/ui/views/addresses/AddressesView.svelte` | Inbox address management & list | `addresses` |
| `addressView` | `src/ui/views/addresses/AddressView.svelte` | Single address details, QR code, expiry & notes | `addresses` |
| `autofill` | `src/ui/views/autofill/AutofillView.svelte` | Unified Autofill hub (Profiles & Credentials) | `autofill` |
| `identities` | `src/ui/views/autofill/IdentitiesView.svelte` | Profile templates & persona management | `autofill` |
| `loginInfo` | `src/ui/views/autofill/GeneratedAccountsView.svelte` | Generated credential vault & history | `autofill` |
| `settings` | `src/ui/views/ExtensionSettingsView.svelte` | Primary extension settings hub | `settings` |
| `organize` | `src/ui/views/OrganizeView.svelte` | Unified Tags, Labels, and Filters hub | `organize` |
| `activity` | `src/ui/views/ActivityView.svelte` | Activity log & usage analytics | `activity` |
| `about` | `src/ui/views/AboutView.svelte` | About page, version details & FAQ | — |
| `mailProvider` | `src/ui/views/settings/MailProviderView.svelte` | Mail provider & custom instance settings | `settings` |
| `keybindings` | `src/ui/views/settings/KeyboardShortcutsView.svelte` | Keyboard shortcut configuration | `settings` |
| `diagnostics` | `src/ui/views/settings/DiagnosticsView.svelte` | System diagnostics & health check | `settings` |
| `storagePerformance` | `src/ui/views/settings/StoragePerformanceView.svelte` | Storage usage, cache & retention settings | `settings` |
| `componentVisibility` | `src/ui/views/settings/ComponentVisibilitySettingsView.svelte` | UI chrome & toolbar visibility settings | `settings` |
| `constantsSettings` | `src/ui/views/settings/ConstantsSettingsView.svelte` | Advanced system constants configuration | `settings` |
| `htmlRendering` | `src/ui/views/settings/HtmlRenderingSettingsView.svelte` | Per-tag HTML sanitization toggles | `settings` |
| `navbarOrder` | `src/ui/views/settings/NavbarOrderSettingsView.svelte` | Customizable navbar order settings | `settings` |

---

## Dialogs / Overlays

Location: `src/ui/blocks/dialogs/`

| Component | Purpose |
|-----------|---------|
| `ConfirmDialog.svelte` | Generic yes/no confirmation (delete inbox, hard reset, etc.) |
| `CreateInboxDialog.svelte` | Choose random vs. custom username when creating an inbox |
| `QrDialog.svelte` | QR code of the selected email address (download / copy image) |
| `TagDialog.svelte` | Set or edit a tag + color on an inbox |

---

## Email Body Rendering Isolation

Email message bodies are rendered by `src/ui/components/composites/EmailBody.svelte`.
Rendering is hardened in **two layers**:

1. **Sanitizer (security boundary)** — `src/utils/sanitize-html.ts` (DOMPurify). Strips
   scripts, event attributes, `<link>`/`<meta>`/`<html>`/`<head>`/`<body>` tags
   (and entity-encoded forms), `class`/`id` attributes, and forbidden overlay/phishing
   CSS props (`position`, `z-index`, `inset`, `opacity`, `visibility`, …). Inline
   `style` attributes are only kept when the `htmlRenderingSettings.style` toggle is on.
   When called with `{ darkMode: true }` (MailView + the message window detect it via
   `isDarkThemeActive()`), a neutralization pass rewrites hardcoded light backgrounds
   → `transparent` and dark text → `inherit` (luminance-based), so white-background
   emails stay readable on dark themes; layout-affecting CSS is never touched. Print
   output deliberately skips this so PDFs keep the email's original colors.

   **Safe-subset `<style>` blocks (shadow-DOM path only).** MailView passes
   `{ allowStyleBlocks: true }` because `EmailBody` renders into an **open shadow
   root** — a `<style>` element inside the root is scoped to that shadow tree and
   can never restyle the extension UI. The CSS is still filtered fail-closed by
   `sanitizeStyleBlockCss()` before re-injection:

   - **Kept** — plain layout/content rules and `@media` / `@supports` blocks (the
     responsive-layout win for newsletter emails). When `{ darkMode: true }` is
     passed (MailView), light `background`/`background-color` values and dark
     `color` values inside style blocks are neutralized exactly like inline
     styles, so white-background emails stay readable on dark themes.
   - **Stripped** — `@import`, `@charset`, `@namespace`, `@font-face`, `@keyframes`,
     `@page`, `@layer`, `@container`, custom properties (`--*`), `url(...)`,
     `expression(...)`, `behavior:`, overlay/hijack props (`position`, `z-index`,
     `transform`, `opacity`, …), and `:host` / `:root` selectors. Unknown at-rules
     fail closed. `@media` rules keep only their sanitized inner rules.
   - **Re-injection hardening** — re-injected blocks escape `</style` → `<\/style`
     (a CSS escape for `/`) so a `</style` sequence inside a CSS string value can
     never terminate the `<style>` element early and leak raw HTML into the shadow
     root; the re-injected string bypasses DOMPurify, so this escape is mandatory.

   Light-DOM consumers (message window, print) never pass this flag — their style
   blocks stay stripped. The `htmlRenderingSettings.style` toggle gates both inline
   styles and style blocks. Sanitizing email CSS is deliberately *not* a sandbox:
   the shadow root is the style quarantine, the sanitizer is the script/overlay
   boundary.
2. **Shadow DOM (style quarantine)** — `EmailBody.svelte` attaches an **open** shadow
   root to a host `<div>` and inserts the sanitized HTML plus the email-body typography
   CSS *inside* the root. No selector can cross the boundary in either direction, so
   email markup can never restyle/hide the app and app CSS can never restyle the email.

### Trade-offs (documented)

| Aspect | Behavior |
|--------|----------|
| **Style isolation** | Total both ways; the app's `--md-*` custom properties and inherited font/color/line-height/direction still flow through, so dark mode and theming keep working for free. Sanitized email `<style>` blocks (MailView only) stay scoped inside the shadow root and are filtered to a safe CSS subset (`sanitizeStyleBlockCss`). |
| **Events across the boundary** | Events are composed (they bubble up), but a document listener's `target.closest()` cannot see past the boundary. Code matching elements inside the email must walk `getRootNode()` → `ShadowRoot.host`. The global contextmenu lock in `AppLayout.svelte` (`hitSelectableRegion`) already does this so right-click-to-copy still works inside the email body. |
| **Find-in-page (Ctrl+F)** | Matches open shadow roots in modern Chrome / Firefox / Safari; very old engines may skip email content. |
| **Screen readers** | Open shadow DOM is exposed to the a11y tree; legacy assistive-tech bugs are possible — the sanitizer remains the security boundary regardless. |
| **Selection** | Text inside the shadow is selectable and `window.getSelection()` sees it; the global `td, th { user-select: none }` rule no longer reaches email tables (table text is now copyable). The host keeps `data-selectable-text` so the native-context-menu exception still matches. |
| **Svelte reactivity** | Content is inserted via shadow-root fragments (bypassing `{@html}`); `EmailBody` re-syncs in a `$effect` when its `html` prop changes. |

Keep `EmailBody` the single place email HTML is injected. Do not add `{@html}` for
unsanitized email content elsewhere, and do not render email CSS into the light DOM.

---

## Content-Script Popup (injected into web pages)

Location: `src/entrypoints/content/autofill/autofill-buttons.ts`

| Element | Purpose |
|---------|---------|
| Per-field autofill button | Small icon button next to each input - opens the per-field popup |
| Autofill popup | Dropdown with "Fill Email", "Generate Password", "Autofill Entire Form", etc. |
| "Fill All" pill | Button positioned above the form - fills every field at once |
| Disposable hint chip | Inline suggestion under email fields to use a temp alias instead |

---

## Permissions

| Permission | Why |
|------------|-----|
| `storage`, `unlimitedStorage` | Inboxes, emails, credentials, settings |
| `alarms` | Periodic inbox refresh |
| `notifications` | New mail / OTP alerts |
| `clipboardRead` / `clipboardWrite` | Copy email, OTP, credentials |
| `scripting`, `activeTab` | Content-script injection on user gesture |
| `cookies` | Cookie-session mail providers |
| `declarativeNetRequest` | Optional UA spoofing for identity profiles |
| `host_permissions` | Known HTTPS API endpoints in `providers.jsonc` |

---

## Entrypoint Parity

| Surface | Entry | Shared Component |
|---------|-------|------------------|
| Popup / Sidepanel / App | `popup.svelte`, `sidepanel.svelte`, `app.svelte` | `AppLayout.svelte` (shared root shell) |
| Background | `src/entrypoints/background/` | Service worker: inbox sync, message router, alarms |
| Content script | `src/entrypoints/content/` | Injected autofill, OTP detection & disposable hints |