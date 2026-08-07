/**
 * Shared dynamic font-sizing for single-line button/nav labels.
 * Shrinks font until every label fits its container without truncation/wrap.
 */

export type FitLabelFontOptions = {
  /** CSS font-weight (default 600) */
  weight?: number | string;
  /** Starting font size in px */
  basePx?: number;
  /** Minimum font size in px */
  minPx?: number;
  /** Extra width reserved (icon + padding + gaps) */
  reservedPx?: number;
  /** Font family stack */
  fontFamily?: string;
};

const DEFAULT_FONT =
  'system-ui, Roboto, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

/**
 * Measure labels against available widths and return a font-size (px) that fits all.
 * @param labelsWithWidth array of { text, availableWidth } where availableWidth is the button/item content box
 */
export function fitLabelFontSize(
  labelsWithWidth: Array<{ text: string; availableWidth: number }>,
  options: FitLabelFontOptions = {}
): number {
  const weight = options.weight ?? 600;
  const base = options.basePx ?? 13;
  const minPx = options.minPx ?? 8.5;
  const reserved = options.reservedPx ?? 0;
  const fontFamily = options.fontFamily ?? DEFAULT_FONT;

  if (typeof document === 'undefined' || !labelsWithWidth.length) return base;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return base;

  let size = base;
  while (size >= minPx) {
    ctx.font = `${weight} ${size}px ${fontFamily}`;
    let fits = true;
    for (const { text, availableWidth } of labelsWithWidth) {
      if (!text) continue;
      const need = ctx.measureText(text).width + reserved;
      if (need > availableWidth - 2) {
        fits = false;
        break;
      }
    }
    if (fits) break;
    size -= 0.25;
  }
  return Math.round(size * 100) / 100;
}

export type FitActionButtonsResult = {
  /** Font size in px */
  fontPx: number;
  /** Layout mode: P0 = equal width, P1 = content-adjusted width, P2 = reduced font + content-adjusted width */
  mode: 'P0' | 'P1' | 'P2';
  /** Whether buttons should use equal width (flex-1) */
  equalWidth: boolean;
};

/**
 * Priority Hierarchy for Action Buttons:
 * P0: Equal width + equal height + MD3 sizing (12px)
 * P1: Adjust button widths while keeping MD3 typography (12px)
 * P2: Reduce font size (equally for all buttons) + adjust widths
 */
export function fitActionButtonsLayout(
  items: Array<{ text: string }>,
  containerWidth: number,
  options: FitLabelFontOptions & { gapPx?: number } = {}
): FitActionButtonsResult {
  const weight = options.weight ?? 700;
  const basePx = options.basePx ?? 12;
  const minPx = options.minPx ?? 8.5;
  const reservedPx = options.reservedPx ?? 36;
  const gapPx = options.gapPx ?? 6;
  const fontFamily = options.fontFamily ?? DEFAULT_FONT;

  if (typeof document === 'undefined' || !items.length || containerWidth <= 0) {
    return { fontPx: basePx, mode: 'P0', equalWidth: true };
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return { fontPx: basePx, mode: 'P0', equalWidth: true };

  const N = items.length;
  const totalGaps = (N - 1) * gapPx;
  const availableTotalWidth = containerWidth - totalGaps;
  const equalWidthShare = availableTotalWidth / N;

  // 1. Measure all labels at standard MD3 base font size (basePx, e.g. 12px)
  ctx.font = `${weight} ${basePx}px ${fontFamily}`;
  const widthsAtBase = items.map((item) =>
    item.text ? ctx.measureText(item.text).width + reservedPx : reservedPx
  );

  // Check P0: Equal width + equal height + MD3 sizing
  const fitsEqualWidth = widthsAtBase.every((w) => w <= equalWidthShare - 1);
  if (fitsEqualWidth) {
    return { fontPx: basePx, mode: 'P0', equalWidth: true };
  }

  // Check P1: Adjust button widths while keeping MD3 typography (basePx)
  const sumWidthsAtBase = widthsAtBase.reduce((a, b) => a + b, 0);
  if (sumWidthsAtBase <= availableTotalWidth - 1) {
    return { fontPx: basePx, mode: 'P1', equalWidth: false };
  }

  // P2: Reduce font size (equally for all buttons) + adjust widths
  let size = basePx;
  while (size > minPx) {
    size -= 0.25;
    ctx.font = `${weight} ${size}px ${fontFamily}`;
    let sum = 0;
    for (const item of items) {
      const w = item.text ? ctx.measureText(item.text).width + reservedPx : reservedPx;
      sum += w;
    }
    if (sum <= availableTotalWidth - 1) {
      break;
    }
  }

  const fontPx = Math.max(minPx, Math.round(size * 100) / 100);
  return { fontPx, mode: 'P2', equalWidth: false };
}

/**
 * Fit font for a set of buttons (uses each button's clientWidth and a label selector).
 */
export function fitButtonsLabelFont(
  buttons: HTMLElement[],
  labelSelector = 'span.leading-tight, span.whitespace-nowrap, span.truncate, .btn-label',
  options: FitLabelFontOptions = {}
): number {
  const items = buttons.map((btn) => {
    const el = btn.querySelector(labelSelector);
    const text = (el?.textContent || btn.textContent || '').trim();
    return { text };
  });
  const container = buttons[0]?.parentElement;
  const containerWidth = container?.clientWidth || 0;
  const res = fitActionButtonsLayout(items, containerWidth, options);
  return res.fontPx;
}
