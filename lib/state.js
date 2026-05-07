/** @import {BlockRow, ActionPayload} from './types.js' */

// `proposed_delete` is a kind of pending review — LLM proposes to remove the
// entire block; editor must consciously confirm (or override). Treated as
// "needs action" so it shows up in pending lists and progress counters.
export const NOT_REVIEWED = new Set(['pending', 'proposed', 'proposed_delete', 'error']);
export const REVIEWED = new Set(['accepted', 'edited', 'skipped', 'deleted']);

/**
 * Group block rows by story_id, preserving source order.
 * @param {BlockRow[]} blocks
 * @returns {Array<{story_id:string, story_name:string, story_full_slug:string, locale:string, blocks:BlockRow[]}>}
 */
export function groupByStory(blocks) {
  // Dedupe by row_id BEFORE grouping. Concurrent search-workflow executions
  // can write duplicate rows (same campaign_id/story_id/block_uid → identical
  // row_id) into the data table. With duplicates, Alpine's <template x-for>
  // sees colliding :key values and refuses to render the list — pending
  // counters still see two items but the user sees an empty story page.
  // Pick the row with the most-advanced status (reviewed beats pending) and
  // most-recent updated_at to preserve any decisions already taken.
  const STATUS_RANK = { proposed: 0, pending: 0, error: 0, proposed_delete: 1, llm_no_change: 0, accepted: 2, edited: 2, skipped: 2, deleted: 2 };
  const byRow = new Map();
  const noRowId = [];
  for (const block of blocks) {
    if (!block) continue;
    if (!block.row_id) { noRowId.push(block); continue; }
    const existing = byRow.get(block.row_id);
    if (!existing) { byRow.set(block.row_id, block); continue; }
    const er = STATUS_RANK[existing.status] ?? 0;
    const br = STATUS_RANK[block.status] ?? 0;
    if (br > er) { byRow.set(block.row_id, block); continue; }
    if (br === er && (block.updated_at || '') > (existing.updated_at || '')) {
      byRow.set(block.row_id, block);
    }
  }
  const deduped = [...Array.from(byRow.values()), ...noRowId];

  /** @type {Map<string, any>} */
  const map = new Map();
  for (const block of deduped) {
    if (!map.has(block.story_id)) {
      map.set(block.story_id, {
        story_id: block.story_id,
        story_name: block.story_name,
        story_full_slug: block.story_full_slug,
        locale: block.locale,
        blocks: [],
      });
    }
    map.get(block.story_id).blocks.push(block);
  }
  return Array.from(map.values());
}

/**
 * @param {BlockRow[]} blocks
 */
export function computeProgress(blocks) {
  // Dedupe by row_id so progress isn't doubled when concurrent search runs
  // produced duplicates. Keep the first occurrence (groupByStory picks the
  // best-status copy; here we just need stable counts).
  const seen = new Set();
  const deduped = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.row_id) {
      if (seen.has(b.row_id)) continue;
      seen.add(b.row_id);
    }
    deduped.push(b);
  }
  const by_status = {
    pending: 0, proposed: 0, accepted: 0, edited: 0, skipped: 0, deleted: 0, error: 0,
  };
  for (const b of deduped) {
    by_status[b.status] = (by_status[b.status] || 0) + 1;
  }
  const total = deduped.length;
  const reviewed = deduped.filter(b => REVIEWED.has(b.status)).length;
  return { total, reviewed, by_status };
}

/**
 * @param {BlockRow} block
 * @param {Pick<ActionPayload,'action'|'edited_payload'|'skip_reason'>} action
 * @returns {BlockRow}
 */
export function applyAction(block, action) {
  switch (action.action) {
    case 'accept':
      return { ...block, status: 'accepted' };
    case 'edit':
      return { ...block, status: 'edited', edited_payload: action.edited_payload };
    case 'skip':
      return { ...block, status: 'skipped', skip_reason: action.skip_reason || null };
    case 'delete':
      return { ...block, status: 'deleted' };
    case 'revert':
      // Undo. Drop status back to the LLM's original proposal so the editor
      // can review again. Cleanses any user-supplied edit/skip metadata so
      // the next decision starts from a clean slate. proposed_payload and
      // original_payload are NEVER touched — they're the source-of-truth.
      return {
        ...block,
        status: 'proposed',
        edited_payload: null,
        skip_reason: null,
      };
    default:
      throw new Error(`Unknown action: ${action.action}`);
  }
}

/**
 * Return the subset of a story group's blocks that still need review
 * (status in NOT_REVIEWED). Defensive against missing/null group input —
 * returns [] rather than throwing — because callers may invoke during
 * transient render states.
 *
 * @param {{blocks?: BlockRow[]} | null | undefined} group
 * @returns {BlockRow[]}
 */
export function getPendingBlocksInStory(group) {
  if (!group || !Array.isArray(group.blocks)) return [];
  return group.blocks.filter(b => NOT_REVIEWED.has(b.status));
}

/**
 * @param {Array<{story_id:string, blocks:BlockRow[]}>} groups
 * @param {string|null} current_story_id
 * @returns {string|null}
 */
export function getNextPendingStory(groups, current_story_id) {
  const idx = current_story_id == null
    ? -1
    : groups.findIndex(g => g.story_id === current_story_id);
  for (let i = idx + 1; i < groups.length; i++) {
    if (groups[i].blocks.some(b => NOT_REVIEWED.has(b.status))) {
      return groups[i].story_id;
    }
  }
  return null;
}
