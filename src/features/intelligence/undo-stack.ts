/**
 * Multi-level form undo stack (content-script local memory).
 */

export type SnapField = {
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  value: string;
  checked?: boolean;
};

export type UndoFrame = {
  at: number;
  label: string;
  fields: SnapField[];
};

export class FormUndoStack {
  private frames: UndoFrame[] = [];
  constructor(private maxDepth = 5) {}

  setMaxDepth(n: number) {
    this.maxDepth = Math.max(1, Math.min(20, n));
    if (this.frames.length > this.maxDepth) this.frames = this.frames.slice(-this.maxDepth);
  }

  push(form: ParentNode, label = 'fill'): void {
    const fields: SnapField[] = [];
    try {
      const nodes = form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >('input, select, textarea');
      for (const el of Array.from(nodes)) {
        if (
          (el as HTMLInputElement).type === 'checkbox' ||
          (el as HTMLInputElement).type === 'radio'
        ) {
          fields.push({
            el,
            value: (el as HTMLInputElement).value || '',
            checked: !!(el as HTMLInputElement).checked,
          });
        } else {
          fields.push({ el, value: el.value || '' });
        }
      }
    } catch {
      /* ignore */
    }
    this.frames.push({ at: Date.now(), label, fields });
    if (this.frames.length > this.maxDepth) this.frames.shift();
  }

  canUndo(): boolean {
    return this.frames.length > 0;
  }

  depth(): number {
    return this.frames.length;
  }

  /** Pop one level and restore. Returns false if empty. */
  undo(): boolean {
    const frame = this.frames.pop();
    if (!frame) return false;
    for (const s of frame.fields) {
      try {
        if (!s.el.isConnected) continue;
        if (s.checked !== undefined && 'checked' in s.el) {
          (s.el as HTMLInputElement).checked = !!s.checked;
          s.el.value = s.value;
        } else {
          s.el.value = s.value;
        }
        s.el.dispatchEvent(new Event('input', { bubbles: true }));
        s.el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {
        /* ignore */
      }
    }
    return true;
  }

  clear(): void {
    this.frames = [];
  }
}

/** Per-form weak map so re-injects share stack when possible */
const stacks = new WeakMap<object, FormUndoStack>();

export function getFormUndoStack(form: ParentNode, maxDepth = 5): FormUndoStack {
  let s = stacks.get(form);
  if (!s) {
    s = new FormUndoStack(maxDepth);
    stacks.set(form, s);
  } else {
    s.setMaxDepth(maxDepth);
  }
  return s;
}
