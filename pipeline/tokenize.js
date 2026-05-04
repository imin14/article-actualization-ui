/**
 * Approximate token estimation without a real tokenizer dependency.
 *
 * Why not a real tokenizer?
 * - The n8n backend will consume these helpers via inline Code nodes; we want
 *   zero npm install on the n8n side.
 * - We only need rough estimates to enforce token budgets and gate prompts.
 *   Anthropic's tokenizer would be more accurate but isn't available in
 *   plain Node without extra deps.
 *
 * Heuristic (order-of-magnitude accurate, not exact):
 * - Latin/ASCII text averages roughly 4 characters per token (Anthropic and
 *   OpenAI both publish this rule of thumb).
 * - Cyrillic, Greek, Arabic, Hebrew tend to roughly 2 chars per token because
 *   the BPE merges are sparser for these scripts.
 * - CJK (Chinese / Japanese / Korean) ideographs run roughly 1 token per 1–2
 *   characters; we use 2 as a conservative-low estimate.
 * - Code/punctuation-heavy strings tokenize denser than prose; we add a small
 *   boost when the punctuation ratio is high.
 * - URLs tokenize denser than prose because schemes, slashes, query params,
 *   and fragments often each cost their own token.
 *
 * The result is a single integer that we use only for budget enforcement.
 * Off-by-30% is fine; off-by-3x is not.
 */

const URL_RE = /https?:\/\/\S+/g;
// Punctuation/symbol chars commonly seen in code and structured strings.
const PUNCT_RE = /[{}()\[\]<>:;,/\\|@#$%^&*+=~`'"!?\-_]/g;

/**
 * Count chars in a Unicode range using surrogate-pair-safe iteration.
 * @param {string} text
 * @param {(cp:number)=>boolean} predicate
 * @returns {number}
 */
function countCodePoints(text, predicate) {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (predicate(cp)) n++;
  }
  return n;
}

/** Cyrillic block: U+0400–U+04FF, plus Cyrillic Supplement U+0500–U+052F. */
function isCyrillic(cp) {
  return (cp >= 0x0400 && cp <= 0x052F);
}

/**
 * CJK Unified Ideographs and common neighbours: U+3000–U+9FFF covers
 * CJK punctuation, Hiragana, Katakana, and the main CJK ideograph block.
 * Hangul Syllables U+AC00–U+D7AF added.
 */
function isCJK(cp) {
  return (cp >= 0x3000 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7AF);
}

/**
 * Approximate token count for `text`.
 *
 * @param {string|null|undefined} text
 * @returns {number} non-negative integer estimate
 */
export function approxTokens(text) {
  if (text == null) return 0;
  const s = String(text);
  if (s.length === 0) return 0;

  // Pull URLs out first — they tokenize dense, count chars/2.5.
  let urlChars = 0;
  let stripped = s;
  const urlMatches = s.match(URL_RE);
  if (urlMatches) {
    for (const u of urlMatches) urlChars += u.length;
    stripped = s.replace(URL_RE, '');
  }

  // Count Cyrillic / CJK code points in the URL-stripped remainder.
  const cyrChars = countCodePoints(stripped, isCyrillic);
  const cjkChars = countCodePoints(stripped, isCJK);
  // The remainder we'll treat as "Latin-ish" (covers Latin, Greek, digits,
  // punctuation, whitespace). This is the bulk of typical English content.
  // Use stripped.length minus the dense scripts we already counted.
  const denseScriptChars = cyrChars + cjkChars;
  const latinChars = Math.max(0, stripped.length - denseScriptChars);

  // Base estimate.
  let tokens =
    latinChars / 4 +
    cyrChars / 2 +
    cjkChars / 2 +
    urlChars / 2.5;

  // Punctuation density boost. If a non-trivial share of the Latin region is
  // punctuation/symbols (typical of code), add a small multiplicative bump.
  if (stripped.length > 20) {
    const punctMatches = stripped.match(PUNCT_RE);
    const punctCount = punctMatches ? punctMatches.length : 0;
    const punctRatio = punctCount / stripped.length;
    // Threshold tuned so prose with ordinary punctuation (~5–8%) gets no
    // boost, while code-heavy text (>15%) gets +20%.
    if (punctRatio > 0.10) {
      const boost = 1 + Math.min(0.5, (punctRatio - 0.10) * 4);
      tokens = tokens * boost;
    }
  }

  // Always at least 1 token for any non-empty string.
  return Math.max(1, Math.ceil(tokens));
}

/**
 * Truncate `text` so its approxTokens estimate is <= budget. Cuts on a
 * whitespace boundary so we never return a half-word fragment. If `text`
 * is already under budget, returns it unchanged.
 *
 * Strategy: binary-search the largest character prefix whose token estimate
 * fits, then snap back to the nearest whitespace.
 *
 * @param {string|null|undefined} text
 * @param {number} budget non-negative integer token cap
 * @returns {string}
 */
export function truncateToTokenBudget(text, budget) {
  if (text == null) return '';
  const s = String(text);
  if (s.length === 0) return '';
  if (budget <= 0) return '';
  if (approxTokens(s) <= budget) return s;

  // Binary search the longest prefix that fits.
  let lo = 0;
  let hi = s.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (approxTokens(s.slice(0, mid)) <= budget) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best === 0) return '';

  // Snap back to a whitespace boundary so we don't cut mid-word.
  const sliced = s.slice(0, best);
  const lastWS = sliced.search(/\s\S*$/);
  if (lastWS > 0) {
    return sliced.slice(0, lastWS);
  }
  // No whitespace found in the prefix — single huge word case. We must still
  // honour the budget, so return empty.
  if (/\s/.test(sliced)) return sliced.replace(/\S*$/, '').trimEnd();
  return '';
}
