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
