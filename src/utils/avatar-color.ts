/**
 * Google-style avatar fills - the classic 7-color initial-avatar palette used
 * by Gmail / Google Contacts. Single source of truth for letter avatars across
 * the app: import these instead of hardcoding per-view background colors.
 *
 * GOOGLE_AVATAR_HEX    → hex values (SVG data-URLs, default-avatar.ts)
 * GOOGLE_AVATAR_COLORS → literal Tailwind classes (JIT-safe, DOM avatars)
 *
 * NOTE: white initials on the lightest pastels (#FDE293, #F6BF26, #FAA0A0,
 * #A2C8FC) are intentionally low-contrast — that's the authentic Google avatar
 * look, and these are small decorative circles. Do not darken the palette.
 */
export const GOOGLE_AVATAR_HEX = [
  '#F6BF26', // yellow
  '#F28E82', // coral red
  '#A2C8FC', // blue
  '#FAA0A0', // pink
  '#D7AEFB', // purple
  '#FDE293', // sand
  '#A1D9A0', // green
] as const;

/** Same palette as Tailwind classes with white initials (Google look). */
export const GOOGLE_AVATAR_COLORS = [
  'bg-[#F6BF26] text-white',
  'bg-[#F28E82] text-white',
  'bg-[#A2C8FC] text-white',
  'bg-[#FAA0A0] text-white',
  'bg-[#D7AEFB] text-white',
  'bg-[#FDE293] text-white',
  'bg-[#A1D9A0] text-white',
] as const;

/** Muted / read-state avatar shell */
export const AVATAR_MUTED = 'bg-md-outline-variant text-md-on-surface';

/** Stable 16-bit hash — same seed always maps to the same avatar color. */
function avatarHash(email: string): number {
  let hash = 0;
  const s = email || '';
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) & 0xffff;
  return hash;
}

/**
 * Stable hash of a seed (email / domain / name) → a Google-style avatar color.
 * Same email always maps to the same color so avatars stay consistent.
 */
export function avatarColor(email: string): string {
  return GOOGLE_AVATAR_COLORS[avatarHash(email) % GOOGLE_AVATAR_COLORS.length];
}
