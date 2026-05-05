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
      return Object.keys(b?.original_payload || {});
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
      const edited = this.block.edited_payload || {};
      const proposed = this.block.proposed_payload || {};
      for (const k of Object.keys(this.block.original_payload || {})) {
        if (edited[k] != null) this.editedFields[k] = edited[k];
        else if (proposed[k] != null) this.editedFields[k] = proposed[k];
        else this.editedFields[k] = this.block.original_payload[k] || '';
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
Alpine.data('appRoot', window.appRoot);
Alpine.data('overviewScreen', window.overviewScreen);
Alpine.data('storyScreen', window.storyScreen);
Alpine.data('blockCard', window.blockCard);
Alpine.data('blockActions', window.blockActions);
Alpine.start();
