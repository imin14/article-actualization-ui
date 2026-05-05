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

const formTrigger = trigger({
  type: 'n8n-nodes-base.formTrigger',
  version: 2.5,
  config: {
    name: 'WF-Search-PreProcess Form',
    position: [0, 0],
    parameters: {
      formTitle: 'Mass Actualization: Search & Pre-Process',
      formDescription:
        'Phase 1 + 1.5 — finds Storyblok blocks affected by a topic and pre-computes LLM rewrite proposals into the campaign_blocks Data Table. This is READ-ONLY against Storyblok. SAFETY_DRY_RUN is on by default.',
      formFields: {
        values: [
          { fieldLabel: 'campaign_topic', fieldType: 'text', placeholder: 'e.g. Portugal Golden Visa: 5 to 10 years for citizenship', requiredField: true },
          { fieldLabel: 'campaign_id', fieldType: 'text', placeholder: 'Optional. Auto-generated as cmp-<slug>-YYYY-MM-DD if left blank.', requiredField: false },
          { fieldLabel: 'keyword', fieldType: 'text', placeholder: 'Substring to find in content (case-insensitive). e.g. 5', requiredField: true },
          { fieldLabel: 'context_description', fieldType: 'textarea', placeholder: 'Plain-language description of what makes a hit relevant.', requiredField: true },
          { fieldLabel: 'source_locale', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: [{ option: 'ru' }, { option: 'en' }] } },
          { fieldLabel: 'folder', fieldType: 'text', placeholder: 'Optional Storyblok starts_with filter. Leave empty for whole tree.', requiredField: false },
          { fieldLabel: 'content_type', fieldType: 'text', placeholder: 'Storyblok contain_component filter. Default: article', requiredField: false, defaultValue: 'article' },
          { fieldLabel: 'rewrite_prompt', fieldType: 'textarea', placeholder: 'Global rewrite instruction sent to the LLM for Phase 1.5.', requiredField: true },
          { fieldLabel: 'dry_run', fieldType: 'checkbox', requiredField: false, fieldOptions: { values: [{ option: 'yes' }] }, defaultValue: 'yes' },
        ],
      },
      options: { appendAttribution: false },
    },
  },
  output: [{
    campaign_topic: 'Portugal Golden Visa: 5 to 10 years',
    campaign_id: '',
    keyword: '5',
    context_description: '5 years of Portugal Golden Visa residence required for citizenship',
    source_locale: 'ru',
    folder: 'immigrantinvest/blog',
    content_type: 'article',
    rewrite_prompt: 'Update content where Portugal Golden Visa requires 10 years (not 5).',
    dry_run: ['yes'],
  }],
});

// SPA-driven webhook trigger (POST). Runs in parallel to formTrigger;
// both feed initCampaign which already accepts the same field set.
// CORS preflight (OPTIONS) is auto-handled by n8n when allowedOrigins is set
// on the POST trigger — adding a separate OPTIONS trigger on the same path
// causes a path-collision 500.
const searchWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Search Webhook (SPA)',
    position: [0, 200],
    parameters: {
      httpMethod: 'POST',
      path: 'search-trigger',
      responseMode: 'responseNode',
      options: {
        allowedOrigins: 'https://imin.github.io,http://localhost:8080',
      },
    },
  },
  output: [{
    body: {
      campaign_topic: 'Portugal Golden Visa: 5 → 10 years',
      campaign_id: '',
      keyword: '5',
      context_description: 'Mention of 5 years for Portugal citizenship',
      source_locale: 'ru',
      folder: 'immigrantinvest/new-blog',
      content_type: 'flatArticle',
      rewrite_prompt: 'Update content where Portugal Golden Visa requires 10 years (not 5)...',
      dry_run: true,
      t: 'dev-token-change-me',
    },
    headers: { origin: 'https://imin.github.io' },
  }],
});

// Validate auth + normalise webhook payload to the same shape initCampaign expects.
// Also computes __cors_origin (reflected origin if whitelisted) so downstream
// Respond nodes can emit a single Access-Control-Allow-Origin header.
const validateWebhookInput = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate webhook auth + payload',
    position: [240, 200],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const EXPECTED_TOKEN = 'dev-token-change-me';
const ALLOWED_ORIGINS = ['https://imin.github.io', 'http://localhost:8080'];
const DEFAULT_ORIGIN = 'https://imin.github.io';
const raw = $input.first().json || {};
const body = raw.body || raw;
const headers = raw.headers || {};
const originHeader = headers.origin || headers.Origin || '';
const corsOrigin = ALLOWED_ORIGINS.indexOf(originHeader) >= 0 ? originHeader : DEFAULT_ORIGIN;
const authHeader = headers.authorization || headers.Authorization || '';
const t = (body.t || authHeader.replace(/^Bearer\\s+/i, '') || '').trim();
if (t !== EXPECTED_TOKEN) {
  return [{ json: { __error: 'unauthorized', __status: 401, __cors_origin: corsOrigin } }];
}
const required = ['campaign_topic', 'keyword', 'context_description', 'rewrite_prompt'];
const missing = required.filter(k => !body[k] || String(body[k]).trim() === '');
if (missing.length) {
  return [{ json: { __error: 'missing fields: ' + missing.join(', '), __status: 400, __cors_origin: corsOrigin } }];
}
const sourceLocale = String(body.source_locale || 'ru').trim();
function slugify(s) { return s.toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
const today = new Date().toISOString().slice(0, 10);
let campaignId = String(body.campaign_id || '').trim();
if (!campaignId) campaignId = 'cmp-' + slugify(String(body.campaign_topic)) + '-' + today;
return [{ json: {
  campaign_topic: body.campaign_topic,
  campaign_id: campaignId,
  keyword: body.keyword,
  context_description: body.context_description,
  source_locale: sourceLocale,
  folder: body.folder || '',
  content_type: body.content_type || 'flatArticle',
  rewrite_prompt: body.rewrite_prompt,
  dry_run: body.dry_run !== false,
  __cors_origin: corsOrigin,
} }];`,
    },
  },
  output: [{
    campaign_topic: 'Portugal Golden Visa: 5 → 10 years',
    campaign_id: 'cmp-portugal-golden-visa-2026-05-04',
    keyword: '5',
    context_description: 'Mention of 5 years for Portugal citizenship',
    source_locale: 'ru',
    folder: 'immigrantinvest/new-blog',
    content_type: 'flatArticle',
    rewrite_prompt: 'Update content...',
    dry_run: true,
    __cors_origin: 'https://imin.github.io',
  }],
});

// Branch on whether validateWebhookInput emitted an error.
const checkAuth = ifElse({
  version: 2.2,
  config: {
    name: 'Auth ok?',
    position: [480, 200],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{
          leftValue: expr('{{ !$json.__error }}'),
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
      },
    },
  },
});

// Success branch: respond with { queued: true, campaign_id, started_at } + CORS,
// then continue to initCampaign so the rest of the pipeline runs in the background.
const respondQueued = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond: queued',
    position: [720, 100],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ queued: true, campaign_id: $json.campaign_id || "", started_at: new Date().toISOString() }) }}'),
      options: {
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin.github.io" }}') },
            { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
            { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      },
    },
  },
  output: [{ ok: true }],
});

// Error branch: respond with the validator's error message + status code + CORS.
const respondError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond: error',
    position: [720, 300],
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ error: $json.__error || "bad request" }) }}'),
      options: {
        responseCode: expr('{{ $json.__status || 400 }}'),
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin.github.io" }}') },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      },
    },
  },
  output: [{ ok: false }],
});

// Strip the helper field __cors_origin before handing the payload to initCampaign,
// so the existing form-trigger pipeline keeps working unchanged downstream.
const stripCorsField = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Strip __cors_origin',
    position: [960, 100],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const items = $input.all();
const validated = $('Validate webhook auth + payload').first().json;
const out = Object.assign({}, validated);
delete out.__cors_origin;
delete out.__error;
delete out.__status;
return [{ json: out }];`,
    },
  },
  output: [{
    campaign_topic: 'Portugal Golden Visa: 5 → 10 years',
    campaign_id: 'cmp-portugal-golden-visa-2026-05-04',
    keyword: '5',
    context_description: 'Mention of 5 years for Portugal citizenship',
    source_locale: 'ru',
    folder: 'immigrantinvest/new-blog',
    content_type: 'flatArticle',
    rewrite_prompt: 'Update content...',
    dry_run: true,
  }],
});

const initCampaign = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Init Campaign Meta',
    position: [240, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const SAFETY_DRY_RUN = true;
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
return [{ json: { safety_dry_run: SAFETY_DRY_RUN, dry_run_effective: dryRunEffective, campaign_id: campaignId, campaign_topic: topic, campaign_started_at: startedAt, keyword: keyword, keyword_lc: keyword.toLowerCase(), context_description: contextDescription, rewrite_prompt: rewritePrompt, source_locale: sourceLocale, folder: folder, content_type: contentType } }];`,
    },
  },
  output: [{
    safety_dry_run: true, dry_run_effective: true,
    campaign_id: 'cmp-portugal-2026-05-04',
    campaign_topic: 'Portugal Golden Visa: 5 to 10 years',
    campaign_started_at: '2026-05-04T22:00:00.000Z',
    keyword: '5', keyword_lc: '5',
    context_description: '5 years of Portugal Golden Visa residence',
    rewrite_prompt: 'Update content where Portugal Golden Visa requires 10 years.',
    source_locale: 'ru', folder: 'immigrantinvest/blog', content_type: 'article',
  }],
});

const fetchStoryblokStories = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Storyblok mAPI: List Stories',
    position: [480, 0],
    alwaysOutputData: true,
    parameters: {
      method: 'GET',
      url: 'https://mapi.storyblok.com/v1/spaces/176292/stories',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: {
        parameters: [
          { name: 'per_page', value: '1000' },
          { name: 'page', value: '1' },
          { name: 'starts_with', value: '={{ $json.folder }}' },
          { name: 'contain_component', value: '={{ $json.content_type }}' },
          // Filter by ORIGINAL language. seo.0.languages contains every translation
          // that exists for a story (including the origin), so all_in_array=ru would
          // also match EN-program articles that happen to have an RU translation.
          // We want stories where the editor's content is primary, so filter by
          // originalLanguage.
          { name: 'filter_query[seo.0.originalLanguage][in]', value: '={{ $json.source_locale }}' },
          { name: 'with_summary', value: '1' },
          { name: 'is_root', value: 'true' },
          { name: 'locale', value: '={{ $json.source_locale }}' },
        ],
      },
      options: { timeout: 60000, response: { response: { fullResponse: false, responseFormat: 'json', neverError: true } } },
    },
    credentials: { httpHeaderAuth: newCredential('Storyblok mAPI Token (read-only)') },
  },
  output: [{ stories: [{ id: 12345, name: 'Portugal Golden Visa', full_slug: 'immigrantinvest/blog/portugal-golden-visa', content: { component: 'article', body: [{ _uid: 'block-1', component: 'text_block', text: 'Portugal Golden Visa requires 5 years of residence for citizenship.' }] } }] }],
});

const flattenAndSubstringFilter = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Flatten + Substring Filter',
    position: [720, 0],
    alwaysOutputData: true,
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const meta = $("Init Campaign Meta").first().json;
const keywordLc = meta.keyword_lc;
const upstream = $input.first().json || {};
const stories = Array.isArray(upstream.stories) ? upstream.stories : [];
function walkLeaves(obj, prefix, out) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "string" || typeof obj === "number") { out.push({ path: prefix, value: String(obj) }); return; }
  if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) walkLeaves(obj[i], prefix ? \`\${prefix}.\${i}\` : String(i), out); return; }
  if (typeof obj === "object") { for (const k of Object.keys(obj)) { if (k === "_uid" || k === "_editable" || k === "component") continue; walkLeaves(obj[k], prefix ? \`\${prefix}.\${k}\` : k, out); } }
}
function walkBlocks(arr, prefix, out) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (!b || typeof b !== "object") continue;
    const path = prefix ? \`\${prefix}[\${i}]\` : \`body[\${i}]\`;
    if (b._uid && b.component) out.push({ _uid: b._uid, component: b.component, path, payload: b });
    for (const k of Object.keys(b)) { if (Array.isArray(b[k]) && b[k].length && typeof b[k][0] === "object") walkBlocks(b[k], \`\${path}.\${k}\`, out); }
  }
}
function paragraphContext(text, kwLc) {
  const paras = String(text).split(/\\n\\s*\\n/);
  const hits = [];
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].toLowerCase().includes(kwLc)) {
      const start = Math.max(0, i - 1);
      const end = Math.min(paras.length - 1, i + 1);
      hits.push({ para_index: i, context: paras.slice(start, end + 1).join("\\n\\n") });
    }
  }
  return hits;
}
const out = [];
let totalBlocks = 0;
for (const story of stories) {
  if (!story || !story.content) continue;
  const blocks = [];
  walkBlocks(story.content.body, "body", blocks);
  totalBlocks += blocks.length;
  for (const block of blocks) {
    const leaves = [];
    walkLeaves(block.payload, "", leaves);
    const matchedFields = [];
    const fieldHits = {};
    for (const leaf of leaves) {
      if (typeof leaf.value !== "string") continue;
      if (!leaf.value.toLowerCase().includes(keywordLc)) continue;
      const trimmed = leaf.value.trim();
      if (/^https?:\\/\\//i.test(trimmed)) continue;
      if (/^\\d+(?:[.,]\\d+)?$/.test(trimmed)) continue;
      matchedFields.push(leaf.path);
      fieldHits[leaf.path] = paragraphContext(leaf.value, keywordLc);
    }
    if (matchedFields.length === 0) continue;
    out.push({ json: { story_id: String(story.id || ""), story_full_slug: story.full_slug || story.slug || "", story_name: story.name || "", block_uid: block._uid, block_component: block.component, block_path: block.path, affected_fields: matchedFields, field_hits: fieldHits, original_payload: block.payload } });
  }
}
if (out.length === 0) return [{ json: { __empty: true, __debug: { stories_scanned: stories.length, blocks_scanned: totalBlocks, keyword: meta.keyword } } }];
return out;`,
    },
  },
  output: [{ story_id: '12345', story_full_slug: 'immigrantinvest/blog/portugal-golden-visa', story_name: 'Portugal Golden Visa', block_uid: 'block-1', block_component: 'text_block', block_path: 'body[0]', affected_fields: ['text'], field_hits: { text: [{ para_index: 0, context: 'Portugal Golden Visa requires 5 years.' }] }, original_payload: { _uid: 'block-1', component: 'text_block', text: 'Portugal Golden Visa requires 5 years.' } }],
});

const loopBlocks = splitInBatches({
  version: 3,
  config: { name: 'Loop Over Block Batches', position: [960, 0], parameters: { batchSize: 10, options: {} } },
});

const prepareFilterPayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Filter Batch',
    position: [1200, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const meta = $("Init Campaign Meta").first().json;
const items = $input.all().map((it) => it.json).filter(b => !b.__empty);
if (items.length === 0) return [{ json: { __empty: true, batch: [], meta } }];
const batch = items.map((b, idx) => ({ index: idx, block_uid: b.block_uid, block_component: b.block_component, affected_fields: b.affected_fields, hit_paragraphs: b.field_hits }));
return [{ json: { keyword: meta.keyword, context_description: meta.context_description, batch_count: batch.length, batch: batch, __originals: items } }];`,
    },
  },
  output: [{ keyword: '5', context_description: '5 years', batch_count: 1, batch: [{ index: 0, block_uid: 'block-1' }], __originals: [] }],
});

const filterModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
  version: 1.1,
  config: {
    name: 'Gemini Flash (Filter)',
    position: [1200, 200],
    parameters: { modelName: 'models/gemini-2.5-flash', options: { temperature: 0.1, maxOutputTokens: 2048 } },
    credentials: { googlePalmApi: newCredential('Google Gemini API') },
  },
});

const rewriteModel = languageModel({
  type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
  version: 1.1,
  config: {
    name: 'Gemini Flash (Rewrite)',
    position: [1680, 200],
    parameters: { modelName: 'models/gemini-2.5-flash', options: { temperature: 0.2, maxOutputTokens: 4096 } },
    credentials: { googlePalmApi: newCredential('Google Gemini API') },
  },
});

const filterParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Filter Verdict Schema',
    position: [1360, 200],
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: '{"verdicts":[{"index":0,"match":true,"reason":"directly relevant"}]}',
    },
  },
});

const rewriteParser = outputParser({
  type: '@n8n/n8n-nodes-langchain.outputParserStructured',
  version: 1.3,
  config: {
    name: 'Rewrite Proposal Schema',
    position: [1840, 200],
    parameters: {
      schemaType: 'fromJson',
      jsonSchemaExample: '{"proposals":[{"index":0,"updated_fields":{"text":"new text"}}]}',
    },
  },
});

const filterAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'LLM Relevance Filter',
    position: [1440, -100],
    parameters: {
      promptType: 'define',
      hasOutputParser: true,
      text: `=Classify these blocks for relevance to the campaign topic.

Keyword (substring match): {{ $json.keyword }}
Topic / what the keyword should refer to:
{{ $json.context_description }}

BATCH ({{ $json.batch_count }} blocks). Each block lists affected_fields and the paragraphs where the keyword appeared (with one paragraph of context above and below):
{{ JSON.stringify($json.batch) }}

For each block return: index (same), match (true/false), reason (one short sentence). Return EXACTLY {{ $json.batch_count }} verdicts in input order.`,
      options: {
        systemMessage: `You are a strict relevance classifier for an editorial mass-update campaign.

A keyword substring search has already pre-filtered candidate blocks. Your job is to decide which keyword hits ACTUALLY refer to the campaign topic.

Rules:
- A hit is a match only if the surrounding paragraph is genuinely about the topic.
- Numbers used for unrelated quantities ("5 minutes", "5 stars") are NOT matches.
- Be strict. False positives waste editorial review time downstream.
- Always return exactly the requested number of verdicts in the requested order.`,
      },
    },
    subnodes: { model: filterModel, outputParser: filterParser },
  },
  output: [{ output: { verdicts: [{ index: 0, match: true, reason: 'directly relevant' }] } }],
});

const mergeFilterVerdicts = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Apply Filter Verdicts',
    position: [1680, -100],
    alwaysOutputData: true,
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const upstream = $input.first().json || {};
const originals = $("Prepare Filter Batch").first().json.__originals || [];
if (upstream.__empty || originals.length === 0) return [{ json: { __empty: true } }];
const parsed = upstream.output || upstream;
const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
const verdictByIndex = {};
for (const v of verdicts) verdictByIndex[v.index] = v;
const kept = [];
for (let i = 0; i < originals.length; i++) {
  const v = verdictByIndex[i];
  if (!v || v.match !== true) continue;
  kept.push({ json: { ...originals[i], llm_match_reason: String(v.reason || "").slice(0, 500) } });
}
if (kept.length === 0) return [{ json: { __empty: true, __dropped_count: originals.length } }];
return kept;`,
    },
  },
  output: [{ story_id: '12345', story_full_slug: 'x', story_name: 'x', block_uid: 'block-1', block_component: 'text_block', block_path: 'body[0]', affected_fields: ['text'], field_hits: {}, original_payload: {}, llm_match_reason: 'directly relevant' }],
});

const prepareRewritePayload = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Prepare Rewrite Batch',
    position: [1920, -100],
    alwaysOutputData: true,
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const meta = $("Init Campaign Meta").first().json;
const items = $input.all().map(i => i.json).filter(b => !b.__empty);
if (items.length === 0) return [{ json: { __empty: true, batch: [], meta } }];
const batch = items.map((b, idx) => ({ index: idx, block_uid: b.block_uid, block_component: b.block_component, affected_fields: b.affected_fields, hit_paragraphs: b.field_hits }));
return [{ json: { rewrite_prompt: meta.rewrite_prompt, keyword: meta.keyword, batch_count: batch.length, batch: batch, __originals: items } }];`,
    },
  },
  output: [{ rewrite_prompt: 'Update...', keyword: '5', batch_count: 1, batch: [{ index: 0 }], __originals: [] }],
});

const rewriteAgent = node({
  type: '@n8n/n8n-nodes-langchain.agent',
  version: 3.1,
  config: {
    name: 'LLM Rewrite Proposal',
    position: [2160, -100],
    parameters: {
      promptType: 'define',
      hasOutputParser: true,
      text: `=GLOBAL REWRITE INSTRUCTION:
{{ $json.rewrite_prompt }}

KEYWORD that triggered the match: {{ $json.keyword }}

BATCH ({{ $json.batch_count }} blocks). Each has affected_fields and hit_paragraphs:
{{ JSON.stringify($json.batch) }}

For each block return: index (same), updated_fields (object — keys are affected_fields, values are the proposed REWRITTEN value of that field). Return EXACTLY {{ $json.batch_count }} proposals in input order.`,
      options: {
        systemMessage: `You are an expert editorial copywriter producing draft rewrite proposals for a content actualisation campaign.

Rules:
- Rewrite ONLY the affected paragraph(s). Preserve the rest of each field as-is.
- Preserve markdown, HTML tags, footnote references like [6], proper nouns, links.
- Apply the global rewrite instruction faithfully — do not introduce new factual claims it does not authorise.
- If the keyword appears multiple times in the same field, rewrite each occurrence.
- Always return exactly the requested number of proposals in the requested order.`,
      },
    },
    subnodes: { model: rewriteModel, outputParser: rewriteParser },
  },
  output: [{ output: { proposals: [{ index: 0, updated_fields: { text: 'new text' } }] } }],
});

const buildRows = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build campaign_blocks Rows',
    position: [2400, -100],
    alwaysOutputData: true,
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const meta = $("Init Campaign Meta").first().json;
const upstream = $input.first().json || {};
const prep = $("Prepare Rewrite Batch").first().json;
const originals = (prep && prep.__originals) || [];
if (upstream.__empty || originals.length === 0) return [{ json: { __empty: true } }];
const parsed = upstream.output || upstream;
const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];
const proposalByIndex = {};
for (const p of proposals) proposalByIndex[p.index] = p;
function setByPath(obj, segs, val) {
  if (segs.length === 0) return;
  const seg = segs[0];
  if (segs.length === 1) { if (Array.isArray(obj)) obj[Number(seg)] = val; else obj[seg] = val; return; }
  const next = Array.isArray(obj) ? obj[Number(seg)] : obj[seg];
  if (next && typeof next === "object") setByPath(next, segs.slice(1), val);
}
function patchPayload(payload, updatedFields) {
  const out = JSON.parse(JSON.stringify(payload));
  for (const fieldPath of Object.keys(updatedFields)) {
    const newVal = updatedFields[fieldPath];
    if (typeof newVal !== "string") continue;
    setByPath(out, fieldPath.split("."), newVal);
  }
  return out;
}
const out = [];
for (let i = 0; i < originals.length; i++) {
  const orig = originals[i];
  const prop = proposalByIndex[i];
  if (!prop || !prop.updated_fields) continue;
  const proposedPayload = patchPayload(orig.original_payload, prop.updated_fields);
  const rowId = \`\${meta.campaign_id}__\${orig.story_id}__\${orig.block_uid}\`;
  out.push({ json: { row_id: rowId, campaign_id: meta.campaign_id, campaign_topic: meta.campaign_topic, campaign_started_at: meta.campaign_started_at, source_locale: meta.source_locale, story_id: orig.story_id, story_full_slug: orig.story_full_slug, story_name: orig.story_name, block_uid: orig.block_uid, block_path: orig.block_path, block_component: orig.block_component, affected_fields: JSON.stringify(orig.affected_fields), original_payload: JSON.stringify(orig.original_payload), llm_match_reason: orig.llm_match_reason || "", proposed_payload: JSON.stringify(proposedPayload), status: "proposed", updated_at: new Date().toISOString() } });
}
if (out.length === 0) return [{ json: { __empty: true } }];
return out;`,
    },
  },
  output: [{
    row_id: 'cmp__12345__block-1',
    campaign_id: 'cmp',
    campaign_topic: 'Portugal Golden Visa: 5 to 10 years',
    campaign_started_at: '2026-05-04T22:00:00.000Z',
    source_locale: 'ru',
    story_id: '12345',
    story_full_slug: 'immigrantinvest/blog/portugal-golden-visa',
    story_name: 'Portugal Golden Visa',
    block_uid: 'block-1',
    block_path: 'body[0]',
    block_component: 'text_block',
    affected_fields: '["text"]',
    original_payload: '{}',
    llm_match_reason: 'directly relevant',
    proposed_payload: '{}',
    status: 'proposed',
    updated_at: '2026-05-04T22:00:00.000Z',
  }],
});

const insertRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Insert into campaign_blocks',
    position: [2640, -100],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'id', value: 'wgKa7GSxjKjGrwQK', cachedResultName: 'campaign_blocks' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
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
        },
        matchingColumns: [],
        schema: [
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
        ],
      },
      options: { optimizeBulk: true },
    },
  },
  output: [{ id: 1, createdAt: '2026-05-04T22:00:00.000Z' }],
});

const slackNotify = node({
  type: 'n8n-nodes-base.slack',
  version: 2.4,
  config: {
    name: 'Slack: Campaign Ready for Review',
    position: [1200, 600],
    executeOnce: true,
    parameters: {
      resource: 'message',
      operation: 'post',
      select: 'channel',
      channelId: { __rl: true, mode: 'list', value: 'C09KC8MGE4A', cachedResultName: 'translation-reports' },
      messageType: 'text',
      text: `={{ $('Init Campaign Meta').item.json.dry_run_effective ? '[DRY-RUN] ' : '[LIVE] ' }}*Mass Actualization — Campaign Ready for Review*
*Topic:* {{ $('Init Campaign Meta').item.json.campaign_topic }}
*Campaign ID:* \`{{ $('Init Campaign Meta').item.json.campaign_id }}\`
*Source locale:* \`{{ $('Init Campaign Meta').item.json.source_locale }}\`
*Keyword:* \`{{ $('Init Campaign Meta').item.json.keyword }}\`
*Mode:* {{ $('Init Campaign Meta').item.json.dry_run_effective ? 'DRY-RUN (no Storyblok writes — review only)' : 'LIVE (UI accept will publish)' }}

Open the review UI: https://imin.github.io/article-actualization-ui/?campaign_id={{ $('Init Campaign Meta').item.json.campaign_id }}`,
      otherOptions: { includeLinkToWorkflow: false },
    },
    credentials: { slackApi: newCredential('Slack Bot') },
  },
  output: [{ ok: true }],
});

const stickyOverview = sticky(
  '## WF-Search-PreProcess  (Phase 1 + 1.5)\n\nForm-triggered pipeline that finds Storyblok blocks affected by a campaign topic and pre-computes LLM rewrite proposals.\n\nOutput: rows in the campaign_blocks Data Table (id wgKa7GSxjKjGrwQK) with status proposed, ready for editor review via the WF-UIBackend (id ORKhXHUFSANVF51w).\n\nThis workflow never writes to Storyblok. It only reads via mAPI and writes to the internal Data Table.',
  [],
  { color: 7, width: 480, height: 240 },
);

const stickySafety = sticky(
  '## SAFETY_DRY_RUN = true  (default)\n\nThe constant lives at the top of the Init Campaign Meta Code node.\n\nIn this workflow nothing is destructive (read-only mAPI + Data Table inserts), so the flag only:\n- forces the Slack notification into DRY-RUN tone\n- documents intent for symmetry with WF-UIBackend',
  [],
  { color: 3, width: 360, height: 280 },
);

const stickyPipeline = sticky(
  '## Pipeline\n\n1. Form trigger or SPA webhook - campaign meta + search params\n2. Init Campaign Meta - normalise input, generate campaign_id, set safety flag\n3. Storyblok mAPI: List Stories - single call (per_page=1000) with starts_with + contain_component + locale filter\n4. Flatten + Substring Filter - walk content tree, JS-only keyword match, attach hit-paragraphs\n5. Loop Over Block Batches (10 at a time): prepare batch, LLM filter, drop non-matches, prepare rewrite batch, LLM rewrite, build rows, Data Table insert, next batch\n6. Slack: Campaign Ready for Review - once, after the loop completes',
  [],
  { color: 4, width: 480, height: 280 },
);

const stickyWebhookEntrypoint = sticky(
  '## SPA webhook entrypoint\n\nPOST /webhook/search-trigger - JSON body with form-trigger fields plus a shared token t.\n\nValidate node returns 401 (bad token) or 400 (missing required field) before hitting the rest of the pipeline. Success path responds immediately with { queued: true, campaign_id, started_at } then continues to Init Campaign Meta in the background.\n\nCORS: imin.github.io and localhost:8080 whitelisted at the n8n trigger level (allowedOrigins). n8n auto-handles OPTIONS preflight on the POST trigger when allowedOrigins is set - NO separate OPTIONS trigger (would cause path-collision 500).\n\nForm trigger remains untouched.',
  [],
  { color: 5, width: 480, height: 320 },
);

export default workflow('wf-search-preprocess', 'Mass Actualization: Search & Pre-Process')
  // Branch 1: original form-triggered pipeline.
  .add(formTrigger)
  .to(initCampaign)
  .to(fetchStoryblokStories)
  .to(flattenAndSubstringFilter)
  .to(
    loopBlocks
      .onEachBatch(
        prepareFilterPayload
          .to(filterAgent)
          .to(mergeFilterVerdicts)
          .to(prepareRewritePayload)
          .to(rewriteAgent)
          .to(buildRows)
          .to(insertRows)
          .to(nextBatch(loopBlocks)),
      )
      .onDone(slackNotify),
  )
  // Branch 2: SPA webhook → validate → checkAuth → respondQueued → initCampaign.
  .add(searchWebhook)
  .to(validateWebhookInput)
  .to(
    checkAuth
      .onTrue(respondQueued.to(stripCorsField).to(initCampaign))
      .onFalse(respondError),
  )
  .add(stickyOverview)
  .add(stickySafety)
  .add(stickyPipeline)
  .add(stickyWebhookEntrypoint);
