import { describe, it, expect } from 'vitest';
import { createAPIClient } from '../lib/api.js';

describe('real API client surface', () => {
  it('createAPIClient returns an object exposing the expected method names', () => {
    const api = createAPIClient({ baseURL: 'https://example.com', token: 'x' });
    expect(typeof api.getCampaignState).toBe('function');
    expect(typeof api.postAction).toBe('function');
    expect(typeof api.listCampaigns).toBe('function');
  });
});

describe('real API client edge cases', () => {
  it('postAction throws a recognisable error when fetch is unavailable / fails', async () => {
    const original = global.fetch;
    global.fetch = () => { throw new Error('fetch unavailable'); };
    try {
      const api = createAPIClient({ baseURL: 'https://example.com', token: 'x' });
      await expect(api.postAction({
        campaign_id: 'c', row_id: 'r', action: 'accept',
      })).rejects.toThrow(/fetch|unavailable|undefined|postAction/i);
    } finally {
      global.fetch = original;
    }
  });

  it('getCampaignState rejects when response is missing campaign/blocks', async () => {
    const original = global.fetch;
    global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    try {
      const api = createAPIClient({ baseURL: 'https://example.com', token: 'x' });
      await expect(api.getCampaignState('cmp-x')).rejects.toThrow(/Invalid/);
    } finally {
      global.fetch = original;
    }
  });

  it('getCampaignState rejects with timeout error when fetch never resolves', async () => {
    const original = global.fetch;
    // Honour the abort signal: reject with AbortError when the controller fires.
    global.fetch = (_url, opts) => new Promise((_resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }
    });
    try {
      const api = createAPIClient({
        baseURL: 'https://example.com',
        token: 'x',
        timeoutMs: 100,
      });
      await expect(api.getCampaignState('cmp-x')).rejects.toThrow(/timed out/i);
    } finally {
      global.fetch = original;
    }
  });
});
