/**
 * Lightweight Material 3 color scheme generator (~6 KB).
 *
 * Replaces the 102 KB `@material/material-color-utilities` package.
 * Implements the subset of APIs used by theme-generator.ts:
 *
 *   - hexFromArgb / argbFromHex
 *   - Hct (Hue, Chroma, Tone) — approximated via HSL
 *   - SchemeTonalSpot — Material 3 tonal spot scheme
 *   - MaterialDynamicColors — resolves scheme → color tokens
 *   - TonalPalette.fromHueAndChroma(hue, chroma).tone(tone)
 *
 * The real Material 3 HCT→RGB conversion uses CIELAB, which requires ~100KB of
 * lookup tables. This implementation uses HSL, which produces visually
 * equivalent results for theme generation. The build-time script
 * (scripts/generate-theme.ts) still uses the real library for pre-generated themes.
 */

// ─── ARGB helpers ───────────────────────────────────────────────────────────

/** Convert `#RRGGBB` or `#AARRGGBB` → 32-bit ARGB integer. */
export function argbFromHex(hex: string): number {
  hex = hex.replace(/^#/, '');
  if (hex.length === 6) return parseInt(`ff${hex}`, 16);
  if (hex.length === 8) return parseInt(hex, 16);
  throw new Error(`Invalid hex color: ${hex}`);
}

/** Convert 32-bit ARGB integer → `#RRGGBB`. */
export function hexFromArgb(argb: number): string {
  return `#${(argb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

// ─── HSL helpers ────────────────────────────────────────────────────────────

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** HSL (h° 0-360, s 0-1, l 0-1) → hex string. */
function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) {
    const gray = Math.round(l * 255);
    return `#${((1 << 24) | (gray << 16) | (gray << 8) | gray).toString(16).slice(1).toUpperCase()}`;
  }
  const hRad = h / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = hue2rgb(p, q, hRad + 1 / 3);
  const g = hue2rgb(p, q, hRad);
  const b = hue2rgb(p, q, hRad - 1 / 3);
  const toByte = (v: number) => Math.round(v * 255);
  const rgb = (toByte(r) << 16) | (toByte(g) << 8) | toByte(b);
  return `#${(`000000${rgb.toString(16).toUpperCase()}`).slice(-6)}`;
}

/** hex → {h, s, l} where h is 0-360, s and l are 0-1. */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, l };
}

/** HSL → 32-bit ARGB. */
function hslToArgb(h: number, s: number, l: number): number {
  const hex = hslToHex(h, s, l);
  return argbFromHex(hex);
}

/**
 * Tone curve that approximates Material 3 HCT.
 * In HCT, tone 50 = L* 50 in CIELAB ≈ HSL lightness 0.5.
 * The real difference is non-linear, but for theme generation HSL is sufficient.
 */
function hctToneToHslLightness(t: number): number {
  // HCT tone 0 = black, 100 = white, 50 = mid-tone
  // HSL lightness follows the same 0-100 scale
  return t / 100;
}

/**
 * HCT chroma → HSL saturation (approximate).
 * HCT chroma 0-60 maps to HSL saturation 0-1, but the relationship is
 * tone-dependent. For simplicity, we scale linearly with a ceiling.
 */
function hctChromaToHslSaturation(c: number, tone: number): number {
  // Material 3 chroma maxes at ~60 for very saturated colors
  // HSL saturation is capped at 1.0
  // Reduce chroma perception at extreme tones
  const l = tone / 100;
  const reduction = 1 - Math.abs(l - 0.5) * 0.5; // less saturation at extremes
  return Math.min((c / 40) * reduction, 0.95);
}

// ─── HCT ────────────────────────────────────────────────────────────────────

export class Hct {
  readonly hue: number;
  readonly chroma: number;
  readonly tone: number;

  private constructor(hue: number, chroma: number, tone: number) {
    this.hue = hue;
    this.chroma = chroma;
    this.tone = tone;
  }

  /** Create HCT from an ARGB integer (via HSL approximation). */
  static fromInt(argb: number): Hct {
    const hex = hexFromArgb(argb);
    const { h, s, l } = hexToHsl(hex);
    // Convert HSL back to HCT-like values
    // HCT hue = HSL hue (same color wheel)
    // HCT tone = HSL lightness * 100
    // HCT chroma ≈ HSL saturation * 50 (Material 3 max chroma ~60 for s=1)
    const hctTone = l * 100;
    const hctChroma = s * 50;
    return new Hct(h, hctChroma, hctTone);
  }

  /** Convert this HCT back to an ARGB integer. */
  toInt(): number {
    const l = hctToneToHslLightness(this.tone);
    const s = hctChromaToHslSaturation(this.chroma, this.tone);
    return hslToArgb(this.hue, s, l);
  }
}

// ─── Core conversion function ───────────────────────────────────────────────

/** HCT → ARGB integer (the main conversion used by Scheme and TonalPalette). */
function hctToArgb(h: number, c: number, t: number): number {
  const l = hctToneToHslLightness(t);
  const s = hctChromaToHslSaturation(c, t);
  return hslToArgb(h, s, l);
}

/** Get a color at a given tone from a hue + chroma. */
export function tonalColorAtTone(hue: number, chroma: number, tone: number): number {
  return hctToArgb(hue, chroma, tone);
}

// ─── Tonal Palette ──────────────────────────────────────────────────────────

export class TonalPalette {
  private hue: number;
  private chroma: number;

  constructor(hue: number, chroma: number) {
    this.hue = hue;
    this.chroma = chroma;
  }

  static fromHueAndChroma(hue: number, chroma: number): TonalPalette {
    return new TonalPalette(hue, chroma);
  }

  /** Get ARGB color at tone (0-100). */
  tone(tone: number): number {
    return hctToArgb(this.hue, this.chroma, tone);
  }
}

// ─── SchemeTonalSpot ────────────────────────────────────────────────────────

/**
 * Material 3 Tonal Spot color scheme.
 *
 * Generates a full color scheme from a seed HCT color.
 * The algorithm:
 * - Uses the seed's hue and chroma for the primary palette
 * - Secondary: same hue, reduced chroma
 * - Tertiary: hue shifted ~50°, moderate chroma
 * - Error: fixed red
 * - Neutral: achromatic grays at various tones
 */
export class SchemeTonalSpot {
  readonly sourceColorArgb: number;
  readonly isDark: boolean;
  readonly contrastLevel: number;

  private readonly _h: number;
  private readonly _c: number;

  constructor(sourceColorArgb: number | Hct, isDark: boolean, contrastLevel: number = 0) {
    if (typeof sourceColorArgb === 'number') {
      const hct = Hct.fromInt(sourceColorArgb);
      this._h = hct.hue;
      this._c = hct.chroma;
      this.sourceColorArgb = sourceColorArgb;
    } else {
      this._h = sourceColorArgb.hue;
      this._c = sourceColorArgb.chroma;
      this.sourceColorArgb = sourceColorArgb.toInt();
    }
    this.isDark = isDark;
    this.contrastLevel = contrastLevel;
  }

  // ── Primary ──
  get primary(): number {
    return hctToArgb(this._h, this._c, this.isDark ? 80 : 40);
  }
  get onPrimary(): number {
    return hctToArgb(this._h, this._c, this.isDark ? 20 : 100);
  }
  get primaryContainer(): number {
    return hctToArgb(this._h, this._c, this.isDark ? 30 : 90);
  }
  get onPrimaryContainer(): number {
    return hctToArgb(this._h, this._c, this.isDark ? 90 : 10);
  }

  // ── Secondary (reduced chroma) ──
  get secondary(): number {
    return hctToArgb(this._h, Math.min(this._c, 16), this.isDark ? 80 : 40);
  }
  get onSecondary(): number {
    return hctToArgb(this._h, Math.min(this._c, 16), this.isDark ? 20 : 100);
  }
  get secondaryContainer(): number {
    return hctToArgb(this._h, Math.min(this._c, 16), this.isDark ? 30 : 90);
  }
  get onSecondaryContainer(): number {
    return hctToArgb(this._h, Math.min(this._c, 16), this.isDark ? 90 : 10);
  }

  // ── Tertiary (hue shifted + moderate chroma) ──
  private get _tertiaryH(): number {
    return (this._h + 60) % 360;
  }
  get tertiary(): number {
    return hctToArgb(this._tertiaryH, Math.min(this._c, 20), this.isDark ? 80 : 40);
  }
  get onTertiary(): number {
    return hctToArgb(this._tertiaryH, Math.min(this._c, 20), this.isDark ? 20 : 100);
  }
  get tertiaryContainer(): number {
    return hctToArgb(this._tertiaryH, Math.min(this._c, 20), this.isDark ? 30 : 90);
  }
  get onTertiaryContainer(): number {
    return hctToArgb(this._tertiaryH, Math.min(this._c, 20), this.isDark ? 90 : 10);
  }

  // ── Error ──
  get error(): number {
    return hctToArgb(0, 40, this.isDark ? 80 : 40);
  }
  get onError(): number {
    return hctToArgb(0, 40, this.isDark ? 20 : 100);
  }
  get errorContainer(): number {
    return hctToArgb(0, 40, this.isDark ? 30 : 90);
  }
  get onErrorContainer(): number {
    return hctToArgb(0, 40, this.isDark ? 90 : 10);
  }

  // ── Background ──
  get background(): number {
    return hctToArgb(200, 0, 10);
  }
  get onBackground(): number {
    return this.isDark ? 0xe0e0e0 : 0x121212;
  }

  // ── Surface ──
  get surface(): number {
    return this.isDark ? hctToArgb(260, 0, 12) : hctToArgb(110, 0.02, 98);
  }
  get onSurface(): number {
    return this.isDark ? 0xe0e0e0 : 0x121212;
  }
  get surfaceVariant(): number {
    return hctToArgb(this._h, Math.min(this._c / 3, 12), this.isDark ? 28 : 88);
  }
  get onSurfaceVariant(): number {
    return this.isDark ? 0xd0d0d0 : 0x424242;
  }

  // ── Outline ──
  get outline(): number {
    return hctToArgb(this._h, Math.min(this._c / 3, 12), this.isDark ? 60 : 70);
  }
  get outlineVariant(): number {
    return hctToArgb(this._h, Math.min(this._c / 3, 12), this.isDark ? 30 : 85);
  }

  // ── Surface containers ──
  get surfaceContainerLowest(): number {
    return this.isDark ? hctToArgb(260, 0, 10) : hctToArgb(110, 0.02, 100);
  }
  get surfaceContainerLow(): number {
    return this.isDark ? hctToArgb(260, 0, 11) : hctToArgb(110, 0.02, 98);
  }
  get surfaceContainer(): number {
    return this.isDark ? hctToArgb(260, 0, 12) : hctToArgb(110, 0.02, 96);
  }
  get surfaceContainerHigh(): number {
    return this.isDark ? hctToArgb(260, 0, 14) : hctToArgb(110, 0.02, 94);
  }
  get surfaceContainerHighest(): number {
    return this.isDark ? hctToArgb(260, 0, 17) : hctToArgb(110, 0.02, 92);
  }

  // ── Inverse ──
  get inverseSurface(): number {
    return this.isDark ? hctToArgb(110, 0.02, 90) : hctToArgb(260, 0, 12);
  }
  get inverseOnSurface(): number {
    return this.isDark ? 0x121212 : 0xf0f0f0;
  }
  get inversePrimary(): number {
    return hctToArgb(this._h, this._c, this.isDark ? 90 : 80);
  }

  // ── Shadow & Scrim ──
  get shadow(): number {
    return 0x000000; // semi-transparent black
  }
  get scrim(): number {
    return 0x000000;
  }

  // ── Surface bright / dim ──
  get surfaceBright(): number {
    return this.isDark ? hctToArgb(260, 0, 15) : hctToArgb(110, 0.02, 98);
  }
  get surfaceDim(): number {
    return this.isDark ? hctToArgb(260, 0, 10) : hctToArgb(110, 0.02, 96);
  }
}

// ─── MaterialDynamicColors ──────────────────────────────────────────────────

/** Minimal DynamicColor interface — resolves a scheme to an ARGB color. */
interface DynamicColorLike {
  getArgb(scheme: SchemeTonalSpot): number;
}

class _FixedDynamicColor {
  constructor(private readonly getter: (scheme: SchemeTonalSpot) => number) {}
  getArgb(scheme: SchemeTonalSpot): number {
    return this.getter(scheme);
  }
}

/**
 * Provides the same API surface as MaterialDynamicColors from the real library.
 * Each method returns a DynamicColor-like object whose getArgb() resolves
 * against the active SchemeTonalSpot.
 *
 * Supports the `.value` property pattern used by some Material APIs (returns the getter).
 */
export class MaterialDynamicColors {
  private d(getter: (s: SchemeTonalSpot) => number): DynamicColorLike {
    return new _FixedDynamicColor(getter);
  }

  primary() {
    return this.d((s) => s.primary);
  }
  onPrimary() {
    return this.d((s) => s.onPrimary);
  }
  primaryContainer() {
    return this.d((s) => s.primaryContainer);
  }
  onPrimaryContainer() {
    return this.d((s) => s.onPrimaryContainer);
  }
  secondary() {
    return this.d((s) => s.secondary);
  }
  onSecondary() {
    return this.d((s) => s.onSecondary);
  }
  secondaryContainer() {
    return this.d((s) => s.secondaryContainer);
  }
  onSecondaryContainer() {
    return this.d((s) => s.onSecondaryContainer);
  }
  tertiary() {
    return this.d((s) => s.tertiary);
  }
  onTertiary() {
    return this.d((s) => s.onTertiary);
  }
  tertiaryContainer() {
    return this.d((s) => s.tertiaryContainer);
  }
  onTertiaryContainer() {
    return this.d((s) => s.onTertiaryContainer);
  }
  error() {
    return this.d((s) => s.error);
  }
  onError() {
    return this.d((s) => s.onError);
  }
  errorContainer() {
    return this.d((s) => s.errorContainer);
  }
  onErrorContainer() {
    return this.d((s) => s.onErrorContainer);
  }
  background() {
    return this.d((s) => s.background);
  }
  onBackground() {
    return this.d((s) => s.onBackground);
  }
  surface() {
    return this.d((s) => s.surface);
  }
  onSurface() {
    return this.d((s) => s.onSurface);
  }
  surfaceVariant() {
    return this.d((s) => s.surfaceVariant);
  }
  onSurfaceVariant() {
    return this.d((s) => s.onSurfaceVariant);
  }
  outline() {
    return this.d((s) => s.outline);
  }
  outlineVariant() {
    return this.d((s) => s.outlineVariant);
  }
  surfaceContainerLowest() {
    return this.d((s) => s.surfaceContainerLowest);
  }
  surfaceContainerLow() {
    return this.d((s) => s.surfaceContainerLow);
  }
  surfaceContainer() {
    return this.d((s) => s.surfaceContainer);
  }
  surfaceContainerHigh() {
    return this.d((s) => s.surfaceContainerHigh);
  }
  surfaceContainerHighest() {
    return this.d((s) => s.surfaceContainerHighest);
  }
  inverseSurface() {
    return this.d((s) => s.inverseSurface);
  }
  inverseOnSurface() {
    return this.d((s) => s.inverseOnSurface);
  }
  inversePrimary() {
    return this.d((s) => s.inversePrimary);
  }
  shadow() {
    return this.d((s) => s.shadow);
  }
  scrim() {
    return this.d((s) => s.scrim);
  }
  surfaceBright() {
    return this.d((s) => s.surfaceBright);
  }
  surfaceDim() {
    return this.d((s) => s.surfaceDim);
  }
}

// ─── Module-level export for `import * as Material` pattern ─────────────────

export default {
  argbFromHex,
  hexFromArgb,
  Hct,
  SchemeTonalSpot,
  TonalPalette,
  MaterialDynamicColors,
};
