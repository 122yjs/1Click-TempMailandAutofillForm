/**
 * Svelte Action: actionBtnCascade
 * Enforces Rule #8 in AGENTS.md for Action Button Rows (Mailbox, Account Selector, Addresses).
 *
 * Sizing rules:
 * 1. Constant Row Width (w-full flex justify-between)
 * 2. Single-line labels (whitespace-nowrap overflow-visible)
 * 3. Priority Cascade:
 *    P0: Equal Width + MD3 12px (flex-1)
 *    P1: Content-Adjusted Width + MD3 12px (flex-auto)
 *    P2: Scaled Font/Icon Size + Content-Adjusted (font scaling)
 */

export function actionBtnCascade(node: HTMLElement): { destroy(): void } {
  let resizeObserver: ResizeObserver | null = null;

  function evaluateCascade() {
    const buttons = Array.from(node.querySelectorAll<HTMLElement>('button, a, [role="button"]'));
    if (!buttons.length) return;

    // Ensure all labels enforce single-line text
    for (const btn of buttons) {
      const labels = btn.querySelectorAll<HTMLElement>('.btn-label, span');
      for (const label of labels) {
        label.style.whiteSpace = 'nowrap';
        label.style.overflow = 'visible';
      }
    }

    const containerWidth = node.clientWidth;
    if (containerWidth <= 0) return;

    // Test P0: Equal width flex-1
    node.dataset.cascadeState = 'P0';
    node.style.fontSize = '';

    let totalContentWidth = 0;
    for (const btn of buttons) {
      totalContentWidth += btn.scrollWidth;
    }

    if (totalContentWidth <= containerWidth) {
      // P0 fits cleanly
      return;
    }

    // Switch to P1: Content-adjusted widths
    node.dataset.cascadeState = 'P1';

    if (node.scrollWidth <= containerWidth) {
      return;
    }

    // Switch to P2: Scaled Font & Icon Size
    node.dataset.cascadeState = 'P2';
    const overflowRatio = containerWidth / Math.max(1, node.scrollWidth);
    const targetFontSize = Math.max(10, Math.floor(12 * overflowRatio * 10) / 10);
    node.style.fontSize = `${targetFontSize}px`;
  }

  resizeObserver = new ResizeObserver(() => {
    requestAnimationFrame(evaluateCascade);
  });

  resizeObserver.observe(node);
  evaluateCascade();

  return {
    destroy() {
      resizeObserver?.disconnect();
    },
  };
}
