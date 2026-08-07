import { describe, expect, it } from 'bun:test';
import { base32ToBytes, generateTOTP } from '@/utils/totp.js';

describe('base32ToBytes', () => {
  it('decodes standard Base32 strings correctly', () => {
    const bytes = base32ToBytes('JBSWY3DPEBLW64TMMQ');
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe('Hello World');
  });

  it('handles spaces, dashes and lower-case characters', () => {
    const bytes = base32ToBytes('jbsw-y3dp eblw 64tm mq');
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe('Hello World');
  });
});

describe('generateTOTP', () => {
  it('generates expected 6-digit TOTP for RFC 6238 test vector', async () => {
    // RFC 6238 seed: "12345678901234567890" -> Base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

    // T = 59 seconds -> Counter = 1
    const result = await generateTOTP(secret, 59000);
    expect(result.code).toBe('287082');
    expect(result.secondsRemaining).toBe(1);
    expect(result.progressPercent).toBe(3);
  });

  it('returns empty result for invalid secret', async () => {
    const result = await generateTOTP('');
    expect(result.code).toBe('');
    expect(result.secondsRemaining).toBe(0);
  });
});
