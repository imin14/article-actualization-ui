/**
 * Pure focus-movement helpers used by the keyboard-shortcuts wiring.
 *
 * The handlers operate over an ordered list of items that each have a stable
 * id (e.g. `row_id` for blocks or `story_id` for stories). They do not
 * wraparound — at the boundaries they clamp to the first/last item.
 *
 * @template {{ row_id?: string, story_id?: string }} T
 */

/**
 * Resolve the id field for an item in a focusable list. We accept either
 * `row_id` (blocks) or `story_id` (overview rows) so callers don't need to
 * normalize before passing the list.
 *
 * @param {object} item
 * @returns {string|null}
 */
function idOf(item) {
  if (item == null) return null;
  if (item.row_id != null) return item.row_id;
  if (item.story_id != null) return item.story_id;
  return null;
}

/**
 * Find the index of the item whose id matches `currentId`.
 *
 * @param {Array<object>} list
 * @param {string|null|undefined} currentId
 * @returns {number} -1 when not found / null current
 */
function indexOf(list, currentId) {
  if (currentId == null) return -1;
  for (let i = 0; i < list.length; i++) {
    if (idOf(list[i]) === currentId) return i;
  }
  return -1;
}

/**
 * Return the id of the next focusable item after `currentId`.
 *
 * Behaviour:
 * - empty list                  → null
 * - currentId null              → first item
 * - currentId not in list       → first item (treat unknown as "no focus yet")
 * - currentId is the last item  → null (clamp at end, no wraparound)
 *
 * @param {string|null|undefined} currentId
 * @param {Array<object>} list
 * @returns {string|null}
 */
export function nextFocusable(currentId, list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = indexOf(list, currentId);
  if (idx === -1) return idOf(list[0]);
  if (idx >= list.length - 1) return null;
  return idOf(list[idx + 1]);
}

/**
 * Return the id of the previous focusable item before `currentId`.
 *
 * Behaviour:
 * - empty list                   → null
 * - currentId null               → first item (so ↑ before any focus picks up
 *                                  the first card, mirroring `nextFocusable`)
 * - currentId not in list        → first item
 * - currentId is the first item  → null (clamp at start, no wraparound)
 *
 * @param {string|null|undefined} currentId
 * @param {Array<object>} list
 * @returns {string|null}
 */
export function prevFocusable(currentId, list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = indexOf(list, currentId);
  if (idx === -1) return idOf(list[0]);
  if (idx === 0) return null;
  return idOf(list[idx - 1]);
}
