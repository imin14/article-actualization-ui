import { describe, it, expect, beforeEach } from 'vitest';
import { createAPIClient } from '../lib/api.js';
import { MOCK_CAMPAIGN } from '../lib/mock-data.js';

describe('mock API client', () => {
  let api;
  beforeEach(() => {
    api = createAPIClient({ mode: 'mock' });
  });

  it('getCampaignState returns the mock campaign', async () => {
    const state = await api.getCampaignState('cmp-portugal-2026-05-04');
    expect(state.campaign.id).toBe('cmp-portugal-2026-05-04');
    expect(state.blocks.length).toBeGreaterThan(0);
  });

  it('getCampaignState returns a clone — mutations do not affect future calls', async () => {
    const a = await api.getCampaignState('cmp-portugal-2026-05-04');
    a.blocks[0].status = 'accepted';
    const b = await api.getCampaignState('cmp-portugal-2026-05-04');
    expect(b.blocks[0].status).toBe('proposed');
  });

  it('postAction with accept updates row status in subsequent state fetches', async () => {
    const before = await api.getCampaignState('cmp-portugal-2026-05-04');
    const target = before.blocks[0];
    const result = await api.postAction({
      campaign_id: before.campaign.id,
      row_id: target.row_id,
      action: 'accept',
    });
    expect(result.status).toBe('ok');
    expect(result.new_status).toBe('accepted');

    const after = await api.getCampaignState('cmp-portugal-2026-05-04');
    const updated = after.blocks.find(b => b.row_id === target.row_id);
    expect(updated.status).toBe('accepted');
  });

  it('postAction with edit stores edited_payload and sets status=edited', async () => {
    const before = await api.getCampaignState('cmp-portugal-2026-05-04');
    const target = before.blocks[0];
    await api.postAction({
      campaign_id: before.campaign.id,
      row_id: target.row_id,
      action: 'edit',
      edited_payload: { textMarkdown: 'manual edit' },
    });
    const after = await api.getCampaignState('cmp-portugal-2026-05-04');
    const updated = after.blocks.find(b => b.row_id === target.row_id);
    expect(updated.status).toBe('edited');
    expect(updated.edited_payload).toEqual({ textMarkdown: 'manual edit' });
  });

  it('postAction with skip stores skip_reason', async () => {
    const before = await api.getCampaignState('cmp-portugal-2026-05-04');
    const target = before.blocks[0];
    await api.postAction({
      campaign_id: before.campaign.id,
      row_id: target.row_id,
      action: 'skip',
      skip_reason: { category: 'llm_misunderstood', comment: '' },
    });
    const after = await api.getCampaignState('cmp-portugal-2026-05-04');
    const updated = after.blocks.find(b => b.row_id === target.row_id);
    expect(updated.status).toBe('skipped');
    expect(updated.skip_reason.category).toBe('llm_misunderstood');
  });

  it('postAction with delete sets status=deleted', async () => {
    const before = await api.getCampaignState('cmp-portugal-2026-05-04');
    const target = before.blocks[0];
    await api.postAction({
      campaign_id: before.campaign.id,
      row_id: target.row_id,
      action: 'delete',
    });
    const after = await api.getCampaignState('cmp-portugal-2026-05-04');
    const updated = after.blocks.find(b => b.row_id === target.row_id);
    expect(updated.status).toBe('deleted');
  });

  it('postAction throws on unknown row_id', async () => {
    await expect(api.postAction({
      campaign_id: 'cmp-portugal-2026-05-04',
      row_id: 'does-not-exist',
      action: 'accept',
    })).rejects.toThrow(/row not found/i);
  });
});

describe('real API client surface', () => {
  it('createAPIClient with mode=real returns an object exposing same method names', () => {
    const api = createAPIClient({ mode: 'real', baseURL: 'https://example.com', token: 'x' });
    expect(typeof api.getCampaignState).toBe('function');
    expect(typeof api.postAction).toBe('function');
  });
});

describe('API client edge cases', () => {
  it('mock client: two consecutive postActions on same row — second overwrites first (accept then skip → final=skipped)', async () => {
    const api = createAPIClient({ mode: 'mock' });
    const before = await api.getCampaignState('cmp-portugal-2026-05-04');
    const target = before.blocks[0];
    await api.postAction({
      campaign_id: before.campaign.id,
      row_id: target.row_id,
      action: 'accept',
    });
    const second = await api.postAction({
      campaign_id: before.campaign.id,
      row_id: target.row_id,
      action: 'skip',
      skip_reason: { category: 'other', comment: 'changed mind' },
    });
    expect(second.new_status).toBe('skipped');

    const after = await api.getCampaignState('cmp-portugal-2026-05-04');
    const updated = after.blocks.find(b => b.row_id === target.row_id);
    expect(updated.status).toBe('skipped');
    expect(updated.skip_reason.category).toBe('other');
  });

  it('mock client: getCampaignState ignores the campaignId param (returns mock regardless)', async () => {
    const api = createAPIClient({ mode: 'mock' });
    // Pinning behavior: the mock client does not throw or filter by campaignId.
    const a = await api.getCampaignState('totally-unknown-id');
    const b = await api.getCampaignState(undefined);
    expect(a.campaign.id).toBe('cmp-portugal-2026-05-04');
    expect(b.campaign.id).toBe('cmp-portugal-2026-05-04');
  });

  it('mock client: postAction with action=edit and missing edited_payload sets row.edited_payload to undefined and does not crash', async () => {
    const api = createAPIClient({ mode: 'mock' });
    const before = await api.getCampaignState('cmp-portugal-2026-05-04');
    const target = before.blocks[0];
    const result = await api.postAction({
      campaign_id: before.campaign.id,
      row_id: target.row_id,
      action: 'edit',
      // edited_payload omitted on purpose
    });
    expect(result.status).toBe('ok');
    expect(result.new_status).toBe('edited');

    const after = await api.getCampaignState('cmp-portugal-2026-05-04');
    const updated = after.blocks.find(b => b.row_id === target.row_id);
    expect(updated.status).toBe('edited');
    expect(updated.edited_payload).toBeUndefined();
  });

  it('real client: postAction throws a recognizable error when fetch is unavailable / fails', async () => {
    const original = global.fetch;
    global.fetch = () => { throw new Error('fetch unavailable'); };
    try {
      const api = createAPIClient({ mode: 'real', baseURL: 'https://example.com', token: 'x' });
      await expect(api.postAction({
        campaign_id: 'c', row_id: 'r', action: 'accept',
      })).rejects.toThrow(/fetch|unavailable|undefined|postAction/i);
    } finally {
      global.fetch = original;
    }
  });
});
