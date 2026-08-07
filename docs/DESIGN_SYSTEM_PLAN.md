# Plan: Multiple Design System Offering

> **Status:** Proposal / pre-implementation
> **Owner:** UnarchiveTech
> **Related files:** `src/utils/theme-generator.ts`, `src/features/theme/theme-actions.ts`, `tailwind.config.js`, `src/styles/theme.css`

## 1. Goal

Some users dislike Material You and want an alternative design system (Carbon,
Fluent 2, etc.). Today the extension ships **one** design system - Material 3 -
driven by a single seed color. This document plans how to offer additional
design systems while being honest about the trade-offs.

## 2. Motivation

- Material You's personalization (seed → full tonal scheme) is powerful, but its
  rounded shapes, soft elevation, and tonal containers are a *taste*, not a
  universal preference.
- Users coming from IBM/enterprise tooling may prefer Carbon's sharp, flat,
  high-density look. Users on Windows/Microsoft ecosystems may prefer Fluent 2's
  acrylic + reveal aesthetic.
- A fixed "preset palette" switch is low-cost and gives meaningful variety even
  without a full design-system swap.

## 3. Current Architecture (ground truth)

The theming stack has three layers that any plan must respect:

### 3.1 Token layer - Tailwind → CSS variables

`tailwind.config.js` exposes ~30 semantic color tokens, each backed by a CSS
variable:

```
md-primary          → var(--md-primary)
md-on-primary       → var(--md-on-primary)
md-primary-container → var(--md-primary-container)
md-secondary / -container / on-*
md-tertiary  / -container / on-*
md-error / -container / on-*
md-success / md-warning (and on-* variants)
md-surface / md-on-surface / md-surface-variant / md-on-surface-variant
md-surface-container-lowest / -low / -container / -high / -highest  (5 tiers)
md-background / md-on-background
md-outline / md-outline-variant
md-inverse-surface / md-inverse-on-surface / md-inverse-primary
md-shadow / md-scrim
```

Components consume these via Tailwind classes (`bg-md-primary`,
`text-md-on-surface`, `rounded-2xl`, etc.). **No component references a raw
hex value** - everything flows through the CSS variables.

### 3.2 Generator layer - `theme-generator.ts`

`applyThemeFromSeed(seedColor, isDark, contrastLevel)` uses
`@material/material-color-utilities` (lazy-loaded, ~104 KB chunk) to turn **one
seed hex** into the entire 30-token scheme via `SchemeTonalSpot`. This is the
Material You superpower: perceptual HCT color science → full tonal palette from
one input.

`success`/`warning` are **not** part of Material's spec - they're hand-derived
from `TonalPalette` at hue 142/85 (`theme-generator.ts:71-83`).

### 3.3 Application layer - `theme-actions.ts`

- `applyTheme(mode, contrast)` sets `data-theme="{light|dark}-{standard|medium|high}"`
  on `<html>`. The static CSS in `src/styles/theme.css` provides default values
  for all `--md-*` tokens keyed off that attribute.
- `applyCustomColor(color)` overrides the defaults by calling
  `applyThemeFromSeed()` and writing inline `--md-*` properties on `<html>`.
- Settings persisted: `themeMode`, `customColor`, `contrastLevel`
  (in `browser.storage.local`).

### 3.4 Shape is NOT tokenized

Border radius (`rounded-2xl`, `rounded-xl`), shadows, padding, and
`font-family` are **hardcoded in component Tailwind classes** - they are
Material-shaped, not switchable via variables. This is the third, often
underestimated, challenge (see §4.3).

## 4. The Three Core Challenges

### 4.1 Color role mapping is lossy

Material 3 has roles that Carbon and Fluent 2 simply **do not have**:

| Material role (used in this codebase) | Has a peer? |
|---------------------------------------|-------------|
| `primary` / `on-primary` | ✅ both Carbon & Fluent |
| `secondary` | ⚠️ loose (Carbon `$interactive`, Fluent `neutralStroke1`) |
| **`tertiary` / `tertiary-container`** | ❌ **no equivalent** in either |
| **`primary-container` / `on-primary-container`** | ❌ no real equivalent - this is Material's "tonal button" concept |
| `error` / `error-container` | ⚠️ error yes; container tier is Material-only |
| `success` / `warning` | ✅ both (`$support-*` / `colorPalette*Background`) |
| `surface` / `on-surface` | ✅ yes |
| `surface-variant` | ⚠️ loose |
| **`surface-container-{lowest,low,container,high,highest}` (5 tiers)** | ❌ Carbon has **2** tiers (`$layer`, `$layer-active`); Fluent has ~6 numbered (`neutralBackground1-6`) - count mismatch |
| `outline` / `outline-variant` | ✅ yes |
| `inverse-*` | ⚠️ loose |
| `scrim` | ✅ yes (`$overlay` / `backgroundOverlay`) |

Conversely, Carbon/Fluent have roles Material lacks:
- Carbon: `$focus` / `$focus-inset` (dedicated focus ring - Material has none;
  we fake focus with `outline`).
- Fluent: `neutralForeground1/2/3/4` (4-level text hierarchy vs Material's 2).

**Implication:** re-mapping Material tokens onto Carbon/Fluent will either drop
`tertiary`/`*-container`/5-tier-surface into `primary`/`secondary`/a 2-tier
surface (losing nuance), or require synthesizing those values ourselves.

### 4.2 Seed generation is Material-exclusive

`@material/material-color-utilities`' `Scheme.fromSeed()` is genuinely unique:
HCT-based perceptual tonal palette generation from one hex input.

- **Carbon** ships **fixed themes** (white / g10 / g90 / g100) - no "pick any
  color" UX.
- **Fluent 2** has an accent slot but not a full tonal-scheme generator.

**Implication:** the "choose a custom theme color" feature would be
**Material-only**. Users picking Carbon get IBM's fixed palettes; picking Fluent
get Microsoft's fixed palettes. A hand-rolled HSL tint generator for the others
is possible but visibly worse than HCT, especially in dark mode.

### 4.3 Shape is not tokenized (color swap ≠ design system swap)

Components use `rounded-2xl`, soft `0.1s` transitions, elevation via surface
tone, generous padding - all **Material shape language** baked into Tailwind
classes. Swapping only color variables yields **Material layout painted in
Carbon colors** - a hybrid that satisfies neither camp.

- Real Fluent 2 = acrylic + reveal + 4px radius + 0–2px shadows.
- Real Carbon = sharp 0px corners + IBM Plex font + flat + strict 8px grid.

To genuinely offer those systems, shape tokens (radius, shadow, spacing,
font-family) must also be tokenized and switchable.

## 5. Options Considered

### Option A - Curated Material Presets (lowest effort, honest)

Ship 4–6 hand-curated Material schemes (e.g. "Forest", "Ocean", "Sunset",
"Mono") as **fixed seed values**, framed as *themes*, not as switching to
another design system.

| Aspect | Detail |
|--------|--------|
| Effort | Near-zero - reuse existing `applyThemeFromSeed` machinery |
| Seed generation | ✅ preserved (it's still Material) |
| Role mapping | N/A (same system) |
| Shape | unchanged Material |
| User value | Variety for people who dislike the default green, without claiming to be "Carbon" |
| Honesty | ✅ high - no false promise of a different design system |
| Bundle size | no change |

### Option B - Fixed Carbon/Fluent Palettes Mapped to `--md-*` (medium effort, hybrid)

Ship one fixed Carbon palette and one fixed Fluent palette, each re-mapped onto
the existing `--md-*` token names via a mapping table. Be transparent in the UI
that "custom color" personalization is Material-only; Carbon/Fluent are fixed.

| Aspect | Detail |
|--------|--------|
| Effort | Medium - one mapping table per system; data-only, no new deps if values are hand-extracted |
| Seed generation | ❌ Material-only |
| Role mapping | ⚠️ lossy (tertiary, containers, 5-tier surface collapse) |
| Shape | still Material-shaped (color swap only) |
| User value | "Feels more Carbon/Fluent-colored" - acceptable if labeled as a *palette*, not a full design system |
| Honesty | ⚠️ medium - must be labeled carefully to avoid the Frankenstein complaint |
| Bundle size | small if values are inline JSON; large if bundling `@carbon/styles` / `@fluentui/tokens` |

### Option C - True Multi Design-System via Abstract Tokens (highest effort, real)

Introduce a design-system token abstraction (`ds-surface`, `ds-primary`,
`ds-radius`, `ds-shadow`, `ds-font`) that each design system provides a value
map for, and have components consume the abstract tokens. Add shape tokens
(radius, shadow, spacing, font-family) that switch per system.

| Aspect | Detail |
|--------|--------|
| Effort | High - refactor every component's class names + add a shape-token system that doesn't exist yet |
| Seed generation | Material-only; others fixed |
| Role mapping | ✅ clean (each system defines its own full map) |
| Shape | ✅ genuinely switches (radius/shadow/font/spacing) |
| User value | "I want Fluent, not Material" - actually delivered |
| Honesty | ✅ high |
| Bundle size | each system adds a token map; shape tokens are tiny |

## 6. Recommendation

**Start with Option A**, keep Option B as a follow-up, treat Option C as a
future product decision - not a nice-to-have.

**Rationale:**
- Option A delivers ~80% of the user value (variety) at ~5% of the cost, and
  keeps the seed-generation differentiator intact.
- Option B is worth doing *only if* "Carbon/Fluent-colored" (not shaped) is
  acceptable to users - validate this with users before building.
- Option C is the only path that truly satisfies "I dislike Material's *shape*,
  not just its *colors*." It's a real product feature, not a settings toggle.
  Do it only if "multi design-system" is a stated product goal.

## 7. Implementation Phases (if Option B or C is pursued)

### Phase 0 - Validation (no code)
- Survey / user feedback: do dissenters dislike Material's **colors** or its
  **shape**? This determines A vs B vs C.
- Confirm which systems to support first (Carbon vs Fluent vs both).

### Phase 1 - Token abstraction (prerequisite for B and C)
- Introduce a `DesignSystem` config type with a `colors` map and (for C) a
  `shape` map.
- Add `selectedDesignSystem` to settings/storage.
- Refactor `theme-actions.ts` so the apply path branches on design system:
  - Material → existing `applyThemeFromSeed`.
  - Carbon/Fluent → apply a fixed token map to `--md-*` (B) or `--ds-*` (C).

### Phase 2 - Carbon/Fluent palette maps (Option B)
- Hand-extract fixed light + dark palettes for each system into a
  `src/config/design-systems/` JSON/TS file (data-only, no runtime dep).
- Write the role-mapping table per §4.1, documenting where Material roles
  collapse (tertiary → primary, 5-tier surface → 2-tier, etc.).
- UI: design-system selector in settings; disable "custom color" when a
  non-Material system is selected.

### Phase 3 - Shape tokens (Option C only)
- Add shape CSS variables: `--ds-radius-sm/md/lg/xl`, `--ds-shadow-sm/md/lg`,
  `--ds-font-family`, `--ds-spacing-unit`.
- Add them to `tailwind.config.js` as `ds-radius-*`, `ds-shadow-*`, etc.
- Audit every component for hardcoded `rounded-*` / shadow / font classes and
  migrate to the `ds-*` tokens. (This is the bulk of the work.)
- Each design system's config provides a shape map.

### Phase 4 - Polish
- Focus-ring handling: Material fakes focus with `outline`; Carbon has a
  dedicated `$focus` token. Decide whether to expose a `--ds-focus` token.
- Animations/transitions: Material uses `0.1s`; Carbon is snappier. Consider a
  `--ds-transition` token.
- Bundle: import **only** the palette/token data from Carbon/Fluent packages,
  not the full style sheets, to avoid a size blowup.

## 8. File Impact Analysis

| File | Option A | Option B | Option C |
|------|----------|----------|----------|
| `tailwind.config.js` | no change | no change | add `ds-*` shape tokens |
| `src/utils/theme-generator.ts` | no change | add `applyFixedPalette()` | add DS dispatch |
| `src/features/theme/theme-actions.ts` | no change | branch on DS | branch on DS + shape |
| `src/styles/theme.css` | no change | no change | add `--ds-*` defaults |
| `src/config/` (new) | - | `design-systems/*.json` | `design-systems/*.json` + shape maps |
| `src/views/ExtensionSettingsView.svelte` | add preset picker | add DS selector + disable custom color | add DS selector + shape preview |
| `src/utils/types.ts` | - | add `DesignSystem` type + storage key | + shape types |
| `src/utils/storage-keys.ts` | - | add `selectedDesignSystem` key | same |
| All `*.svelte` components | no change | no change | **migrate hardcoded shape classes → `ds-*`** |
| `package.json` | no change | maybe add palette data deps | same |

## 9. Risks & Open Questions

1. **"Frankenstein" risk (Option B):** Material shape + Carbon color may look
   worse than either pure system. Validate with users before shipping B.
2. **Role collapse documentation:** Whatever collapses (tertiary → primary,
   5-tier → 2-tier surface) must be explicitly documented so future maintainers
   don't expect 1:1 parity.
3. **Bundle size:** `@material/material-color-utilities` is already a ~104 KB
   chunk. Adding `@carbon/styles` / `@fluentui/tokens` naively could double it.
   Prefer inline data-only extraction.
4. **Contrast levels:** Material has 3 contrast tiers; Carbon/Fluent have
   different accessibility models. Decide whether "contrast level" is
   Material-only or mapped.
5. **Content script theming:** The autofill button injection
   (`autofill-buttons.ts`) reads `customColor` from storage and applies it
   inline. A non-Material design system may need different inline color
   handling there too (the `sanitizeColor` validation still applies).
6. **i18n:** New UI strings ("Design System", "Carbon", "Fluent", preset names)
   must be added to `en.json` and mirrored to all 6 locales per AGENTS.md rule.
7. **Does "preset themes" (Option A) cannibalize demand for B/C?** Possibly -
   but A is cheap and gives real signal on whether users want more.

## 10. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| _pending_ | Choose A / B / C | Awaiting user-validation survey results |

---

*This is a planning document, not an implementation spec. Concrete code
changes should be tracked in separate tasks once an option is chosen.*


