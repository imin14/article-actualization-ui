import { describe, it, expect } from 'vitest';
import { groupByStory, computeProgress, applyAction, getNextPendingStory } from '../lib/state.js';
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
