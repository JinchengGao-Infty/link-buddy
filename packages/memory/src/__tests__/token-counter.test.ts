import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../token-counter.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates tokens for short English text', () => {
    // "Hello" = 5 chars -> ceil(5/4) = 2
    expect(estimateTokens('Hello')).toBe(2);
  });

  it('estimates tokens for a typical sentence', () => {
    const text = 'The quick brown fox jumps over the lazy dog'; // 43 chars -> ceil(43/4) = 11
    expect(estimateTokens(text)).toBe(11);
  });

  it('estimates tokens for long text proportionally', () => {
    const text = 'a'.repeat(400); // ceil(400/4) = 100
    expect(estimateTokens(text)).toBe(100);
  });

  it('rounds up fractional tokens', () => {
    // 5 chars -> ceil(5/4) = 2
    expect(estimateTokens('abcde')).toBe(2);
    // 4 chars -> ceil(4/4) = 1
    expect(estimateTokens('abcd')).toBe(1);
    // 1 char -> ceil(1/4) = 1
    expect(estimateTokens('a')).toBe(1);
  });
});
