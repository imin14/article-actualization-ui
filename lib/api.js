import { MOCK_CAMPAIGN } from './mock-data.js';
import { applyAction } from './state.js';

/**
 * @typedef {Object} APIClientOptions
 * @property {'mock'|'real'} mode
 * @property {string} [baseURL]
 * @property {string} [token]
 */

/** Deep-clone a JSON-serializable value. */
function clone(v) { return JSON.parse(JSON.stringify(v)); }

/**
 * Mock API: keeps an in-memory copy of MOCK_CAMPAIGN that mutates per action.
 * Used for development before the n8n backend is wired.
 */
function createMockClient() {
  const state = clone(MOCK_CAMPAIGN);

  return {
    async getCampaignState(_campaignId) {
      return clone(state);
    },
    async postAction(payload) {
      const idx = state.blocks.findIndex(b => b.row_id === payload.row_id);
      if (idx < 0) throw new Error(`Row not found: ${payload.row_id}`);
      const updated = applyAction(state.blocks[idx], {
        action: payload.action,
        edited_payload: payload.edited_payload,
        skip_reason: payload.skip_reason,
      });
      state.blocks[idx] = updated;
      return { status: 'ok', new_status: updated.status, row_id: updated.row_id };
    },
  };
}

/**
 * Real API client: talks to n8n webhooks. Wiring to actual backend is done
 * in the backend integration plan; this just defines the surface.
 *
 * @param {Required<Pick<APIClientOptions,'baseURL'|'token'>>} opts
 */
function createRealClient({ baseURL, token }) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  return {
    async getCampaignState(campaignId) {
      const url = `${baseURL}/webhook/campaign-state?campaign_id=${encodeURIComponent(campaignId)}`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`getCampaignState ${r.status}`);
      return r.json();
    },
    async postAction(payload) {
      const url = `${baseURL}/webhook/campaign-action`;
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(`postAction ${r.status}`);
      return r.json();
    },
  };
}

/** @param {APIClientOptions} opts */
export function createAPIClient(opts) {
  if (opts.mode === 'mock') return createMockClient();
  if (opts.mode === 'real') return createRealClient({
    baseURL: opts.baseURL || '',
    token: opts.token || '',
  });
  throw new Error(`Unknown API mode: ${opts.mode}`);
}
