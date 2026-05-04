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
 * Defensive runtime check for the campaign-state response shape. Both mock
 * and real clients run this on outgoing payloads so a malformed response
 * trips the SPA's error toast at the API layer rather than corrupting the
 * Alpine state and producing confusing downstream errors.
 *
 * @param {unknown} state
 * @throws {Error} if state is not `{ campaign, blocks: [...] }`.
 */
function validateCampaignState(state) {
  if (!state || typeof state !== 'object' || !state.campaign || !Array.isArray(state.blocks)) {
    throw new Error('Invalid campaign state response: missing campaign or blocks');
  }
}

/**
 * Mock API: keeps an in-memory copy of MOCK_CAMPAIGN that mutates per action.
 * Used for development before the n8n backend is wired.
 */
function createMockClient() {
  const state = clone(MOCK_CAMPAIGN);

  return {
    async getCampaignState(_campaignId) {
      const cloned = clone(state);
      validateCampaignState(cloned);
      return cloned;
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
 * fetch wrapper that aborts after `timeoutMs`. Mapped to a friendlier error
 * message at the call site so editors don't see raw AbortError jargon.
 *
 * @param {string} url
 * @param {RequestInit} [opts]
 * @param {number} [timeoutMs] default 30s
 */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Real API client: talks to n8n webhooks. Wiring to actual backend is done
 * in the backend integration plan; this just defines the surface.
 *
 * @param {Required<Pick<APIClientOptions,'baseURL'|'token'>>} opts
 * @param {{ timeoutMs?: number }} [overrides] internal — tests pass a small timeout
 */
function createRealClient({ baseURL, token }, overrides = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
  const timeoutMs = overrides.timeoutMs ?? 30000;

  return {
    async getCampaignState(campaignId) {
      const url = `${baseURL}/webhook/campaign-state?campaign_id=${encodeURIComponent(campaignId)}`;
      let r;
      try {
        r = await fetchWithTimeout(url, { headers }, timeoutMs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
        throw e;
      }
      if (!r.ok) throw new Error(`getCampaignState ${r.status}`);
      const data = await r.json();
      validateCampaignState(data);
      return data;
    },
    async postAction(payload) {
      const url = `${baseURL}/webhook/campaign-action`;
      let r;
      try {
        r = await fetchWithTimeout(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        }, timeoutMs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
        throw e;
      }
      if (!r.ok) throw new Error(`postAction ${r.status}`);
      return r.json();
    },
  };
}

/**
 * @param {APIClientOptions & { timeoutMs?: number }} opts
 *   `timeoutMs` is an internal override for tests; production code should
 *   leave it undefined and accept the 30s default.
 */
export function createAPIClient(opts) {
  if (opts.mode === 'mock') return createMockClient();
  if (opts.mode === 'real') return createRealClient(
    { baseURL: opts.baseURL || '', token: opts.token || '' },
    { timeoutMs: opts.timeoutMs },
  );
  throw new Error(`Unknown API mode: ${opts.mode}`);
}
