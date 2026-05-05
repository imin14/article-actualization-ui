import Alpine from 'alpinejs';
import { createAPIClient } from './lib/api.js';
import { groupByStory, computeProgress, applyAction, getNextPendingStory, getPendingBlocksInStory, NOT_REVIEWED } from './lib/state.js';
import { renderDiffHTML } from './lib/diff.js';
import { nextFocusable, prevFocusable } from './lib/focus.js';

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
//   ?campaign=<campaign_id>          — required for real campaigns; defaults to mock fixture
//   ?api=<n8n base URL>              — when present, switches to real client; absent = mock mode
//   ?t=<bearer token>                — one-time onboarding token; saved to localStorage
//                                      and scrubbed from URL on first load.
//
// Without ?api=, the app runs against the in-memory mock for local development.
const params = new URLSearchParams(window.location.search);
const CAMPAIGN_ID_PARAM = params.get('campaign');
const CAMPAIGN_ID = CAMPAIGN_ID_PARAM || 'cmp-portugal-2026-05-04';
// True only when the URL explicitly named a campaign — otherwise the editor
// is just landing on the SPA to start a new one and we should skip the
// auto-load (which would otherwise hit a non-existent campaign and show a
// confusing error toast).
const HAS_EXPLICIT_CAMPAIGN = !!CAMPAIGN_ID_PARAM;

const API_BASE_URL = params.get('api') || '';
const API_MODE = API_BASE_URL ? 'real' : 'mock';

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
  mode: API_MODE,
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

window.appRoot = function () {
  return {
    loading: true,
    error: null,
    globalError: null,
    state: null,        // CampaignState from API
    groups: [],         // grouped by story
    // 'auth' shown when API_MODE='real' but no token in storage. The auth
    // screen is the only way in — every other screen requires a valid token.
    screen: 'overview', // 'auth' | 'campaigns' | 'overview' | 'story' | 'done' | 'search'
    currentStoryId: null,
    apiMode: API_MODE,
    hasToken: !!CURRENT_TOKEN,
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
      // Auth gate: real mode without a token sends the user straight to the
      // auth screen. We never hit the API in that state, so an empty token
      // can't trigger a 401 cascade.
      if (this.apiMode === 'real' && !this.hasToken) {
        this.screen = 'auth';
        this.loading = false;
        return;
      }
      // Real mode with no explicit ?campaign= → land on campaigns picker.
      // Editor either resumes an existing campaign or kicks off a new search.
      if (this.apiMode === 'real' && !HAS_EXPLICIT_CAMPAIGN) {
        this.screen = 'campaigns';
        this.loading = false;
        this.loadCampaigns();
        return;
      }
      try {
        await this.refresh();
        // Background-load campaigns list so the header's prev/next campaign
        // buttons have something to navigate. Failures are silent — they only
        // affect cross-campaign nav, not the current campaign view.
        if (this.apiMode === 'real') {
          this.loadCampaigns().catch(() => {});
          // Quiet polling so the "Search status" indicator transitions from
          // running → idle on its own, and new blocks materialise as they
          // get inserted. Only polls when the user is on a campaign view
          // (story or overview screen) — auth and search forms are skipped.
          this._startStatusPolling();
        }
      } catch (e) {
        if (this.apiMode === 'real' && isAuthFailure(e)) {
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
      const t = String(this.authForm.token || '').trim().replace(/^bearer\s+/i, '');
      if (!t) {
        this.authForm.error = 'Введите токен';
        return;
      }
      this.authForm.saving = true;
      this.authForm.error = '';
      writeStoredToken(t);
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
        if (this.apiMode === 'real' && isAuthFailure(e)) {
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
      if (this.apiMode !== 'real') return 'mock';
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
        this.resumeError = 'Не нашёл сохранённый конфиг этой кампании в этом браузере. Запусти новую (форма поиска) с тем же campaign_id.';
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
        this.resumeMessage = `Запущен. Уже обработанные сторис будут пропущены автоматически.`;
        // Refresh once after a beat so the new block.updated_at flips status
        // to "running" without the user having to F5.
        setTimeout(() => { this.refresh().catch(() => {}); }, 2000);
      } catch (e) {
        this.resumeError = String(e.message || e);
      } finally {
        this.resumeBusy = false;
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
      if (this.state.progress.reviewed >= this.state.progress.total) {
        this.screen = 'done';
      }
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
        if (this.apiMode === 'real' && isAuthFailure(e)) {
          handleAuthFailure();
          return;
        }
        this.globalError = `Действие не сохранилось: ${e.message}. Состояние возвращено.`;
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
      const counts = { pending: 0, proposed: 0, accepted: 0, edited: 0, skipped: 0, deleted: 0, error: 0 };
      for (const b of group.blocks) counts[b.status] = (counts[b.status] || 0) + 1;
      const out = [];
      const needsAction = counts.pending + counts.proposed;
      if (needsAction)     out.push({ label: 'pending',  count: needsAction,     classes: 'bg-amber-100 text-amber-800' });
      if (counts.accepted) out.push({ label: 'accepted', count: counts.accepted, classes: 'bg-emerald-100 text-emerald-800' });
      if (counts.edited)   out.push({ label: 'edited',   count: counts.edited,   classes: 'bg-emerald-100 text-emerald-800' });
      if (counts.skipped)  out.push({ label: 'skipped',  count: counts.skipped,  classes: 'bg-slate-200 text-slate-700' });
      if (counts.deleted)  out.push({ label: 'deleted',  count: counts.deleted,  classes: 'bg-red-100 text-red-800' });
      if (counts.error)    out.push({ label: 'error',    count: counts.error,    classes: 'bg-red-100 text-red-800' });
      return out;
    },
  };
};
window.storyScreen = function () {
  return {
    bulkAccepting: false,

    init() {
      // Listen for the global keyboard shortcut (Shift+A) so the same logic
      // runs whether the user clicks the button or presses the key.
      window.addEventListener('story-bulk-accept', () => {
        if (!this.bulkAccepting && this.hasPendingBlocks()) {
          this.bulkAcceptRemaining();
        }
      });
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
      const pendingRowIds = getPendingBlocksInStory(this.group).map(b => b.row_id);
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
    statusBadgeClasses(status) {
      switch (status) {
        case 'proposed': return 'bg-amber-100 text-amber-800';
        case 'accepted': return 'bg-emerald-100 text-emerald-800';
        case 'edited':   return 'bg-emerald-100 text-emerald-800';
        case 'skipped':  return 'bg-slate-200 text-slate-700';
        case 'deleted':  return 'bg-red-100 text-red-800';
        case 'error':    return 'bg-red-100 text-red-800';
        default:         return 'bg-slate-100 text-slate-600';
      }
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
    isMock: API_MODE !== 'real',
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
      const prefill = root && root._resumePrefill;
      if (prefill) {
        for (const k of Object.keys(prefill)) this.form[k] = prefill[k];
        if (root) root._resumePrefill = null;
      }
    },

    /** Generate a default campaign_id from topic + today, slug-style. */
    suggestedCampaignId() {
      const topic = (this.form.campaign_topic || '').toLowerCase();
      const slug = topic
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
      const date = new Date().toISOString().slice(0, 10);
      return `cmp-${slug || 'campaign'}-${date}`;
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
     * Mock submission. Simulates the four pipeline phases with realistic
     * latencies and counters so the operator can preview the experience.
     * Real wiring will POST the form to a new n8n webhook that triggers
     * WF-Search-PreProcess.
     */
    async submit() {
      if (!this.canSubmit()) return;
      if (!this.form.campaign_id) this.form.campaign_id = this.suggestedCampaignId();

      this.submitting = true;
      this.error = null;
      this.queuedCampaignId = null;
      this.queuedAt = null;

      try {
        if (API_MODE === 'real') {
          await this._realSubmit();
        } else {
          await this._mockSubmit();
        }
        this.submitted = true;
      } catch (e) {
        this.error = String(e.message || e);
      } finally {
        this.submitting = false;
      }
    },

    /**
     * Real mode — POST form to n8n webhook. Returns immediately when
     * n8n responds with { queued: true, campaign_id, started_at }.
     * The pipeline (mAPI → substring → LLM filter → LLM rewrite →
     * Data Table insert → Slack ping) runs in the background.
     */
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
    },

    /** Mock mode — simulates the four pipeline phases. Used when no ?api=. */
    async _mockSubmit() {
      this.progress = { stage: 'fetching', stories_scanned: 0, blocks_scanned: 0, hits_after_substring: 0, hits_after_llm_filter: 0, proposed: 0 };
      await this._countUpTo('stories_scanned', 487, 1500);
      this.progress.blocks_scanned = 487 * 52;
      this.progress.stage = 'filtering';
      await new Promise(r => setTimeout(r, 200));
      await this._countUpTo('hits_after_substring', 4827, 800);
      await new Promise(r => setTimeout(r, 200));
      await this._countUpTo('hits_after_llm_filter', 312, 1800);
      this.progress.stage = 'rewriting';
      await new Promise(r => setTimeout(r, 200));
      await this._countUpTo('proposed', 312, 2200);
      this.progress.stage = 'done';
      this.queuedCampaignId = this.form.campaign_id;
      this.queuedAt = new Date().toISOString();
    },

    /** URL pointing the SPA at the campaign that was just queued. */
    reviewQueueUrl() {
      if (!this.queuedCampaignId) return null;
      const u = new URL(window.location.href);
      u.searchParams.set('campaign', this.queuedCampaignId);
      return u.toString();
    },

    _countUpTo(field, target, durationMs) {
      return new Promise(resolve => {
        const start = performance.now();
        const tick = (now) => {
          const t = Math.min(1, (now - start) / durationMs);
          // ease-out
          const eased = 1 - Math.pow(1 - t, 3);
          this.progress[field] = Math.round(target * eased);
          if (t < 1) requestAnimationFrame(tick);
          else { this.progress[field] = target; resolve(); }
        };
        requestAnimationFrame(tick);
      });
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
