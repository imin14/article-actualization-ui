import { createAPIClient } from './lib/api.js';
import { groupByStory, computeProgress, applyAction, getNextPendingStory } from './lib/state.js';
import { renderDiffHTML } from './lib/diff.js';

// === Configuration ===
// API config is read from URL query params:
//   ?campaign=<campaign_id>          — required for real campaigns; defaults to mock fixture
//   ?api=<n8n base URL>              — when present, switches to real client; absent = mock mode
//   ?t=<bearer token>                — auth token for n8n webhooks
//
// Without ?api=, the app runs against the in-memory mock for local development.
const params = new URLSearchParams(window.location.search);
const CAMPAIGN_ID = params.get('campaign') || 'cmp-portugal-2026-05-04';

const API_BASE_URL = params.get('api') || '';
const API_TOKEN = params.get('t') || '';
const API_MODE = API_BASE_URL ? 'real' : 'mock';

const api = createAPIClient({
  mode: API_MODE,
  baseURL: API_BASE_URL,
  token: API_TOKEN,
});

window.appRoot = function () {
  return {
    loading: true,
    error: null,
    globalError: null,
    state: null,        // CampaignState from API
    groups: [],         // grouped by story
    screen: 'overview', // 'overview' | 'story' | 'done'
    currentStoryId: null,

    async init() {
      try {
        await this.refresh();
      } catch (e) {
        this.error = String(e.message || e);
      } finally {
        this.loading = false;
      }
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
    init() {},
    get group() {
      return this.$root.groups.find(g => g.story_id === this.$root.currentStoryId) || null;
    },
    hasPendingBlocks() {
      const g = this.group;
      if (!g) return false;
      return g.blocks.some(b => ['proposed', 'pending', 'error'].includes(b.status));
    },
  };
};

window.blockCard = function (block) {
  return {
    block,
    init(root) {
      this._root = root;
    },
    fieldsToShow(b) {
      // Show every key that appears in original_payload (proposed should match).
      return Object.keys(b.original_payload || {});
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

window.blockActions = function (block) {
  return {
    block,
    busy: false,
    error: null,

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

    init(root) {
      this._root = root;
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
      const proposed = this.block.proposed_payload || {};
      for (const k of Object.keys(this.block.original_payload || {})) {
        this.editedFields[k] = proposed[k] != null ? proposed[k] : (this.block.original_payload[k] || '');
      }
      this.editing = true;
      this.error = null;
    },

    cancelEdit() {
      this.editing = false;
      this.editedFields = {};
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
      } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; }
    },

    openSkipModal() {
      this.skipForm = { category: 'other', comment: '' };
      this.skipModal = true;
      this.error = null;
    },
    closeSkipModal() {
      this.skipModal = false;
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
      } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; }
    },

    openDeleteConfirm() {
      this.deleteModal = true;
      this.error = null;
    },
    closeDeleteConfirm() {
      this.deleteModal = false;
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
      } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; }
    },
  };
};
