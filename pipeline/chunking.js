/**
 * Semantic chunking for block fields.
 *
 * Token-economy principle: before we ever ask an LLM "is this paragraph
 * relevant?", we cheaply (in pure JS) prefilter to paragraphs that contain
 * the campaign keyword. Most paragraphs in a typical Storyblok block don't
 * mention the keyword at all — we can drop them immediately and never spend
 * tokens on them.
 *
 * Then, when we do call an LLM (for classification or rewrite), we send the
 * hit paragraph plus a configurable context window (default 1 before, 1
 * after). This is enough surrounding prose for the LLM to rewrite
 * intelligently without dragging in unrelated parts of the article.
 */

/**
 * Split markdown / plain text into paragraphs on blank lines. Trims each
 * paragraph and drops empty ones. Single newlines inside a paragraph are
 * preserved (they're typical for soft-wrapped markdown lists, code blocks,
 * etc.).
 *
 * @param {string|null|undefined} markdown
 * @returns {string[]}
 */
export function splitIntoParagraphs(markdown) {
  if (markdown == null) return [];
  const s = String(markdown);
  if (s.length === 0) return [];
  // Normalise CRLF to LF first so the split regex stays simple.
  const lf = s.replace(/\r\n/g, '\n');
  return lf
    .split(/\n[ \t]*\n+/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

/**
 * @typedef {Object} ParagraphHit
 * @property {string} text - the matching paragraph
 * @property {number} index - 0-based index of the paragraph within the source text
 */

/**
 * @typedef {Object} FindKeywordParagraphsOptions
 * @property {boolean} [caseSensitive=false] - if true, exact-case substring match.
 */

/**
 * Find paragraphs containing `keyword`. Returns hits with their index inside
 * the source text so callers can later build a context window around them.
 *
 * Note: we don't use word-boundary matching by default. The caller supplies
 * the keyword exactly; "5 years" should match "5 years" wherever it appears.
 * If the campaign needs stricter matching, the n8n flow can construct a
 * regex-aware variant separately.
 *
 * @param {string|null|undefined} text
 * @param {string} keyword
 * @param {FindKeywordParagraphsOptions} [opts]
 * @returns {ParagraphHit[]}
 */
export function findKeywordParagraphs(text, keyword, opts = {}) {
  if (text == null) return [];
  if (typeof keyword !== 'string' || keyword.length === 0) return [];
  const { caseSensitive = false } = opts;
  const paragraphs = splitIntoParagraphs(text);
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  /** @type {ParagraphHit[]} */
  const hits = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const hay = caseSensitive ? paragraphs[i] : paragraphs[i].toLowerCase();
    if (hay.includes(needle)) {
      hits.push({ text: paragraphs[i], index: i });
    }
  }
  return hits;
}

/**
 * Build a context window around a hit paragraph: returns paragraphs
 * [hitIndex - before .. hitIndex + after] joined with `\n\n`. Clamped to
 * array bounds.
 *
 * @param {string[]} paragraphs
 * @param {number} hitIndex
 * @param {number} before
 * @param {number} after
 * @returns {string}
 */
export function extractContextWindow(paragraphs, hitIndex, before, after) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) return '';
  if (hitIndex < 0 || hitIndex >= paragraphs.length) return '';
  const start = Math.max(0, hitIndex - Math.max(0, before));
  const end = Math.min(paragraphs.length - 1, hitIndex + Math.max(0, after));
  return paragraphs.slice(start, end + 1).join('\n\n');
}
