/**
 * Safe DOM property getters that guard against HTML Form Element Named Access shadowing.
 * In HTML forms, `<input name="id">` or `<input id="id">` causes `form.id` or `el.id`
 * to return an HTMLInputElement (Object) instead of a string, which causes
 * `(el.id || '').toLowerCase()` to throw `TypeError: ...toLowerCase is not a function`.
 */

export function safeStringProp(obj: unknown, prop: string): string {
  if (!obj || typeof obj !== 'object') return '';
  const val = (obj as Record<string, unknown>)[prop];
  if (typeof val === 'string') return val;
  if ('getAttribute' in obj && typeof (obj as Element).getAttribute === 'function') {
    const attr = (obj as Element).getAttribute(prop);
    if (typeof attr === 'string') return attr;
  }
  return '';
}

export function safeId(el: unknown): string {
  return safeStringProp(el, 'id');
}

export function safeName(el: unknown): string {
  return safeStringProp(el, 'name');
}

export function safePlaceholder(el: unknown): string {
  return safeStringProp(el, 'placeholder');
}
