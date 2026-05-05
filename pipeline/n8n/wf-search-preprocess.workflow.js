import {
  workflow,
  node,
  trigger,
  sticky,
  newCredential,
  splitInBatches,
  nextBatch,
  languageModel,
  outputParser,
  ifElse,
  expr,
} from '@n8n/workflow-sdk';

// =============================================================================
// WF-Search-PreProcess (Phase 1 + 1.5) — per-story sequential pipeline
//
// For each story (sequential, batchSize=1):
//   1. Check campaign_blocks for existing rows with (campaign_id, story_id).
//      If any exist, this story was already processed for this campaign → skip.
//   2. Substring filter over story.content.body — collect matched blocks
//      with their full _uid, path, payload, hit-paragraphs.
//   3. If 0 matches → insert sentinel row (status='no_matches'), next story.
//   4. ONE LLM call: classify each match's relevance AND propose rewrite for
//      relevant ones, in a single structured-output prompt. Cheaper than
//      filter+rewrite separately and gives the LLM better context.
//   5. Build campaign_blocks rows for kept (match=true) blocks. Each row:
//      - row_id = `${campaign_id}__${story_id}__${block_uid}` — stable PK
//      - block_uid = Storyblok's stable identifier (survives reorders)
//      - block_path = informational snapshot (may go stale)
//      - original_content_hash = sha-1 of original_payload (for stale-detection
//        at LIVE accept time — when DRY_RUN comes off, accept-handler refetches
//        the story, finds block by _uid, compares hash; mismatch → 'stale').
//      - proposed_payload = patched JSON with LLM-suggested updated_fields
//      - status = 'proposed'
//      Insert all rows in one DT call. If 0 kept → sentinel 'no_relevant'.
//   6. Next batch.
//
// SAFETY_DRY_RUN forced. Read-only on Storyblok (CDN public token).
// Sentinel rows (block_component='__sentinel__') are filtered out by the SPA's
// Shape state response in WF-UIBackend.
// =============================================================================

const formTrigger = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.5,
  config: {
    name: 'WF-Search-PreProcess Form',
    position: [0, 0],
    parameters: {
      formTitle: 'Mass Actualization: Search & Pre-Process',
      formDescription: 'Phase 1 + 1.5 — finds Storyblok blocks affected by a topic.',
      formFields: { values: [
        { fieldLabel: 'campaign_topic', fieldType: 'text', requiredField: true },
        { fieldLabel: 'campaign_id', fieldType: 'text', requiredField: false },
        { fieldLabel: 'keyword', fieldType: 'text', requiredField: true },
        { fieldLabel: 'context_description', fieldType: 'textarea', requiredField: true },
        { fieldLabel: 'source_locale', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: [{ option: 'ru' }, { option: 'en' }] } },
        { fieldLabel: 'folder', fieldType: 'text', requiredField: false },
        { fieldLabel: 'content_type', fieldType: 'text', requiredField: false, defaultValue: 'article' },
        { fieldLabel: 'rewrite_prompt', fieldType: 'textarea', requiredField: true },
        { fieldLabel: 'dry_run', fieldType: 'checkbox', requiredField: false, fieldOptions: { values: [{ option: 'yes' }] }, defaultValue: 'yes' },
      ]},
      options: { appendAttribution: false },
    },
  },
  output: [{ campaign_topic: 'x', keyword: '5', context_description: 'x', rewrite_prompt: 'x', source_locale: 'ru', folder: '', content_type: 'flatArticle', dry_run: ['yes'] }],
});

const searchWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Search Webhook (SPA)',
    position: [0, 200],
    parameters: {
      httpMethod: 'POST',
      path: 'search-trigger',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: { allowedOrigins: 'https://imin.github.io,http://localhost:8080' },
    },
    credentials: { httpHeaderAuth: newCredential('Actualization UI Webhook') },
  },
  output: [{ body: { campaign_topic: 'x', keyword: '5', context_description: 'x', rewrite_prompt: 'x', source_locale: 'ru', folder: '', content_type: 'flatArticle', dry_run: true }, headers: { origin: 'https://imin.github.io' } }],
});

const validateWebhookInput = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Validate webhook payload', position: [240, 200], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const ALLOWED_ORIGINS = ['https://imin.github.io', 'http://localhost:8080'];
const DEFAULT_ORIGIN = 'https://imin.github.io';
const raw = $input.first().json || {};
const body = raw.body || raw;
const headers = raw.headers || {};
const originHeader = headers.origin || headers.Origin || '';
const corsOrigin = ALLOWED_ORIGINS.indexOf(originHeader) >= 0 ? originHeader : DEFAULT_ORIGIN;
const required = ['campaign_topic', 'keyword', 'context_description', 'rewrite_prompt'];
const missing = required.filter(k => !body[k] || String(body[k]).trim() === '');
if (missing.length) { return [{ json: { __error: 'missing fields: ' + missing.join(', '), __status: 400, __cors_origin: corsOrigin } }]; }
const sourceLocale = String(body.source_locale || 'ru').trim();
function slugify(s) { return s.toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
const today = new Date().toISOString().slice(0, 10);
let campaignId = String(body.campaign_id || '').trim();
if (!campaignId) campaignId = 'cmp-' + slugify(String(body.campaign_topic)) + '-' + today;
return [{ json: { campaign_topic: body.campaign_topic, campaign_id: campaignId, keyword: body.keyword, context_description: body.context_description, source_locale: sourceLocale, folder: body.folder || '', content_type: body.content_type || 'flatArticle', rewrite_prompt: body.rewrite_prompt, dry_run: body.dry_run !== false, __cors_origin: corsOrigin } }];` } },
  output: [{ campaign_topic: 'x', campaign_id: 'cmp-x', keyword: '5', context_description: 'x', source_locale: 'ru', folder: '', content_type: 'flatArticle', rewrite_prompt: 'x', dry_run: true, __cors_origin: 'https://imin.github.io' }],
});

const checkPayload = ifElse({
  version: 2.2,
  config: { name: 'Payload ok?', position: [480, 200], parameters: { conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('{{ !$json.__error }}'), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }] } } },
});

const respondQueued = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Respond: queued', position: [720, 100], parameters: { respondWith: 'json', responseBody: expr('{{ JSON.stringify({ queued: true, campaign_id: $json.campaign_id || "", started_at: new Date().toISOString() }) }}'), options: { responseHeaders: { entries: [
    { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin.github.io" }}') },
    { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
    { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
    { name: 'Content-Type', value: 'application/json' },
  ]} } } },
  output: [{ ok: true }],
});

const respondError = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Respond: error', position: [720, 300], parameters: { respondWith: 'json', responseBody: expr('{{ JSON.stringify({ error: $json.__error || "bad request" }) }}'), options: { responseCode: expr('{{ $json.__status || 400 }}'), responseHeaders: { entries: [
    { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin.github.io" }}') },
    { name: 'Content-Type', value: 'application/json' },
  ]} } } },
  output: [{ ok: false }],
});

const stripCorsField = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Strip __cors_origin', position: [960, 100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const validated = $('Validate webhook payload').first().json;
const out = Object.assign({}, validated);
delete out.__cors_origin; delete out.__error; delete out.__status;
return [{ json: out }];` } },
  output: [{ campaign_topic: 'x', campaign_id: 'cmp-x', keyword: '5', context_description: 'x', source_locale: 'ru', folder: '', content_type: 'flatArticle', rewrite_prompt: 'x', dry_run: true }],
});

const initCampaign = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Init Campaign Meta', position: [240, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const SAFETY_DRY_RUN = true;
const item = $input.first().json;
const topic = String(item.campaign_topic || "").trim();
if (!topic) throw new Error("campaign_topic is required");
const keyword = String(item.keyword || "").trim();
if (!keyword) throw new Error("keyword is required");
const contextDescription = String(item.context_description || "").trim();
const rewritePrompt = String(item.rewrite_prompt || "").trim();
if (!contextDescription) throw new Error("context_description is required");
if (!rewritePrompt) throw new Error("rewrite_prompt is required");
const sourceLocale = String(item.source_locale || "ru").trim();
const folder = String(item.folder || "").trim();
const contentType = String(item.content_type || "article").trim();
const userChoseDryRun = Array.isArray(item.dry_run) ? item.dry_run.length > 0 : Boolean(item.dry_run);
const dryRunEffective = SAFETY_DRY_RUN || userChoseDryRun;
function slugify(s) { return s.toLowerCase().normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }
const today = new Date().toISOString().slice(0, 10);
let campaignId = String(item.campaign_id || "").trim();
if (!campaignId) campaignId = \`cmp-\${slugify(topic)}-\${today}\`;
const startedAt = new Date().toISOString();
return [{ json: { safety_dry_run: SAFETY_DRY_RUN, dry_run_effective: dryRunEffective, campaign_id: campaignId, campaign_topic: topic, campaign_started_at: startedAt, keyword: keyword, keyword_lc: keyword.toLowerCase(), context_description: contextDescription, rewrite_prompt: rewritePrompt, source_locale: sourceLocale, folder: folder, content_type: contentType } }];` } },
  output: [{ safety_dry_run: true, dry_run_effective: true, campaign_id: 'cmp-x', campaign_topic: 'x', campaign_started_at: '2026-05-04T22:00:00.000Z', keyword: '5', keyword_lc: '5', context_description: 'x', rewrite_prompt: 'x', source_locale: 'ru', folder: '', content_type: 'article' }],
});

const generatePageNumbers = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Generate Page Numbers', position: [480, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $input.first().json;
const MAX_PAGES = 10;
const out = [];
for (let p = 1; p <= MAX_PAGES; p++) out.push({ json: { page: p, folder: meta.folder, source_locale: meta.source_locale } });
return out;` } },
  output: [{ page: 1, folder: '', source_locale: 'ru' }],
});

const fetchStoryblokStories = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.4,
  config: { name: 'Storyblok CDN: List Stories', position: [720, 0], alwaysOutputData: true, parameters: { method: 'GET', url: 'https://api.storyblok.com/v2/cdn/stories', sendQuery: true, specifyQuery: 'keypair', queryParameters: { parameters: [
    { name: 'token', value: '82kxsVsvTpKJldQD7DqCvQtt' },
    { name: 'per_page', value: '100' },
    { name: 'page', value: '={{ $json.page }}' },
    { name: 'starts_with', value: '={{ $json.folder }}' },
    { name: 'filter_query[seo.0.originalLanguage][in]', value: '={{ $json.source_locale }}' },
  ] }, options: {
    timeout: 60000,
    response: { response: { fullResponse: false, responseFormat: 'json', neverError: true } },
    batching: { batch: { batchSize: 5, batchInterval: 1100 } },
  } } },
  output: [{ stories: [] }],
});

// Combine pages, emit ONE item per story so the splitInBatches downstream can
// loop over them sequentially (batchSize=1).
const flattenStoriesToList = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Flatten Stories', position: [960, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const pages = $input.all();
const out = [];
for (const p of pages) {
  const stories = Array.isArray(p.json && p.json.stories) ? p.json.stories : [];
  for (const s of stories) {
    if (!s || !s.content) continue;
    out.push({ json: {
      story_id: String(s.id || ''),
      story_uuid: s.uuid || '',
      story_full_slug: s.full_slug || s.slug || '',
      story_name: s.name || '',
      content: s.content,
    } });
  }
}
return out;` } },
  output: [{ story_id: '12345', story_full_slug: 'x', story_name: 'x', content: { body: [] } }],
});

const loopStories = splitInBatches({
  version: 3,
  config: { name: 'Loop Over Stories', position: [1200, 0], parameters: { batchSize: 1, options: {} } },
});

// Look for existing campaign_blocks rows for this (campaign_id, story_id).
// If any exist, this story was already processed → skip on re-run.
const checkStoryProcessed = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'Check Story Processed', position: [1440, -100], alwaysOutputData: true, parameters: {
    resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'id', value: 'wgKa7GSxjKjGrwQK', cachedResultName: 'campaign_blocks' },
    matchType: 'allConditions',
    filters: { conditions: [
      { keyName: 'campaign_id', condition: 'eq', keyValue: expr('={{ $(\'Init Campaign Meta\').first().json.campaign_id }}') },
      { keyName: 'story_id', condition: 'eq', keyValue: expr('={{ $json.story_id }}') },
    ] },
    returnAll: true,
  } },
  output: [{ id: 0, row_id: 'x' }],
});

// Decide skip vs process. The DataTable.get with alwaysOutputData=true emits
// at least one item; we count items minus the synthetic empty marker.
// Using $input.all().length as a proxy: 0 real rows means the get returned
// nothing and n8n synthesised one empty item — distinguish by checking if
// $input.first().json has a row_id field.
const decideSkipStory = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Decide Skip', position: [1680, -100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const items = $input.all().filter(it => it.json && it.json.row_id);
const story = $('Loop Over Stories').first().json;
return [{ json: {
  __skip: items.length > 0,
  __reason: items.length > 0 ? 'already-processed' : 'fresh',
  __existing_count: items.length,
  story_id: story.story_id,
  story_uuid: story.story_uuid,
  story_full_slug: story.story_full_slug,
  story_name: story.story_name,
  content: story.content,
} }];` } },
  output: [{ __skip: false, story_id: '12345', story_full_slug: 'x', story_name: 'x', content: { body: [] } }],
});

const skipIfProcessed = ifElse({
  version: 2.2,
  config: { name: 'Already processed?', position: [1920, -100], parameters: { conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('={{ $json.__skip }}'), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }] } } },
});

// Walk THIS one story's content body, find blocks where keyword appears in
// any string leaf. For each matched block, capture _uid (stable identifier),
// component, body-relative path (snapshot), affected_fields (paths within
// the block), hit_paragraphs (with one paragraph of context above/below for
// the LLM).
const substringFilterStory = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Substring Filter (per story)', position: [2160, -100], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $('Init Campaign Meta').first().json;
const story = $input.first().json;
const keywordLc = meta.keyword_lc;

function walkLeaves(obj, prefix, out) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string' || typeof obj === 'number') { out.push({ path: prefix, value: String(obj) }); return; }
  if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) walkLeaves(obj[i], prefix ? \`\${prefix}.\${i}\` : String(i), out); return; }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) { if (k === '_uid' || k === '_editable' || k === 'component') continue; walkLeaves(obj[k], prefix ? \`\${prefix}.\${k}\` : k, out); }
  }
}
function walkBlocks(arr, prefix, out) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (!b || typeof b !== 'object') continue;
    const path = prefix ? \`\${prefix}[\${i}]\` : \`body[\${i}]\`;
    if (b._uid && b.component) out.push({ _uid: b._uid, component: b.component, path, payload: b });
    for (const k of Object.keys(b)) { if (Array.isArray(b[k]) && b[k].length && typeof b[k][0] === 'object') walkBlocks(b[k], \`\${path}.\${k}\`, out); }
  }
}
function paragraphContext(text, kwLc) {
  const paras = String(text).split(/\\n\\s*\\n/);
  const hits = [];
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].toLowerCase().includes(kwLc)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(paras.length - 1, i + 1);
      hits.push({ para_index: i, context: paras.slice(start, end + 1).join('\\n\\n') });
    }
  }
  return hits;
}
function hashPayload(p) {
  // FNV-1a 32-bit, deterministic, fast. Used for stale-detection at LIVE
  // accept time — current block content vs original snapshot.
  const s = JSON.stringify(p);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}

const blocks = [];
walkBlocks(story.content && story.content.body, 'body', blocks);
const matched = [];
for (const block of blocks) {
  const leaves = [];
  walkLeaves(block.payload, '', leaves);
  const matchedFields = [];
  const fieldHits = {};
  for (const leaf of leaves) {
    if (typeof leaf.value !== 'string') continue;
    if (!leaf.value.toLowerCase().includes(keywordLc)) continue;
    const trimmed = leaf.value.trim();
    if (/^https?:\\/\\//i.test(trimmed)) continue;
    if (/^\\d+(?:[.,]\\d+)?$/.test(trimmed)) continue;
    matchedFields.push(leaf.path);
    fieldHits[leaf.path] = paragraphContext(leaf.value, keywordLc);
  }
  if (matchedFields.length === 0) continue;
  matched.push({
    _uid: block._uid,
    component: block.component,
    path: block.path,
    payload: block.payload,
    affected_fields: matchedFields,
    field_hits: fieldHits,
    content_hash: hashPayload(block.payload),
  });
}

return [{ json: {
  story_id: story.story_id,
  story_full_slug: story.story_full_slug,
  story_name: story.story_name,
  matches: matched,
  match_count: matched.length,
} }];` } },
  output: [{ story_id: '12345', story_full_slug: 'x', story_name: 'x', matches: [], match_count: 0 }],
});

const hasMatches = ifElse({
  version: 2.2,
  config: { name: 'Has matches?', position: [2400, -100], parameters: { conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('={{ $json.match_count }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }] } } },
});

const llmModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', version: 1.1,
  config: { name: 'Gemini Flash', position: [2640, 0], parameters: { modelName: 'models/gemini-2.5-flash', options: { temperature: 0.2, maxOutputTokens: 8192 } }, credentials: { googlePalmApi: newCredential('Google Gemini API') } },
});

const verdictsParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured', version: 1.3,
  config: { name: 'Verdicts Schema', position: [2800, 0], parameters: {
    schemaType: 'fromJson',
    jsonSchemaExample: '{"verdicts":[{"index":0,"match":true,"reason":"directly about topic","updated_fields":{"text":"new text"}},{"index":1,"match":false,"reason":"unrelated mention","updated_fields":{}}]}',
  } },
});

// Single LLM call combining classification + rewrite proposal. Gemini Flash
// gets the WHOLE story context (slug/name + all matched blocks for THIS story
// in one batch). Output schema asks for, per match: index, match (boolean),
// reason, updated_fields (only when match=true). Cheaper than two separate
// calls and gives the model story-level context for relevance decisions.
const classifyRewriteAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent', version: 3.1,
  config: { name: 'LLM Classify + Rewrite', position: [2640, -200], onError: 'continueRegularOutput', parameters: {
    promptType: 'define',
    hasOutputParser: true,
    text: `=Story: {{ $json.story_full_slug }}
Topic: {{ $('Init Campaign Meta').first().json.context_description }}
Keyword (substring): {{ $('Init Campaign Meta').first().json.keyword }}
Rewrite instruction: {{ $('Init Campaign Meta').first().json.rewrite_prompt }}

MATCHED BLOCKS ({{ $json.match_count }}):
{{ JSON.stringify(($json.matches || []).map((m, i) => ({ index: i, _uid: m._uid, component: m.component, affected_fields: m.affected_fields, hit_paragraphs: m.field_hits }))) }}

For EACH block return one verdict object with ALL FOUR fields:
- index (0..N-1, in input order)
- match: true|false — does the keyword in surrounding paragraph ACTUALLY refer to the topic? Numbers like "5 stars", "5 minutes", "топ-5", "5 последних лет" = false.
- reason: one short sentence.
- updated_fields: object — ALWAYS PRESENT. When match=true: keys = entries from affected_fields, values = rewritten text. When match=false: empty object {} (do NOT omit the field).

Return EXACTLY {{ $json.match_count }} verdicts in input order.`,
    options: {
      systemMessage: `Editorial assistant. Be strict on relevance. Always include updated_fields in every verdict object — empty object {} for match=false. When match=true, apply the rewrite instruction faithfully without new facts; preserve markdown/HTML/footnotes/links/proper nouns; rewrite EVERY occurrence in that field.`,
    },
  }, subnodes: { model: llmModel, outputParser: verdictsParser } },
  output: [{ output: { verdicts: [] } }],
});

// Take LLM verdicts, build a campaign_blocks row per match=true result (with
// patched proposed_payload, content_hash, full identifiers). If 0 kept after
// filtering, still emit a sentinel row so this story's row count > 0 and
// future runs skip it.
const buildRowsFromVerdicts = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Rows', position: [2880, -200], alwaysOutputData: true, parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $('Init Campaign Meta').first().json;
const filterOut = $('Substring Filter (per story)').first().json;
const story = filterOut;
const upstream = $input.first().json || {};

// When agent.onError=continueRegularOutput, the upstream item may carry
// an error field instead of output — emit an llm_error sentinel so the
// story is still marked as processed and the loop continues.
if (upstream.error || (!upstream.output && !upstream.verdicts)) {
  const now = new Date().toISOString();
  const rid = \`\${meta.campaign_id}__\${story.story_id}____sentinel__\`;
  return [{ json: { row_id: rid, campaign_id: meta.campaign_id, campaign_topic: meta.campaign_topic, campaign_started_at: meta.campaign_started_at, source_locale: meta.source_locale, story_id: story.story_id, story_full_slug: story.story_full_slug, story_name: story.story_name, block_uid: '__sentinel__', block_path: '', block_component: '__sentinel__', affected_fields: '[]', original_payload: '{}', original_content_hash: '', llm_match_reason: 'LLM call errored or returned no parseable output', proposed_payload: '{}', status: 'llm_error', updated_at: now } }];
}

const parsed = upstream.output || upstream;
const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
const verdictByIndex = {};
for (const v of verdicts) verdictByIndex[v.index] = v;

function setByPath(obj, segs, val) {
  if (segs.length === 0) return;
  const seg = segs[0];
  if (segs.length === 1) { if (Array.isArray(obj)) obj[Number(seg)] = val; else obj[seg] = val; return; }
  const next = Array.isArray(obj) ? obj[Number(seg)] : obj[seg];
  if (next && typeof next === 'object') setByPath(next, segs.slice(1), val);
}
function patchPayload(payload, updatedFields) {
  const out = JSON.parse(JSON.stringify(payload));
  for (const fieldPath of Object.keys(updatedFields || {})) {
    const v = updatedFields[fieldPath];
    if (typeof v !== 'string') continue;
    setByPath(out, fieldPath.split('.'), v);
  }
  return out;
}

const matches = Array.isArray(story.matches) ? story.matches : [];
const out = [];
const now = new Date().toISOString();
for (let i = 0; i < matches.length; i++) {
  const m = matches[i];
  const v = verdictByIndex[i];
  if (!v || v.match !== true || !v.updated_fields) continue;
  const proposedPayload = patchPayload(m.payload, v.updated_fields);
  const rowId = \`\${meta.campaign_id}__\${story.story_id}__\${m._uid}\`;
  out.push({ json: {
    row_id: rowId,
    campaign_id: meta.campaign_id,
    campaign_topic: meta.campaign_topic,
    campaign_started_at: meta.campaign_started_at,
    source_locale: meta.source_locale,
    story_id: story.story_id,
    story_full_slug: story.story_full_slug,
    story_name: story.story_name,
    block_uid: m._uid,
    block_path: m.path,
    block_component: m.component,
    affected_fields: JSON.stringify(m.affected_fields || []),
    original_payload: JSON.stringify(m.payload),
    original_content_hash: m.content_hash,
    llm_match_reason: String(v.reason || '').slice(0, 500),
    proposed_payload: JSON.stringify(proposedPayload),
    status: 'proposed',
    updated_at: now,
  } });
}

if (out.length === 0) {
  // Sentinel: tells future runs this story is processed even though no block
  // survived classification. SPA filters block_component='__sentinel__'.
  const rowId = \`\${meta.campaign_id}__\${story.story_id}____sentinel__\`;
  out.push({ json: {
    row_id: rowId,
    campaign_id: meta.campaign_id,
    campaign_topic: meta.campaign_topic,
    campaign_started_at: meta.campaign_started_at,
    source_locale: meta.source_locale,
    story_id: story.story_id,
    story_full_slug: story.story_full_slug,
    story_name: story.story_name,
    block_uid: '__sentinel__',
    block_path: '',
    block_component: '__sentinel__',
    affected_fields: '[]',
    original_payload: '{}',
    original_content_hash: '',
    llm_match_reason: 'No relevant matches after LLM classification',
    proposed_payload: '{}',
    status: 'no_relevant',
    updated_at: now,
  } });
}
return out;` } },
  output: [{ row_id: 'cmp__12345__b-1', campaign_id: 'cmp', story_id: '12345', block_uid: 'b-1', status: 'proposed' }],
});

// Same sentinel insertion logic for the "no substring matches at all" branch.
const buildSentinelNoMatches = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Sentinel (no matches)', position: [2640, 200], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $('Init Campaign Meta').first().json;
const story = $input.first().json;
const now = new Date().toISOString();
const rowId = \`\${meta.campaign_id}__\${story.story_id}____sentinel__\`;
return [{ json: {
  row_id: rowId,
  campaign_id: meta.campaign_id,
  campaign_topic: meta.campaign_topic,
  campaign_started_at: meta.campaign_started_at,
  source_locale: meta.source_locale,
  story_id: story.story_id,
  story_full_slug: story.story_full_slug,
  story_name: story.story_name,
  block_uid: '__sentinel__',
  block_path: '',
  block_component: '__sentinel__',
  affected_fields: '[]',
  original_payload: '{}',
  original_content_hash: '',
  llm_match_reason: 'No substring matches in story content',
  proposed_payload: '{}',
  status: 'no_matches',
  updated_at: now,
} }];` } },
  output: [{ row_id: 'cmp__x__sentinel', block_uid: '__sentinel__', status: 'no_matches' }],
});

const insertRows = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'Insert into campaign_blocks', position: [3120, 0], alwaysOutputData: true, parameters: { resource: 'row', operation: 'insert', dataTableId: { __rl: true, mode: 'id', value: 'wgKa7GSxjKjGrwQK', cachedResultName: 'campaign_blocks' }, columns: { mappingMode: 'defineBelow', value: {
    row_id: '={{ $json.row_id }}',
    campaign_id: '={{ $json.campaign_id }}',
    campaign_topic: '={{ $json.campaign_topic }}',
    campaign_started_at: '={{ $json.campaign_started_at }}',
    source_locale: '={{ $json.source_locale }}',
    story_id: '={{ $json.story_id }}',
    story_full_slug: '={{ $json.story_full_slug }}',
    story_name: '={{ $json.story_name }}',
    block_uid: '={{ $json.block_uid }}',
    block_path: '={{ $json.block_path }}',
    block_component: '={{ $json.block_component }}',
    affected_fields: '={{ $json.affected_fields }}',
    original_payload: '={{ $json.original_payload }}',
    llm_match_reason: '={{ $json.llm_match_reason }}',
    proposed_payload: '={{ $json.proposed_payload }}',
    status: '={{ $json.status }}',
    updated_at: '={{ $json.updated_at }}',
  }, matchingColumns: [], schema: [
    { id: 'row_id', displayName: 'row_id', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'campaign_id', displayName: 'campaign_id', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'campaign_topic', displayName: 'campaign_topic', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'campaign_started_at', displayName: 'campaign_started_at', type: 'date', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'source_locale', displayName: 'source_locale', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'story_id', displayName: 'story_id', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'story_full_slug', displayName: 'story_full_slug', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'story_name', displayName: 'story_name', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'block_uid', displayName: 'block_uid', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'block_path', displayName: 'block_path', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'block_component', displayName: 'block_component', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'affected_fields', displayName: 'affected_fields', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'original_payload', displayName: 'original_payload', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'llm_match_reason', displayName: 'llm_match_reason', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'proposed_payload', displayName: 'proposed_payload', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'status', displayName: 'status', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'updated_at', displayName: 'updated_at', type: 'date', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
  ] }, options: { optimizeBulk: true } } },
  output: [{ id: 1 }],
});

const slackNotify = node({
  type: 'n8n-nodes-base.slack', version: 2.4,
  config: { name: 'Slack: Campaign Ready for Review', position: [1200, 600], executeOnce: true, parameters: { resource: 'message', operation: 'post', select: 'channel', channelId: { __rl: true, mode: 'list', value: 'C09KC8MGE4A', cachedResultName: 'translation-reports' }, messageType: 'text', text: `={{ $('Init Campaign Meta').item.json.dry_run_effective ? '[DRY-RUN] ' : '[LIVE] ' }}*Mass Actualization — Campaign Ready for Review*
*Topic:* {{ $('Init Campaign Meta').item.json.campaign_topic }}
*Campaign ID:* \`{{ $('Init Campaign Meta').item.json.campaign_id }}\`
*Source locale:* \`{{ $('Init Campaign Meta').item.json.source_locale }}\`
*Keyword:* \`{{ $('Init Campaign Meta').item.json.keyword }}\`

Open the review UI: https://imin.github.io/article-actualization-ui/?api=https://n8n-prod-960265555894.europe-west3.run.app&campaign_id={{ $('Init Campaign Meta').item.json.campaign_id }}`, otherOptions: { includeLinkToWorkflow: false } }, credentials: { slackApi: newCredential('Slack Bot') } },
  output: [{ ok: true }],
});

const stickyOverview = sticky('## WF-Search-PreProcess (per-story)\n\nSequential per-story pipeline. Each story is fetched, scanned, classified, and rewritten in isolation. Already-processed stories are detected via existing rows in campaign_blocks (campaign_id + story_id) and skipped. Sentinel rows track stories with no matches so re-runs do not reprocess them.\n\nblock_uid is the stable identifier across Storyblok edits. Snapshot path is informational. content_hash enables stale-detection at LIVE accept time.', [], { color: 7, width: 520, height: 240 });
const stickyArch = sticky('## Per-story flow (matryoshka)\n\nLoop Over Stories (batchSize=1)\n  ├─ Check existing rows for (campaign_id, story_id)\n  ├─ Skip if already processed\n  ├─ Substring filter the story body\n  ├─ If 0 matches: insert sentinel (no_matches), next\n  ├─ ONE LLM call: classify + rewrite per match\n  ├─ Build rows for kept blocks (or sentinel no_relevant)\n  └─ Insert into campaign_blocks, next', [], { color: 4, width: 520, height: 240 });
const stickyLive = sticky('## Stale-content handling (LIVE TODO)\n\nDRY_RUN mode: Accept just flips status; block_path going stale is harmless.\n\nLIVE mode (when SAFETY_DRY_RUN=false in WF-UIBackend):\n1. On accept/edit, refetch the story by story_id from Storyblok mAPI.\n2. Walk current content.body, find block by _uid (stable).\n3. Compare current block content_hash to original_content_hash.\n   - If equal: safe to patch with proposed_payload (using current path).\n   - If different: status=stale_content, editor must re-review.\n4. If _uid not found: status=error_block_missing (block was deleted).', [], { color: 3, width: 480, height: 280 });

export default workflow('wf-search-preprocess', 'Mass Actualization: Search & Pre-Process')
  .add(formTrigger)
  .to(initCampaign)
  .to(generatePageNumbers)
  .to(fetchStoryblokStories)
  .to(flattenStoriesToList)
  .to(loopStories
    .onEachBatch(
      checkStoryProcessed
        .to(decideSkipStory)
        .to(skipIfProcessed
          .onTrue(nextBatch(loopStories))
          .onFalse(
            substringFilterStory
              .to(hasMatches
                .onTrue(
                  classifyRewriteAgent
                    .to(buildRowsFromVerdicts)
                    .to(insertRows)
                    .to(nextBatch(loopStories))
                )
                .onFalse(
                  buildSentinelNoMatches
                    .to(insertRows)
                    .to(nextBatch(loopStories))
                )
              )
          )
        )
    )
    .onDone(slackNotify)
  )
  .add(searchWebhook)
  .to(validateWebhookInput)
  .to(checkPayload.onTrue(respondQueued.to(stripCorsField).to(initCampaign)).onFalse(respondError))
  .add(stickyOverview)
  .add(stickyArch)
  .add(stickyLive);
