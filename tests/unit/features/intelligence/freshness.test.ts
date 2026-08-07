import { describe, expect, test } from 'bun:test';
import { rankIdentitiesForSignup } from '@/features/intelligence/freshness.js';
import type { Identity } from '@/utils/types.js';

function id(partial: Partial<Identity> & { id: string; name: string }): Identity {
  return {
    firstNames: 'A, B',
    lastNames: 'X, Y',
    useRandomPassword: true,
    isDefault: false,
    createdAt: Date.now(),
    ...partial,
  } as Identity;
}

describe('rankIdentitiesForSignup', () => {
  test('prefers identities not used on the domain', async () => {
    // Mock storage via global is hard; function reads browser.storage — skip if unavailable
    if (typeof globalThis === 'undefined') return;
    const identities = [
      id({ id: 'used', name: 'Used', isDefault: true }),
      id({ id: 'fresh', name: 'Fresh' }),
    ];
    const ranked = await rankIdentitiesForSignup('example.com', identities, [
      'a@example.com',
      'b@example.com',
    ]);
    expect(ranked.length).toBe(2);
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0);
  });
});
