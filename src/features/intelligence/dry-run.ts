/**
 * Dry-run preview overlay — show what would be filled before commit.
 */

import { getOrCreateShadowRoot } from '@/entrypoints/content/dom/shadow-dom.js';
import { PORTAL_Z } from '@/utils/portal-layers.js';

export type DryRunRow = { label: string; value: string; kind?: string };

export async function showDryRunPreview(opts: {
  rows: DryRunRow[];
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  const root = getOrCreateShadowRoot();
  if (!root) return true; // no shadow — proceed

  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.style.cssText = `
      position:fixed;inset:0;z-index:${PORTAL_Z.dialog ?? 10000};
      background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;
      font-family:system-ui,sans-serif;
    `;
    const panel = document.createElement('div');
    panel.style.cssText = `
      background:var(--md-surface,#fff);color:var(--md-on-surface,#1a1c16);
      border-radius:16px;padding:18px 16px;width:min(360px,92vw);max-height:70vh;overflow:auto;
      box-shadow:0 16px 48px rgba(0,0,0,0.25);border:1px solid var(--md-outline-variant,#c5c8ba);
    `;
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:700;font-size:14px;margin-bottom:10px;';
    h.textContent = opts.title || 'Preview autofill';
    panel.appendChild(h);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:14px;';
    for (const row of opts.rows) {
      const line = document.createElement('div');
      line.style.cssText =
        'display:flex;gap:8px;font-size:12px;align-items:baseline;border-bottom:1px solid rgba(0,0,0,0.06);padding-bottom:4px;';
      const lab = document.createElement('span');
      lab.style.cssText =
        'opacity:0.55;min-width:72px;text-transform:uppercase;font-size:10px;font-weight:600;';
      lab.textContent = row.label;
      const val = document.createElement('span');
      val.style.cssText = 'flex:1;word-break:break-all;font-weight:500;';
      // Mask password-like
      const isSecret = /password/i.test(row.label) || row.kind === 'password';
      val.textContent = isSecret ? '••••••••' : row.value;
      line.appendChild(lab);
      line.appendChild(val);
      list.appendChild(line);
    }
    panel.appendChild(list);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = opts.cancelLabel || 'Cancel';
    cancel.style.cssText =
      'padding:8px 12px;border-radius:10px;border:0;background:var(--md-surface-variant,#e1e4d5);cursor:pointer;font-weight:600;font-size:12px;';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = opts.confirmLabel || 'Fill';
    ok.style.cssText =
      'padding:8px 14px;border-radius:10px;border:0;background:var(--md-primary,#4c662b);color:var(--md-on-primary,#fff);cursor:pointer;font-weight:700;font-size:12px;';
    cancel.onclick = () => {
      backdrop.remove();
      resolve(false);
    };
    ok.onclick = () => {
      backdrop.remove();
      resolve(true);
    };
    actions.appendChild(cancel);
    actions.appendChild(ok);
    panel.appendChild(actions);
    backdrop.appendChild(panel);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        backdrop.remove();
        resolve(false);
      }
    });
    root.appendChild(backdrop);
  });
}
