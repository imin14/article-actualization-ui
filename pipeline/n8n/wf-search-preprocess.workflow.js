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

const initCampaign = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Init Campaign Meta',
    position: [240, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        'const SAFETY_DRY_RUN = true;\n' +
        'const item = $input.first().json;\n' +
        'const topic = String(item.campaign_topic || "").trim();\n' +
        'if (!topic) throw new Error("campaign_topic is required");\n' +
        'const keyword = String(item.keyword || "").trim();\n' +
        'if (!keyword) throw new Error("keyword is required");\n' +
        'const contextDescription = String(item.context_description || "").trim();\n' +
        'const rewritePrompt = String(item.rewrite_prompt || "").trim();\n' +
        'if (!contextDescription) throw new Error("context_description is required");\n' +
        'if (!rewritePrompt) throw new Error("rewrite_prompt is required");\n' +
        'const sourceLocale = String(item.source_locale || "ru").trim();\n' +
        'const folder = String(item.folder || "").trim();\n' +
        'const contentType = String(item.content_type || "article").trim();\n' +
        'const userChoseDryRun = Array.isArray(item.dry_run) ? item.dry_run.length > 0 : Boolean(item.dry_run);\n' +
        'const dryRunEffective = SAFETY_DRY_RUN || userChoseDryRun;\n' +
        'function slugify(s) { return s.toLowerCase().normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }\n' +
        'const today = new Date().toISOString().slice(0, 10);\n' +
        'let campaignId = String(item.campaign_id || "").trim();\n' +
        'if (!campaignId) campaignId = `cmp-${slugify(topic)}-${today}`;\n' +
        'const startedAt = new Date().toISOString();\n' +
        'return [{ json: { safety_dry_run: SAFETY_DRY_RUN, dry_run_effective: dryRunEffective, campaign_id: campaignId, campaign_topic: topic, campaign_started_at: startedAt, keyword: keyword, keyword_lc: keyword.toLowerCase(), context_description: contextDescription, rewrite_prompt: rewritePrompt, source_locale: sourceLocale, folder: folder, content_type: contentType } }];\n',
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
          { name: 'filter_query[seo.0.languages][all_in_array]', value: '={{ $json.source_locale }}' },
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
      jsCode:
        'const meta = $("Init Campaign Meta").first().json;\n' +
        'const keywordLc = meta.keyword_lc;\n' +
        'const upstream = $input.first().json || {};\n' +
        'const stories = Array.isArray(upstream.stories) ? upstream.stories : [];\n' +
        'function walkLeaves(obj, prefix, out) {\n' +
        '  if (obj === null || obj === undefined) return;\n' +
        '  if (typeof obj === "string" || typeof obj === "number") { out.push({ path: prefix, value: String(obj) }); return; }\n' +
        '  if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) walkLeaves(obj[i], prefix ? `${prefix}.${i}` : String(i), out); return; }\n' +
        '  if (typeof obj === "object") { for (const k of Object.keys(obj)) { if (k === "_uid" || k === "_editable" || k === "component") continue; walkLeaves(obj[k], prefix ? `${prefix}.${k}` : k, out); } }\n' +
        '}\n' +
        'function walkBlocks(arr, prefix, out) {\n' +
        '  if (!Array.isArray(arr)) return;\n' +
        '  for (let i = 0; i < arr.length; i++) {\n' +
        '    const b = arr[i];\n' +
        '    if (!b || typeof b !== "object") continue;\n' +
        '    const path = prefix ? `${prefix}[${i}]` : `body[${i}]`;\n' +
        '    if (b._uid && b.component) out.push({ _uid: b._uid, component: b.component, path, payload: b });\n' +
        '    for (const k of Object.keys(b)) { if (Array.isArray(b[k]) && b[k].length && typeof b[k][0] === "object") walkBlocks(b[k], `${path}.${k}`, out); }\n' +
        '  }\n' +
        '}\n' +
        'function paragraphContext(text, kwLc) {\n' +
        '  const paras = String(text).split(/\\n\\s*\\n/);\n' +
        '  const hits = [];\n' +
        '  for (let i = 0; i < paras.length; i++) {\n' +
        '    if (paras[i].toLowerCase().includes(kwLc)) {\n' +
        '      const start = Math.max(0, i - 1);\n' +
        '      const end = Math.min(paras.length - 1, i + 1);\n' +
        '      hits.push({ para_index: i, context: paras.slice(start, end + 1).join("\\n\\n") });\n' +
        '    }\n' +
        '  }\n' +
        '  return hits;\n' +
        '}\n' +
        'const out = [];\n' +
        'let totalBlocks = 0;\n' +
        'for (const story of stories) {\n' +
        '  if (!story || !story.content) continue;\n' +
        '  const blocks = [];\n' +
        '  walkBlocks(story.content.body, "body", blocks);\n' +
        '  totalBlocks += blocks.length;\n' +
        '  for (const block of blocks) {\n' +
        '    const leaves = [];\n' +
        '    walkLeaves(block.payload, "", leaves);\n' +
        '    const matchedFields = [];\n' +
        '    const fieldHits = {};\n' +
        '    for (const leaf of leaves) {\n' +
        '      if (typeof leaf.value !== "string") continue;\n' +
        '      if (!leaf.value.toLowerCase().includes(keywordLc)) continue;\n' +
        '      const trimmed = leaf.value.trim();\n' +
        '      if (/^https?:\\/\\//i.test(trimmed)) continue;\n' +
        '      if (/^\\d+(?:[.,]\\d+)?$/.test(trimmed)) continue;\n' +
        '      matchedFields.push(leaf.path);\n' +
        '      fieldHits[leaf.path] = paragraphContext(leaf.value, keywordLc);\n' +
        '    }\n' +
        '    if (matchedFields.length === 0) continue;\n' +
        '    out.push({ json: { story_id: String(story.id || ""), story_full_slug: story.full_slug || story.slug || "", story_name: story.name || "", block_uid: block._uid, block_component: block.component, block_path: block.path, affected_fields: matchedFields, field_hits: fieldHits, original_payload: block.payload } });\n' +
        '  }\n' +
        '}\n' +
        'if (out.length === 0) return [{ json: { __empty: true, __debug: { stories_scanned: stories.length, blocks_scanned: totalBlocks, keyword: meta.keyword } } }];\n' +
        'return out;\n',
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
      jsCode:
        'const meta = $("Init Campaign Meta").first().json;\n' +
        'const items = $input.all().map((it) => it.json).filter(b => !b.__empty);\n' +
        'if (items.length === 0) return [{ json: { __empty: true, batch: [], meta } }];\n' +
        'const batch = items.map((b, idx) => ({ index: idx, block_uid: b.block_uid, block_component: b.block_component, affected_fields: b.affected_fields, hit_paragraphs: b.field_hits }));\n' +
        'return [{ json: { keyword: meta.keyword, context_description: meta.context_description, batch_count: batch.length, batch: batch, __originals: items } }];\n',
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
      text:
        '=Classify these blocks for relevance to the campaign topic.\n\n' +
        'Keyword (substring match): {{ $json.keyword }}\n' +
        'Topic / what the keyword should refer to:\n' +
        '{{ $json.context_description }}\n\n' +
        'BATCH ({{ $json.batch_count }} blocks). Each block lists affected_fields and the paragraphs where the keyword appeared (with one paragraph of context above and below):\n' +
        '{{ JSON.stringify($json.batch) }}\n\n' +
        'For each block return: index (same), match (true/false), reason (one short sentence). ' +
        'Return EXACTLY {{ $json.batch_count }} verdicts in input order.',
      options: {
        systemMessage:
          'You are a strict relevance classifier for an editorial mass-update campaign.\n\n' +
          'A keyword substring search has already pre-filtered candidate blocks. Your job is to decide which keyword hits ACTUALLY refer to the campaign topic.\n\n' +
          'Rules:\n' +
          '- A hit is a match only if the surrounding paragraph is genuinely about the topic.\n' +
          '- Numbers used for unrelated quantities ("5 minutes", "5 stars") are NOT matches.\n' +
          '- Be strict. False positives waste editorial review time downstream.\n' +
          '- Always return exactly the requested number of verdicts in the requested order.',
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
      jsCode:
        'const upstream = $input.first().json || {};\n' +
        'const originals = $("Prepare Filter Batch").first().json.__originals || [];\n' +
        'if (upstream.__empty || originals.length === 0) return [{ json: { __empty: true } }];\n' +
        'const parsed = upstream.output || upstream;\n' +
        'const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];\n' +
        'const verdictByIndex = {};\n' +
        'for (const v of verdicts) verdictByIndex[v.index] = v;\n' +
        'const kept = [];\n' +
        'for (let i = 0; i < originals.length; i++) {\n' +
        '  const v = verdictByIndex[i];\n' +
        '  if (!v || v.match !== true) continue;\n' +
        '  kept.push({ json: { ...originals[i], llm_match_reason: String(v.reason || "").slice(0, 500) } });\n' +
        '}\n' +
        'if (kept.length === 0) return [{ json: { __empty: true, __dropped_count: originals.length } }];\n' +
        'return kept;\n',
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
      jsCode:
        'const meta = $("Init Campaign Meta").first().json;\n' +
        'const items = $input.all().map(i => i.json).filter(b => !b.__empty);\n' +
        'if (items.length === 0) return [{ json: { __empty: true, batch: [], meta } }];\n' +
        'const batch = items.map((b, idx) => ({ index: idx, block_uid: b.block_uid, block_component: b.block_component, affected_fields: b.affected_fields, hit_paragraphs: b.field_hits }));\n' +
        'return [{ json: { rewrite_prompt: meta.rewrite_prompt, keyword: meta.keyword, batch_count: batch.length, batch: batch, __originals: items } }];\n',
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
      text:
        '=GLOBAL REWRITE INSTRUCTION:\n' +
        '{{ $json.rewrite_prompt }}\n\n' +
        'KEYWORD that triggered the match: {{ $json.keyword }}\n\n' +
        'BATCH ({{ $json.batch_count }} blocks). Each has affected_fields and hit_paragraphs:\n' +
        '{{ JSON.stringify($json.batch) }}\n\n' +
        'For each block return: index (same), updated_fields (object — keys are affected_fields, values are the proposed REWRITTEN value of that field). ' +
        'Return EXACTLY {{ $json.batch_count }} proposals in input order.',
      options: {
        systemMessage:
          'You are an expert editorial copywriter producing draft rewrite proposals for a content actualisation campaign.\n\n' +
          'Rules:\n' +
          '- Rewrite ONLY the affected paragraph(s). Preserve the rest of each field as-is.\n' +
          '- Preserve markdown, HTML tags, footnote references like [6], proper nouns, links.\n' +
          '- Apply the global rewrite instruction faithfully — do not introduce new factual claims it does not authorise.\n' +
          '- If the keyword appears multiple times in the same field, rewrite each occurrence.\n' +
          '- Always return exactly the requested number of proposals in the requested order.',
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
      jsCode:
        'const meta = $("Init Campaign Meta").first().json;\n' +
        'const upstream = $input.first().json || {};\n' +
        'const prep = $("Prepare Rewrite Batch").first().json;\n' +
        'const originals = (prep && prep.__originals) || [];\n' +
        'if (upstream.__empty || originals.length === 0) return [{ json: { __empty: true } }];\n' +
        'const parsed = upstream.output || upstream;\n' +
        'const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];\n' +
        'const proposalByIndex = {};\n' +
        'for (const p of proposals) proposalByIndex[p.index] = p;\n' +
        'function setByPath(obj, segs, val) {\n' +
        '  if (segs.length === 0) return;\n' +
        '  const seg = segs[0];\n' +
        '  if (segs.length === 1) { if (Array.isArray(obj)) obj[Number(seg)] = val; else obj[seg] = val; return; }\n' +
        '  const next = Array.isArray(obj) ? obj[Number(seg)] : obj[seg];\n' +
        '  if (next && typeof next === "object") setByPath(next, segs.slice(1), val);\n' +
        '}\n' +
        'function patchPayload(payload, updatedFields) {\n' +
        '  const out = JSON.parse(JSON.stringify(payload));\n' +
        '  for (const fieldPath of Object.keys(updatedFields)) {\n' +
        '    const newVal = updatedFields[fieldPath];\n' +
        '    if (typeof newVal !== "string") continue;\n' +
        '    setByPath(out, fieldPath.split("."), newVal);\n' +
        '  }\n' +
        '  return out;\n' +
        '}\n' +
        'const out = [];\n' +
        'for (let i = 0; i < originals.length; i++) {\n' +
        '  const orig = originals[i];\n' +
        '  const prop = proposalByIndex[i];\n' +
        '  if (!prop || !prop.updated_fields) continue;\n' +
        '  const proposedPayload = patchPayload(orig.original_payload, prop.updated_fields);\n' +
        '  const rowId = `${meta.campaign_id}__${orig.story_id}__${orig.block_uid}`;\n' +
        '  out.push({ json: { row_id: rowId, campaign_id: meta.campaign_id, campaign_topic: meta.campaign_topic, campaign_started_at: meta.campaign_started_at, source_locale: meta.source_locale, story_id: orig.story_id, story_full_slug: orig.story_full_slug, story_name: orig.story_name, block_uid: orig.block_uid, block_path: orig.block_path, block_component: orig.block_component, affected_fields: JSON.stringify(orig.affected_fields), original_payload: JSON.stringify(orig.original_payload), llm_match_reason: orig.llm_match_reason || "", proposed_payload: JSON.stringify(proposedPayload), status: "proposed", updated_at: new Date().toISOString() } });\n' +
        '}\n' +
        'if (out.length === 0) return [{ json: { __empty: true } }];\n' +
        'return out;\n',
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
      text:
        '={{ $(\'Init Campaign Meta\').item.json.dry_run_effective ? \'[DRY-RUN] \' : \'[LIVE] \' }}*Mass Actualization — Campaign Ready for Review*\n' +
        '*Topic:* {{ $(\'Init Campaign Meta\').item.json.campaign_topic }}\n' +
        '*Campaign ID:* `{{ $(\'Init Campaign Meta\').item.json.campaign_id }}`\n' +
        '*Source locale:* `{{ $(\'Init Campaign Meta\').item.json.source_locale }}`\n' +
        '*Keyword:* `{{ $(\'Init Campaign Meta\').item.json.keyword }}`\n' +
        '*Mode:* {{ $(\'Init Campaign Meta\').item.json.dry_run_effective ? \'DRY-RUN (no Storyblok writes — review only)\' : \'LIVE (UI accept will publish)\' }}\n\n' +
        'Open the review UI: https://imin.github.io/article-actualization-ui/?campaign_id={{ $(\'Init Campaign Meta\').item.json.campaign_id }}',
      otherOptions: { includeLinkToWorkflow: false },
    },
    credentials: { slackApi: newCredential('Slack Bot') },
  },
  output: [{ ok: true }],
});

const stickyOverview = sticky(
  '## WF-Search-PreProcess  (Phase 1 + 1.5)\n\nForm-triggered pipeline that finds Storyblok blocks affected by a campaign topic and pre-computes LLM rewrite proposals.\n\nOutput: rows in the `campaign_blocks` Data Table (id `wgKa7GSxjKjGrwQK`) with `status="proposed"`, ready for editor review via the WF-UIBackend (id `ORKhXHUFSANVF51w`).\n\n**This workflow never writes to Storyblok.** It only reads via mAPI and writes to the internal Data Table.',
  [],
  { color: 7, width: 480, height: 240 },
);

const stickySafety = sticky(
  '## SAFETY_DRY_RUN = true  (default)\n\nThe constant lives at the top of the **Init Campaign Meta** Code node.\n\nIn this workflow nothing is destructive (read-only mAPI + Data Table inserts), so the flag only:\n- forces the Slack notification into DRY-RUN tone\n- documents intent for symmetry with WF-UIBackend\n\n**Workflow is created INACTIVE.** Activate manually after the Storyblok mAPI token + Gemini + Slack credentials are filled in.',
  [],
  { color: 3, width: 360, height: 280 },
);

const stickyTokenEconomy = sticky(
  '## Token Economy (per ~1000 stories ≈ 50K blocks)\n\n**Step 1: Substring filter (JS, no LLM)** — $0\nRemoves ~80% of candidates before any LLM is involved.\n\n**Step 2: LLM filter (Gemini Flash)** — ~$0.60\n~10K hits / 10 per batch = 1K calls × ~200 tokens input × $0.30/M = ~2M tokens × $0.30 = ~$0.60.\n\n**Step 3: LLM rewrite (Gemini Flash)** — ~$0.60\n~5K matches / 10 per batch = 500 calls × ~400 tokens input × $0.30/M = ~2M tokens × $0.30 = ~$0.60.\n\n**Total: ~$1.20–$1.50 per 1000 stories scanned.**\n\nWithout the substring pre-filter: 50K × 200 tokens × $0.30/M = ~$3 just for the filter step. Substring saves ~80%.\n\nOptimisations baked in:\n1. Substring match is JS, not LLM.\n2. Filter prompt sees only hit-paragraphs (paragraph + 1 above/below), not full blocks.\n3. Rewrite prompt sees only hit-paragraphs of affected fields.\n4. Both agents process 10 blocks per call (batched).\n5. Structured output parsers eliminate boilerplate tokens.',
  [],
  { color: 5, width: 480, height: 420 },
);

const stickyPipeline = sticky(
  '## Pipeline\n\n1. **Form trigger** — campaign meta + search params\n2. **Init Campaign Meta** — normalise input, generate campaign_id, set safety flag\n3. **Storyblok mAPI: List Stories** — single call (per_page=1000) with starts_with + contain_component + locale filter\n4. **Flatten + Substring Filter** — walk content tree, JS-only keyword match, attach hit-paragraphs\n5. **Loop Over Block Batches** (10 at a time): prepare batch → LLM filter → drop non-matches → prepare rewrite batch → LLM rewrite → build rows → Data Table insert → next batch\n6. **Slack: Campaign Ready for Review** — once, after the loop completes',
  [],
  { color: 4, width: 480, height: 280 },
);

const stickyCredentials = sticky(
  '## Credentials to fill in\n\n- **Storyblok mAPI Token (read-only)** — Header Auth credential. Header name `Authorization`, value is the flat read-only token (Storyblok mAPI does NOT use Bearer prefix).\n- **Google Gemini API** — used by both filter and rewrite agents.\n- **Slack Bot** — same workspace as the Turkey workflow, channel `translation-reports` (id `C09KC8MGE4A`).\n\nThe workflow is INACTIVE by default. Add credentials, then click Activate when ready.',
  [],
  { color: 6, width: 380, height: 280 },
);

export default workflow('wf-search-preprocess', 'Mass Actualization: Search & Pre-Process')
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
  .add(stickyOverview)
  .add(stickySafety)
  .add(stickyTokenEconomy)
  .add(stickyPipeline)
  .add(stickyCredentials);
