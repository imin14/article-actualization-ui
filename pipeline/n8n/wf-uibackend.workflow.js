import {
  workflow,
  node,
  trigger,
  sticky,
  newCredential,
  switchCase,
  ifElse,
  expr,
} from '@n8n/workflow-sdk';

// =============================================================================
// WF-UIBackend  —  Mass Actualization: UI Backend
//
// Two webhooks consumed by the SPA at imin.github.io/article-actualization-ui:
//
//   GET  /webhook/campaign-state?campaign_id=<id>
//       → { campaign, progress, blocks }
//   POST /webhook/campaign-action
//       body: { campaign_id, row_id, action, edited_payload?, skip_reason? }
//       action ∈ {accept, edit, skip, delete}
//       → { status: 'ok', new_status, row_id, dry_run }
//
// Auth: built-in n8n headerAuth on each trigger, bound to the same credential
// `Actualization UI Webhook` that wf-search-preprocess uses. Wrong/missing
// header → 401 before the workflow runs. CORS preflight is auto-handled by
// n8n when allowedOrigins is set on the GET/POST trigger — no separate
// OPTIONS triggers (they cause path-collision 500).
//
// SAFETY_DRY_RUN = true (forced). Status updates land in the Data Table
// only. No Storyblok writes until going LIVE.
// =============================================================================

const DATA_TABLE_ID = 'wgKa7GSxjKjGrwQK';
const DATA_TABLE_NAME = 'campaign_blocks';
const ALLOWED_ORIGINS_CSV = 'https://imin.github.io,http://localhost:8080';

const COLUMNS_ACCEPT = expr('={{ ' + JSON.stringify({
  mappingMode: 'defineBelow',
  value: { status: '={{ $json.new_status }}', updated_at: '={{ $json.updated_at }}' },
  matchingColumns: [],
  schema: [
    { id: 'status', displayName: 'status', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'updated_at', displayName: 'updated_at', type: 'date', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
  ],
}) + ' }}');

const COLUMNS_EDIT = expr('={{ ' + JSON.stringify({
  mappingMode: 'defineBelow',
  value: { status: '={{ $json.new_status }}', updated_at: '={{ $json.updated_at }}', edited_payload: '={{ $json.edited_payload_str }}' },
  matchingColumns: [],
  schema: [
    { id: 'status', displayName: 'status', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'updated_at', displayName: 'updated_at', type: 'date', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'edited_payload', displayName: 'edited_payload', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
  ],
}) + ' }}');

const COLUMNS_SKIP = expr('={{ ' + JSON.stringify({
  mappingMode: 'defineBelow',
  value: { status: '={{ $json.new_status }}', updated_at: '={{ $json.updated_at }}', skip_reason: '={{ $json.skip_reason_str }}' },
  matchingColumns: [],
  schema: [
    { id: 'status', displayName: 'status', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'updated_at', displayName: 'updated_at', type: 'date', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'skip_reason', displayName: 'skip_reason', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
  ],
}) + ' }}');

const COLUMNS_DELETE = expr('={{ ' + JSON.stringify({
  mappingMode: 'defineBelow',
  value: { status: '={{ $json.new_status }}', updated_at: '={{ $json.updated_at }}' },
  matchingColumns: [],
  schema: [
    { id: 'status', displayName: 'status', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'updated_at', displayName: 'updated_at', type: 'date', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
  ],
}) + ' }}');

const getStateWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'GET campaign-state',
    position: [0, 0],
    parameters: {
      httpMethod: 'GET',
      path: 'campaign-state',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: { allowedOrigins: ALLOWED_ORIGINS_CSV },
    },
    credentials: { httpHeaderAuth: newCredential('Actualization UI Webhook') },
  },
  output: [{ headers: { origin: 'https://imin.github.io' }, query: { campaign_id: 'cmp-portugal-2026-05-04' } }],
});

const validateGetParams = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate GET params',
    position: [240, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const ALLOWED_ORIGINS = ['https://imin.github.io', 'http://localhost:8080'];
const DEFAULT_ORIGIN = 'https://imin.github.io';
const item = $input.first().json || {};
const headers = item.headers || {};
const origin = headers.origin || headers.Origin || '';
const corsOrigin = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : DEFAULT_ORIGIN;
const query = item.query || {};
const campaignId = String(query.campaign_id || '').trim();
// Empty campaign_id is valid: list mode. shapeStateResponse decides output shape.
return [{ json: { campaign_id: campaignId, list_mode: !campaignId, __cors_origin: corsOrigin } }];`,
    },
  },
  output: [{ campaign_id: 'cmp-portugal-2026-05-04', __cors_origin: 'https://imin.github.io' }],
});

const checkGetParams = ifElse({
  version: 2.2,
  config: {
    name: 'GET params ok?',
    position: [480, 0],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ !$json.__error }}'), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      },
    },
  },
});

const fetchCampaignRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch campaign rows',
    position: [720, -100],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME },
      matchType: 'allConditions',
      // No filter — fetch all rows. shapeStateResponse filters by campaign_id
      // when one is provided, or groups into a campaigns list when not.
      filters: { conditions: [] },
      returnAll: true,
    },
  },
  output: [{ id: 1, row_id: 'r-1', campaign_id: 'cmp-portugal-2026-05-04', campaign_topic: 'Portugal GV', campaign_started_at: '2026-05-05T00:00:00Z', source_locale: 'ru', story_id: 's-1', story_full_slug: 'a/b', story_name: 'X', block_uid: 'b-1', block_path: 'body[0]', block_component: 'text', affected_fields: '["text"]', original_payload: '{}', proposed_payload: '{}', edited_payload: '', llm_match_reason: 'x', status: 'pending', skip_reason: '', storyblok_response: '', error_message: '', updated_at: '2026-05-05T00:00:00Z', cascaded_at: '' }],
});

const shapeStateResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Shape state response',
    position: [960, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const validated = $('Validate GET params').first().json;
const corsOrigin = validated.__cors_origin || 'https://imin.github.io';
const requestedCampaignId = validated.campaign_id;
const allRows = $input.all().map(i => i.json).filter(r => r && r.row_id);
const tryParse = (s) => { if (!s || typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return s; } };

// LIST MODE: no campaign_id given → return summary of every campaign in the table.
if (!requestedCampaignId) {
  const byCampaign = {};
  for (const r of allRows) {
    const cid = r.campaign_id;
    if (!cid) continue;
    if (!byCampaign[cid]) {
      byCampaign[cid] = {
        id: cid,
        topic: r.campaign_topic || '',
        source_locale: r.source_locale || 'en',
        started_at: r.campaign_started_at || null,
        total: 0,
        by_status: {},
        last_updated_at: null,
      };
    }
    const c = byCampaign[cid];
    c.total++;
    const st = r.status || 'pending';
    c.by_status[st] = (c.by_status[st] || 0) + 1;
    if (r.updated_at && (!c.last_updated_at || r.updated_at > c.last_updated_at)) c.last_updated_at = r.updated_at;
  }
  const campaigns = Object.values(byCampaign).sort((a, b) => (b.last_updated_at || '').localeCompare(a.last_updated_at || ''));
  return [{ json: { __status: 200, __body: { campaigns }, __cors_origin: corsOrigin } }];
}

// SINGLE CAMPAIGN MODE: filter to the requested campaign and return state.
const rows = allRows.filter(r => r.campaign_id === requestedCampaignId);
if (rows.length === 0) {
  return [{ json: { __status: 404, __body: { error: 'campaign not found' }, __cors_origin: corsOrigin } }];
}
const first = rows[0];
const campaign = { id: first.campaign_id, topic: first.campaign_topic || '', started_at: first.campaign_started_at || null, source_locale: first.source_locale || 'en' };
const blocks = rows.map(r => ({
  row_id: r.row_id, campaign_id: r.campaign_id, story_id: r.story_id, story_full_slug: r.story_full_slug, story_name: r.story_name,
  block_uid: r.block_uid, block_path: r.block_path, block_component: r.block_component,
  affected_fields: tryParse(r.affected_fields) || [], original_payload: tryParse(r.original_payload) || {},
  llm_match_reason: r.llm_match_reason || '', proposed_payload: tryParse(r.proposed_payload) || {},
  edited_payload: r.edited_payload ? tryParse(r.edited_payload) : null,
  status: r.status || 'pending', skip_reason: r.skip_reason ? tryParse(r.skip_reason) : null,
  storyblok_response: r.storyblok_response ? tryParse(r.storyblok_response) : null,
  error_message: r.error_message || '', updated_at: r.updated_at || null, cascaded_at: r.cascaded_at || null,
  locale: first.source_locale || 'en',
}));
const byStatus = {};
for (const b of blocks) byStatus[b.status] = (byStatus[b.status] || 0) + 1;
const reviewed = blocks.filter(b => b.status !== 'pending').length;
const progress = { total: blocks.length, reviewed, by_status: byStatus };
return [{ json: { __status: 200, __body: { campaign, progress, blocks }, __cors_origin: corsOrigin } }];`,
    },
  },
  output: [{ __status: 200, __body: { campaign: { id: 'x', topic: 'x', source_locale: 'ru' }, progress: { total: 0, reviewed: 0, by_status: {} }, blocks: [] }, __cors_origin: 'https://imin.github.io' }],
});

const respondGetState = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond GET state',
    position: [1200, -100],
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify($json.__body) }}'),
      options: {
        responseCode: expr('={{ $json.__status }}'),
        responseHeaders: { entries: [
          { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin.github.io" }}') },
          { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
          { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
          { name: 'Content-Type', value: 'application/json' },
        ]},
      },
    },
  },
  output: [{ ok: true }],
});

const respondGetError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond GET error',
    position: [720, 100],
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify({ error: $json.__error || "bad request" }) }}'),
      options: {
        responseCode: expr('={{ $json.__status || 400 }}'),
        responseHeaders: { entries: [
          { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin.github.io" }}') },
          { name: 'Content-Type', value: 'application/json' },
        ]},
      },
    },
  },
  output: [{ ok: false }],
});

const postActionWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'POST campaign-action',
    position: [0, 600],
    parameters: {
      httpMethod: 'POST',
      path: 'campaign-action',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: { allowedOrigins: ALLOWED_ORIGINS_CSV },
    },
    credentials: { httpHeaderAuth: newCredential('Actualization UI Webhook') },
  },
  output: [{ headers: { origin: 'https://imin.github.io' }, body: { campaign_id: 'cmp-x', row_id: 'r-1', action: 'accept' } }],
});

const validatePostBody = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate POST body',
    position: [240, 600],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const ALLOWED_ORIGINS = ['https://imin.github.io', 'http://localhost:8080'];
const DEFAULT_ORIGIN = 'https://imin.github.io';
const VALID_ACTIONS = ['accept', 'edit', 'skip', 'delete'];
const SAFETY_DRY_RUN = true;
const item = $input.first().json || {};
const headers = item.headers || {};
const origin = headers.origin || headers.Origin || '';
const corsOrigin = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : DEFAULT_ORIGIN;
const body = item.body || {};
const rowId = String(body.row_id || '').trim();
const action = String(body.action || '').trim();
const campaignId = String(body.campaign_id || '').trim();
if (!rowId || !action) {
  return [{ json: { __error: 'row_id and action are required', __status: 400, __cors_origin: corsOrigin } }];
}
if (VALID_ACTIONS.indexOf(action) < 0) {
  return [{ json: { __error: 'invalid action; expected accept|edit|skip|delete', __status: 400, __cors_origin: corsOrigin } }];
}
const editedPayloadStr = body.edited_payload ? JSON.stringify(body.edited_payload) : '';
const skipReasonStr = body.skip_reason ? JSON.stringify(body.skip_reason) : '';
const newStatus = action === 'accept' ? 'accepted' : action === 'edit' ? 'edited' : action === 'skip' ? 'skipped' : 'deleted';
return [{ json: { row_id: rowId, campaign_id: campaignId, action, new_status: newStatus, edited_payload_str: editedPayloadStr, skip_reason_str: skipReasonStr, updated_at: new Date().toISOString(), safety_dry_run: SAFETY_DRY_RUN, __cors_origin: corsOrigin } }];`,
    },
  },
  output: [{ row_id: 'r-1', campaign_id: 'cmp-x', action: 'accept', new_status: 'accepted', edited_payload_str: '', skip_reason_str: '', updated_at: '2026-05-05T00:00:00.000Z', safety_dry_run: true, __cors_origin: 'https://imin.github.io' }],
});

const checkPostParams = ifElse({
  version: 2.2,
  config: {
    name: 'POST params ok?',
    position: [480, 600],
    parameters: {
      conditions: {
        combinator: 'and',
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ !$json.__error }}'), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
      },
    },
  },
});

const routeByAction = switchCase({
  version: 3.4,
  config: {
    name: 'Route by action',
    position: [720, 500],
    parameters: {
      mode: 'rules',
      rules: { values: [
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('={{ $json.action }}'), rightValue: 'accept', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'accept' },
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('={{ $json.action }}'), rightValue: 'edit', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'edit' },
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('={{ $json.action }}'), rightValue: 'skip', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'skip' },
        { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ leftValue: expr('={{ $json.action }}'), rightValue: 'delete', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, renameOutput: true, outputKey: 'delete' },
      ]},
    },
  },
});

const updateAccept = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'Update row → accepted', position: [960, 300], alwaysOutputData: true, parameters: { resource: 'row', operation: 'update', dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME }, matchType: 'allConditions', filters: { conditions: [{ keyName: 'row_id', condition: 'eq', keyValue: expr('={{ $json.row_id }}') }] }, columns: COLUMNS_ACCEPT } },
});
const updateEdit = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'Update row → edited', position: [960, 460], alwaysOutputData: true, parameters: { resource: 'row', operation: 'update', dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME }, matchType: 'allConditions', filters: { conditions: [{ keyName: 'row_id', condition: 'eq', keyValue: expr('={{ $json.row_id }}') }] }, columns: COLUMNS_EDIT } },
});
const updateSkip = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'Update row → skipped', position: [960, 620], alwaysOutputData: true, parameters: { resource: 'row', operation: 'update', dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME }, matchType: 'allConditions', filters: { conditions: [{ keyName: 'row_id', condition: 'eq', keyValue: expr('={{ $json.row_id }}') }] }, columns: COLUMNS_SKIP } },
});
const updateDelete = node({
  type: 'n8n-nodes-base.dataTable', version: 1.1,
  config: { name: 'Update row → deleted', position: [960, 780], alwaysOutputData: true, parameters: { resource: 'row', operation: 'update', dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME }, matchType: 'allConditions', filters: { conditions: [{ keyName: 'row_id', condition: 'eq', keyValue: expr('={{ $json.row_id }}') }] }, columns: COLUMNS_DELETE } },
});

const buildPostOk = node({
  type: 'n8n-nodes-base.code', version: 2,
  config: { name: 'Build POST ok', position: [1200, 500], parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: `const v = $('Validate POST body').first().json;
return [{ json: { __status: 200, __body: { status: 'ok', new_status: v.new_status, row_id: v.row_id, dry_run: v.safety_dry_run !== false }, __cors_origin: v.__cors_origin || 'https://imin.github.io' } }];` } },
  output: [{ __status: 200, __body: { status: 'ok', new_status: 'accepted', row_id: 'r-1', dry_run: true }, __cors_origin: 'https://imin.github.io' }],
});

const respondPostOk = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Respond POST ok', position: [1440, 500], parameters: { respondWith: 'json', responseBody: expr('={{ JSON.stringify($json.__body) }}'), options: { responseCode: expr('={{ $json.__status }}'), responseHeaders: { entries: [
    { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin.github.io" }}') },
    { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
    { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
    { name: 'Content-Type', value: 'application/json' },
  ]} } } },
});

const respondPostError = node({
  type: 'n8n-nodes-base.respondToWebhook', version: 1.5,
  config: { name: 'Respond POST error', position: [720, 800], parameters: { respondWith: 'json', responseBody: expr('={{ JSON.stringify({ error: $json.__error || "bad request" }) }}'), options: { responseCode: expr('={{ $json.__status || 400 }}'), responseHeaders: { entries: [
    { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin.github.io" }}') },
    { name: 'Content-Type', value: 'application/json' },
  ]} } } },
});

const archSticky = sticky('## WF-UIBackend\n\nGET /webhook/campaign-state — reads campaign_blocks Data Table.\nPOST /webhook/campaign-action — updates row by row_id; switchCase routes to per-action update node.\n\nAuth: headerAuth credential `Actualization UI Webhook`. CORS: imin.github.io + localhost:8080.', [], { color: 7, width: 480, height: 240 });
const safetySticky = sticky('## SAFETY_DRY_RUN = true (forced)\n\nIn Validate POST body. Status updates only — no Storyblok writes until LIVE.', [], { color: 3, width: 360, height: 200 });

export default workflow('wf-uibackend', 'Mass Actualization: UI Backend')
  .add(getStateWebhook)
  .to(validateGetParams)
  .to(checkGetParams.onTrue(fetchCampaignRows.to(shapeStateResponse).to(respondGetState)).onFalse(respondGetError))
  .add(postActionWebhook)
  .to(validatePostBody)
  .to(checkPostParams.onTrue(routeByAction.onCase(0, updateAccept.to(buildPostOk).to(respondPostOk)).onCase(1, updateEdit.to(buildPostOk).to(respondPostOk)).onCase(2, updateSkip.to(buildPostOk).to(respondPostOk)).onCase(3, updateDelete.to(buildPostOk).to(respondPostOk))).onFalse(respondPostError))
  .add(archSticky)
  .add(safetySticky);
