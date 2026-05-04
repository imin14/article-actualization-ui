import { describe, it, expect } from 'vitest';
import { groupByStory, computeProgress, applyAction, getNextPendingStory, getPendingBlocksInStory } from '../lib/state.js';
import { MOCK_CAMPAIGN } from '../lib/mock-data.js';

describe('groupByStory', () => {
  it('groups blocks by story_id with story metadata', () => {
    const groups = groupByStory(MOCK_CAMPAIGN.blocks);
    expect(groups).toHaveLength(3);
    expect(groups[0].story_id).toBe('12345');
    expect(groups[0].story_name).toBe('ВНЖ в Португалии: программы и условия');
    expect(groups[0].locale).toBe('ru');
    expect(groups[0].blocks).toHaveLength(2);
  });

  it('preserves source order within each story', () => {
    const groups = groupByStory(MOCK_CAMPAIGN.blocks);
    const story12345 = groups.find(g => g.story_id === '12345');
    expect(story12345.blocks[0].row_id).toBe('r-001');
    expect(story12345.blocks[1].row_id).toBe('r-002');
  });

  it('handles empty input', () => {
    expect(groupByStory([])).toEqual([]);
  });
});

describe('computeProgress', () => {
  it('counts blocks by status', () => {
    const blocks = [
      { status: 'proposed' }, { status: 'accepted' }, { status: 'accepted' },
      { status: 'skipped' }, { status: 'edited' },
    ];
    const progress = computeProgress(blocks);
    expect(progress.total).toBe(5);
    expect(progress.reviewed).toBe(4);
    expect(progress.by_status.accepted).toBe(2);
    expect(progress.by_status.skipped).toBe(1);
    expect(progress.by_status.proposed).toBe(1);
  });

  it('treats proposed and pending and error as not-yet-reviewed', () => {
    const blocks = [
      { status: 'proposed' }, { status: 'pending' }, { status: 'error' },
    ];
    expect(computeProgress(blocks).reviewed).toBe(0);
  });
});

describe('applyAction', () => {
  it('marks block as accepted', () => {
    const block = { row_id: 'r-001', status: 'proposed', proposed_payload: { a: 'X' }, edited_payload: null };
    const updated = applyAction(block, { action: 'accept' });
    expect(updated.status).toBe('accepted');
    expect(updated.row_id).toBe('r-001');
  });

  it('marks block as edited and stores edited_payload', () => {
    const block = { row_id: 'r-001', status: 'proposed', proposed_payload: { a: 'X' }, edited_payload: null };
    const updated = applyAction(block, { action: 'edit', edited_payload: { a: 'Y' } });
    expect(updated.status).toBe('edited');
    expect(updated.edited_payload).toEqual({ a: 'Y' });
  });

  it('marks block as skipped with reason', () => {
    const block = { row_id: 'r-001', status: 'proposed' };
    const updated = applyAction(block, { action: 'skip', skip_reason: { category: 'other', comment: 'needs review' } });
    expect(updated.status).toBe('skipped');
    expect(updated.skip_reason).toEqual({ category: 'other', comment: 'needs review' });
  });

  it('marks block as deleted', () => {
    const block = { row_id: 'r-001', status: 'proposed' };
    const updated = applyAction(block, { action: 'delete' });
    expect(updated.status).toBe('deleted');
  });

  it('throws on unknown action', () => {
    expect(() => applyAction({ status: 'proposed' }, { action: 'foo' })).toThrow(/unknown action/i);
  });
});

describe('getNextPendingStory', () => {
  it('returns next story with at least one not-yet-reviewed block', () => {
    const groups = [
      { story_id: 'a', blocks: [{ status: 'accepted' }, { status: 'accepted' }] },
      { story_id: 'b', blocks: [{ status: 'proposed' }] },
      { story_id: 'c', blocks: [{ status: 'proposed' }] },
    ];
    expect(getNextPendingStory(groups, 'a')).toBe('b');
    expect(getNextPendingStory(groups, 'b')).toBe('c');
  });

  it('returns null when no more pending stories', () => {
    const groups = [
      { story_id: 'a', blocks: [{ status: 'accepted' }] },
      { story_id: 'b', blocks: [{ status: 'accepted' }] },
    ];
    expect(getNextPendingStory(groups, 'a')).toBeNull();
  });

  it('returns first pending story when current is null', () => {
    const groups = [
      { story_id: 'a', blocks: [{ status: 'accepted' }] },
      { story_id: 'b', blocks: [{ status: 'proposed' }] },
    ];
    expect(getNextPendingStory(groups, null)).toBe('b');
  });
});

describe('getPendingBlocksInStory', () => {
  it('returns only blocks whose status is in NOT_REVIEWED (pending/proposed/error)', () => {
    const group = {
      story_id: 's1',
      blocks: [
        { row_id: 'r1', status: 'accepted' },
        { row_id: 'r2', status: 'proposed' },
        { row_id: 'r3', status: 'pending' },
        { row_id: 'r4', status: 'error' },
        { row_id: 'r5', status: 'edited' },
        { row_id: 'r6', status: 'skipped' },
        { row_id: 'r7', status: 'deleted' },
      ],
    };
    const pending = getPendingBlocksInStory(group);
    expect(pending.map(b => b.row_id)).toEqual(['r2', 'r3', 'r4']);
  });

  it('returns [] for null/undefined group or missing blocks array', () => {
    expect(getPendingBlocksInStory(null)).toEqual([]);
    expect(getPendingBlocksInStory(undefined)).toEqual([]);
    expect(getPendingBlocksInStory({})).toEqual([]);
    expect(getPendingBlocksInStory({ blocks: null })).toEqual([]);
  });

  it('preserves source order of pending blocks', () => {
    const group = {
      blocks: [
        { row_id: 'r1', status: 'proposed' },
        { row_id: 'r2', status: 'accepted' },
        { row_id: 'r3', status: 'error' },
        { row_id: 'r4', status: 'pending' },
      ],
    };
    expect(getPendingBlocksInStory(group).map(b => b.row_id)).toEqual(['r1', 'r3', 'r4']);
  });
});

describe('edge cases', () => {
  it('groupByStory keeps first-seen story_name when blocks share story_id but have different story_names', () => {
    const blocks = [
      { story_id: 's1', story_name: 'First Name', story_full_slug: 'a', locale: 'ru', row_id: 'r1' },
      { story_id: 's1', story_name: 'Different Name', story_full_slug: 'a', locale: 'ru', row_id: 'r2' },
    ];
    const groups = groupByStory(blocks);
    expect(groups).toHaveLength(1);
    expect(groups[0].story_name).toBe('First Name');
    expect(groups[0].blocks).toHaveLength(2);
  });

  it('computeProgress treats unknown statuses as NOT reviewed', () => {
    // Reviewed counts only the explicit REVIEWED set (accepted/edited/skipped/deleted).
    // An unknown status like "foo" is tracked in by_status but does NOT count
    // toward reviewed — defensive against typos/new statuses leaking through.
    const blocks = [{ status: 'foo' }, { status: 'accepted' }];
    const progress = computeProgress(blocks);
    expect(progress.total).toBe(2);
    expect(progress.by_status['foo']).toBe(1);
    expect(progress.by_status.accepted).toBe(1);
    // Only 'accepted' is explicitly reviewed; 'foo' is unknown and excluded.
    expect(progress.reviewed).toBe(1);
  });

  it('applyAction returns a new object and does not mutate the input', () => {
    const block = {
      row_id: 'r-001', status: 'proposed', proposed_payload: { a: 'X' },
      edited_payload: null, skip_reason: null,
    };
    const snapshot = JSON.parse(JSON.stringify(block));
    const updated = applyAction(block, { action: 'accept' });
    expect(block).toEqual(snapshot);
    expect(updated).not.toBe(block);
    expect(updated.status).toBe('accepted');
  });

  it('applyAction with action=edit and missing edited_payload sets edited_payload to undefined and does not crash', () => {
    const block = { row_id: 'r-001', status: 'proposed', proposed_payload: { a: 'X' }, edited_payload: null };
    const updated = applyAction(block, { action: 'edit' });
    expect(updated.status).toBe('edited');
    expect(updated.edited_payload).toBeUndefined();
  });

  it('getNextPendingStory with current_story_id not in groups falls back to first pending story', () => {
    const groups = [
      { story_id: 'a', blocks: [{ status: 'proposed' }] },
      { story_id: 'b', blocks: [{ status: 'proposed' }] },
    ];
    // findIndex returns -1 for not-found; loop starts at 0 → returns 'a'.
    expect(getNextPendingStory(groups, 'nonexistent')).toBe('a');
  });

  it('getNextPendingStory with a single fully-reviewed group returns null', () => {
    const groups = [
      { story_id: 'a', blocks: [{ status: 'accepted' }, { status: 'skipped' }] },
    ];
    expect(getNextPendingStory(groups, null)).toBeNull();
    expect(getNextPendingStory(groups, 'a')).toBeNull();
  });
});
