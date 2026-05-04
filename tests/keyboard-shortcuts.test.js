import { describe, it, expect } from 'vitest';
import { nextFocusable, prevFocusable } from '../lib/focus.js';

const blocks = [
  { row_id: 'r-001' },
  { row_id: 'r-002' },
  { row_id: 'r-003' },
];

const stories = [
  { story_id: 's-1' },
  { story_id: 's-2' },
  { story_id: 's-3' },
];

describe('nextFocusable', () => {
  it('returns the first id when current is null', () => {
    expect(nextFocusable(null, blocks)).toBe('r-001');
  });

  it('returns the first id when current is undefined', () => {
    expect(nextFocusable(undefined, blocks)).toBe('r-001');
  });

  it('returns the next id when current is in the middle', () => {
    expect(nextFocusable('r-002', blocks)).toBe('r-003');
  });

  it('returns the next id when current is the first item', () => {
    expect(nextFocusable('r-001', blocks)).toBe('r-002');
  });

  it('returns null when current is the last item (no wraparound)', () => {
    expect(nextFocusable('r-003', blocks)).toBe(null);
  });

  it('returns the first id when current is unknown', () => {
    expect(nextFocusable('r-zzz', blocks)).toBe('r-001');
  });

  it('returns null on empty list', () => {
    expect(nextFocusable(null, [])).toBe(null);
    expect(nextFocusable('r-001', [])).toBe(null);
  });

  it('handles non-array inputs defensively', () => {
    expect(nextFocusable(null, undefined)).toBe(null);
    expect(nextFocusable(null, null)).toBe(null);
  });

  it('works with story_id-keyed lists', () => {
    expect(nextFocusable(null, stories)).toBe('s-1');
    expect(nextFocusable('s-1', stories)).toBe('s-2');
    expect(nextFocusable('s-3', stories)).toBe(null);
  });
});

describe('prevFocusable', () => {
  it('returns the first id when current is null (no focus yet)', () => {
    expect(prevFocusable(null, blocks)).toBe('r-001');
  });

  it('returns the previous id when current is in the middle', () => {
    expect(prevFocusable('r-002', blocks)).toBe('r-001');
  });

  it('returns the previous id when current is the last item', () => {
    expect(prevFocusable('r-003', blocks)).toBe('r-002');
  });

  it('returns null when current is the first item (no wraparound)', () => {
    expect(prevFocusable('r-001', blocks)).toBe(null);
  });

  it('returns the first id when current is unknown', () => {
    expect(prevFocusable('r-zzz', blocks)).toBe('r-001');
  });

  it('returns null on empty list', () => {
    expect(prevFocusable(null, [])).toBe(null);
    expect(prevFocusable('r-001', [])).toBe(null);
  });

  it('handles non-array inputs defensively', () => {
    expect(prevFocusable(null, undefined)).toBe(null);
    expect(prevFocusable(null, null)).toBe(null);
  });

  it('works with story_id-keyed lists', () => {
    expect(prevFocusable(null, stories)).toBe('s-1');
    expect(prevFocusable('s-2', stories)).toBe('s-1');
    expect(prevFocusable('s-1', stories)).toBe(null);
  });
});
