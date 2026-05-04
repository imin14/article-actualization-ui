/**
 * Search & rewrite orchestration over a single block.
 *
 * Token economy principles encoded here:
 *
 * 1. Substring-filter in JS first. A block with 30 paragraphs typically has
 *    1–3 hits. We never send the other 27+ paragraphs to an LLM.
 *
 * 2. Classification calls send only the hit paragraph plus a one-line
 *    description of the campaign topic. No surrounding context, no full
 *    block. This keeps the input under ~500 tokens regardless of block size.
 *
 * 3. Rewrite calls send only the affected fields with a small context
 *    window per hit (default 1 paragraph before + 1 after). Unrelated
 *    fields of the same block are not sent.
 *
 * 4. Both prompts emit explicit JSON output schemas so the LLM has no need
 *    to spend output tokens on boilerplate prose.
 *
 * Estimated cost per 1000 stories (back-of-envelope, Anthropic sonnet-tier
 * pricing as of early 2026):
 * - Average story has ~10 blocks, ~5 with at least one hit on a typical
 *   campaign keyword.
 * - Classification: ~500 input tokens × 5 hits/story × 1000 stories = 2.5M
 *   input tokens (cheap "yes/no" gating call). Output tokens trivial.
 * - Rewrite: ~800 input tokens × 5 hits/story × 1000 stories = 4M input
 *   tokens. Output ~100 tokens per rewrite × 5 × 1000 = 500K output tokens.
 * - Compared to "send the whole article to GPT-4" baseline (~5K input
 *   tokens × 1 call/story × 1000 = 5M input tokens AND no fine-grained
 *   diffing), this approach uses comparable input tokens but produces
 *   structured field-level diffs we can review per-block.
 *
 * The big win is auditability, not raw token reduction: we know exactly
 * which paragraph each rewrite came from, and we never let the LLM hallucinate
 * edits on unrelated paragraphs.
 */

import { splitIntoParagraphs, findKeywordParagraphs, extractContextWindow } from './chunking.js';

/**
 * @typedef {Object} BlockHit
 * @property {string} field - field name within original_payload
 * @property {number} hit_index - paragraph index within that field
 * @property {string} hit_paragraph - the matching paragraph text
 * @property {string} context - hit paragraph + N before / M after, joined with \n\n
 */

/**
 * @typedef {Object} FindHitsOptions
 * @property {number} [contextBefore=1] - paragraphs of context before each hit
 * @property {number} [contextAfter=1] - paragraphs of context after each hit
 * @property {boolean} [caseSensitive=false] - case-sensitive keyword match
 */

/**
 * For a single block, find every paragraph in every string field of
 * `original_payload` that contains `keyword`. Returns one hit per matching
 * paragraph with a precomputed context window suitable for LLM rewrite.
 *
 * Non-string fields are skipped silently. A missing `original_payload` is
 * tolerated and produces an empty result.
 *
 * @param {{ original_payload?: Record<string, unknown>|null }} block
 * @param {string} keyword
 * @param {FindHitsOptions} [opts]
 * @returns {BlockHit[]}
 */
export function findHitsInBlock(block, keyword, opts = {}) {
  const { contextBefore = 1, contextAfter = 1, caseSensitive = false } = opts;
  const payload = block && block.original_payload;
  if (!payload || typeof payload !== 'object') return [];
  /** @type {BlockHit[]} */
  const out = [];
  for (const [field, value] of Object.entries(payload)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const paragraphs = splitIntoParagraphs(value);
    if (paragraphs.length === 0) continue;
    const hits = findKeywordParagraphs(value, keyword, { caseSensitive });
    for (const h of hits) {
      out.push({
        field,
        hit_index: h.index,
        hit_paragraph: h.text,
        context: extractContextWindow(paragraphs, h.index, contextBefore, contextAfter),
      });
    }
  }
  return out;
}

/**
 * @typedef {Object} ClassificationPromptArgs
 * @property {string} keyword
 * @property {string} contextDescription - one-line topic, e.g. "Portugal Golden Visa: 5→10 years"
 * @property {BlockHit[]} hits
 */

/**
 * @typedef {Object} PromptResult
 * @property {string} prompt - the full prompt text to send the model
 * @property {object} schema - a JSON schema describing the expected response
 */

/**
 * Build a minimal classification prompt that asks the LLM:
 * "given the campaign topic and a few hit paragraphs, is this block in scope
 * for rewriting?"
 *
 * Sends only the hit paragraphs (not their context windows, not the full
 * block) to keep the input under ~500 tokens. The cheap-and-fast model
 * answers a structured yes/no.
 *
 * @param {ClassificationPromptArgs} args
 * @returns {PromptResult}
 */
export function buildClassificationPrompt({ keyword, contextDescription, hits }) {
  if (!Array.isArray(hits) || hits.length === 0) {
    return { prompt: '', schema: classificationSchema() };
  }
  const lines = [];
  lines.push(`Campaign topic: ${contextDescription}`);
  lines.push(`Trigger keyword: "${keyword}"`);
  lines.push('');
  lines.push('A keyword search found these paragraphs in a content block:');
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    lines.push(`[${i + 1}] field=${h.field} ¶${h.hit_index}: ${h.hit_paragraph}`);
  }
  lines.push('');
  lines.push(
    'Decide whether the campaign topic actually applies to this block — i.e. ' +
    'whether a rewrite per the campaign is needed. Reply ONLY with JSON ' +
    'matching the schema: { "in_scope": boolean, "reason": string }. ' +
    'Keep "reason" under 20 words.'
  );
  return { prompt: lines.join('\n'), schema: classificationSchema() };
}

/**
 * @typedef {Object} RewritePromptArgs
 * @property {string} rewritePrompt - human-written instruction, e.g. "replace 5 with 10 years where it concerns citizenship"
 * @property {{ block_component?: string, original_payload?: Record<string, unknown> }} block
 * @property {BlockHit[]} hits
 */

/**
 * Build a rewrite prompt that asks the LLM to produce updated values for
 * exactly the affected fields. Sends only the context window around each
 * hit (configurable via findHitsInBlock — default 1 paragraph before + 1
 * after). Unrelated fields of the same block are NOT sent.
 *
 * Multiple hits in the same field are grouped into one entry. The
 * downstream n8n flow handles paragraph-level splicing back into the full
 * original field value using the `hit_index` metadata; the LLM's job is
 * just to produce the rewritten content for the context windows it saw.
 *
 * Output schema: `{ updated_fields: { <fieldName>: <newValue> } }`. Keys are
 * exactly the affected field names. The value is the rewritten context
 * window content for that field — what the LLM saw under "### Field:
 * <fieldName>" but rewritten per the campaign instruction.
 *
 * @param {RewritePromptArgs} args
 * @returns {PromptResult}
 */
export function buildRewritePrompt({ rewritePrompt, block, hits }) {
  if (!Array.isArray(hits) || hits.length === 0) {
    return { prompt: '', schema: rewriteSchema([]) };
  }
  // Group hits by field, preserving insertion order.
  /** @type {Map<string, BlockHit[]>} */
  const byField = new Map();
  for (const h of hits) {
    if (!byField.has(h.field)) byField.set(h.field, []);
    byField.get(h.field).push(h);
  }

  const lines = [];
  lines.push(`Rewrite instruction: ${rewritePrompt}`);
  if (block && block.block_component) {
    lines.push(`Block component: ${block.block_component}`);
  }
  lines.push('');
  lines.push('Below are the affected fields and the paragraphs around each hit.');
  lines.push('Other fields of the block are intentionally not shown.');
  for (const [field, fieldHits] of byField.entries()) {
    lines.push('');
    lines.push(`### Field: ${field}`);
    for (let i = 0; i < fieldHits.length; i++) {
      const h = fieldHits[i];
      lines.push(`-- Hit ${i + 1} (¶${h.hit_index}) --`);
      lines.push(h.context);
    }
  }
  lines.push('');
  lines.push(
    'Return ONLY JSON matching the schema: ' +
    '{ "updated_fields": { "<fieldName>": "<rewritten content>" } }. ' +
    'Keys must be exactly the field names shown above. ' +
    'For each field, return the rewritten version of the content shown ' +
    'under that field heading (preserve paragraph breaks with blank lines). ' +
    'Do NOT add fields that were not shown. Do NOT invent paragraphs that ' +
    'were not in the input. Preserve markdown formatting.'
  );

  return { prompt: lines.join('\n'), schema: rewriteSchema(Array.from(byField.keys())) };
}

/* -------------------- internal: JSON schema builders -------------------- */

function classificationSchema() {
  return {
    type: 'object',
    properties: {
      in_scope: { type: 'boolean', description: 'Whether the campaign topic applies to this block.' },
      reason: { type: 'string', description: 'Short justification, < 20 words.' },
    },
    required: ['in_scope', 'reason'],
    additionalProperties: false,
  };
}

/**
 * @param {string[]} fieldNames
 */
function rewriteSchema(fieldNames) {
  /** @type {Record<string, object>} */
  const fieldProps = {};
  for (const name of fieldNames) {
    fieldProps[name] = { type: 'string' };
  }
  return {
    type: 'object',
    properties: {
      updated_fields: {
        type: 'object',
        properties: fieldProps,
        required: fieldNames,
        additionalProperties: false,
      },
    },
    required: ['updated_fields'],
    additionalProperties: false,
  };
}
