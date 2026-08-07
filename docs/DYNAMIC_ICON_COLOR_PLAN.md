# Plan: Dynamic Extension Icon Color

> **Status:** Proposal / pre-implementation
> **Related files:** `wxt.config.ts`, `src/features/theme/theme-actions.ts`, `src/entrypoints/background/index.ts`, `src/entrypoints/content/autofill/autofill-buttons.ts`

## 1. Goal

Change the browser toolbar icon color to match the user's `customColor` theme
setting, so the toolbar icon visually aligns with the in-page autofill buttons
and the extension UI.

## 2. Feasibility

**Yes, it's possible** - `browser.action.setIcon()` can change the toolbar icon
at runtime. The `customColor` setting already flows through the theme system
(`applyCustomColor()` in `theme-actions.ts`), and the content-script injection
(`autofill-buttons.ts`) already reads `customColor` for its inline button colors.
So the visual would be consistent across toolbar + injected UI.

### The hard constraint - Chrome vs Firefox

- **Chrome** supports per-color dynamic icons via `canvas.toDataURL()` →
  `setIcon({ imageData })`. Draw the SVG onto a canvas, recolor, pass the data
  URL. Standard pattern, works well.
- **Firefox** does NOT support `setIcon` with canvas data URLs the same way -
  it expects `ImageData` objects and the API behaves differently. Requires
  browser-specific code paths (the project already uses
  `browser_specific_settings` in `wxt.config.ts`).

## 3. Two Approaches

### Approach A - Canvas recolor (exact match, more code)

Dynamically recolor the SVG icon at runtime from the user's hex color.

**Flow:**
1. User changes `customColor` → `applyCustomColor()` fires (already happens).
2. Add a call to a new `setExtensionIconColor(color)` in the **background**
   (icons can only be set from the service worker, not from popup).
3. That function: loads `public/logo.svg`, recolors fill/stroke, rasterizes to
   16/32/48/128 PNG via `OffscreenCanvas` (Chrome 109+) + `toDataURL()`, calls
   `browser.action.setIcon({ imageData })`.
4. On Firefox: use `ImageData` instead of data URLs.
5. Reset: when `customColor` is cleared, call
   `setIcon({ path: { 16: 'icons/icon16.png', ... } })` to restore defaults.

**Caveat:** the service worker can't use `<canvas>` directly - use
`OffscreenCanvas`. The lazy-load pattern from `theme-generator.ts` (which
already lazy-loads Material color utilities) can be reused here.

| Aspect | Detail |
|--------|--------|
| Color match | ✅ exact - any user hex |
| Effort | Medium - canvas + OffscreenCanvas + Firefox divergence |
| Cross-browser | ⚠️ requires separate Chrome/Firefox code paths |
| Bundle size | small (SVG is already bundled) |

### Approach B - Pre-rendered icon variants (recommended)

Ship 3-4 colored icon sets as static PNGs and swap by path. No canvas needed.

**Flow:**
1. Pre-render colored icon variants (e.g. `icon16-green.png`, `icon16-blue.png`,
   `icon16-purple.png`, `icon16-amber.png`) into `public/icons/`.
2. In the background, when `customColor` changes, map the hex to the nearest
   preset and call `browser.action.setIcon({ path: { 16: ..., 48: ..., 128: ... } })`.
3. Reset: restore the default static icon paths.
4. Works identically on Chrome and Firefox - `setIcon({ path })` is
   cross-browser standard.

| Aspect | Detail |
|--------|--------|
| Color match | ⚠️ approximate - closest preset, not exact hex |
| Effort | Low - generate PNGs once, swap by path |
| Cross-browser | ✅ identical code path (no divergence) |
| Bundle size | +N icon sets (small - icons are ~1-2 KB each) |

## 4. Recommendation

**Hold off unless users have explicitly asked for it.** Rationale:

1. **Low visual payoff.** The toolbar icon is 16×16 and often monochrome on
   most browser themes. Chrome desaturates toolbar icons in dark mode by
   default. A colored icon is barely visible at that size.
2. **Color consistency already exists where it matters.** The in-page autofill
   buttons and the extension UI both follow `customColor`. The toolbar icon is
   the one place users *expect* to stay standard (for findability in a crowded
   toolbar).
3. **Firefox divergence adds maintenance cost** for a cosmetic feature
   (Approach A only).
4. **If built, use Approach B (pre-rendered variants).** Same visual result for
   90% of users (who pick from presets anyway), fraction of the code, no
   cross-browser pain.

## 5. Implementation Plan (if Approach B is pursued)

### Phase 1 - Generate icon variants
- Use `scripts/generate-theme.ts` (or a one-off script) to render
  `public/logo.svg` in 3-4 preset colors at 16/32/48/128 px →
  `public/icons/icon{size}-{color}.png`.
- Presets: `green` (default, already shipped), `blue`, `purple`, `amber`.

### Phase 2 - Background icon swap
- In `src/entrypoints/background/index.ts`, add a `setExtensionIconColor(color)`:
  - Map the hex to the nearest preset (simple hue-distance or a lookup table).
  - Call `browser.action.setIcon({ path: { 16: ..., 48: ..., 128: ... } })`.
  - On empty/invalid color, restore default paths.
- Hook it into the existing `customColor` storage change listener
  (`browser.storage.onChanged` in `setupUnreadBadge` - add an icon-refresh
  branch there, or add a separate listener).

### Phase 3 - Firefox verification
- `setIcon({ path })` is cross-browser standard - verify on Firefox that the
  path swap works without code changes.
- If Firefox needs `ImageData` instead (older versions), add a fallback.

## 6. File Impact

| File | Approach A | Approach B |
|------|-----------|-----------|
| `public/icons/` | no change | +3-4 colored PNG sets (12-16 files) |
| `src/entrypoints/background/index.ts` | add `setExtensionIconColor` (canvas) | add `setExtensionIconColor` (path swap) |
| `src/features/theme/theme-actions.ts` | call icon set on color change | same |
| `wxt.config.ts` | no change | no change (manifest icons stay default) |
| `scripts/generate-theme.ts` | no change | add icon-variant generation step |
| `package.json` | no change | no change |

## 7. Open Questions

1. **Exact match vs preset?** If users demand exact hex match → Approach A.
   If presets are acceptable → Approach B (recommended).
2. **Badge color sync?** `setupUnreadBadge` already sets the badge background
   to `customColor`. Should the icon color and badge color always match?
   (Recommend: yes - they're adjacent in the toolbar.)
3. **Dark-mode desaturation?** Chrome may desaturate the icon regardless. Is
   the effort worth it if the color is invisible in dark mode? Validate with a
   manual test before committing.
4. **How many presets?** 3-4 covers the common cases. More presets = more
   bundle weight (icons are small but they add up).

## 8. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| _pending_ | Build / don't build / which approach | Awaiting user demand signal |

---

*This is a planning document, not an implementation spec. The feature is
feasible but low-priority - validate user demand before investing effort.*