import { describe, it, expect } from 'vitest';
import { approxTokens, truncateToTokenBudget } from '../lib/tokenize.js';

describe('approxTokens', () => {
  it('returns 0 for empty input', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens(null)).toBe(0);
    expect(approxTokens(undefined)).toBe(0);
  });

  it('estimates Latin text at roughly chars/4', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'; // 44 chars
    const t = approxTokens(text);
    expect(t).toBeGreaterThanOrEqual(8);
    expect(t).toBeLessThanOrEqual(15);
  });

  it('estimates Cyrillic text more densely than Latin (chars/2 ish)', () => {
    const ru = 'Стать гражданином Португалии можно через 5 лет.'; // 47 chars
    const en = 'You can become a Portuguese citizen after 5 years.'; // 51 chars
    const tRu = approxTokens(ru);
    const tEn = approxTokens(en);
    // Cyrillic should produce more tokens per character than Latin.
    // Both strings have similar character counts, but Cyrillic estimate must be higher.
    expect(tRu).toBeGreaterThan(tEn);
  });

  it('estimates CJK text roughly chars/2', () => {
    const cjk = '葡萄牙公民身份需要十年居住时间。'; // 16 CJK chars
    const t = approxTokens(cjk);
    // Should be in the ballpark of 8 (chars/2) — allow generous range.
    expect(t).toBeGreaterThanOrEqual(6);
    expect(t).toBeLessThanOrEqual(20);
  });

  it('returns positive integer for any non-empty string', () => {
    expect(approxTokens('a')).toBeGreaterThan(0);
    expect(Number.isInteger(approxTokens('hello world'))).toBe(true);
  });

  it('boosts estimate for code-like content with many punctuation/symbol chars', () => {
    const prose = 'this is a normal sentence with words and stuff'; // 47 chars
    const code = 'fn(x){return x?.y??[]:({a:1,b:[2,3]});}//t'; // 42 chars
    const tProse = approxTokens(prose);
    const tCode = approxTokens(code);
    // Code-heavy text should produce relatively more tokens per char than prose.
    const proseRate = tProse / prose.length;
    const codeRate = tCode / code.length;
    expect(codeRate).toBeGreaterThan(proseRate);
  });

  it('boosts estimate for URLs', () => {
    const plain = 'see the docs for more info on this matter please';
    const withUrl = 'see https://example.com/path?x=1&y=2#frag for more info';
    const tPlain = approxTokens(plain);
    const tUrl = approxTokens(withUrl);
    expect(tUrl).toBeGreaterThan(tPlain);
  });

  it('is monotonic: longer input never returns fewer tokens', () => {
    const a = 'hello world';
    const b = 'hello world hello world hello world';
    expect(approxTokens(b)).toBeGreaterThanOrEqual(approxTokens(a));
  });
});

describe('truncateToTokenBudget', () => {
  it('returns the input unchanged when under budget', () => {
    const text = 'Short input.';
    const out = truncateToTokenBudget(text, 1000);
    expect(out).toBe(text);
  });

  it('returns empty string for empty input', () => {
    expect(truncateToTokenBudget('', 100)).toBe('');
    expect(truncateToTokenBudget(null, 100)).toBe('');
  });

  it('truncates result to fit within token budget', () => {
    const long = 'one two three four five six seven eight nine ten '.repeat(50);
    const budget = 20;
    const out = truncateToTokenBudget(long, budget);
    expect(approxTokens(out)).toBeLessThanOrEqual(budget);
    expect(out.length).toBeLessThan(long.length);
  });

  it('truncates at a word boundary, not mid-word', () => {
    const text = 'aaaaa bbbbb ccccc ddddd eeeee fffff ggggg hhhhh';
    const out = truncateToTokenBudget(text, 5);
    // Result should not end mid-word: every char in the result up to its
    // length should match the prefix of the input on word boundaries.
    expect(text.startsWith(out.replace(/\s+$/, ''))).toBe(true);
    // Should not split a 5-letter word in half.
    const trimmed = out.replace(/\s+$/, '');
    if (trimmed.length > 0) {
      const lastChar = trimmed[trimmed.length - 1];
      const nextCharInOriginal = text[trimmed.length];
      // Either we ended at the end of the string OR the next char in original
      // is a whitespace (i.e. we cut on a word boundary).
      const endedCleanly = trimmed.length === text.length || /\s/.test(nextCharInOriginal);
      expect(endedCleanly).toBe(true);
    }
  });

  it('handles a single huge word that exceeds the budget by returning empty or minimal', () => {
    const huge = 'x'.repeat(10000);
    const out = truncateToTokenBudget(huge, 5);
    // We can't word-boundary split a single huge word; result must still
    // honour the budget. Empty string is acceptable.
    expect(approxTokens(out)).toBeLessThanOrEqual(5);
  });

  it('respects budget=0 by returning empty string', () => {
    expect(truncateToTokenBudget('hello world', 0)).toBe('');
  });
});
