/** Test helper mirroring a11y-fields matchKindFromText logic (no DOM). */
export function matchKindFromTextExport(text: string): { kind: string; confidence: number } | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(e-?mail|mail\s*address)\b/.test(t)) return { kind: 'email', confidence: 0.95 };
  if (/\b(password|passwd|pwd)\b/.test(t)) return { kind: 'password', confidence: 0.95 };
  if (/\b(phone|mobile|cell|tel)\b/.test(t)) return { kind: 'phone', confidence: 0.9 };
  return null;
}
