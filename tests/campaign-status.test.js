import { describe, it, expect } from 'vitest';
import { campaignStatus, countPending, RUNNING_WINDOW_MS } from '../lib/state.js';

// Fixed clock so the "running" window is deterministic.
const NOW = Date.parse('2026-08-06T15:50:00Z');
const secondsAgo = (s) => new Date(NOW - s * 1000).toISOString();

describe('countPending', () => {
  it('counts proposed blocks, which is what the pipeline actually writes', () => {
    expect(countPending({ by_status: { proposed: 3 } })).toBe(3);
  });

  it('still counts the legacy "pending" name', () => {
    expect(countPending({ by_status: { pending: 2 } })).toBe(2);
  });

  it('counts proposed_delete and error as awaiting a decision', () => {
    expect(countPending({ by_status: { proposed_delete: 1, error: 2 } })).toBe(3);
  });

  it('does not count reviewed statuses', () => {
    expect(countPending({ by_status: { accepted: 4, edited: 3, skipped: 2, deleted: 1 } })).toBe(0);
  });

  it('does not count llm_no_change — there is nothing for the editor to do', () => {
    expect(countPending({ by_status: { llm_no_change: 7 } })).toBe(0);
  });

  it('survives a missing or empty by_status', () => {
    expect(countPending({})).toBe(0);
    expect(countPending(null)).toBe(0);
    expect(countPending({ by_status: {} })).toBe(0);
  });
});

describe('campaignStatus', () => {
  it('reports "empty" when the campaign holds no blocks', () => {
    expect(campaignStatus({ total: 0, by_status: {} }, NOW).label).toBe('empty');
  });

  // Regression: this used to read by_status.pending, which the pipeline never
  // emits. Pending was therefore always 0 and this rendered "ready" while the
  // search was mid-run with nothing reviewed — exactly what was reported for
  // the Spain FIP campaign (1 block found, search only ~half done).
  it('reports "running" while a freshly-written campaign still has proposed blocks', () => {
    const c = { total: 1, by_status: { proposed: 1 }, last_updated_at: secondsAgo(10) };
    expect(campaignStatus(c, NOW).label).toBe('running');
  });

  it('reports progress once writes have gone quiet but review is outstanding', () => {
    const c = { total: 42, by_status: { proposed: 42 }, last_updated_at: secondsAgo(3600) };
    expect(campaignStatus(c, NOW).label).toBe('0/42');
  });

  it('counts reviewed blocks against the total in the progress label', () => {
    const c = {
      total: 10,
      by_status: { proposed: 4, accepted: 5, skipped: 1 },
      last_updated_at: secondsAgo(3600),
    };
    expect(campaignStatus(c, NOW).label).toBe('6/10');
  });

  it('reports "ready" only once nothing is awaiting review', () => {
    const c = {
      total: 10,
      by_status: { accepted: 7, skipped: 3 },
      last_updated_at: secondsAgo(3600),
    };
    expect(campaignStatus(c, NOW)).toEqual({ label: 'ready', tone: 'success' });
  });

  it('reports "ready" for a campaign whose blocks all came back llm_no_change', () => {
    const c = { total: 5, by_status: { llm_no_change: 5 }, last_updated_at: secondsAgo(3600) };
    expect(campaignStatus(c, NOW).label).toBe('ready');
  });

  it('prefers "ready" over "running" when a completed campaign was just touched', () => {
    const c = { total: 3, by_status: { accepted: 3 }, last_updated_at: secondsAgo(5) };
    expect(campaignStatus(c, NOW).label).toBe('ready');
  });

  it('leaves the running window at the boundary', () => {
    const justInside = {
      total: 2,
      by_status: { proposed: 2 },
      last_updated_at: new Date(NOW - RUNNING_WINDOW_MS + 1000).toISOString(),
    };
    const justOutside = {
      total: 2,
      by_status: { proposed: 2 },
      last_updated_at: new Date(NOW - RUNNING_WINDOW_MS - 1000).toISOString(),
    };
    expect(campaignStatus(justInside, NOW).label).toBe('running');
    expect(campaignStatus(justOutside, NOW).label).toBe('0/2');
  });

  it('falls back to a progress label when last_updated_at is missing', () => {
    const c = { total: 4, by_status: { proposed: 1, accepted: 3 }, last_updated_at: null };
    expect(campaignStatus(c, NOW).label).toBe('3/4');
  });

  it('does not throw on a null campaign', () => {
    expect(campaignStatus(null, NOW).label).toBe('empty');
  });

  it('matches the shape of a real completed campaign from the list endpoint', () => {
    // cmp-portugal-5-10-years-citizenship-en-2026-05-07, as served today.
    const c = {
      total: 161,
      by_status: { edited: 70, skipped: 18, accepted: 69, llm_no_change: 4 },
      last_updated_at: '2026-05-08T13:51:22.737Z',
    };
    expect(campaignStatus(c, NOW).label).toBe('ready');
  });
});
