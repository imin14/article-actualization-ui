import { describe, it, expect } from 'vitest';
import { renderDiffHTML, escapeHTML } from '../lib/diff.js';

describe('escapeHTML', () => {
  it('escapes <, >, &, ", \'', () => {
    expect(escapeHTML('<script>"a"</script>'))
      .toBe('&lt;script&gt;&quot;a&quot;&lt;/script&gt;');
    expect(escapeHTML("a&b'c")).toBe('a&amp;b&#39;c');
  });

  it('handles empty and null', () => {
    expect(escapeHTML('')).toBe('');
    expect(escapeHTML(null)).toBe('');
  });
});

describe('renderDiffHTML', () => {
  it('wraps removed words in <del> and added in <ins>', () => {
    const html = renderDiffHTML('5 years', '10 years');
    expect(html).toContain('<del');
    expect(html).toContain('5');
    expect(html).toContain('<ins');
    expect(html).toContain('10');
    expect(html).toContain('years');
  });

  it('returns plain text when nothing changed', () => {
    const html = renderDiffHTML('hello world', 'hello world');
    expect(html).not.toContain('<del');
    expect(html).not.toContain('<ins');
    expect(html).toContain('hello world');
  });

  it('escapes user content to prevent XSS', () => {
    const html = renderDiffHTML('<b>5</b>', '<b>10</b>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });

  it('handles multi-line input preserving line breaks via \\n', () => {
    const html = renderDiffHTML('line1\nline2', 'line1\nline2 changed');
    expect(html).toContain('line1');
    expect(html).toContain('changed');
  });
});

describe('escapeHTML edge cases', () => {
  it('passes through 4-byte emoji unchanged (no HTML special chars in surrogate pair)', () => {
    const out = escapeHTML('5 → 10 🎉');
    expect(out).toBe('5 → 10 🎉');
  });

  it('preserves Cyrillic while escaping brackets and ampersand in mixed content', () => {
    const out = escapeHTML('<b>да & нет</b>');
    expect(out).toContain('да');
    expect(out).toContain('нет');
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('&lt;/b&gt;');
    expect(out).toContain('&amp;');
    expect(out).not.toContain('<b>');
  });
});

describe('renderDiffHTML edge cases', () => {
  it('does not crash when one input is null and renders the non-null side', () => {
    // renderDiffHTML coerces null → '' internally. So null vs string behaves
    // like '' vs string — entire string gets marked as added.
    const fromNull = renderDiffHTML(null, 'hello');
    expect(fromNull).toContain('hello');
    expect(fromNull).toContain('<ins');

    const toNull = renderDiffHTML('hello', null);
    expect(toNull).toContain('hello');
    expect(toNull).toContain('<del');
  });

  it('handles very long mostly-identical inputs without crashing and produces bounded output', () => {
    const base = 'word '.repeat(2000); // ~10KB
    const changed = base + 'extra';
    const out = renderDiffHTML(base, changed);
    // Output should at least include the prose; we just want to ensure it
    // didn't blow up and produces a string of plausible size.
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // Bounded: shouldn't be more than a small multiple of input size.
    expect(out.length).toBeLessThan(changed.length * 5);
    expect(out).toContain('extra');
  });

  it('preserves Cyrillic word boundaries — marks "5" removed and "10" added but keeps "лет" unchanged', () => {
    const out = renderDiffHTML('5 лет', '10 лет');
    expect(out).toMatch(/<del[^>]*>5<\/del>/);
    expect(out).toMatch(/<ins[^>]*>10<\/ins>/);
    // "лет" should appear outside of any del/ins tags (preserved segment).
    // After removing all del/ins blocks we should still see "лет".
    const stripped = out
      .replace(/<del[^>]*>[\s\S]*?<\/del>/g, '')
      .replace(/<ins[^>]*>[\s\S]*?<\/ins>/g, '');
    expect(stripped).toContain('лет');
  });
});
