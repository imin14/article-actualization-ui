import Alpine from 'alpinejs';
import { createAPIClient } from './lib/api.js';
import { groupByStory, computeProgress, applyAction, getNextPendingStory, getPendingBlocksInStory, NOT_REVIEWED, REVIEWED } from './lib/state.js';
import { renderDiffHTML } from './lib/diff.js';
import { nextFocusable, prevFocusable } from './lib/focus.js';
import { TRANSLATIONS, SUPPORTED_LOCALES, DEFAULT_LOCALE, readStoredLocale, writeStoredLocale, translate, formatDateTime } from './lib/i18n.js';

window.Alpine = Alpine;

// Lookup the appRoot reactive scope. Used by child component factories that
// can't reach the parent via `this.$root` (Alpine 3 returns the *closest*
// x-data ancestor, including self, not the topmost — so from inside a child
// x-data the magic doesn't climb to appRoot). DOM lookup is reliable.
function getAppRootScope() {
  const el = document.querySelector('#app');
  return el && el._x_dataStack ? el._x_dataStack[0] : null;
}

// === Configuration ===
// API config is read from URL query params:
//   ?campaign=<campaign_id>   — opens a specific campaign view
//   ?api=<n8n base URL>       — overrides the default production API
//   ?t=<bearer token>         — one-time onboarding token; saved to localStorage
//                               and scrubbed from URL on first load.
//
// Default API points at the production n8n instance — there is no mock mode.
const PRODUCTION_API_BASE_URL = 'https://n8n-prod-960265555894.europe-west3.run.app';

const params = new URLSearchParams(window.location.search);
const CAMPAIGN_ID_PARAM = params.get('campaign');
const CAMPAIGN_ID = CAMPAIGN_ID_PARAM || '';
// True only when the URL explicitly named a campaign — otherwise the editor
// is just landing on the SPA to start a new one and we should skip the
// auto-load (which would otherwise hit a non-existent campaign and show a
// confusing error toast).
const HAS_EXPLICIT_CAMPAIGN = !!CAMPAIGN_ID_PARAM;

const API_BASE_URL = params.get('api') || PRODUCTION_API_BASE_URL;

// Token lives in localStorage so it doesn't sit in the URL bar / history /
// referer / shared links. The URL `?t=...` form is for one-time onboarding —
// the editor opens it once and the token is moved to localStorage immediately.
const TOKEN_STORAGE_KEY = 'actualization_ui_token_v1';
function readStoredToken() {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY) || ''; } catch { return ''; }
}
function writeStoredToken(t) {
  try { localStorage.setItem(TOKEN_STORAGE_KEY, t); } catch {}
}
function clearStoredToken() {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch {}
}

// Per-campaign search config (keyword, prompt, etc.) is kept in localStorage
// so the SPA can re-trigger the same workflow run with the same parameters
// without making the user re-fill the form. The workflow itself dedupes by
// (campaign_id, story_id) so re-submitting is safe — already-processed
// stories are skipped.
const CAMPAIGN_CONFIGS_KEY = 'actualization_ui_campaign_configs_v1';
function readCampaignConfigs() {
  try {
    const raw = localStorage.getItem(CAMPAIGN_CONFIGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveCampaignConfig(campaignId, config) {
  if (!campaignId) return;
  try {
    const all = readCampaignConfigs();
    all[campaignId] = { ...config, _saved_at: new Date().toISOString() };
    localStorage.setItem(CAMPAIGN_CONFIGS_KEY, JSON.stringify(all));
  } catch {}
}
function getCampaignConfig(campaignId) {
  const all = readCampaignConfigs();
  return all[campaignId] || null;
}

const urlToken = params.get('t');
if (urlToken) {
  // Strip a leading "Bearer " in case the onboarding link was built with the
  // full credential value rather than just the secret. SPA prepends "Bearer "
  // itself, so doubling would produce 403.
  writeStoredToken(urlToken.trim().replace(/^bearer\s+/i, ''));
  params.delete('t');
  const newSearch = params.toString();
  const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
  window.history.replaceState(null, '', newUrl);
}

let CURRENT_TOKEN = readStoredToken();
const API_TOKEN = CURRENT_TOKEN; // legacy alias used elsewhere in this file

const api = createAPIClient({
  baseURL: API_BASE_URL,
  getToken: () => CURRENT_TOKEN,
});

// Centralised auth-failure handler. Wipes the stored token and reloads the
// SPA so the auth-gate screen is shown fresh. Called from anywhere a backend
// returns 401/403 (or whatever the response parses as "unauthorized").
function isAuthFailure(error) {
  const msg = String(error && (error.message || error)).toLowerCase();
  return msg.includes('401') || msg.includes('403') || msg.includes('unauthorized') || msg.includes('authorization data');
}
function handleAuthFailure() {
  clearStoredToken();
  CURRENT_TOKEN = '';
  window.location.reload();
}

/** Walk a Storyblok story.content tree and return a map block_uid →
 *  { prev: {uid, component, excerpt}, next: {...} }. "Neighbors" are the
 *  block's siblings in the same parent array — for a top-level textBlock,
 *  that's the block before/after; for a deeply-nested table_cell, it's
 *  cells in the same row. We visit every array of blocks (anything whose
 *  first item has a _uid + component) and emit neighbor entries. */
function buildNeighborMap(content) {
  const out = {};
  // For each block we expose three forms of context to the editor:
  //   1. heading_path: nearest section title(s) above (e.g. "Portugal
  //      Golden Visa" when matched block is buried inside that section).
  //   2. table_context: column header + row label when the block sits in
  //      a table cell. Critical for "5 years"-style cells in comparison
  //      tables that mean nothing without column/row anchoring.
  //   3. neighbors: prev/next sibling blocks (walk-up to nearest array
  //      with > 1 sibling so single-child sections still get useful
  //      surrounding context).
  function isProseString(s) {
    const t = String(s).trim();
    if (!t) return false;
    if (t.length < 5) return false;
    if (/^https?:\/\//i.test(t)) return false;
    if (/^\/\//.test(t)) return false;
    if (/\.(jpe?g|png|gif|svg|webp|avif|mp4|webm|pdf|woff2?|ttf|css|js|json)(\?|$)/i.test(t)) return false;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false;
    if (/^#[0-9a-f]{3,8}$/i.test(t)) return false;
    if (/^(doc|paragraph|text|bold|italic|underline|link|textStyle|table|table_row|table_cell|heading|bullet_list|list_item|ordered_list|default|primary|secondary|center|left|right|top|bottom|small|medium|large|none|auto)$/i.test(t)) return false;
    if (/^<!--/.test(t)) return false; // Storyblok meta comments
    if (/^[\[\{]/.test(t) && /[\]\}]$/.test(t)) return false; // looks like JSON blob
    return true;
  }
  function excerptOf(b) {
    if (!b || typeof b !== 'object') return '';
    const pieces = [];
    function walk(o, depth) {
      if (!o || depth > 12) return;
      if (typeof o === 'string') { if (isProseString(o)) pieces.push(o); return; }
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (typeof o === 'object') {
        for (const k of Object.keys(o)) {
          if (k === '_uid' || k === '_editable' || k === 'component' || k === 'type') continue;
          walk(o[k], depth + 1);
        }
      }
    }
    walk(b, 0);
    return pieces.join(' ').replace(/\s+/g, ' ').trim().slice(0, 280);
  }
  // Each entry in the chain: { arr (parent block-array), idx (position in
  // arr), parent (the parent BLOCK whose body/content holds this array, or
  // null if at the root of story.content) }
  const chains = new Map();
  function recordChains(node, chain, parentBlock) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      const blocks = node.filter(x => x && typeof x === 'object' && x._uid && x.component);
      if (blocks.length > 0) {
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          const newChain = chain.concat([{ arr: blocks, idx: i, parent: parentBlock }]);
          chains.set(b._uid, newChain);
          recordChains(b, newChain, b);
        }
        for (const item of node) {
          if (!(item && typeof item === 'object' && item._uid && item.component)) recordChains(item, chain, parentBlock);
        }
      } else {
        for (const item of node) recordChains(item, chain, parentBlock);
      }
      return;
    }
    for (const k of Object.keys(node)) {
      if (k === '_uid' || k === '_editable' || k === 'component') continue;
      recordChains(node[k], chain, parentBlock);
    }
  }
  recordChains(content, [], null);

  function shortText(s, n) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  }

  // Section-title-like fields on Storyblok block components.
  function blockTitle(b) {
    if (!b || typeof b !== 'object') return '';
    return shortText(b.title || b.headline || b.heading || b.name || '', 140);
  }

  // For a block that sits inside a table_cell (or is one), derive
  // { column, row_label, caption }. Walks chain to find the table block
  // (one with `rows` array) and extracts:
  //   column = first cell of row 0 at the same cell index
  //   row_label = first cell of the current row
  //   caption = title/headline of the table block itself or the nearest
  //             ancestor block with a title
  function tableContextFor(uid, chain) {
    if (!chain || chain.length === 0) return null;
    // Find the deepest ancestor that has a `rows` array, and the cell
    // index this uid sits under.
    let tableBlock = null;
    let rowIdx = -1;
    let cellIdx = -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      const link = chain[i];
      const cand = link.parent;
      if (cand && Array.isArray(cand.rows) && cand.rows.length > 0) {
        tableBlock = cand;
        // The chain entries between this level and the table tell us row/cell.
        // Walk forward until we exit the table to find row + cell indexes.
        for (let j = i; j < chain.length; j++) {
          const p = chain[j].parent;
          if (!p) continue;
          // A row object typically has .cells; the chain hop INTO cells
          // gives us cellIdx. The hop into rows gives rowIdx.
          if (Array.isArray(p.cells) && cellIdx < 0) {
            cellIdx = chain[j].idx;
            // The block that contains `cells` is the row; find its idx in
            // the previous link's array.
            if (j > 0) rowIdx = chain[j - 1].idx;
          }
        }
        break;
      }
    }
    if (!tableBlock) return null;
    let column = '';
    let rowLabel = '';
    if (rowIdx >= 0 && cellIdx >= 0 && tableBlock.rows[0] && Array.isArray(tableBlock.rows[0].cells)) {
      const headerCell = tableBlock.rows[0].cells[cellIdx];
      if (headerCell) column = shortText(excerptOf(headerCell), 200);
    }
    if (rowIdx >= 0 && tableBlock.rows[rowIdx] && Array.isArray(tableBlock.rows[rowIdx].cells)) {
      const labelCell = tableBlock.rows[rowIdx].cells[0];
      if (labelCell) rowLabel = shortText(excerptOf(labelCell), 200);
    }
    // Caption: prefer table block's own title; else nearest ancestor with one.
    let caption = blockTitle(tableBlock);
    if (!caption) {
      for (let i = chain.length - 1; i >= 0; i--) {
        const t = blockTitle(chain[i].parent);
        if (t) { caption = t; break; }
      }
    }
    if (!column && !rowLabel && !caption) return null;
    return { column, row_label: rowLabel, caption };
  }

  // Heading path = section titles of ancestor BLOCKS, outermost first.
  // E.g. story → "Portugal Golden Visa" → "Pros and cons" → matched block.
  function headingPathFor(chain) {
    const path = [];
    for (const link of chain) {
      const t = blockTitle(link.parent);
      if (t) path.push(t);
    }
    return path;
  }

  for (const [uid, chain] of chains) {
    let prev = null, next = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const { arr, idx } = chain[i];
      if (arr.length <= 1) continue;
      if (idx > 0) prev = arr[idx - 1];
      if (idx < arr.length - 1) next = arr[idx + 1];
      break;
    }
    out[uid] = {
      prev: prev ? { uid: prev._uid, component: prev.component, excerpt: excerptOf(prev) } : null,
      next: next ? { uid: next._uid, component: next.component, excerpt: excerptOf(next) } : null,
      heading_path: headingPathFor(chain),
      table_context: tableContextFor(uid, chain),
    };
  }
  return out;
}

/** Extract the first paragraph or text snippet that contains the keyword,
 *  for use as a Chrome text-fragment URL. Falls back to the first leaf text
 *  in the block if no field_hits are present. */
function extractFirstHitExcerpt(block) {
  if (!block) return '';
  // Look at proposed_payload (closest to live text) → original_payload.
  const payload = block.original_payload || block.proposed_payload || {};
  const pieces = [];
  function walk(o, depth) {
    if (!o || depth > 6) return;
    if (typeof o === 'string') { pieces.push(o); return; }
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    if (typeof o === 'object') {
      if (typeof o.text === 'string') pieces.push(o.text);
      if (typeof o.textMarkdown === 'string') pieces.push(o.textMarkdown);
      if (typeof o.headline === 'string') pieces.push(o.headline);
      if (Array.isArray(o.content)) walk(o.content, depth + 1);
    }
  }
  walk(payload, 0);
  const text = pieces.join(' ').replace(/[*_`#>~\\]+/g, '').replace(/\s+/g, ' ').trim();
  // Prefer a substring around the first occurrence of the keyword. We don't
  // know the campaign keyword here, so we just take the first ~80 chars.
  return text.slice(0, 100);
}

window.appRoot = function () {
  return {
    loading: true,
    error: null,
    globalError: null,
    state: null,        // CampaignState from API
    groups: [],         // grouped by story
    // 'auth' shown when no token in storage. The auth screen is the only way
    // in — every other screen requires a valid token.
    screen: 'overview', // 'auth' | 'campaigns' | 'overview' | 'story' | 'done' | 'search'
    currentStoryId: null,
    hasToken: !!CURRENT_TOKEN,

    // ─── i18n ──────────────────────────────────────────────────────────
    // Reactive locale; templates do `x-text="t('key')"` and re-render when
    // setLocale() flips it. The t() function reads this.locale to register
    // an Alpine reactivity dependency.
    locale: readStoredLocale(),
    SUPPORTED_LANGS: SUPPORTED_LOCALES,
    t(key, params) {
      // Read this.locale FIRST so Alpine tracks the dependency.
      const loc = this.locale;
      return translate(TRANSLATIONS, key, loc, params);
    },
    fmtDateTime(iso) {
      const loc = this.locale;
      return formatDateTime(iso, loc);
    },
    setLocale(loc) {
      if (!SUPPORTED_LOCALES.includes(loc)) return;
      this.locale = loc;
      writeStoredLocale(loc);
    },
    toggleLocale() {
      const next = this.locale === 'ru' ? 'en' : 'ru';
      this.setLocale(next);
    },
    authForm: { token: '', error: '', saving: false },
    campaigns: [],
    campaignsLoading: false,
    campaignsError: null,

    // Keyboard shortcut state
    focusedRowId: null,    // currently focused block on story screen
    focusedStoryId: null,  // currently focused story on overview screen
    helpOpen: false,
    // Tracks per-block UI state so the global keydown handler knows whether
    // to intercept non-Escape keys. blockActions reports into these via
    // notifyBlockUi(). Sets are keyed by row_id.
    _blocksWithOpenModal: new Set(),
    _blocksEditing: new Set(),

    async init() {
      // Auth gate: no token → straight to the auth screen. We never hit the
      // API in that state, so an empty token can't trigger a 401 cascade.
      if (!this.hasToken) {
        this.screen = 'auth';
        this.loading = false;
        return;
      }
      // No explicit ?campaign= → land on campaigns picker. Editor either
      // resumes an existing campaign or kicks off a new search.
      if (!HAS_EXPLICIT_CAMPAIGN) {
        this.screen = 'campaigns';
        this.loading = false;
        this.loadCampaigns();
        return;
      }
      try {
        await this.refresh();
        this.loadCampaigns().catch(() => {});
        // Quiet polling so the "Search status" indicator transitions from
        // running → idle on its own, and new blocks materialise as they
        // get inserted. Only polls when the user is on a campaign view
        // (story or overview screen) — auth and search forms are skipped.
        this._startStatusPolling();
      } catch (e) {
        if (isAuthFailure(e)) {
          handleAuthFailure();
          return;
        }
        this.error = String(e.message || e);
      } finally {
        this.loading = false;
      }
    },

    async submitAuthToken() {
      // Strip a leading "Bearer " if the editor copy-pasted the entire
      // credential value from n8n (which already includes "Bearer "). The
      // SPA prepends "Bearer " itself when sending the request, so storing
      // it again here would produce "Bearer Bearer ..." and 403.
      const tok = String(this.authForm.token || '').trim().replace(/^bearer\s+/i, '');
      if (!tok) {
        this.authForm.error = this.t('auth.empty_token_error');
        return;
      }
      this.authForm.saving = true;
      this.authForm.error = '';
      writeStoredToken(tok);
      window.location.reload();
    },

    logout() {
      handleAuthFailure();
    },

    async loadCampaigns() {
      this.campaignsLoading = true;
      this.campaignsError = null;
      try {
        const list = await api.listCampaigns();
        this.campaigns = list || [];
      } catch (e) {
        if (isAuthFailure(e)) {
          handleAuthFailure();
          return;
        }
        this.campaignsError = String(e.message || e);
      } finally {
        this.campaignsLoading = false;
      }
    },

    openCampaign(campaignId) {
      // Navigate via URL so a refresh stays on the campaign and the rest of
      // the SPA's flow (init → refresh → render) takes over normally.
      const params = new URLSearchParams(window.location.search);
      params.set('campaign', campaignId);
      window.location.search = params.toString();
    },

    // Per-campaign delete confirm state. campaign_id → typed value.
    deleteCampaignTarget: null,
    deleteCampaignTyped: '',
    deleteCampaignBusy: false,
    deleteCampaignError: null,
    openDeleteCampaign(campaignId) {
      this.deleteCampaignTarget = campaignId;
      this.deleteCampaignTyped = '';
      this.deleteCampaignError = null;
    },
    closeDeleteCampaign() {
      this.deleteCampaignTarget = null;
      this.deleteCampaignTyped = '';
      this.deleteCampaignError = null;
    },
    async confirmDeleteCampaign() {
      const cid = this.deleteCampaignTarget;
      if (!cid) return;
      if (this.deleteCampaignTyped.trim() !== cid) {
        this.deleteCampaignError = this.t('campaigns.delete.typed_mismatch');
        return;
      }
      this.deleteCampaignBusy = true;
      this.deleteCampaignError = null;
      try {
        await api.deleteCampaign(cid);
        // Drop locally cached config + content for that campaign.
        try {
          const all = readCampaignConfigs();
          delete all[cid];
          localStorage.setItem(CAMPAIGN_CONFIGS_KEY, JSON.stringify(all));
        } catch {}
        delete this.storyContentCache[cid];
        this.closeDeleteCampaign();
        await this.loadCampaigns();
      } catch (e) {
        if (isAuthFailure(e)) { handleAuthFailure(); return; }
        this.deleteCampaignError = String(e.message || e);
      } finally {
        this.deleteCampaignBusy = false;
      }
    },

    goToCampaigns() {
      this.screen = 'campaigns';
      if (!this.campaigns.length) this.loadCampaigns();
    },

    // ─── Search execution status + resume ────────────────────────
    // The SPA infers "is the search workflow currently running for this
    // campaign?" from the freshness of the latest block-row updated_at.
    // n8n stamps each newly-inserted row with the current ISO timestamp,
    // so a recent timestamp implies the workflow is actively writing.
    // Threshold is 90s — accommodates one CDN-page batch + one LLM call.
    runningThresholdMs: 90 * 1000,
    resumeBusy: false,
    resumeError: null,
    resumeMessage: null,
    get latestBlockUpdatedAt() {
      const blocks = this.state && this.state.blocks ? this.state.blocks : [];
      let latest = '';
      for (const b of blocks) { if (b.updated_at && b.updated_at > latest) latest = b.updated_at; }
      return latest || null;
    },
    get isSearchRunning() {
      const latest = this.latestBlockUpdatedAt;
      if (!latest) return false;
      const ageMs = Date.now() - new Date(latest).getTime();
      return ageMs >= 0 && ageMs < this.runningThresholdMs;
    },
    get searchStatusLabel() {
      if (this.isSearchRunning) return 'running';
      if (!this.state || !this.state.blocks || this.state.blocks.length === 0) return 'empty';
      return 'idle';
    },
    get hasResumeConfig() {
      if (!this.state || !this.state.campaign) return false;
      return !!getCampaignConfig(this.state.campaign.id);
    },
    _statusPollHandle: null,
    _startStatusPolling() {
      if (this._statusPollHandle) return;
      const POLL_MS = 8000;
      const tick = async () => {
        // Skip polling on screens where state isn't being viewed.
        if (this.screen !== 'overview' && this.screen !== 'story') return;
        if (this.loading || this.error) return;
        try { await this.refresh(); } catch { /* silent — polling shouldn't bubble */ }
      };
      this._statusPollHandle = setInterval(tick, POLL_MS);
    },
    async resumeCurrentCampaign() {
      this.resumeError = null;
      this.resumeMessage = null;
      if (!this.state || !this.state.campaign) return;
      const cid = this.state.campaign.id;
      const cfg = getCampaignConfig(cid);
      if (!cfg) {
        this.resumeError = this.t('overview.resume.no_config');
        return;
      }
      this.resumeBusy = true;
      try {
        const res = await fetch(`${API_BASE_URL}/webhook/search-trigger`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: CURRENT_TOKEN },
          body: JSON.stringify({ ...cfg, campaign_id: cid }),
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${res.status}` }; }
        if (res.status === 401 || res.status === 403) { handleAuthFailure(); return; }
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        this.resumeMessage = this.t('overview.resume.message');
        // Refresh once after a beat so the new block.updated_at flips status
        // to "running" without the user having to F5.
        setTimeout(() => { this.refresh().catch(() => {}); }, 2000);
      } catch (e) {
        this.resumeError = String(e.message || e);
      } finally {
        this.resumeBusy = false;
      }
    },

    // ─── Cascade publish + rollback ─────────────────────────────
    //
    // After every block is reviewed (status in {accepted, edited, skipped,
    // deleted}), the editor publishes the campaign — pushes accepted/edited
    // blocks to Storyblok and triggers translation cascade. Cascade is
    // backed by snapshots so individual stories or the whole campaign can
    // be rolled back from the SPA.

    publishModalOpen: false,
    // Phase 2A: cascade pushes ONLY the source-locale (RU master) update via
    // Storyblok mAPI. Translations are intentionally NOT in this phase —
    // they will land in Phase 2B as a separate trigger to Turkey Blocks
    // Generator workflow.
    publishImmediately: false,     // false = draft (default, safe), true = publish immediately
    publishBusy: false,
    publishError: null,
    publishMessage: null,

    /** True iff every block in the campaign has been decided by the editor.
     *  proposed/proposed_delete/pending/error all count as "still needs review". */
    get readyToPublish() {
      const p = this.state && this.state.progress;
      if (!p || p.total === 0) return false;
      return p.reviewed >= p.total;
    },
    /** A row is "currently published" iff it was cascaded AND not since
     *  rolled back (rolled_back_at <= cascaded_at, or no rolled_back_at).
     *  We can't clear cascaded_at on rollback (n8n DataTable rejects empty
     *  strings on date cols), so we infer state by comparing timestamps. */
    isCurrentlyPublished(b) {
      if (!b.cascaded_at) return false;
      if (!b.rolled_back_at) return true;
      return new Date(b.rolled_back_at).getTime() < new Date(b.cascaded_at).getTime();
    },
    /** True when at least one decided-but-not-currently-published block
     *  exists. Drives the "publish" banner. Partial publish is allowed:
     *  editor doesn't have to wait until the whole campaign is reviewed.
     *  Rolled-back rows naturally land here because they're not currently
     *  published (rolled_back_at > cascaded_at). */
    get hasPublishableRows() {
      const blocks = this.state && this.state.blocks ? this.state.blocks : [];
      return blocks.some(b => ['accepted','edited','deleted'].includes(b.status) && !this.isCurrentlyPublished(b));
    },
    /** Count of decided-but-not-currently-published blocks (banner display). */
    get publishableRowCount() {
      const blocks = this.state && this.state.blocks ? this.state.blocks : [];
      return blocks.filter(b => ['accepted','edited','deleted'].includes(b.status) && !this.isCurrentlyPublished(b)).length;
    },
    /** Count of blocks still awaiting editor decision (shown in partial-publish banner). */
    get unreviewedRowCount() {
      const blocks = this.state && this.state.blocks ? this.state.blocks : [];
      const NOT_DONE = new Set(['pending', 'proposed', 'proposed_delete', 'error']);
      return blocks.filter(b => NOT_DONE.has(b.status)).length;
    },
    /** Some stories currently published (drives campaign-rollback banner). */
    get hasCascadedRows() {
      const blocks = this.state && this.state.blocks ? this.state.blocks : [];
      return blocks.some(b => this.isCurrentlyPublished(b));
    },
    /** All actionable rows currently published. */
    get fullyCascaded() {
      const blocks = this.state && this.state.blocks ? this.state.blocks : [];
      const actionable = blocks.filter(b => ['accepted','edited','deleted'].includes(b.status));
      if (actionable.length === 0) return false;
      return actionable.every(b => this.isCurrentlyPublished(b));
    },
    /** story_id -> { cascaded, locales, has_snapshot, partial, translation }
     *  for overview badges + rollback buttons + planet emoji.
     *
     *  translation: aggregated metadata for the planet tooltip:
     *    { status, source, target_locales, locale_counts, triggered_at, age_minutes }
     *    status ∈ {none, queued, triggered, no_targets, skipped, stale}
     *    - 'none' means cascade_locale_results unset
     *    - 'queued' set by Mark rows cascaded right after PUT
     *    - 'triggered' set by WF-Translate after Turkey fired
     *    - 'no_targets' set by WF-Translate when no locales meet threshold
     *    - 'stale' = triggered, but >10 min ago AND status hasn't moved on
     *      (heuristic for "Turkey probably failed silently — offer retry") */
    get cascadeStateByStory() {
      const out = {};
      const blocks = this.state && this.state.blocks ? this.state.blocks : [];
      const STALE_MS = 10 * 60 * 1000;
      const now = Date.now();
      for (const b of blocks) {
        if (!out[b.story_id]) out[b.story_id] = { cascaded: false, locales: null, has_snapshot: false, has_publishable: false, translation: null };
        const s = out[b.story_id];
        const published = this.isCurrentlyPublished(b);
        if (published) s.cascaded = true;
        if (b.has_snapshot) s.has_snapshot = true;
        if (b.cascade_locale_results && !s.translation) {
          const r = b.cascade_locale_results;
          let status = r.translation_status || 'none';
          // Stale = triggered but Turkey hasn't reported back in a while.
          // (We can't *know* — heuristic only. Lets user retry safely.)
          if (status === 'triggered' || status === 'queued') {
            const t = r.translation_triggered_at || b.cascaded_at;
            if (t) {
              const ageMs = now - new Date(t).getTime();
              if (ageMs > STALE_MS) status = 'stale';
            }
          }
          s.translation = {
            status,
            source: r.source || null,
            target_locales: r.target_locales || [],
            locale_counts: r.locale_counts || {},
            triggered_at: r.translation_triggered_at || null,
            published: r.published === true,
          };
        }
        if (b.cascade_locale_results && !s.locales) s.locales = b.cascade_locale_results;
        if (['accepted','edited','deleted'].includes(b.status) && !published) s.has_publishable = true;
      }
      for (const k of Object.keys(out)) {
        out[k].partial = out[k].cascaded && out[k].has_publishable;
      }
      return out;
    },

    openPublishModal() {
      this.publishImmediately = false;   // default safe: draft
      this.publishError = null;
      this.publishMessage = null;
      this.publishModalOpen = true;
    },
    closePublishModal() {
      this.publishModalOpen = false;
    },
    async confirmPublish() {
      if (!this.state || !this.state.campaign) return;
      this.publishBusy = true;
      this.publishError = null;
      try {
        const res = await api.cascadeTrigger({
          campaign_id: this.state.campaign.id,
          publish: this.publishImmediately,
        });
        const tail = res.queued ? this.t('toast.cascade_queued_tail') : '';
        this.publishMessage = this.t(this.publishImmediately ? 'toast.cascade_started_publish' : 'toast.cascade_started_draft', { tail }).trim();
        this.publishModalOpen = false;
        // Force immediate refresh so the cascade banner appears asap; further
        // updates ride on the existing 8s polling interval.
        setTimeout(() => { this.refresh().catch(() => {}); }, 5000);
      } catch (e) {
        if (isAuthFailure(e)) { handleAuthFailure(); return; }
        this.publishError = String(e.message || e);
      } finally {
        this.publishBusy = false;
      }
    },

    /** Roll back one story (or the entire campaign if storyId is omitted). */
    async rollbackStory(storyId) {
      if (!this.state || !this.state.campaign) return;
      const ok = confirm(storyId
        ? this.t('confirm.rollback_story', { id: storyId })
        : this.t('confirm.rollback_campaign'));
      if (!ok) return;
      this.publishBusy = true;
      this.publishError = null;
      try {
        const payload = { campaign_id: this.state.campaign.id };
        if (storyId) payload.story_id = String(storyId);
        await api.cascadeRollback(payload);
        this.publishMessage = this.t(storyId ? 'toast.story_rolled_back' : 'toast.campaign_rolled_back');
        setTimeout(() => { this.refresh().catch(() => {}); }, 3000);
      } catch (e) {
        if (isAuthFailure(e)) { handleAuthFailure(); return; }
        this.publishError = String(e.message || e);
      } finally {
        this.publishBusy = false;
      }
    },

    /** Build the multi-line tooltip for a story's planet emoji. Called from
     *  the overview template's `:title` binding. Lives in app.js (not inline)
     *  so the IIFE doesn't shadow the i18n `t` function and so all string
     *  literals are localised. */
    translationTooltip(storyId) {
      const s = this.cascadeStateByStory[storyId];
      if (!s || !s.translation) return '';
      const tr = s.translation;
      const lines = [];
      lines.push(this.t(tr.published ? 'overview.story.translate.master.published' : 'overview.story.translate.master.draft'));
      if (tr.source) lines.push(this.t('overview.story.translate.master_label', { locale: tr.source }));
      if (tr.status === 'triggered' && tr.target_locales && tr.target_locales.length) {
        lines.push(this.t('overview.story.translate.triggered', { locales: tr.target_locales.join(', ') }));
        if (tr.triggered_at) lines.push(this.t('overview.story.translate.triggered_at', { time: this.fmtDateTime(tr.triggered_at) }));
      } else if (tr.status === 'queued') {
        lines.push(this.t('overview.story.translate.queued'));
      } else if (tr.status === 'no_targets') {
        lines.push(this.t('overview.story.translate.no_targets'));
      } else if (tr.status === 'stale') {
        lines.push(this.t('overview.story.translate.stale'));
        lines.push(this.t('overview.story.translate.stale_action'));
      } else if (tr.status === 'skipped') {
        lines.push(this.t('overview.story.translate.skipped'));
      }
      return lines.join('\n');
    },

    /** Trigger / re-trigger translation for one cascaded story. Idempotent:
     *  the translate workflow detects current state and re-fires Turkey. */
    async retryTranslation(storyId) {
      if (!this.state || !this.state.campaign || !storyId) return;
      this.publishBusy = true;
      this.publishError = null;
      try {
        await api.translateStory({
          campaign_id: this.state.campaign.id,
          story_id: String(storyId),
        });
        this.publishMessage = this.t('toast.translate_triggered');
        setTimeout(() => { this.refresh().catch(() => {}); }, 3000);
      } catch (e) {
        if (isAuthFailure(e)) { handleAuthFailure(); return; }
        this.publishError = String(e.message || e);
      } finally {
        this.publishBusy = false;
      }
    },

    /** Roll back ONE block to its pre-cascade state. Storyblok story is
     *  fetched fresh, the block is found by _uid, replaced with snapshot
     *  version, and PUT'd back. Other blocks of the same story (whether
     *  cascaded or not) are left untouched. */
    async rollbackBlock(rowId) {
      if (!this.state || !this.state.campaign || !rowId) return;
      const ok = confirm(this.t('confirm.rollback_block'));
      if (!ok) return;
      this.publishBusy = true;
      this.publishError = null;
      try {
        await api.cascadeRollback({
          campaign_id: this.state.campaign.id,
          row_id: String(rowId),
        });
        this.publishMessage = this.t('toast.block_rolled_back');
        setTimeout(() => { this.refresh().catch(() => {}); }, 2000);
      } catch (e) {
        if (isAuthFailure(e)) { handleAuthFailure(); return; }
        this.publishError = String(e.message || e);
      } finally {
        this.publishBusy = false;
      }
    },

    // ─── Drill-in / drill-out (матрёшка) navigation ─────────────
    // Three nested levels: Campaigns → Stories → Blocks. drillUp() unwinds
    // by one level; drillDown() opens the focused (or first) child item.
    drillUp() {
      if (this.screen === 'story') { this.goToOverview(); return; }
      if (this.screen === 'overview' || this.screen === 'done') { this.goToCampaigns(); return; }
    },
    drillDown() {
      if (this.screen === 'campaigns') {
        const c = this.campaigns && this.campaigns[0];
        if (c) this.openCampaign(c.id);
        return;
      }
      if (this.screen === 'overview') {
        const target = this.focusedStoryId
          || (this.groups && this.groups[0] && this.groups[0].story_id);
        if (target) this.goToStory(target);
        return;
      }
      if (this.screen === 'story') {
        // No nested screen for individual blocks — just focus the next block.
        const blocks = this.currentStoryBlocks;
        if (!blocks.length) return;
        const idx = blocks.findIndex(b => b.row_id === this.focusedRowId);
        const next = idx < 0 ? blocks[0] : blocks[Math.min(idx + 1, blocks.length - 1)];
        if (next) this._moveFocus(next.row_id, 'block');
      }
    },

    /**
     * Heuristic status label for a campaign card.
     * - "running" if any block is still pending AND the row was updated
     *   within the last 2 minutes (search workflow likely still inserting)
     * - "ready"   if every block is non-pending (review complete)
     * - "review"  otherwise (some pending, but search appears done)
     */
    campaignStatus(c) {
      const total = c.total || 0;
      const pending = (c.by_status && c.by_status.pending) || 0;
      const reviewed = total - pending;
      if (total === 0) return { label: 'empty', tone: 'neutral' };
      if (pending === 0) return { label: 'ready', tone: 'success' };
      const last = c.last_updated_at ? Date.parse(c.last_updated_at) : 0;
      const ageMs = Date.now() - last;
      if (last && ageMs < 2 * 60 * 1000) return { label: 'running', tone: 'warning' };
      return { label: `${reviewed}/${total}`, tone: 'progress' };
    },

    async refresh() {
      const state = await api.getCampaignState(CAMPAIGN_ID);
      state.progress = computeProgress(state.blocks);
      this.state = state;
      this.groups = groupByStory(state.blocks);

      // If finished and no pending stories anywhere, show 'done'.
      // "Done" only when there's actually something AND it's all reviewed.
      // If total === 0, the campaign is just empty (no matches yet, or the
      // search workflow is still running) — showing the done screen would
      // be misleading.
      if (this.state.progress.total > 0 && this.state.progress.reviewed >= this.state.progress.total) {
        this.screen = 'done';
      }

      this._loadServerConfig().catch(() => {});
    },

    // Story content cache: story_id → { content, neighbors_by_uid }.
    // Lazy-loaded when the editor opens a story. neighbors_by_uid maps a
    // block_uid to { prev: {uid, excerpt, component}, next: {...} } so block
    // cards can render surrounding-block excerpts inline.
    storyContentCache: {},
    _storyContentLoading: {},
    async loadStoryContent(storyId) {
      if (!storyId) return null;
      if (this.storyContentCache[storyId]) return this.storyContentCache[storyId];
      if (this._storyContentLoading[storyId]) return this._storyContentLoading[storyId];
      const promise = (async () => {
        try {
          const res = await api.getStoryContent(storyId);
          const content = (res && res.content) || {};
          const neighbors = buildNeighborMap(content);
          const entry = { content, neighbors_by_uid: neighbors, full_slug: res && res.full_slug, path: res && res.path };
          this.storyContentCache[storyId] = entry;
          return entry;
        } catch { return null; }
        finally { delete this._storyContentLoading[storyId]; }
      })();
      this._storyContentLoading[storyId] = promise;
      return promise;
    },

    /** Public live URL for a block — opens imin's blog page with a Chrome
     *  text-fragment scroll-to-and-highlight on the matched paragraph.
     *
     *  URL building priority:
     *  1. Storyblok `path` field if set on the story (canonical site path)
     *  2. Heuristic mapping from full_slug:
     *     - strip leading `immigrantinvest/` (Storyblok folder root, not in URL)
     *     - rewrite `new-blog/` → `ru/blog/` (RU campaigns)
     *     - everything else kept as-is (insider/, blog/, etc.)
     */
    blockLiveUrl(block) {
      if (!block || !block.story_full_slug) return null;
      const cached = block.story_id ? this.storyContentCache[block.story_id] : null;
      let publicPath = (cached && cached.path) || null;
      if (!publicPath) {
        let s = String(block.story_full_slug || '').replace(/^\/+|\/+$/g, '');
        if (s.startsWith('immigrantinvest/')) s = s.slice('immigrantinvest/'.length);
        if (s.startsWith('new-blog/')) s = 'ru/blog/' + s.slice('new-blog/'.length);
        publicPath = s;
      } else {
        publicPath = String(publicPath).replace(/^\/+|\/+$/g, '');
      }
      const base = 'https://immigrantinvest.com/' + publicPath + '/';
      const excerpt = extractFirstHitExcerpt(block);
      if (!excerpt) return base;
      const enc = encodeURIComponent(excerpt.slice(0, 80)).replace(/'/g, '%27');
      return base + '#:~:text=' + enc;
    },

    /** Storyblok admin URL for the story. Visual editor doesn't have a
     *  documented public way to scroll to a specific block, so we open the
     *  story and pass `_storyblok_c` as a hint (no-op if Storyblok ignores
     *  it; future-proof if they ever wire it up). Editor still has to
     *  locate the block visually. */
    blockStoryblokUrl(block) {
      if (!block || !block.story_id) return null;
      const base = 'https://app.storyblok.com/#/me/spaces/176292/stories/0/0/' + encodeURIComponent(block.story_id);
      if (block.block_uid) return base + '?_storyblok_c=' + encodeURIComponent(block.block_uid);
      return base;
    },

    /** Returns the full context bundle for a block:
     *  { prev, next, heading_path, table_context }. Empty defaults if the
     *  story content isn't loaded yet. */
    blockNeighbors(block) {
      if (!block || !block.story_id || !block.block_uid) return { prev: null, next: null, heading_path: [], table_context: null };
      const entry = this.storyContentCache[block.story_id];
      if (!entry) return { prev: null, next: null, heading_path: [], table_context: null };
      const ctx = entry.neighbors_by_uid[block.block_uid];
      if (!ctx) return { prev: null, next: null, heading_path: [], table_context: null };
      return ctx;
    },

    /** Returns true if there is any meaningful context worth showing. Drives
     *  the empty-state fallback in the context panel. */
    blockHasContext(block) {
      const c = this.blockNeighbors(block);
      if (!c) return false;
      if (c.heading_path && c.heading_path.length) return true;
      if (c.table_context && (c.table_context.column || c.table_context.row_label || c.table_context.caption)) return true;
      if (c.prev && c.prev.excerpt) return true;
      if (c.next && c.next.excerpt) return true;
      return false;
    },

    /** Per-block expanded state for the context panel. row_id → boolean. */
    contextOpenByRow: {},
    toggleContext(rowId) {
      this.contextOpenByRow[rowId] = !this.contextOpenByRow[rowId];
    },

    serverConfig: null,
    _serverConfigLoadedFor: null,
    async _loadServerConfig() {
      if (!this.state || !this.state.campaign) return;
      const cid = this.state.campaign.id;
      if (this._serverConfigLoadedFor === cid && this.serverConfig) return;
      try {
        const res = await api.getCampaignConfig(cid);
        this.serverConfig = (res && res.config) || null;
        this._serverConfigLoadedFor = cid;
        if (!this.serverConfig) {
          const local = getCampaignConfig(cid);
          if (local) {
            const { _saved_at, ...cfg } = local;
            try {
              await api.saveCampaignConfig(cid, cfg);
              this.serverConfig = cfg;
            } catch { /* swallow — backfill is best-effort */ }
          }
        }
      } catch { /* swallow — config is non-critical */ }
    },

    configOpen: false,
    toggleConfig() { this.configOpen = !this.configOpen; },
    configEntries() {
      const c = this.serverConfig;
      if (!c) return [];
      const order = ['campaign_topic','keyword','block_required_keywords','article_any_keywords','context_description','rewrite_prompt','source_locale','folder','content_type','dry_run'];
      const out = [];
      for (const k of order) {
        if (c[k] === undefined || c[k] === null || c[k] === '') continue;
        out.push({ key: k, value: typeof c[k] === 'object' ? JSON.stringify(c[k]) : String(c[k]) });
      }
      for (const k of Object.keys(c)) {
        if (order.indexOf(k) >= 0) continue;
        if (k.startsWith('_')) continue;
        if (c[k] === undefined || c[k] === null || c[k] === '') continue;
        out.push({ key: k, value: typeof c[k] === 'object' ? JSON.stringify(c[k]) : String(c[k]) });
      }
      return out;
    },

    goToStory(storyId) {
      this.currentStoryId = storyId;
      this.screen = 'story';
    },

    goToOverview() {
      this.currentStoryId = null;
      this.screen = 'overview';
    },

    goToSearch() {
      this.screen = 'search';
    },

    // Open the search form with the current campaign's id (and saved config
    // if available) pre-filled. Workflow's per-story dedup makes this safe
    // — already-scanned stories will be skipped on the second run.
    goToSearchForResume() {
      this._resumePrefill = null;
      if (this.state && this.state.campaign) {
        const cid = this.state.campaign.id;
        const cfg = getCampaignConfig(cid) || {};
        this._resumePrefill = {
          campaign_topic: cfg.campaign_topic || (this.state.campaign.topic || ''),
          campaign_id: cid,
          keyword: cfg.keyword || '',
          context_description: cfg.context_description || '',
          source_locale: cfg.source_locale || (this.state.campaign.source_locale || 'ru'),
          folder: cfg.folder || '',
          content_type: cfg.content_type || 'flatArticle',
          rewrite_prompt: cfg.rewrite_prompt || '',
          dry_run: cfg.dry_run !== false,
        };
      }
      this.screen = 'search';
    },

    async submitAction(payload) {
      // Optimistic update
      const idx = this.state.blocks.findIndex(b => b.row_id === payload.row_id);
      if (idx >= 0) {
        this.state.blocks[idx] = applyAction(this.state.blocks[idx], payload);
        this.state.progress = computeProgress(this.state.blocks);
        this.groups = groupByStory(this.state.blocks);
      }
      try {
        const result = await api.postAction({ ...payload, campaign_id: CAMPAIGN_ID });
        // Reconcile with server: if backend reports a different new_status
        // (e.g. Storyblok write failed → 'error' even though we predicted
        // 'accepted'), overwrite the local row so the UI reflects truth.
        if (result && result.new_status && idx >= 0) {
          const current = this.state.blocks[idx].status;
          if (current !== result.new_status) {
            this.state.blocks[idx] = { ...this.state.blocks[idx], status: result.new_status };
            this.state.progress = computeProgress(this.state.blocks);
            this.groups = groupByStory(this.state.blocks);
          }
        }
      } catch (e) {
        if (isAuthFailure(e)) {
          handleAuthFailure();
          return;
        }
        this.globalError = this.t('toast.action_failed', { message: e.message });
        await this.refresh();
        throw e;
      }
    },

    advanceToNextStory() {
      const next = getNextPendingStory(this.groups, this.currentStoryId);
      if (next) {
        this.currentStoryId = next;
      } else {
        this.screen = this.state.progress.reviewed >= this.state.progress.total ? 'done' : 'overview';
      }
    },

    // helpers exposed to child components via Alpine `$root`
    diffHTML(a, b) { return renderDiffHTML(a || '', b || ''); },

    // ---- keyboard / focus plumbing ----

    /** Called by blockActions to keep appRoot informed of per-block UI state. */
    notifyBlockUi(rowId, kind, open) {
      const set = kind === 'modal' ? this._blocksWithOpenModal
                : kind === 'editing' ? this._blocksEditing
                : null;
      if (!set) return;
      if (open) set.add(rowId); else set.delete(rowId);
    },

    /** Focused block on the current story (or null). */
    get focusedBlock() {
      if (!this.currentStoryId) return null;
      const g = this.groups.find(g => g.story_id === this.currentStoryId);
      if (!g) return null;
      return g.blocks.find(b => b.row_id === this.focusedRowId) || null;
    },

    /** Blocks of the current story (empty list if not on story screen). */
    get currentStoryBlocks() {
      if (this.screen !== 'story' || !this.currentStoryId) return [];
      const g = this.groups.find(g => g.story_id === this.currentStoryId);
      return g ? g.blocks : [];
    },

    /** Move focus and (optionally) scroll the new card into view. */
    _moveFocus(nextId, kind) {
      if (kind === 'block') this.focusedRowId = nextId;
      if (kind === 'story') this.focusedStoryId = nextId;
      if (!nextId) return;
      // Scroll into view on next tick so Alpine can update `:class` first.
      requestAnimationFrame(() => {
        const sel = kind === 'block'
          ? `[data-row-id="${nextId}"]`
          : `[data-story-id="${nextId}"]`;
        const el = document.querySelector(sel);
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    },

    focusNextBlock() {
      const list = this.currentStoryBlocks;
      const next = nextFocusable(this.focusedRowId, list);
      // Clamp: if we're past the end stay on the last one rather than dropping focus.
      if (next == null && list.length > 0 && this.focusedRowId != null) return;
      this._moveFocus(next, 'block');
    },

    focusPrevBlock() {
      const list = this.currentStoryBlocks;
      const prev = prevFocusable(this.focusedRowId, list);
      if (prev == null && list.length > 0 && this.focusedRowId != null) return;
      this._moveFocus(prev, 'block');
    },

    focusNextStory() {
      const list = this.groups;
      const next = nextFocusable(this.focusedStoryId, list);
      if (next == null && list.length > 0 && this.focusedStoryId != null) return;
      this._moveFocus(next, 'story');
    },

    focusPrevStory() {
      const list = this.groups;
      const prev = prevFocusable(this.focusedStoryId, list);
      if (prev == null && list.length > 0 && this.focusedStoryId != null) return;
      this._moveFocus(prev, 'story');
    },

    /** Dispatch a row-scoped action so the per-block component can react. */
    _dispatchRowAction(rowId, action) {
      window.dispatchEvent(new CustomEvent('row-action', {
        detail: { row_id: rowId, action },
      }));
    },

    /** True when story-screen has at least one pending block. */
    storyHasPendingBlocks() {
      return this.currentStoryBlocks.some(b => NOT_REVIEWED.has(b.status));
    },

    /** Is *some* block-level modal (skip/delete) currently open? */
    get _anyBlockModalOpen() {
      return this._blocksWithOpenModal.size > 0;
    },

    /** Is *some* block currently in inline-edit mode? */
    get _anyBlockEditing() {
      return this._blocksEditing.size > 0;
    },

    /**
     * Single root keydown listener. Routes keys based on screen + state.
     * Order matters: modal handling first, then text-input handling, then editing,
     * then per-screen shortcuts.
     */
    onGlobalKey(event) {
      const key = event.key;

      // Ignore key combinations with modifiers (cmd/ctrl/alt) so we don't
      // hijack the user's browser shortcuts (cmd+R, ctrl+L, etc.).
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      // 1. Help overlay open → only Escape and `?` close it.
      if (this.helpOpen) {
        if (key === 'Escape' || key === '?' || key === '/') {
          this.helpOpen = false;
          event.preventDefault();
        }
        return;
      }

      // 2. globalError toast visible → Escape dismisses, swallow other keys
      // so they don't accidentally act on stale focus.
      if (this.globalError) {
        if (key === 'Escape') {
          this.globalError = null;
          event.preventDefault();
        }
        return;
      }

      // 3. Block-level modal open → only Escape; let the block close it via the event.
      if (this._anyBlockModalOpen) {
        if (key === 'Escape') {
          // Broadcast: every block listening will close its own modal if open.
          window.dispatchEvent(new CustomEvent('row-action', {
            detail: { row_id: '*', action: 'escape' },
          }));
          event.preventDefault();
        }
        return;
      }

      // 4. Focus is in a text input / textarea → only Escape (cancel edit / blur).
      const tag = (event.target && event.target.tagName) || '';
      const isTextField = tag === 'TEXTAREA' || tag === 'INPUT';
      if (isTextField) {
        if (key === 'Escape') {
          if (this._anyBlockEditing) {
            window.dispatchEvent(new CustomEvent('row-action', {
              detail: { row_id: '*', action: 'cancel-edit' },
            }));
          } else if (event.target.blur) {
            event.target.blur();
          }
          event.preventDefault();
        }
        return;
      }

      // 5. Some block is in inline-edit mode but focus is outside the textarea
      //    (e.g. user clicked a button). Escape cancels; nothing else.
      if (this._anyBlockEditing) {
        if (key === 'Escape') {
          window.dispatchEvent(new CustomEvent('row-action', {
            detail: { row_id: '*', action: 'cancel-edit' },
          }));
          event.preventDefault();
        }
        return;
      }

      // 6. Help toggles work on every screen (when nothing else is open).
      if (key === '?' || key === '/') {
        this.helpOpen = true;
        event.preventDefault();
        return;
      }

      // 7. Screen-specific routing.
      if (this.screen === 'story') {
        this._handleStoryKey(event);
      } else if (this.screen === 'overview') {
        this._handleOverviewKey(event);
      }
    },

    _handleStoryKey(event) {
      const key = event.key;
      const focused = this.focusedBlock;
      const focusable = focused && NOT_REVIEWED.has(focused.status);
      const revertable = focused && REVIEWED.has(focused.status);

      if (key === 'j' || key === 'ArrowDown') {
        this.focusNextBlock();
        event.preventDefault();
      } else if (key === 'k' || key === 'ArrowUp') {
        this.focusPrevBlock();
        event.preventDefault();
      } else if (key === 'A') {
        // Shift+A — bulk-accept all remaining pending blocks in this story.
        // The storyScreen component listens for this event; broadcasting via
        // CustomEvent keeps appRoot decoupled from storyScreen internals.
        if (this.storyHasPendingBlocks()) {
          window.dispatchEvent(new CustomEvent('story-bulk-accept'));
          event.preventDefault();
        }
      } else if (key === 'a' || key === ' ') {
        if (focused && focusable) {
          const acceptedId = focused.row_id;
          this.submitAction({ row_id: acceptedId, action: 'accept' })
            .then(() => {
              // Auto-advance to keep the rhythm fast: jump to the next still-pending block.
              const list = this.currentStoryBlocks;
              const startIdx = list.findIndex(b => b.row_id === acceptedId);
              for (let i = startIdx + 1; i < list.length; i++) {
                if (NOT_REVIEWED.has(list[i].status)) {
                  this._moveFocus(list[i].row_id, 'block');
                  return;
                }
              }
            })
            .catch(() => {});
          event.preventDefault();
        }
      } else if (key === 'e') {
        if (focused && focusable) {
          this._dispatchRowAction(focused.row_id, 'edit');
          event.preventDefault();
        }
      } else if (key === 's') {
        if (focused && focusable) {
          this._dispatchRowAction(focused.row_id, 'skip');
          event.preventDefault();
        }
      } else if (key === 'd') {
        if (focused && focusable) {
          this._dispatchRowAction(focused.row_id, 'delete');
          event.preventDefault();
        }
      } else if (key === 'u') {
        // Undo / revert. Only meaningful on already-reviewed blocks; for
        // pending/proposed blocks the equivalent is just "make a different
        // choice" — there's nothing to undo yet.
        if (focused && revertable) {
          this._dispatchRowAction(focused.row_id, 'revert');
          event.preventDefault();
        }
      } else if (key === 'n') {
        if (!this.storyHasPendingBlocks()) {
          this.advanceToNextStory();
          // When advancing, reset block focus on the new story.
          this.focusedRowId = null;
          event.preventDefault();
        }
      } else if (key === 'b') {
        this.goToOverview();
        this.focusedRowId = null;
        event.preventDefault();
      } else if (key === 'Escape') {
        if (this.focusedRowId) {
          this.focusedRowId = null;
          event.preventDefault();
        }
      }
    },

    _handleOverviewKey(event) {
      const key = event.key;
      if (key === 'j' || key === 'ArrowDown') {
        this.focusNextStory();
        event.preventDefault();
      } else if (key === 'k' || key === 'ArrowUp') {
        this.focusPrevStory();
        event.preventDefault();
      } else if (key === 'Enter' || key === 'o') {
        if (this.focusedStoryId) {
          this.goToStory(this.focusedStoryId);
          this.focusedRowId = null;
          event.preventDefault();
        }
      } else if (key === 'Escape') {
        if (this.focusedStoryId) {
          this.focusedStoryId = null;
          event.preventDefault();
        }
      }
    },
  };
};

// Placeholder child component factories — implemented in subsequent tasks.
window.overviewScreen = function () {
  return {
    init() {},
    storyBadges(group) {
      const counts = { pending: 0, proposed: 0, proposed_delete: 0, accepted: 0, edited: 0, skipped: 0, deleted: 0, error: 0 };
      for (const b of group.blocks) counts[b.status] = (counts[b.status] || 0) + 1;
      const out = [];
      const needsAction = counts.pending + counts.proposed;
      if (needsAction)             out.push({ label: 'pending',     count: needsAction,             classes: 'bg-amber-100 text-amber-800' });
      if (counts.proposed_delete)  out.push({ label: 'to remove',   count: counts.proposed_delete,  classes: 'bg-red-100 text-red-800' });
      if (counts.accepted)         out.push({ label: 'accepted',    count: counts.accepted,         classes: 'bg-emerald-100 text-emerald-800' });
      if (counts.edited)           out.push({ label: 'edited',      count: counts.edited,           classes: 'bg-emerald-100 text-emerald-800' });
      if (counts.skipped)          out.push({ label: 'skipped',     count: counts.skipped,          classes: 'bg-slate-200 text-slate-700' });
      if (counts.deleted)          out.push({ label: 'deleted',     count: counts.deleted,          classes: 'bg-red-100 text-red-800' });
      if (counts.error)            out.push({ label: 'error',       count: counts.error,            classes: 'bg-red-100 text-red-800' });
      return out;
    },
  };
};
window.storyScreen = function () {
  return {
    bulkAccepting: false,

    init() {
      window.addEventListener('story-bulk-accept', () => {
        if (!this.bulkAccepting && this.hasPendingBlocks()) {
          this.bulkAcceptRemaining();
        }
      });
      // Lazy-load surrounding-block context for this story so each block
      // card can render prev/next excerpts. Best-effort; failure is silent.
      const root = getAppRootScope();
      if (root && root.currentStoryId) {
        root.loadStoryContent(root.currentStoryId).catch(() => {});
      }
    },

    get group() {
      const root = getAppRootScope();
      if (!root) return null;
      return root.groups.find(g => g.story_id === root.currentStoryId) || null;
    },

    hasPendingBlocks() {
      return getPendingBlocksInStory(this.group).length > 0;
    },

    pendingBlockCount() {
      return getPendingBlocksInStory(this.group).length;
    },

    /**
     * Sequentially accept every still-pending block in the current story.
     * Sequential — not parallel — so each optimistic state update applied by
     * submitAction flows correctly into the next iteration. Stops at the
     * first error (no retry, no skip-and-continue) so the editor can manually
     * inspect the failed row.
     */
    async bulkAcceptRemaining() {
      if (this.bulkAccepting) return;
      const root = getAppRootScope();
      if (!root) return;
      // Snapshot the row_ids up front so we don't iterate over a mutating
      // group.blocks list while submitAction reassigns root.groups.
      // Exclude `proposed_delete` rows: those are destructive and must be
      // confirmed individually — bulk-accept would silently delete blocks the
      // editor didn't read.
      const pendingRowIds = getPendingBlocksInStory(this.group)
        .filter(b => b.status !== 'proposed_delete')
        .map(b => b.row_id);
      if (pendingRowIds.length === 0) return;

      this.bulkAccepting = true;
      try {
        for (const rowId of pendingRowIds) {
          try {
            await root.submitAction({ row_id: rowId, action: 'accept' });
          } catch (e) {
            root.globalError = `Bulk accept stopped at row ${rowId}: ${e.message || e}`;
            return;
          }
        }
        // All pending blocks resolved — auto-advance to the next story.
        if (!this.hasPendingBlocks()) {
          root.advanceToNextStory();
        }
      } finally {
        this.bulkAccepting = false;
      }
    },
  };
};

window.blockCard = function (rowId) {
  // Pass `rowId` (string), NOT `block` (object). When the parent's
  // state.blocks[i] is reassigned by submitAction, Alpine's :key reuse means
  // the closure-captured block object is stale. Looking up the live block by
  // row_id from appRoot every read gives us reactive freshness.
  return {
    init() {
      this._root = getAppRootScope();
    },
    get block() {
      const root = getAppRootScope();
      const found = root?.state?.blocks?.find(b => b.row_id === rowId);
      return found || { row_id: rowId, status: 'pending', original_payload: {}, proposed_payload: {}, edited_payload: null, llm_match_reason: '', block_component: '', block_path: '' };
    },
    fieldsToShow(b) {
      // affected_fields holds the deep paths (e.g. "cells.0.content.0.content.0.text")
      // where the substring keyword actually matched. We render diffs on those
      // leaves only — top-level keys would include arrays (cells, content) that
      // aren't strings and render as "undefined" in the diff.
      if (Array.isArray(b?.affected_fields) && b.affected_fields.length) return b.affected_fields;
      return Object.keys(b?.original_payload || {});
    },
    getByPath(obj, path) {
      if (!obj || !path) return null;
      const segs = String(path).split('.');
      let cur = obj;
      for (const seg of segs) {
        if (cur == null) return null;
        cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
      }
      return cur;
    },
    /** True if proposed/edited differs from original for this field. When false,
     *  the template surfaces a "⚠ no changes proposed" warning instead of an
     *  empty-looking diff (which is indistinguishable from the original text). */
    hasChanges(b, fieldName) {
      const orig = String(this.getByPath(b?.original_payload, fieldName) ?? '');
      const proposed = this.getByPath(b?.edited_payload, fieldName)
        ?? this.getByPath(b?.proposed_payload, fieldName)
        ?? this.getByPath(b?.original_payload, fieldName);
      return String(proposed ?? '') !== orig;
    },
    statusBadgeClasses(status) {
      switch (status) {
        case 'proposed':        return 'bg-amber-100 text-amber-800';
        case 'proposed_delete': return 'bg-red-100 text-red-800';
        case 'accepted':        return 'bg-emerald-100 text-emerald-800';
        case 'edited':          return 'bg-emerald-100 text-emerald-800';
        case 'skipped':         return 'bg-slate-200 text-slate-700';
        case 'deleted':         return 'bg-red-100 text-red-800';
        case 'error':           return 'bg-red-100 text-red-800';
        default:                return 'bg-slate-100 text-slate-600';
      }
    },
    /** Mirror of appRoot.isCurrentlyPublished — local copy so per-block
     *  templates don't have to reach into _root. cascaded_at is sticky in
     *  the DataTable (n8n date col can't be cleared), so we compare against
     *  rolled_back_at to know if rollback happened after the cascade. */
    isPublished(b) {
      if (!b || !b.cascaded_at) return false;
      if (!b.rolled_back_at) return true;
      return new Date(b.rolled_back_at).getTime() < new Date(b.cascaded_at).getTime();
    },
    // i18n proxy so per-block templates can do `t('...')` directly. Reads
    // appRoot.locale through the cached _root reference (which is itself an
    // Alpine reactive proxy) so locale changes trigger re-render here too.
    t(key, params) {
      const root = this._root || getAppRootScope();
      return root ? root.t(key, params) : key;
    },
  };
};

window.blockActions = function (rowId) {
  // Pass `rowId` (string), NOT `block` (object) — see blockCard for why.
  return {
    busy: false,
    error: null,
    get block() {
      const root = getAppRootScope();
      const found = root?.state?.blocks?.find(b => b.row_id === rowId);
      return found || { row_id: rowId, status: 'pending', original_payload: {}, proposed_payload: {}, edited_payload: null };
    },

    // Edit state
    editing: false,
    editedFields: {},

    // Skip state
    skipModal: false,
    skipForm: { category: 'other', comment: '' },
    skipReasonOptions: [
      { value: 'llm_misunderstood', label: 'LLM не понял контекст' },
      { value: 'fact_recheck',      label: 'Нужна перепроверка фактов' },
      { value: 'complex_case',      label: 'Сложный кейс — требует ручной правки' },
      { value: 'other',             label: 'Другое' },
    ],

    // Delete state
    deleteModal: false,

    init() {
      // See blockCard — Alpine 3's $root doesn't climb to appRoot from a child
      // x-data scope. Look up appRoot via the DOM instead.
      this._root = getAppRootScope();
    },

    // i18n proxy — blockActions templates do `t('...')` and re-render when
    // appRoot.locale flips (the proxy reads _root.locale, tracked by Alpine).
    t(key, params) {
      const root = this._root || getAppRootScope();
      return root ? root.t(key, params) : key;
    },

    /**
     * Handle a row-action event dispatched from appRoot. Each block listens
     * and acts iff the event is targeted at its row_id (or '*' for broadcast
     * actions like Escape).
     */
    onRowAction(detail) {
      if (!detail) return;
      const targetsMe = detail.row_id === this.block.row_id;
      const isBroadcast = detail.row_id === '*';
      if (!targetsMe && !isBroadcast) return;

      switch (detail.action) {
        case 'edit':
          if (targetsMe) this.startEdit();
          break;
        case 'skip':
          if (targetsMe) this.openSkipModal();
          break;
        case 'delete':
          if (targetsMe) this.openDeleteConfirm();
          break;
        case 'revert':
          if (targetsMe) this.onRevert();
          break;
        case 'escape':
          // Broadcast: close any modal this block has open.
          if (this.skipModal) this.closeSkipModal();
          if (this.deleteModal) this.closeDeleteConfirm();
          break;
        case 'cancel-edit':
          if (this.editing) this.cancelEdit();
          break;
      }
    },

    /** Move keyboard focus into the first textarea once the inline editor is rendered. */
    _focusFirstEditField() {
      requestAnimationFrame(() => {
        const card = document.querySelector(`[data-row-id="${this.block.row_id}"]`);
        if (!card) return;
        const ta = card.querySelector('textarea');
        if (ta && ta.focus) ta.focus();
      });
    },

    async onAccept() {
      this.busy = true;
      this.error = null;
      try {
        await this._root.submitAction({ row_id: this.block.row_id, action: 'accept' });
      } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; }
    },

    startEdit() {
      this.editedFields = {};
      const block = this.block;
      // affected_fields holds deep dot/index paths for nested blocks
      // (table_row, faq, etc.). Walk each path on every payload to pre-fill
      // textareas with the LEAF value, not an array/object.
      const fields = Array.isArray(block.affected_fields) && block.affected_fields.length
        ? block.affected_fields
        : Object.keys(block.original_payload || {});
      const root = getAppRootScope();
      const drill = (obj, path) => root && typeof root.getByPath === 'function' ? root.getByPath(obj, path) : null;
      // Fallback drill for environments where appRoot isn't ready yet.
      const localDrill = (obj, path) => {
        if (!obj || !path) return null;
        const segs = String(path).split('.');
        let cur = obj;
        for (const seg of segs) {
          if (cur == null) return null;
          cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
        }
        return cur;
      };
      const get = (obj, path) => drill(obj, path) ?? localDrill(obj, path);
      for (const k of fields) {
        const editedVal = get(block.edited_payload, k);
        const proposedVal = get(block.proposed_payload, k);
        const originalVal = get(block.original_payload, k);
        if (editedVal != null) this.editedFields[k] = String(editedVal);
        else if (proposedVal != null) this.editedFields[k] = String(proposedVal);
        else this.editedFields[k] = String(originalVal ?? '');
      }
      this.editing = true;
      this.error = null;
      if (this._root) this._root.notifyBlockUi(this.block.row_id, 'editing', true);
      this._focusFirstEditField();
    },

    cancelEdit() {
      this.editing = false;
      this.editedFields = {};
      if (this._root) this._root.notifyBlockUi(this.block.row_id, 'editing', false);
    },

    async onAcceptEdited() {
      this.busy = true;
      this.error = null;
      try {
        await this._root.submitAction({
          row_id: this.block.row_id,
          action: 'edit',
          edited_payload: { ...this.editedFields },
        });
        this.editing = false;
        if (this._root) this._root.notifyBlockUi(this.block.row_id, 'editing', false);
      } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; }
    },

    openSkipModal() {
      this.skipForm = { category: 'other', comment: '' };
      this.skipModal = true;
      this.error = null;
      if (this._root) this._root.notifyBlockUi(this.block.row_id, 'modal', true);
    },
    closeSkipModal() {
      this.skipModal = false;
      if (this._root) this._root.notifyBlockUi(this.block.row_id, 'modal', false);
    },
    async confirmSkip() {
      this.busy = true;
      this.error = null;
      try {
        await this._root.submitAction({
          row_id: this.block.row_id,
          action: 'skip',
          skip_reason: { ...this.skipForm },
        });
        this.skipModal = false;
        if (this._root) this._root.notifyBlockUi(this.block.row_id, 'modal', false);
      } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; }
    },

    openDeleteConfirm() {
      this.deleteModal = true;
      this.error = null;
      if (this._root) this._root.notifyBlockUi(this.block.row_id, 'modal', true);
    },
    closeDeleteConfirm() {
      this.deleteModal = false;
      if (this._root) this._root.notifyBlockUi(this.block.row_id, 'modal', false);
    },
    async confirmDelete() {
      this.busy = true;
      this.error = null;
      try {
        await this._root.submitAction({
          row_id: this.block.row_id,
          action: 'delete',
        });
        this.deleteModal = false;
        if (this._root) this._root.notifyBlockUi(this.block.row_id, 'modal', false);
      } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; }
    },

    /**
     * Revert (undo) — kicks the block back to `proposed` so the editor can
     * reconsider. Backend wipes edited_payload + skip_reason as part of the
     * revert update, so the next decision starts from a clean slate. No
     * confirmation modal: revert is itself reversible (just re-decide), and
     * the friction would defeat the purpose.
     */
    async onRevert() {
      this.busy = true;
      this.error = null;
      try {
        await this._root.submitAction({
          row_id: this.block.row_id,
          action: 'revert',
        });
      } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; }
    },
  };
};

// Register Alpine data factories AFTER the module's import chain has executed,
// then start Alpine. This is the canonical Alpine + ESM pattern: importing
// Alpine via the module and starting it explicitly avoids the race condition
// where Alpine's auto-start fires before the ESM imports resolve and leaves
// every `x-data="appRoot()"` bound to an empty {} scope.
window.searchScreen = function () {
  return {
    /**
     * Phase-1 search form. Mirrors the n8n WF-Search-PreProcess form
     * trigger fields. In real-mode (when ?api=... is set) submission
     * POSTs to /webhook/search-trigger and returns immediately with a
     * queued status. The full pipeline runs in background and Slack-pings
     * when ready.
     */
    form: {
      campaign_topic: '',
      campaign_id: '',
      keyword: '',
      block_required_keywords: '',
      article_any_keywords: '',
      context_description: '',
      source_locale: 'ru',
      folder: 'immigrantinvest/new-blog',
      content_type: 'flatArticle',
      rewrite_prompt: '',
      dry_run: true,
    },

    submitting: false,
    submitted: false,
    queuedCampaignId: null,
    queuedAt: null,
    progress: {
      stage: 'idle', // 'idle' | 'queued' | 'fetching' | 'filtering' | 'rewriting' | 'done'
      stories_scanned: 0,
      blocks_scanned: 0,
      hits_after_substring: 0,
      hits_after_llm_filter: 0,
      proposed: 0,
    },
    error: null,

    init() {
      // When opened via "Запустить заново" from a campaign view, the appRoot
      // stashed a prefill object in _resumePrefill. Pull it in once and clear.
      const root = getAppRootScope();
      this._root = root;
      const prefill = root && root._resumePrefill;
      if (prefill) {
        for (const k of Object.keys(prefill)) this.form[k] = prefill[k];
        if (root) root._resumePrefill = null;
      }
    },

    // i18n proxy — searchScreen templates call t('...') and re-render when
    // appRoot.locale flips (proxy reads _root.locale, tracked by Alpine).
    t(key, params) {
      const root = this._root || getAppRootScope();
      return root ? root.t(key, params) : key;
    },

    /** Generate a default campaign_id from topic + locale + today, slug-style.
     *  Locale is included so the same topic in EN vs RU gets distinct IDs —
     *  otherwise reusing the same campaign_id between locales causes the
     *  workflow's existing-rows lookup to mix data across locales. */
    suggestedCampaignId() {
      const topic = (this.form.campaign_topic || '').toLowerCase();
      const slug = topic
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const locale = (this.form.source_locale || 'ru').trim();
      const date = new Date().toISOString().slice(0, 10);
      return `cmp-${slug || 'campaign'}-${locale}-${date}`;
    },

    canSubmit() {
      return this.form.campaign_topic.trim().length >= 3
          && this.form.keyword.trim().length >= 1
          && this.form.context_description.trim().length >= 10
          && this.form.rewrite_prompt.trim().length >= 10
          && !this.submitting;
    },

    fillExample() {
      this.form.campaign_topic = 'Portugal Golden Visa: 5 → 10 years';
      this.form.keyword = '5';
      this.form.block_required_keywords = 'years';
      this.form.article_any_keywords = 'Portugal, Golden Visa';
      this.form.context_description = 'Mention of "5 years" specifically as the residency period required to apply for Portuguese citizenship via naturalisation. Ignore other 5-year mentions (program duration, statistics).';
      this.form.source_locale = 'ru';
      this.form.folder = 'immigrantinvest/new-blog';
      this.form.rewrite_prompt = 'Update content where Portugal Golden Visa requires 10 years (not 5) for citizenship eligibility. Adjust related context, FAQ, timelines. Sections about possible future law changes should be reframed as already-in-effect facts.';
    },

    reset() {
      this.submitting = false;
      this.submitted = false;
      this.progress = { stage: 'idle', stories_scanned: 0, blocks_scanned: 0, hits_after_substring: 0, hits_after_llm_filter: 0, proposed: 0 };
      this.error = null;
    },

    /**
     * Submit the search-trigger form to n8n. Returns immediately when n8n
     * responds with { queued: true, campaign_id, started_at }; the pipeline
     * (mAPI → substring → LLM filter → LLM rewrite → Data Table insert →
     * Slack ping) runs in the background.
     */
    async submit() {
      if (!this.canSubmit()) return;
      if (!this.form.campaign_id) this.form.campaign_id = this.suggestedCampaignId();

      this.submitting = true;
      this.error = null;
      this.queuedCampaignId = null;
      this.queuedAt = null;

      try {
        await this._realSubmit();
        this.submitted = true;
      } catch (e) {
        this.error = String(e.message || e);
      } finally {
        this.submitting = false;
      }
    },

    async _realSubmit() {
      this.progress.stage = 'queued';
      const url = `${API_BASE_URL}/webhook/search-trigger`;
      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), 30000);
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Authorization header value is the raw token, no "Bearer " prefix:
            // Cloud Run's reverse proxy intercepts "Bearer ..." values as
            // Google IAM tokens and rejects with 403 before n8n ever sees the
            // request. Empirically verified — see commit log for fix-detail.
            Authorization: CURRENT_TOKEN,
          },
          body: JSON.stringify(this.form),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw new Error('Search trigger timed out after 30s. n8n may be cold-starting — try again.');
        throw new Error(`Network error: ${e.message}`);
      } finally {
        clearTimeout(timeoutId);
      }
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text || `HTTP ${res.status}` }; }
      if (res.status === 401 || res.status === 403) {
        handleAuthFailure();
        return;
      }
      if (!res.ok || data.error) {
        throw new Error(data.error || `Search trigger failed (HTTP ${res.status})`);
      }
      this.queuedCampaignId = data.campaign_id || this.form.campaign_id;
      this.queuedAt = data.started_at || new Date().toISOString();
      // Stash the config so a "Resume" button on the campaign view can
      // re-trigger the workflow with the same parameters. The workflow
      // dedupes per-story so re-running just continues from where it
      // stopped.
      saveCampaignConfig(this.queuedCampaignId, { ...this.form, campaign_id: this.queuedCampaignId });
      // Also push to backend so other editors see it. Best-effort; the
      // overview screen will try again on load if this fails (e.g. campaign
      // rows haven't been written yet — n8n updates by campaign_id filter so
      // we'd no-op here, but the SPA's _loadServerConfig retries later).
      try {
        await api.saveCampaignConfig(this.queuedCampaignId, { ...this.form, campaign_id: this.queuedCampaignId });
      } catch { /* swallow */ }
    },

    /** URL pointing the SPA at the campaign that was just queued. */
    reviewQueueUrl() {
      if (!this.queuedCampaignId) return null;
      const u = new URL(window.location.href);
      u.searchParams.set('campaign', this.queuedCampaignId);
      return u.toString();
    },
  };
};

Alpine.data('appRoot', window.appRoot);
Alpine.data('overviewScreen', window.overviewScreen);
Alpine.data('storyScreen', window.storyScreen);
Alpine.data('blockCard', window.blockCard);
Alpine.data('blockActions', window.blockActions);
Alpine.data('searchScreen', window.searchScreen);
Alpine.start();
