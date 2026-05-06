import {
  workflow,
  node,
  trigger,
  newCredential,
  splitInBatches,
  nextBatch,
  languageModel,
  outputParser,
  ifElse,
  expr,
} from '@n8n/workflow-sdk';

// =============================================================================
// WF-Search-PreProcess (Phase 1 + 1.5) — resumable, self-chaining pipeline
//
// Each execution processes at most SLICE_SIZE (40) unprocessed stories, then
// HTTP-POSTs the same campaign config to its own webhook to continue with the
// next batch. Chain terminates when Filter Unprocessed Stories returns 0 →
// Campaign Complete? branch fires Slack and stops.
//
// Three-tier search filter (cheapest first):
//   1. Article-level OR (article_any_keywords)  — full-body substring check
//   2. Block-level AND  (block_required_keywords) — all terms in same block
//   3. Main keyword substring                    — at least one match in block
//
// Substring filter runs ONCE per batch (bulk, all 40 stories). Only matched
// stories enter the LLM loop; non-matches get sentinel rows inserted so the
// next chained run skips them.
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
        { fieldLabel: 'block_required_keywords', fieldType: 'text', requiredField: false },
        { fieldLabel: 'article_any_keywords', fieldType: 'text', requiredField: false },
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
if (!campaignId) campaignId = 'cmp-' + slugify(String(body.campaign_topic)) + '-' + sourceLocale + '-' + today;
return [{ json: { campaign_topic: body.campaign_topic, campaign_id: campaignId, keyword: body.keyword, block_required_keywords: body.block_required_keywords || '', article_any_keywords: body.article_any_keywords || '', context_description: body.context_description, source_locale: sourceLocale, folder: body.folder || '', content_type: body.content_type || 'flatArticle', rewrite_prompt: body.rewrite_prompt, dry_run: body.dry_run !== false, __cors_origin: corsOrigin } }];` } },
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
function parseKeywordList(s) { return String(s || "").split(",").map(t => t.trim().toLowerCase()).filter(Boolean); }
const blockRequiredRaw = String(item.block_required_keywords || "").trim();
const articleAnyRaw = String(item.article_any_keywords || "").trim();
const blockRequiredLc = parseKeywordList(blockRequiredRaw);
const articleAnyLc = parseKeywordList(articleAnyRaw);
function slugify(s) { return s.toLowerCase().normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }
const today = new Date().toISOString().slice(0, 10);
let campaignId = String(item.campaign_id || "").trim();
if (!campaignId) campaignId = \`cmp-\${slugify(topic)}-\${sourceLocale}-\${today}\`;
const startedAt = new Date().toISOString();
return [{ json: { safety_dry_run: SAFETY_DRY_RUN, dry_run_effective: dryRunEffective, campaign_id: campaignId, campaign_topic: topic, campaign_started_at: startedAt, keyword: keyword, keyword_lc: keyword.toLowerCase(), block_required_keywords: blockRequiredRaw, article_any_keywords: articleAnyRaw, block_required_keywords_lc: blockRequiredLc, article_any_keywords_lc: articleAnyLc, context_description: contextDescription, rewrite_prompt: rewritePrompt, source_locale: sourceLocale, folder: folder, content_type: contentType } }];` } },
  output: [{ safety_dry_run: true, dry_run_effective: true, campaign_id: 'cmp-x', campaign_topic: 'x', campaign_started_at: '2026-05-04T22:00:00.000Z', keyword: '5', keyword_lc: '5', block_required_keywords: 'years', article_any_keywords: 'Portugal, Golden Visa', block_required_keywords_lc: ['years'], article_any_keywords_lc: ['portugal', 'golden visa'], context_description: 'x', rewrite_prompt: 'x', source_locale: 'ru', folder: '', content_type: 'article' }],
});

// Carry processed_story_ids forward as a comma-separated string so the
// Storyblok CDN call can pass it via excluding_ids — server-side dedup means
// pagination ALWAYS returns genuinely-new stories regardless of which IDs
// were previously processed (no risk of "first page is all done → 0 results").
const generatePageNumbers = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Generate Page Numbers', position: [480, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $input.first().json;
const processedIds = Array.isArray(meta.processed_story_ids) ? meta.processed_story_ids : [];
const excludingIds = processedIds.join(',');
const MAX_PAGES = 10;
const out = [];
for (let p = 1; p <= MAX_PAGES; p++) out.push({ json: { page: p, folder: meta.folder, source_locale: meta.source_locale, excluding_ids: excludingIds } });
return out;` } },
  output: [{ page: 1, folder: '', source_locale: 'ru', excluding_ids: '' }],
});

const fetchStoryblokStories = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.4,
  config: { name: 'Storyblok CDN: List Stories', position: [720, 0], alwaysOutputData: true, parameters: { method: 'GET', url: 'https://api.storyblok.com/v2/cdn/stories', sendQuery: true, specifyQuery: 'keypair', queryParameters: { parameters: [
    { name: 'token', value: '82kxsVsvTpKJldQD7DqCvQtt' },
    { name: 'per_page', value: '100' },
    { name: 'page', value: '={{ $json.page }}' },
    { name: 'starts_with', value: '={{ $json.folder }}' },
    { name: 'filter_query[seo.0.originalLanguage][in]', value: '={{ $json.source_locale }}' },
    { name: 'excluding_ids', value: '={{ $json.excluding_ids }}' },
  ] }, options: {
    timeout: 60000,
    response: { response: { fullResponse: false, responseFormat: 'json', neverError: true } },
    batching: { batch: { batchSize: 1, batchInterval: 400 } },
    retry: { maxTries: 3, waitBetweenTries: 2000 },
  } } },
  output: [{ stories: [] }],
});

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

const fetchProcessedRows = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'Get Processed Rows', position: [480, 100], alwaysOutputData: true, parameters: {
    resource: 'row', operation: 'get',
    dataTableId: { __rl: true, mode: 'id', value: 'wgKa7GSxjKjGrwQK', cachedResultName: 'campaign_blocks' },
    matchType: 'allConditions',
    filters: { conditions: [
      { keyName: 'campaign_id', condition: 'eq', keyValue: expr('={{ $json.campaign_id }}') },
    ] },
    returnAll: true,
  } },
  output: [{ id: 0, row_id: 'x', story_id: '12345' }],
});

const aggregateProcessedStoryIds = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Aggregate Processed Story IDs', position: [480, 200], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $('Init Campaign Meta').first().json;
const rows = $input.all();
const ids = new Set();
for (const r of rows) {
  const sid = r && r.json && r.json.story_id;
  if (sid) ids.add(String(sid));
}
return [{ json: Object.assign({}, meta, { processed_story_ids: Array.from(ids), processed_count: ids.size }) }];` } },
  output: [{ campaign_id: 'cmp-x', folder: '', source_locale: 'ru', processed_story_ids: [], processed_count: 0 }],
});

const filterUnprocessedStories = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Filter Unprocessed Stories', position: [1080, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const processed = new Set($('Aggregate Processed Story IDs').first().json.processed_story_ids || []);
const stories = $input.all();
const out = [];
let skipped = 0;
for (const s of stories) {
  if (!s || !s.json || !s.json.story_id) continue;
  if (processed.has(String(s.json.story_id))) { skipped++; continue; }
  out.push(s);
}
console.log('[Filter Unprocessed] kept=' + out.length + ' skipped=' + skipped + ' total=' + stories.length);
return out;` } },
  output: [{ story_id: '12345', story_full_slug: 'x', story_name: 'x', content: { body: [] } }],
});

const sliceOrMarkComplete = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Slice or Mark Complete', position: [1240, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const SLICE_SIZE = 40;
const stories = $input.all();
const slice = stories.slice(0, SLICE_SIZE);
console.log('[Slice] sliced=' + slice.length + ' of ' + stories.length + ' unprocessed');
if (slice.length === 0) {
  return [{ json: { __complete: true, total_processed: 0 } }];
}
return slice.map(s => ({ json: Object.assign({}, s.json, { __complete: false }) }));` } },
  output: [{ story_id: '12345', story_full_slug: 'x', story_name: 'x', content: { body: [] }, __complete: false }],
});

const isCampaignComplete = ifElse({
  version: 2.2,
  config: { name: 'Campaign Complete?', position: [1400, 0], parameters: { conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('={{ $json.__complete }}'), rightValue: true, operator: { type: 'boolean', operation: 'equals' } }] } } },
});

const buildSelfTriggerBody = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Self-Trigger Body', position: [1400, 600], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $('Init Campaign Meta').first().json;
return [{ json: { campaign_topic: meta.campaign_topic, campaign_id: meta.campaign_id, keyword: meta.keyword, block_required_keywords: meta.block_required_keywords || '', article_any_keywords: meta.article_any_keywords || '', context_description: meta.context_description, source_locale: meta.source_locale, folder: meta.folder, content_type: meta.content_type, rewrite_prompt: meta.rewrite_prompt, dry_run: meta.dry_run_effective } }];` } },
  output: [{ campaign_topic: 'x', campaign_id: 'cmp-x', keyword: '5', block_required_keywords: 'years', article_any_keywords: 'Portugal, Golden Visa', context_description: 'x', source_locale: 'ru', folder: '', content_type: 'flatArticle', rewrite_prompt: 'x', dry_run: true }],
});

const selfTriggerNextBatch = node({
  type: 'n8n-nodes-base.httpRequest', version: 4.4,
  config: { name: 'Self-Trigger Next Batch', position: [1640, 600], alwaysOutputData: true, parameters: {
    method: 'POST',
    url: 'https://n8n-prod-960265555894.europe-west3.run.app/webhook/search-trigger',
    authentication: 'genericCredentialType',
    genericAuthType: 'httpHeaderAuth',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: expr('={{ JSON.stringify($json) }}'),
    options: { timeout: 30000, response: { response: { fullResponse: false, responseFormat: 'text', neverError: true } } },
  }, credentials: { httpHeaderAuth: newCredential('Actualization UI Webhook') } },
  output: [{ ok: true }],
});

// BULK substring filter — processes ALL stories in this batch in one call.
// Three-tier filter (cheapest first): article-level OR, block-level AND, main
// keyword substring. Emits one item per story (preserving order). Each item
// carries .matches[] (may be empty) and .match_count for downstream routing.
// FOUR-tier filter (cheapest first), all on text-only content (URLs/asset paths excluded):
//   0. Locale check — detect actual content language (cyrillic vs latin ratio).
//      Drops stories whose content language doesn't match meta.source_locale.
//      This is needed because Storyblok seo.originalLanguage filter is unreliable.
//   1. Article-level OR (article_any_keywords) — must contain any in actual text.
//   2. Block-level AND (block_required_keywords) — block must contain all in its text.
//   3. Main keyword substring — at least one match in block leaves.
// Block dedup: when walkBlocks emits both parent and child, keep child.
const substringFilterBulk = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Substring Filter (bulk)', position: [1640, 0], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $('Init Campaign Meta').first().json;
const stories = $input.all();
const keywordLc = meta.keyword_lc;
const sourceLocale = String(meta.source_locale || '').toLowerCase();
const articleAny = Array.isArray(meta.article_any_keywords_lc) ? meta.article_any_keywords_lc : [];
const blockRequired = Array.isArray(meta.block_required_keywords_lc) ? meta.block_required_keywords_lc : [];

function isTextLeaf(s) {
  const t = String(s).trim();
  if (!t) return false;
  if (/^https?:\\/\\//i.test(t)) return false;
  if (/^\\/\\//.test(t)) return false;
  if (/\\.(jpe?g|png|gif|svg|webp|avif|mp4|webm|pdf|woff2?|ttf|css|js|json)(\\?|$)/i.test(t)) return false;
  if (/^[\\d\\s,.\\-+()%]+$/.test(t)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false;
  return true;
}
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
function escapeRegex(s) { return String(s).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }
function isWordBoundedMatch(text, kwLc) {
  const re = new RegExp('(^|\\\\s)' + escapeRegex(kwLc) + '(\\\\s|$)', 'i');
  return re.test(text);
}
function paragraphContext(text, kwLc) {
  const re = new RegExp('(^|\\\\s)' + escapeRegex(kwLc) + '(\\\\s|$)', 'i');
  const paras = String(text).split(/\\n\\s*\\n/);
  const hits = [];
  for (let i = 0; i < paras.length; i++) {
    if (re.test(paras[i])) {
      const start = Math.max(0, i - 1);
      const end = Math.min(paras.length - 1, i + 1);
      hits.push({ para_index: i, context: paras.slice(start, end + 1).join('\\n\\n') });
    }
  }
  return hits;
}
function hashPayload(p) {
  const s = JSON.stringify(p);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}
function detectLang(content) {
  const sample = JSON.stringify(content || {}).slice(0, 10000);
  const cyr = (sample.match(/[а-яёА-ЯЁ]/g) || []).length;
  const lat = (sample.match(/[a-zA-Z]/g) || []).length;
  const total = cyr + lat;
  if (total < 50) return null;
  if (cyr / total > 0.30) return 'ru';
  if (lat / total > 0.95) return 'en';
  return null;
}
function emptyResult(story) {
  return { story_id: story.story_id, story_full_slug: story.story_full_slug, story_name: story.story_name, matches: [], match_count: 0 };
}

const out = [];
let droppedByLocale = 0;
let droppedByArticle = 0;
let withMatches = 0;

for (const item of stories) {
  const story = item.json;
  if (!story || !story.story_id) continue;

  if (sourceLocale === 'ru' || sourceLocale === 'en') {
    const detected = detectLang(story.content);
    if (detected && detected !== sourceLocale) {
      droppedByLocale++;
      console.log('[Substring] LOCALE-FILTER drop story=' + story.story_id + ' (' + story.story_full_slug + ') detected=' + detected + ' expected=' + sourceLocale);
      out.push({ json: emptyResult(story) });
      continue;
    }
  }

  if (articleAny.length > 0) {
    const allLeaves = [];
    walkLeaves(story.content || {}, '', allLeaves);
    let articleTextLc = '';
    for (const l of allLeaves) { if (typeof l.value === 'string' && isTextLeaf(l.value)) articleTextLc += ' ' + l.value.toLowerCase(); }
    const hit = articleAny.some(kw => articleTextLc.includes(kw));
    if (!hit) {
      droppedByArticle++;
      console.log('[Substring] ARTICLE-FILTER drop story=' + story.story_id + ' (' + story.story_full_slug + ')');
      out.push({ json: emptyResult(story) });
      continue;
    }
  }

  const allBlocks = [];
  walkBlocks(story.content && story.content.body, 'body', allBlocks);
  const matchableBlocks = allBlocks.filter(b => !allBlocks.some(c => c !== b && c._uid && b._uid && c._uid.startsWith(b._uid + '-')));

  const matched = [];
  for (const block of matchableBlocks) {
    const leaves = [];
    walkLeaves(block.payload, '', leaves);

    if (blockRequired.length > 0) {
      let blockTextLc = '';
      for (const l of leaves) { if (typeof l.value === 'string' && isTextLeaf(l.value)) blockTextLc += ' ' + l.value.toLowerCase(); }
      const allPresent = blockRequired.every(kw => blockTextLc.includes(kw));
      if (!allPresent) continue;
    }

    const matchedFields = [];
    const fieldHits = {};
    for (const leaf of leaves) {
      if (typeof leaf.value !== 'string') continue;
      if (!isTextLeaf(leaf.value)) continue;
      if (!isWordBoundedMatch(leaf.value, keywordLc)) continue;
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

  if (matched.length > 0) withMatches++;
  out.push({ json: {
    story_id: story.story_id,
    story_full_slug: story.story_full_slug,
    story_name: story.story_name,
    matches: matched,
    match_count: matched.length,
  } });
}

console.log('[Substring Bulk] processed=' + stories.length + ' droppedByLocale=' + droppedByLocale + ' droppedByArticle=' + droppedByArticle + ' withMatches=' + withMatches);
return out;` } },
  output: [{ story_id: '12345', story_full_slug: 'x', story_name: 'x', matches: [], match_count: 0 }],
});

const hasMatches = ifElse({
  version: 2.2,
  config: { name: 'Has matches?', position: [2400, -100], parameters: { conditions: { combinator: 'and', options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('={{ $json.match_count }}'), rightValue: 0, operator: { type: 'number', operation: 'gt' } }] } } },
});

const llmModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', version: 1,
  config: { name: 'OpenRouter (gpt-5.1)', position: [2640, 0], parameters: { model: 'openai/gpt-5.1', options: {} }, credentials: { openRouterApi: newCredential('OpenRouter API') } },
});

const verdictsAutofixModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatOpenRouter', version: 1,
  config: { name: 'OpenRouter (gpt-4.1, autofix)', position: [2880, 200], parameters: { model: 'openai/gpt-4.1', options: {} }, credentials: { openRouterApi: newCredential('OpenRouter API') } },
});

const verdictsParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured', version: 1.3,
  config: { name: 'Verdicts Schema', position: [2800, 0], parameters: {
    schemaType: 'fromJson',
    // Two-example variant. Initially tried 3 examples (single + multi-key +
    // empty) but LLM imitated the multi-key shape verbatim — added empty
    // strings for placeholder keys it didn't actually rewrite. Now: one
    // canonical case (single key) + one false case. Multi-field cases are
    // covered by the prompt instructions and Build Rows' defensive remap.
    jsonSchemaExample: '{"verdicts":[{"index":0,"match":true,"reason":"directly about topic","updated_fields":{"textMarkdown":"<full rewritten text>"}},{"index":1,"match":false,"reason":"unrelated mention","updated_fields":{}}]}',
    autoFix: true,
  }, subnodes: { model: verdictsAutofixModel } },
});

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

// Build success rows from LLM verdicts. Story info comes from the current
// loop iteration ($('Loop Over Stories').first().json), since the loop's
// items now carry the full Substring-Filter-bulk output (story + matches).
const buildRowsFromVerdicts = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build Rows', position: [2880, -200], alwaysOutputData: true, parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const meta = $('Init Campaign Meta').first().json;
const story = $('Loop Over Stories').first().json;
const upstream = $input.first().json || {};

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

export default workflow('wf-search-preprocess', 'Mass Actualization: Search & Pre-Process')
  .add(formTrigger)
  .to(initCampaign)
  .to(fetchProcessedRows)
  .to(aggregateProcessedStoryIds)
  .to(generatePageNumbers)
  .to(fetchStoryblokStories)
  .to(flattenStoriesToList)
  .to(filterUnprocessedStories)
  .to(sliceOrMarkComplete)
  .to(isCampaignComplete
    .onTrue(slackNotify)
    .onFalse(substringFilterBulk
      .to(loopStories
        .onEachBatch(
          hasMatches
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
        .onDone(buildSelfTriggerBody.to(selfTriggerNextBatch))
      )
    )
  )
  .add(searchWebhook)
  .to(validateWebhookInput)
  .to(checkPayload.onTrue(respondQueued.to(stripCorsField).to(initCampaign)).onFalse(respondError));
