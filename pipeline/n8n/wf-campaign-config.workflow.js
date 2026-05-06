import {
  workflow,
  node,
  trigger,
  sticky,
  newCredential,
  ifElse,
  expr,
} from '@n8n/workflow-sdk';

// =============================================================================
// WF-CampaignConfig
//
// Stores the SEARCH config (keyword, prompts, locale, folder, etc.) per
// campaign so any editor opening a campaign — not just the one who launched
// the search — can see what params produced the queue.
//
// Storage: `campaign_config` column on every row of campaign_blocks. We write
// the same JSON to all matching rows. Reads return the first non-empty value.
//
//   GET  /webhook/campaign-config?campaign_id=<id>
//        → { campaign_id, config: {...} | null }
//   POST /webhook/campaign-config
//        body: { campaign_id, config: { keyword, ... } }
//        → { campaign_id, written: <int> }
//
// Auth: same headerAuth credential as the rest of the SPA backend.
// =============================================================================

const DATA_TABLE_ID = 'wgKa7GSxjKjGrwQK';
const DATA_TABLE_NAME = 'campaign_blocks';
const ALLOWED_ORIGINS_CSV = 'https://imin14.github.io,http://localhost:8080';

const RESPONSE_HEADERS = { entries: [
  { name: 'Access-Control-Allow-Origin', value: expr('{{ $json.__cors_origin || "https://imin14.github.io" }}') },
  { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
  { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
  { name: 'Content-Type', value: 'application/json' },
] };

const CONFIG_COL_SCHEMA = { id: 'campaign_config', displayName: 'campaign_config', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true };

// ---- GET ---------------------------------------------------------------------

const getWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'GET campaign-config',
    position: [0, 0],
    parameters: {
      httpMethod: 'GET',
      path: 'campaign-config',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: { allowedOrigins: ALLOWED_ORIGINS_CSV },
    },
    credentials: { httpHeaderAuth: newCredential('Actualization UI Webhook') },
  },
  output: [{ headers: { origin: 'https://imin14.github.io' }, query: { campaign_id: 'cmp-x' } }],
});

const validateGet = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate GET',
    position: [240, 0],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const ALLOWED = ['https://imin14.github.io', 'http://localhost:8080'];
const it = $input.first().json || {};
const origin = (it.headers && (it.headers.origin || it.headers.Origin)) || '';
const corsOrigin = ALLOWED.indexOf(origin) >= 0 ? origin : 'https://imin14.github.io';
const cid = String((it.query && it.query.campaign_id) || '').trim();
if (!cid) return [{ json: { __error: 'campaign_id required', __status: 400, __cors_origin: corsOrigin } }];
return [{ json: { campaign_id: cid, __cors_origin: corsOrigin } }];`,
    },
  },
});

const getOk = ifElse({
  version: 2.2,
  config: {
    name: 'GET ok?',
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

const fetchRowsForGet = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Fetch rows (GET)',
    position: [720, -100],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'campaign_id', condition: 'eq', keyValue: expr("={{ $('Validate GET').first().json.campaign_id }}") }] },
      returnAll: true,
    },
  },
});

const shapeGet = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Shape GET response',
    position: [960, -100],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const v = $('Validate GET').first().json;
const rows = $input.all().map(i => i.json).filter(r => r && r.row_id);
let cfg = null;
for (const r of rows) {
  if (r.campaign_config && typeof r.campaign_config === 'string') {
    try { cfg = JSON.parse(r.campaign_config); break; } catch {}
  }
}
return [{ json: { __status: 200, __body: { campaign_id: v.campaign_id, config: cfg }, __cors_origin: v.__cors_origin } }];`,
    },
  },
});

const respondGet = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond GET',
    position: [1200, -100],
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify($json.__body) }}'),
      options: { responseCode: expr('={{ $json.__status }}'), responseHeaders: RESPONSE_HEADERS },
    },
  },
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
      options: { responseCode: expr('={{ $json.__status || 400 }}'), responseHeaders: RESPONSE_HEADERS },
    },
  },
});

// ---- POST --------------------------------------------------------------------

const postWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'POST campaign-config',
    position: [0, 600],
    parameters: {
      httpMethod: 'POST',
      path: 'campaign-config',
      authentication: 'headerAuth',
      responseMode: 'responseNode',
      options: { allowedOrigins: ALLOWED_ORIGINS_CSV },
    },
    credentials: { httpHeaderAuth: newCredential('Actualization UI Webhook') },
  },
  output: [{ headers: { origin: 'https://imin14.github.io' }, body: { campaign_id: 'cmp-x', config: { keyword: 'foo' } } }],
});

const validatePost = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate POST',
    position: [240, 600],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const ALLOWED = ['https://imin14.github.io', 'http://localhost:8080'];
const it = $input.first().json || {};
const origin = (it.headers && (it.headers.origin || it.headers.Origin)) || '';
const corsOrigin = ALLOWED.indexOf(origin) >= 0 ? origin : 'https://imin14.github.io';
const body = it.body || {};
const cid = String(body.campaign_id || '').trim();
if (!cid) return [{ json: { __error: 'campaign_id required', __status: 400, __cors_origin: corsOrigin } }];
const cfg = body.config && typeof body.config === 'object' ? body.config : null;
if (!cfg) return [{ json: { __error: 'config (object) required', __status: 400, __cors_origin: corsOrigin } }];
const cfgStr = JSON.stringify(cfg).slice(0, 8000);
return [{ json: { campaign_id: cid, config_str: cfgStr, __cors_origin: corsOrigin } }];`,
    },
  },
});

const postOk = ifElse({
  version: 2.2,
  config: {
    name: 'POST ok?',
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

const updateRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Write campaign_config',
    position: [720, 500],
    alwaysOutputData: true,
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME },
      matchType: 'allConditions',
      filters: { conditions: [{ keyName: 'campaign_id', condition: 'eq', keyValue: expr('={{ $json.campaign_id }}') }] },
      columns: {
        mappingMode: 'defineBelow',
        value: { campaign_config: expr('={{ $json.config_str }}') },
        matchingColumns: [],
        schema: [CONFIG_COL_SCHEMA],
      },
    },
  },
});

const buildPostOk = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build POST ok',
    position: [960, 500],
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: `const v = $('Validate POST').first().json;
const written = $input.all().length;
return [{ json: { __status: 200, __body: { campaign_id: v.campaign_id, written }, __cors_origin: v.__cors_origin } }];`,
    },
  },
});

const respondPost = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond POST',
    position: [1200, 500],
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify($json.__body) }}'),
      options: { responseCode: expr('={{ $json.__status }}'), responseHeaders: RESPONSE_HEADERS },
    },
  },
});

const respondPostError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond POST error',
    position: [720, 700],
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify({ error: $json.__error || "bad request" }) }}'),
      options: { responseCode: expr('={{ $json.__status || 400 }}'), responseHeaders: RESPONSE_HEADERS },
    },
  },
});

const archSticky = sticky(
  '## WF-CampaignConfig\n\nStores search config per campaign so any editor sees what produced the queue.\n\n- GET /webhook/campaign-config?campaign_id=<id> → { config }\n- POST /webhook/campaign-config { campaign_id, config }\n\nWrites campaign_config column on all rows for the campaign. Auth: Actualization UI Webhook header.',
  [], { color: 7, width: 480, height: 220 }
);

export default workflow('wf-campaign-config', 'Mass Actualization: Campaign Config')
  .add(getWebhook)
  .to(validateGet)
  .to(getOk
    .onTrue(fetchRowsForGet.to(shapeGet).to(respondGet))
    .onFalse(respondGetError)
  )
  .add(postWebhook)
  .to(validatePost)
  .to(postOk
    .onTrue(updateRows.to(buildPostOk).to(respondPost))
    .onFalse(respondPostError)
  )
  .add(archSticky);
