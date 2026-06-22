import { diffWordsWithSpace, diffLines, diffArrays } from 'diff';

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

// Intl.Segmenter for Unicode-aware word splitting (Cyrillic, CJK, etc).
// Cached at module load.
const SEGMENTER = (() => {
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      return new Intl.Segmenter(undefined, { granularity: 'word' });
    }
  } catch {}
  return null;
})();

// Split text into sentence-like chunks for paragraph-level diffing. Native
// `diffSentences` from the diff package has the same Cyrillic-tokenization
// problem as diffWords. We do our own chunking on `.!?` followed by space
// or newline (works for any Unicode script) plus paragraph breaks.
function chunkIntoSentences(text) {
  if (!text) return [];
  // Normalize line endings.
  const normalized = String(text).replace(/\r\n/g, '\n');
  // Split on (sentence end punctuation + whitespace) OR (paragraph break).
  // Use capturing groups to preserve the separators in the result array.
  const parts = normalized.split(/((?<=[.!?])\s+|\n{2,})/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p == null || p === '') continue;
    out.push(p);
  }
  return out;
}

/**
 * Render a sentence-level diff between two strings as HTML.
 *
 * Why sentence-level: word-level diff (diffWords / diffWordsWithSpace) breaks
 * down on Cyrillic — the JS regex \b is ASCII-only, so each non-ASCII letter
 * becomes its own token, producing character-level mush. Sentence-level
 * sidesteps this entirely and is also more readable for prose changes.
 *
 * Within sentences that are SIMILAR enough (high token overlap), we render
 * an inline word-diff using Intl.Segmenter for proper Unicode tokenization.
 * Sentences that are very different are shown as full-strike + full-add.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {string} HTML string
 */
export function renderDiffHTML(oldText, newText) {
  const oldSent = chunkIntoSentences(oldText || '');
  const newSent = chunkIntoSentences(newText || '');
  if (oldSent.length === 0 && newSent.length === 0) return '';

  // Diff the sentence arrays directly. This preserves the original separators
  // (spaces, newlines) because they are included as distinct items in the array.
  const parts = diffArrays(oldSent, newSent);

  const out = [];
  // Walk through diff parts; pair adjacent {removed, added} blocks. If the
  // two chunks share enough word-level overlap, render an INLINE word diff
  // (cleaner for tiny changes like "5"→"10"). Otherwise render as STACKED
  // block — full-strike on old, full-highlight on new.
  for (let i = 0; i < parts.length; i++) {
    const cur = parts[i];
    const next = parts[i + 1];

    // value in diffArrays is an array of segments.
    const curValue = cur.value.join('');

    if (cur.removed && next && next.added) {
      const nextValue = next.value.join('');
      out.push(renderPairedChange(curValue, nextValue));
      i++; // consumed `next`
    } else if (cur.added) {
      out.push(`<ins class="diff-ins">${escapeHTML(curValue)}</ins>`);
    } else if (cur.removed) {
      out.push(`<del class="diff-del">${escapeHTML(curValue)}</del>`);
    } else {
      out.push(escapeHTML(curValue));
    }
  }
  return out.join('');
}

// For an adjacent {removed, added} pair, decide between inline word-diff
// (when changes are small/contained) and stacked block-diff (when chunks
// are largely different — e.g. multi-word Cyrillic rewrites where word-level
// alignment breaks down).
function renderPairedChange(oldChunk, newChunk) {
  const inlineHTML = renderInlineWordDiff(oldChunk, newChunk);
  // Heuristic: if inline diff has >6 ins/del segments OR alternates more
  // than half the time, the change is "messy" — use stacked view instead.
  const segCount = (inlineHTML.match(/<(ins|del) class="diff-(ins|del)">/g) || []).length;
  const longerLen = Math.max(oldChunk.length, newChunk.length);
  const isMessy = segCount > 6 || (segCount > 2 && longerLen > 0 && segCount / (longerLen / 20) > 0.5);
  if (!isMessy) return inlineHTML;
  return (
    `<del class="diff-del">${escapeHTML(oldChunk.replace(/\n+$/, ''))}</del>` +
    `<ins class="diff-ins">${escapeHTML(newChunk.replace(/\n+$/, ''))}</ins>`
  );
}

function renderInlineWordDiff(oldChunk, newChunk) {
  // Use Intl.Segmenter to tokenize into words/punctuation/whitespace properly.
  // This bypasses jsdiff's ASCII-only \b regex.
  const tokenize = (text) => {
    if (!SEGMENTER) return [text];
    return Array.from(SEGMENTER.segment(text)).map(s => s.segment);
  };

  const oldTokens = tokenize(oldChunk);
  const newTokens = tokenize(newChunk);
  const parts = diffArrays(oldTokens, newTokens);

  const out = [];
  for (const part of parts) {
    const value = part.value.join('');
    const escaped = escapeHTML(value);
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
