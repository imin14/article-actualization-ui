import { describe, it, expect } from 'vitest';
import {
  splitIntoParagraphs,
  findKeywordParagraphs,
  extractContextWindow,
} from '../lib/chunking.js';

describe('splitIntoParagraphs', () => {
  it('splits on blank lines (double newlines)', () => {
    const md = 'First paragraph.\n\nSecond paragraph.\n\nThird.';
    expect(splitIntoParagraphs(md)).toEqual([
      'First paragraph.',
      'Second paragraph.',
      'Third.',
    ]);
  });

  it('trims whitespace around each paragraph', () => {
    const md = '   First   \n\n   Second   ';
    expect(splitIntoParagraphs(md)).toEqual(['First', 'Second']);
  });

  it('drops empty paragraphs from runs of blank lines', () => {
    const md = 'A\n\n\n\nB\n\n   \n\nC';
    expect(splitIntoParagraphs(md)).toEqual(['A', 'B', 'C']);
  });

  it('returns single-element array when no blank-line separators', () => {
    expect(splitIntoParagraphs('one line of text')).toEqual(['one line of text']);
  });

  it('returns empty array for empty/null input', () => {
    expect(splitIntoParagraphs('')).toEqual([]);
    expect(splitIntoParagraphs(null)).toEqual([]);
    expect(splitIntoParagraphs(undefined)).toEqual([]);
  });

  it('preserves intra-paragraph single newlines', () => {
    const md = 'line A1\nline A2\n\nline B1';
    expect(splitIntoParagraphs(md)).toEqual(['line A1\nline A2', 'line B1']);
  });
});

describe('findKeywordParagraphs', () => {
  it('returns only paragraphs containing the keyword (case-insensitive)', () => {
    const md = 'About 5 years.\n\nAbout 10 years.\n\nNo numbers here.';
    const hits = findKeywordParagraphs(md, '5 years');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('About 5 years.');
    expect(hits[0].index).toBe(0);
  });

  it('matches case-insensitively by default', () => {
    const md = 'Portugal Citizenship\n\nportugal something else';
    const hits = findKeywordParagraphs(md, 'portugal');
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.index)).toEqual([0, 1]);
  });

  it('returns the paragraph index within the original block', () => {
    const md = 'A\n\nB hit\n\nC\n\nD hit\n\nE';
    const hits = findKeywordParagraphs(md, 'hit');
    expect(hits.map(h => h.index)).toEqual([1, 3]);
  });

  it('returns empty array when keyword not found', () => {
    const hits = findKeywordParagraphs('nothing matches here', 'xyz');
    expect(hits).toEqual([]);
  });

  it('returns empty array for empty text or empty keyword', () => {
    expect(findKeywordParagraphs('', 'foo')).toEqual([]);
    expect(findKeywordParagraphs('something', '')).toEqual([]);
    expect(findKeywordParagraphs(null, 'foo')).toEqual([]);
  });

  it('respects opts.caseSensitive=true when explicitly set', () => {
    const md = 'Portugal\n\nportugal';
    const hits = findKeywordParagraphs(md, 'Portugal', { caseSensitive: true });
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBe(0);
  });

  it('handles Cyrillic keyword matching case-insensitively', () => {
    const md = 'Через 5 лет.\n\nЧерез 10 лет.';
    const hits = findKeywordParagraphs(md, '5 лет');
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBe(0);
  });

  it('treats the whole text as one paragraph if no blank-line splits', () => {
    const hits = findKeywordParagraphs('5 years for citizenship', '5 years');
    expect(hits).toHaveLength(1);
    expect(hits[0].index).toBe(0);
  });
});

describe('extractContextWindow', () => {
  const paragraphs = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];

  it('returns hit + N before + M after joined by \\n\\n', () => {
    const out = extractContextWindow(paragraphs, 3, 1, 1);
    expect(out).toBe('P2\n\nP3\n\nP4');
  });

  it('clamps before/after at the start of the array', () => {
    const out = extractContextWindow(paragraphs, 0, 2, 1);
    expect(out).toBe('P0\n\nP1');
  });

  it('clamps before/after at the end of the array', () => {
    const out = extractContextWindow(paragraphs, 5, 1, 2);
    expect(out).toBe('P4\n\nP5');
  });

  it('returns just the hit when before=0 and after=0', () => {
    const out = extractContextWindow(paragraphs, 2, 0, 0);
    expect(out).toBe('P2');
  });

  it('returns the entire block when window is large', () => {
    const out = extractContextWindow(paragraphs, 2, 100, 100);
    expect(out).toBe('P0\n\nP1\n\nP2\n\nP3\n\nP4\n\nP5');
  });

  it('returns empty string for empty array', () => {
    expect(extractContextWindow([], 0, 1, 1)).toBe('');
  });

  it('throws or returns empty for out-of-range hitIndex', () => {
    // Either it returns empty or throws — implementation detail. We accept both.
    let result;
    let threw = false;
    try {
      result = extractContextWindow(paragraphs, 99, 1, 1);
    } catch (_) {
      threw = true;
    }
    expect(threw || result === '').toBe(true);
  });
});
