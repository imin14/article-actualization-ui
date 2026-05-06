/**
 * @typedef {Object} APIClientOptions
 * @property {string} baseURL n8n base URL (e.g. https://n8n-prod.../).
 * @property {string} [token]
 * @property {() => string} [getToken] preferred over `token` — read at request
 *   time so the SPA can swap the token at runtime (e.g. after auth-failure
 *   recovery or onboarding via `?t=...`).
 */

/**
 * Defensive runtime check for the campaign-state response shape. Trips the
 * SPA's error toast at the API layer if the backend returns something
 * malformed, rather than corrupting the Alpine state with surprising
 * downstream errors.
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
function createRealClient({ baseURL, getToken }, overrides = {}) {
  const buildHeaders = () => ({
    'Content-Type': 'application/json',
    // Raw token, no "Bearer " prefix — Cloud Run intercepts "Bearer ..." as
    // a Google IAM token and rejects with 403 before n8n receives it.
    'Authorization': getToken(),
  });
  const timeoutMs = overrides.timeoutMs ?? 30000;

  return {
    async listCampaigns() {
      const url = `${baseURL}/webhook/campaign-state`;
      let r;
      try {
        r = await fetchWithTimeout(url, { headers: buildHeaders() }, timeoutMs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
        throw e;
      }
      if (!r.ok) throw new Error(`listCampaigns ${r.status}`);
      const data = await r.json();
      if (!data || !Array.isArray(data.campaigns)) throw new Error('Invalid campaigns response');
      return data.campaigns;
    },
    async getCampaignState(campaignId) {
      const url = `${baseURL}/webhook/campaign-state?campaign_id=${encodeURIComponent(campaignId)}`;
      let r;
      try {
        r = await fetchWithTimeout(url, { headers: buildHeaders() }, timeoutMs);
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
          headers: buildHeaders(),
          body: JSON.stringify(payload),
        }, timeoutMs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
        throw e;
      }
      if (!r.ok) throw new Error(`postAction ${r.status}`);
      return r.json();
    },
    /**
     * Trigger Storyblok cascade for a finished campaign. Returns immediately
     * with `{ queued: true, campaign_id, started_at }`; the cascade runs in
     * the background and the SPA polls campaign-state to learn when each
     * story's `cascaded_at` flips to non-null.
     *
     * @param {{ campaign_id: string, publish?: boolean }} payload
     *   publish: false (default) → draft; true → publish immediately.
     */
    async cascadeTrigger(payload) {
      const url = `${baseURL}/webhook/cascade-trigger`;
      let r;
      try {
        r = await fetchWithTimeout(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(payload),
        }, timeoutMs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
        throw e;
      }
      if (!r.ok) throw new Error(`cascadeTrigger ${r.status}`);
      return r.json();
    },
    /**
     * Trigger (or retry) translation for a single cascaded story. WF-Translate
     * detects non-empty target locales and fires the Turkey translator
     * fire-and-forget. Same endpoint serves both initial trigger and manual
     * retry — workflow is idempotent.
     *
     * @param {{ campaign_id: string, story_id: string }} payload
     */
    async translateStory(payload) {
      const url = `${baseURL}/webhook/translate`;
      let r;
      try {
        r = await fetchWithTimeout(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(payload),
        }, timeoutMs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
        throw e;
      }
      if (!r.ok) throw new Error(`translateStory ${r.status}`);
      return r.json();
    },
    /**
     * Roll back one story (story_id present) or the entire campaign
     * (story_id omitted). Restores from pre_cascade_snapshot column.
     *
     * @param {{ campaign_id: string, story_id?: string }} payload
     */
    async cascadeRollback(payload) {
      const url = `${baseURL}/webhook/cascade-rollback`;
      let r;
      try {
        r = await fetchWithTimeout(url, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify(payload),
        }, timeoutMs);
      } catch (e) {
        if (e && e.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs}ms`);
        throw e;
      }
      if (!r.ok) throw new Error(`cascadeRollback ${r.status}`);
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
  const getToken = opts.getToken || (() => opts.token || '');
  return createRealClient(
    { baseURL: opts.baseURL || '', getToken },
    { timeoutMs: opts.timeoutMs },
  );
}
