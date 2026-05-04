import { diffWordsWithSpace } from 'diff';

/**
 * Escape HTML special chars to prevent XSS in diff output.
 * @param {string|null|undefined} str
 * @returns {string}
 */
export function escapeHTML(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a word-level diff between two strings as HTML.
 * Removed segments are wrapped in <del class="diff-del">.
 * Added segments are wrapped in <ins class="diff-ins">.
 * Preserved segments are rendered as plain (escaped) text.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {string} HTML string
 */
export function renderDiffHTML(oldText, newText) {
  const parts = diffWordsWithSpace(oldText || '', newText || '');
  const out = [];
  for (const part of parts) {
    const escaped = escapeHTML(part.value);
    if (part.added) {
      out.push(`<ins class="diff-ins">${escaped}</ins>`);
    } else if (part.removed) {
      out.push(`<del class="diff-del">${escaped}</del>`);
    } else {
      out.push(escaped);
    }
  }
  return out.join('');
}
