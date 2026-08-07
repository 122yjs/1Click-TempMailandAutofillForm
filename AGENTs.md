# AGENTs

This document contains information about AI agents used in this project.

## Overview

Documentation about agent configurations, behaviors, and integration patterns.

## Development Guidelines

### 1. Entrypoint Svelte File Changes

When making changes to entrypoint Svelte files in the `src/entrypoints/` directory, follow this order:

1. **First choice:** Make changes in `popup.svelte`
2. **Then:** Apply the same changes to `sidepanel.svelte`
3. **Finally:** Apply the same changes to `app.svelte`

This ensures consistency across all entrypoints (Popup, Sidepanel, and App views). All three entrypoints share similar structure and functionality, so changes must be reflected in all files to maintain feature parity.

### 2. JSON-Driven Mail Provider Configuration

All mail provider logic must be JSON-driven using `src/config/providers.jsonc`. Do not hardcode provider-specific logic in the code. Instead:

- Read provider configuration from `providers.jsonc`
- Use `loadProviderConfig(provider)` to get provider settings
- Check configuration flags like `customEmail.supported`, `expiry.renewable`, etc.
- All provider-specific behaviors should be controlled via JSON configuration

### 3. Translation Updates

When making changes that affect user-facing text or labels, update the translation files:

- Translation files are located in `src/locales/` (e.g., `en.json`, `ar.json`, etc.)
- `en.json` is the **source of truth** - all other locales must mirror its exact key structure
- Add new translation keys for any new UI text
- Update existing keys if text changes
- Ensure all supported languages receive the same updates: `ar`, `de`, `es`, `fr`, `ja`, `zh`, `th`
- If an interpolation variable (e.g. `{n}`, `{count}`) is used in `en.json`, it **must** appear in every other locale for that same key

#### Translation Completeness Tooling

An automated checker enforces the above rules at multiple levels:

| Layer | Command | When it runs |
|-------|---------|--------------|
| **Pre-commit hook** | `bun run check-translations` | On every `git commit` via Husky |
| **Unit test** | `bun test` | Locally and in CI - file: `src/utils/i18n-check.test.ts` |
| **CI step** | `Check translation completeness` | On every PR via `pr-validation.yml` |
| **Manual** | `bun run check-translations` | Run anytime to audit locale files |

**Adding a new translation key** - workflow:
1. Add the key and English value to `src/locales/en.json`
2. Add the translated value to every other locale file in the same section
3. Run `bun run check-translations` to confirm no keys are missing
4. Commit - the pre-commit hook will re-verify automatically

**What the checker detects:**
- Keys present in `en.json` but missing from another locale (❌ error - blocks CI)
- Keys present in a locale but absent from `en.json` (⚠️ warning - does not block CI)
- Interpolation variables present in an English string but missing from a translation (❌ error)

## Common Patterns and Best Practices

### Storage Key Handling

When working with dynamic storage keys:

```typescript
// ✅ Correct - use dynamic key to access result
const storageKey = `selectedInstance_${providerId}` as const;
const result = await browser.storage.local.get([storageKey as string]) as Record<string, string>;
const selectedInstance = result[storageKey];

// ❌ Incorrect - destructuring with dynamic key doesn't work
const { [storageKey]: selectedInstance } = await browser.storage.local.get([storageKey as string]);
```

### Svelte 5 Reactivity Patterns

- **Derived values in closures:** In Svelte 5, closures over `$derived` values capture a snapshot at closure creation time, not a live reactive reference. Pass values directly instead of relying on closures.
- **Functional updates:** Use functional update patterns for setters to preserve computed fields when updating specific properties.

```typescript
// ✅ Correct - functional update preserves computed fields
setAllInboxes((prev) => prev.map(acc => acc.id === account.id ? { ...acc, autoExtend: newValue } : acc));

// ❌ Incorrect - passes raw storage objects without computed fields
setAllInboxes(updated);
```

### Event Handler Best Practices

Always use `e.stopPropagation()` on button click handlers to prevent event bubbling to parent elements:

```typescript
onclick={(e) => {
  e.stopPropagation();
  onToggleAutoExtend(account);
}}
```

### Type Safety with Functional Updates

When implementing setters that support both direct values and functional updates:

```typescript
setAllInboxes: (v) => {
  allInboxes = typeof v === 'function' ? (v as (prev: Account[]) => Account[])(allInboxes) : v;
}
```

### Skip Email Selection Pattern

When reloading inboxes after operations that shouldn't change the selected email (like toggle operations):

```typescript
await setters.loadInboxes(true); // skipEmailSelection = true
```

### Build Verification

Always run these **four** commands after substantive changes (in order):

1. `bun run typecheck`
2. `bun run format`
3. `bun run check`  (Biome)
4. `bun run build`

Also run `bun run check-translations` when any locale key changes.

### 4. Overlay / portal z-index scale (mandatory)

Single source of truth: `src/utils/portal-layers.ts` (`PORTAL_Z`).

| Layer | z-index | Rule |
|-------|--------:|------|
| Account selector overlay | **40** | Never raise above dialogs |
| Nav / more menus | ~100 | Below dialogs |
| Toasts | **9000** | Below modal dialogs |
| Confirm / Tag / Export dialogs | **10000** | Body-portaled |
| Product tour | 10050 | Above dialogs |
| App tooltips | 100000 | Highest |

**Rules:**
- Confirm/Tag/any blocking dialog MUST portal to `document.body` and use `PORTAL_Z.dialog` (or `z-[10000]`).
- Do **not** invent ad-hoc z-index values on overlays inside transformed ancestors.
- Document any new portal layer in `portal-layers.ts` before use.

### 5. Debugging & code quality strictness

When fixing bugs or adding features, agents MUST:

1. **Reproduce mentally** — identify the exact state machine (selection, drag, storage key, view).
2. **Prefer root cause** over UI workarounds (e.g. don’t raise z-index to hide stacking traps; portal instead).
3. **No silent `catch {}`** on user-visible paths without a toast, log, or intentional comment (`/* ignore */` only for non-critical).
4. **Typed messaging** — background `type:` strings that the UI depends on must stay consistent; avoid stringly-typed renames without grepping callers.
5. **Multi-select integrity** — any bulk action (tag, archive, delete, export) must apply to **all** selected ids, not only the first.
6. **Locale keys** — never ship UI English-only; add `en.json` + all locales before finishing.
7. **Entrypoint parity** — popup / sidepanel / app share `AppLayout`; do not fork feature logic per entrypoint.
8. **Svelte 5** — use `$state` / `$derived` / `$props` / `$effect`; no legacy `export let` for new code.
9. **No browser `confirm()` / `alert()`** — use ConfirmDialog / toast.
10. **DOM depth** — avoid pure pass-through wrappers (div/span/components) that add no layout, a11y, events, or state.

### 6. Cross-browser (Firefox / Safari) polish

- Use `browser` from `wxt/browser` (not `chrome.*` alone).
- Avoid Chrome-only APIs without feature detection (`browser.management`, optional permissions).
- Prefer standard CSS; keep `-webkit-overflow-scrolling: touch` and `scrollbar-width` for scroll containers.
- Manifest `browser_specific_settings.gecko` must stay valid; Safari builds use the same MV3 shell via WXT targets.
- Test critical paths (storage, alarms, content script fill) with opaque CORS / no-cors assumptions in mind.

### 7. Shared UI Component Reuse (Mandatory)

Before creating custom Tailwind cards, search boxes, status badges, or empty states in any view or component, agents MUST inspect and reuse established UI primitives and composites:

- **Setting Cards**: Use `<SettingCard>` for setting card shells (`bg-md-surface-container rounded-2xl p-4 shadow-sm border`).
- **Search Headers**: Use `<SearchFilterHeader>` for top search/filter control rows across list views.
- **Status Badges & Chips**: Use `<Badge variant="..." />` (`primary`, `success`, `warning`, `error`, `neutral`, `tag`, `outline`).
- **Empty List States**: Use `<EmptyState icon="..." title="..." description="..." actionLabel="..." onAction={...} />`.
- **Loading Skeletons**: Use `<Skeleton width="..." height="..." radius="..." />` instead of inline `animate-pulse` markup.

### 8. Action Button Layout & Typography Rules (Mandatory)

For action button rows across Mailbox view, Account Selector popup, and Addresses page selection strips:

1. **No Truncation, No Text Wrapping**:
   - Button text labels must NOT truncate (`truncate` or `overflow-hidden` are prohibited on labels).
   - Labels must enforce single-line text (`whitespace-nowrap` + `overflow-visible`).
2. **Priority Cascade (P0 -> P1 -> P2)**:
   - **P0 (Equal Width + Equal Height + MD3 Sizing)**: Default state. All buttons use equal width (`flex-1`), equal height (`h-8.5` / `h-9`), and standard MD3 12px typography. Active when all label texts fit equal-width shares.
   - **P1 (Content-Adjusted Widths + MD3 Typography)**: If equal width causes any text label to overflow at 12px MD3 font size, buttons switch to content-adjusted widths (`flex-auto`) while keeping standard 12px typography. Active when total content width fits container.
   - **P2 (Proportionally Reduced Font & Icon Size + Content-Adjusted Widths)**: If content-adjusted widths at 12px exceed container width, font size and icon size shrink equally for all buttons in unison (`--action-btn-font` and scaled SVG icons) until the row fits without wrapping or clipping.
3. **Constant Row Width**:
   - Container width MUST remain fixed/constant (`w-full flex justify-between`) and span 100% of parent box width. The row container must never shrink horizontally or shift layout when switching tabs, accounts, or layout modes.

### 9. Content Script Messaging & Non-Blocking Rejections

- **Typed Messaging**: All `browser.runtime.sendMessage` calls between entrypoints (UI, Content Scripts, Background) MUST use `{ type: 'handler_name' }` matching the `RuntimeMessage` interface in `src/utils/types.ts`. Do **not** send un-typed `{ action: '...' }` strings.
- **Non-Blocking Rejections**: In content scripts (`src/entrypoints/content/`), asynchronous `browser.runtime.sendMessage` calls inside DOM event listeners must append `.catch(logError)` or `.catch(/* ignore */)` to prevent uncaught extension context invalidation errors in host webpage developer consoles.

### 10. Sensitive Data Clipboard Purge Policy

- Any user action that copies sensitive data (OTPs, passwords, magic link tokens, recovery keys, secret seeds) MUST use `copyToClipboardAndSchedulePurge(text, delayMs)` (default 30s for OTPs/passwords, 60s for generic text) with user-facing toast feedback.

### 11. View Name Consistency & Global Refactoring Strictness (Mandatory)

1. **Single Source of Truth**: The `View` type in `src/features/types/view-types.ts` and `SPLIT_HOST` registry in `src/ui/views/view-registry.ts` are the strict single sources of truth for all view identifiers.
2. **Canonical View Mapping**:
   - `mailbox`: Primary mailbox and message thread reading view (never `main`).
   - `addresses`: Email address and inbox management page (never `mailboxManagement` or `mailSettings`).
   - `settings`: Main extension settings hub (never `mailSettings`).
   - `organize`: Unified Tags, Labels, and Filters hub.
   - `autofill`: Profiles and Credentials hub.
3. **Exhaustive Propagated Renames**: Whenever a view name, prop name, or storage key is renamed or modified, agents MUST perform a global search and update **every single reference** across the codebase in the same turn. This includes:
   - Type definitions (`src/features/types/view-types.ts`)
   - Registry metadata (`src/ui/views/view-registry.ts`)
   - Shell layouts & navs (`AppLayout.svelte`, `SidebarNav.svelte`, `Footer.svelte`, `Header.svelte`)
   - View components (`ExtensionSettingsView.svelte`, `AddressesView.svelte`, etc.)
   - Utilities (`sidebar-fab.ts`, `view-display-names.ts`)
   - Shortcuts, tour steps, and background handlers (`shortcuts.ts`, `tour-steps.ts`, `background/index.ts`)
4. **Zero Legacy Aliases**: Never leave partial string aliases, fallback checks for old names, or split logic across files. Any view rename must be 100% atomic and unified across all entrypoints.

### 12. Allowed Tools for Code Editing (Mandatory)

1. **Native Built-in Editing Tools Only**: Agents MUST use standard built-in file editing tools (`replace_file_content`, `multi_replace_file_content`, `write_to_file`) when creating or modifying code files in the project.
2. **No Script-Based File Modifications Without Explicit Permission**: Running external shell scripts or execution commands (e.g. PowerShell scripts, Bash one-liners, Python/Node regex replacers) to modify source code files is strictly prohibited. If a task requires a script-based bulk edit, agents MUST ask for explicit user permission first before executing any such script.

## Agent Configurations

<!-- Add your agent configurations here -->

## Usage

<!-- Add usage instructions here -->


