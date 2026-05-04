import {
  workflow,
  node,
  trigger,
  sticky,
  switchCase,
  ifElse,
  expr,
} from '@n8n/workflow-sdk';

const DATA_TABLE_ID = 'wgKa7GSxjKjGrwQK';
const DATA_TABLE_NAME = 'campaign_blocks';
const ALLOWED_ORIGIN = 'https://imin.github.io';

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
  value: { status: '={{ $json.new_status }}', edited_payload: '={{ $json.edited_payload_str }}', updated_at: '={{ $json.updated_at }}' },
  matchingColumns: [],
  schema: [
    { id: 'status', displayName: 'status', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'edited_payload', displayName: 'edited_payload', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'updated_at', displayName: 'updated_at', type: 'date', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
  ],
}) + ' }}');

const COLUMNS_SKIP = expr('={{ ' + JSON.stringify({
  mappingMode: 'defineBelow',
  value: { status: '={{ $json.new_status }}', skip_reason: '={{ $json.skip_reason_str }}', updated_at: '={{ $json.updated_at }}' },
  matchingColumns: [],
  schema: [
    { id: 'status', displayName: 'status', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'skip_reason', displayName: 'skip_reason', type: 'string', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
    { id: 'updated_at', displayName: 'updated_at', type: 'date', removed: false, required: false, display: true, defaultMatch: false, canBeUsedToMatch: true },
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
    parameters: {
      httpMethod: 'GET',
      path: 'campaign-state',
      responseMode: 'responseNode',
      options: { allowedOrigins: ALLOWED_ORIGIN },
    },
    position: [240, 200],
  },
  output: [
    {
      headers: { host: 'localhost' },
      params: {},
      query: { campaign_id: 'cmp-portugal-2026-05-04', t: 'dev-token-change-me' },
      body: {},
      webhookUrl: 'https://example/webhook/campaign-state',
      executionMode: 'production',
    },
  ],
});

const validateGetRequest = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate GET token',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const EXPECTED_TOKEN = 'dev-token-change-me';\n" +
        "const SAFETY_DRY_RUN = true;\n" +
        "const ALLOWED_ORIGIN = 'https://imin.github.io';\n" +
        "const item = $input.first().json;\n" +
        "const query = item.query || {};\n" +
        "const token = query.t || '';\n" +
        "const campaignId = query.campaign_id || '';\n" +
        "let auth = 'ok';\n" +
        "if (!token || token !== EXPECTED_TOKEN) { auth = 'unauthorized'; }\n" +
        "else if (!campaignId) { auth = 'bad_request'; }\n" +
        "return [{ json: { auth, campaign_id: campaignId, token, safety_dry_run: SAFETY_DRY_RUN, allowed_origin: ALLOWED_ORIGIN } }];",
    },
    position: [460, 200],
  },
  output: [
    { auth: 'ok', campaign_id: 'cmp-portugal-2026-05-04', token: 'dev-token-change-me', safety_dry_run: true, allowed_origin: 'https://imin.github.io' },
  ],
});

const checkGetAuth = ifElse({
  version: 2.3,
  config: {
    name: 'Check GET auth',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          { id: 'cond-auth-ok', leftValue: expr('={{ $json.auth }}'), rightValue: 'ok', operator: { type: 'string', operation: 'equals' } },
        ],
        combinator: 'and',
      },
    },
    position: [680, 200],
  },
});

const getTableRows = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Get campaign rows',
    parameters: {
      resource: 'row',
      operation: 'get',
      dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME },
      matchType: 'allConditions',
      filters: {
        conditions: [
          { keyName: 'campaign_id', condition: 'eq', keyValue: expr('={{ $json.campaign_id }}') },
        ],
      },
      returnAll: true,
    },
    alwaysOutputData: true,
    position: [900, 100],
  },
  output: [
    {
      id: 1,
      row_id: 'row-001',
      campaign_id: 'cmp-portugal-2026-05-04',
      campaign_topic: 'Portugal Golden Visa update',
      campaign_started_at: '2026-05-04T12:00:00Z',
      source_locale: 'en',
      story_id: 'story-001',
      story_full_slug: 'guides/portugal/gv-2026',
      story_name: 'Portugal Golden Visa 2026',
      block_uid: 'block-001',
      block_path: 'body[0]',
      block_component: 'paragraph',
      affected_fields: '["text"]',
      original_payload: '{"text":"old"}',
      llm_match_reason: 'matches',
      proposed_payload: '{"text":"new"}',
      edited_payload: '',
      status: 'pending',
      skip_reason: '',
      storyblok_response: '',
      error_message: '',
      updated_at: '2026-05-04T12:05:00Z',
      cascaded_at: '',
    },
  ],
});

const shapeStateResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Shape state response',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const ALLOWED_ORIGIN = 'https://imin.github.io';\n" +
        "const rows = $input.all().map(i => i.json);\n" +
        "const realRows = rows.filter(r => r && r.row_id);\n" +
        "if (realRows.length === 0) {\n" +
        "  return [{ json: { __status: 404, __body: { error: 'campaign_id not found' }, __cors_origin: ALLOWED_ORIGIN } }];\n" +
        "}\n" +
        "const tryParse = (s) => { if (!s || typeof s !== 'string') return s; try { return JSON.parse(s); } catch (e) { return s; } };\n" +
        "const first = realRows[0];\n" +
        "const campaign = { id: first.campaign_id, topic: first.campaign_topic || '', started_at: first.campaign_started_at || null, source_locale: first.source_locale || 'en' };\n" +
        "const blocks = realRows.map(r => ({\n" +
        "  row_id: r.row_id,\n" +
        "  campaign_id: r.campaign_id,\n" +
        "  story_id: r.story_id,\n" +
        "  story_full_slug: r.story_full_slug,\n" +
        "  story_name: r.story_name,\n" +
        "  block_uid: r.block_uid,\n" +
        "  block_path: r.block_path,\n" +
        "  block_component: r.block_component,\n" +
        "  affected_fields: tryParse(r.affected_fields) || [],\n" +
        "  original_payload: tryParse(r.original_payload) || {},\n" +
        "  llm_match_reason: r.llm_match_reason || '',\n" +
        "  proposed_payload: tryParse(r.proposed_payload) || {},\n" +
        "  edited_payload: r.edited_payload ? tryParse(r.edited_payload) : null,\n" +
        "  status: r.status || 'pending',\n" +
        "  skip_reason: r.skip_reason ? tryParse(r.skip_reason) : null,\n" +
        "  storyblok_response: r.storyblok_response ? tryParse(r.storyblok_response) : null,\n" +
        "  error_message: r.error_message || '',\n" +
        "  updated_at: r.updated_at || null,\n" +
        "  cascaded_at: r.cascaded_at || null\n" +
        "}));\n" +
        "const byStatus = {};\n" +
        "for (const b of blocks) { byStatus[b.status] = (byStatus[b.status] || 0) + 1; }\n" +
        "const reviewed = blocks.filter(b => b.status !== 'pending').length;\n" +
        "const progress = { total: blocks.length, reviewed, by_status: byStatus };\n" +
        "return [{ json: { __status: 200, __body: { campaign, progress, blocks }, __cors_origin: ALLOWED_ORIGIN } }];",
    },
    position: [1120, 100],
  },
  output: [
    {
      __status: 200,
      __body: {
        campaign: { id: 'cmp-portugal-2026-05-04', topic: 'Portugal', started_at: '2026-05-04T12:00:00Z', source_locale: 'en' },
        progress: { total: 6, reviewed: 0, by_status: { pending: 6 } },
        blocks: [],
      },
      __cors_origin: 'https://imin.github.io',
    },
  ],
});

const respondGetOk = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond GET state',
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify($json.__body) }}'),
      options: {
        responseCode: expr('={{ $json.__status }}'),
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: ALLOWED_ORIGIN },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      },
    },
    position: [1340, 100],
  },
});

const buildGetError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build GET error response',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const ALLOWED_ORIGIN = 'https://imin.github.io';\n" +
        "const item = $input.first().json;\n" +
        "let status = 401;\n" +
        "let body = { error: 'unauthorized' };\n" +
        "if (item.auth === 'bad_request') { status = 400; body = { error: 'campaign_id is required' }; }\n" +
        "return [{ json: { __status: status, __body: body, __cors_origin: ALLOWED_ORIGIN } }];",
    },
    position: [900, 320],
  },
  output: [
    { __status: 401, __body: { error: 'unauthorized' }, __cors_origin: 'https://imin.github.io' },
  ],
});

const respondGetErrorWebhook = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond GET error',
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify($json.__body) }}'),
      options: {
        responseCode: expr('={{ $json.__status }}'),
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: ALLOWED_ORIGIN },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      },
    },
    position: [1120, 320],
  },
});

const postActionWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'POST campaign-action',
    parameters: {
      httpMethod: 'POST',
      path: 'campaign-action',
      responseMode: 'responseNode',
      options: { allowedOrigins: ALLOWED_ORIGIN },
    },
    position: [240, 600],
  },
  output: [
    {
      headers: { host: 'localhost', 'content-type': 'application/json' },
      params: {},
      query: {},
      body: { campaign_id: 'cmp-portugal-2026-05-04', row_id: 'row-001', action: 'accept', t: 'dev-token-change-me' },
      webhookUrl: 'https://example/webhook/campaign-action',
      executionMode: 'production',
    },
  ],
});

const validatePostBody = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate POST body',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const EXPECTED_TOKEN = 'dev-token-change-me';\n" +
        "const SAFETY_DRY_RUN = true;\n" +
        "const ALLOWED_ORIGIN = 'https://imin.github.io';\n" +
        "const VALID_ACTIONS = ['accept', 'edit', 'skip', 'delete'];\n" +
        "const item = $input.first().json;\n" +
        "const body = item.body || {};\n" +
        "const token = body.t || '';\n" +
        "const rowId = body.row_id || '';\n" +
        "const action = body.action || '';\n" +
        "const campaignId = body.campaign_id || '';\n" +
        "let validation = 'ok';\n" +
        "if (!token || token !== EXPECTED_TOKEN) { validation = 'unauthorized'; }\n" +
        "else if (!rowId || !action) { validation = 'bad_request'; }\n" +
        "else if (!VALID_ACTIONS.includes(action)) { validation = 'invalid_action'; }\n" +
        "const editedPayloadStr = body.edited_payload ? JSON.stringify(body.edited_payload) : '';\n" +
        "const skipReasonStr = body.skip_reason ? JSON.stringify(body.skip_reason) : '';\n" +
        "let newStatus = 'pending';\n" +
        "if (action === 'accept') newStatus = 'accepted';\n" +
        "else if (action === 'edit') newStatus = 'edited';\n" +
        "else if (action === 'skip') newStatus = 'skipped';\n" +
        "else if (action === 'delete') newStatus = 'deleted';\n" +
        "return [{ json: { validation, row_id: rowId, campaign_id: campaignId, action, new_status: newStatus, edited_payload_str: editedPayloadStr, skip_reason_str: skipReasonStr, safety_dry_run: SAFETY_DRY_RUN, allowed_origin: ALLOWED_ORIGIN, updated_at: new Date().toISOString() } }];",
    },
    position: [460, 600],
  },
  output: [
    {
      validation: 'ok',
      row_id: 'row-001',
      campaign_id: 'cmp-portugal-2026-05-04',
      action: 'accept',
      new_status: 'accepted',
      edited_payload_str: '',
      skip_reason_str: '',
      safety_dry_run: true,
      allowed_origin: 'https://imin.github.io',
      updated_at: '2026-05-04T20:00:00.000Z',
    },
  ],
});

const checkPostAuth = ifElse({
  version: 2.3,
  config: {
    name: 'Check POST auth',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          { id: 'cond-post-ok', leftValue: expr('={{ $json.validation }}'), rightValue: 'ok', operator: { type: 'string', operation: 'equals' } },
        ],
        combinator: 'and',
      },
    },
    position: [680, 600],
  },
});

const routeByAction = switchCase({
  version: 3.4,
  config: {
    name: 'Route by action',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ id: 'r-accept', leftValue: expr('={{ $json.action }}'), rightValue: 'accept', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: 'accept',
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ id: 'r-edit', leftValue: expr('={{ $json.action }}'), rightValue: 'edit', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: 'edit',
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ id: 'r-skip', leftValue: expr('={{ $json.action }}'), rightValue: 'skip', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: 'skip',
          },
          {
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
              conditions: [{ id: 'r-delete', leftValue: expr('={{ $json.action }}'), rightValue: 'delete', operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: 'delete',
          },
        ],
      },
    },
    position: [900, 600],
  },
});

const updateAccept = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Update row accept',
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME },
      matchType: 'allConditions',
      filters: {
        conditions: [{ keyName: 'row_id', condition: 'eq', keyValue: expr('={{ $json.row_id }}') }],
      },
      columns: COLUMNS_ACCEPT,
    },
    alwaysOutputData: true,
    position: [1120, 480],
  },
});

const updateEdit = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Update row edit',
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME },
      matchType: 'allConditions',
      filters: {
        conditions: [{ keyName: 'row_id', condition: 'eq', keyValue: expr('={{ $json.row_id }}') }],
      },
      columns: COLUMNS_EDIT,
    },
    alwaysOutputData: true,
    position: [1120, 600],
  },
});

const updateSkip = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Update row skip',
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME },
      matchType: 'allConditions',
      filters: {
        conditions: [{ keyName: 'row_id', condition: 'eq', keyValue: expr('={{ $json.row_id }}') }],
      },
      columns: COLUMNS_SKIP,
    },
    alwaysOutputData: true,
    position: [1120, 720],
  },
});

const updateDelete = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Update row delete',
    parameters: {
      resource: 'row',
      operation: 'update',
      dataTableId: { __rl: true, mode: 'id', value: DATA_TABLE_ID, cachedResultName: DATA_TABLE_NAME },
      matchType: 'allConditions',
      filters: {
        conditions: [{ keyName: 'row_id', condition: 'eq', keyValue: expr('={{ $json.row_id }}') }],
      },
      columns: COLUMNS_DELETE,
    },
    alwaysOutputData: true,
    position: [1120, 840],
  },
});

const checkDryRun = ifElse({
  version: 2.3,
  config: {
    name: 'Check SAFETY_DRY_RUN',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [
          {
            id: 'cond-dryrun-true',
            leftValue: expr("={{ $('Validate POST body').item.json.safety_dry_run }}"),
            rightValue: true,
            operator: { type: 'boolean', operation: 'equals' },
          },
        ],
        combinator: 'and',
      },
    },
    position: [1340, 600],
  },
});

const dryRunLog = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Log dry-run intent',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const v = $('Validate POST body').first().json;\n" +
        "const intent = { dry_run: true, would_call: 'POST https://imin-main.immigrantinvest.com/api/selected-blocks/?publish=0', payload: { row_id: v.row_id, campaign_id: v.campaign_id, action: v.action, new_status: v.new_status } };\n" +
        "console.log('[SAFETY_DRY_RUN] Skipped Storyblok call:', JSON.stringify(intent));\n" +
        "return [{ json: { logged: true, intent } }];",
    },
    position: [1560, 480],
  },
  output: [
    { logged: true, intent: { dry_run: true, would_call: 'POST', payload: {} } },
  ],
});

const storyblokCall = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Storyblok push (gated)',
    parameters: {
      method: 'POST',
      url: 'https://imin-main.immigrantinvest.com/api/selected-blocks/?publish=0',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("={{ JSON.stringify({ row_id: $('Validate POST body').item.json.row_id, campaign_id: $('Validate POST body').item.json.campaign_id, action: $('Validate POST body').item.json.action, new_status: $('Validate POST body').item.json.new_status }) }}"),
      options: {
        response: { response: { neverError: true, responseFormat: 'json' } },
      },
    },
    position: [1560, 720],
  },
});

const buildPostOkResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build POST OK response',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const v = $('Validate POST body').first().json;\n" +
        "const ALLOWED_ORIGIN = 'https://imin.github.io';\n" +
        "return [{ json: { __status: 200, __body: { status: 'ok', new_status: v.new_status, row_id: v.row_id, dry_run: v.safety_dry_run }, __cors_origin: ALLOWED_ORIGIN } }];",
    },
    position: [1780, 600],
  },
  output: [
    {
      __status: 200,
      __body: { status: 'ok', new_status: 'accepted', row_id: 'row-001', dry_run: true },
      __cors_origin: 'https://imin.github.io',
    },
  ],
});

const respondPostOk = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond POST ok',
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify($json.__body) }}'),
      options: {
        responseCode: expr('={{ $json.__status }}'),
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: ALLOWED_ORIGIN },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      },
    },
    position: [2000, 600],
  },
});

const buildPostErrorResponse = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build POST error response',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode:
        "const ALLOWED_ORIGIN = 'https://imin.github.io';\n" +
        "const item = $input.first().json;\n" +
        "let status = 401;\n" +
        "let body = { error: 'unauthorized' };\n" +
        "if (item.validation === 'bad_request') { status = 400; body = { error: 'row_id and action are required' }; }\n" +
        "else if (item.validation === 'invalid_action') { status = 400; body = { error: 'invalid action; expected accept|edit|skip|delete' }; }\n" +
        "return [{ json: { __status: status, __body: body, __cors_origin: ALLOWED_ORIGIN } }];",
    },
    position: [900, 800],
  },
  output: [
    { __status: 401, __body: { error: 'unauthorized' }, __cors_origin: 'https://imin.github.io' },
  ],
});

const respondPostError = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond POST error',
    parameters: {
      respondWith: 'json',
      responseBody: expr('={{ JSON.stringify($json.__body) }}'),
      options: {
        responseCode: expr('={{ $json.__status }}'),
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: ALLOWED_ORIGIN },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
      },
    },
    position: [1120, 800],
  },
});

const optionsStateWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'OPTIONS campaign-state',
    parameters: {
      httpMethod: expr('={{ "OPTIONS" }}'),
      path: 'campaign-state',
      responseMode: 'responseNode',
      options: { allowedOrigins: ALLOWED_ORIGIN },
    },
    position: [240, 1000],
  },
  output: [
    { headers: {}, params: {}, query: {}, body: {}, webhookUrl: '', executionMode: 'production' },
  ],
});

const respondOptionsState = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond OPTIONS state',
    parameters: {
      respondWith: 'noData',
      options: {
        responseCode: 204,
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: ALLOWED_ORIGIN },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
            { name: 'Access-Control-Max-Age', value: '600' },
          ],
        },
      },
    },
    position: [460, 1000],
  },
});

const optionsActionWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'OPTIONS campaign-action',
    parameters: {
      httpMethod: expr('={{ "OPTIONS" }}'),
      path: 'campaign-action',
      responseMode: 'responseNode',
      options: { allowedOrigins: ALLOWED_ORIGIN },
    },
    position: [240, 1200],
  },
  output: [
    { headers: {}, params: {}, query: {}, body: {}, webhookUrl: '', executionMode: 'production' },
  ],
});

const respondOptionsAction = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond OPTIONS action',
    parameters: {
      respondWith: 'noData',
      options: {
        responseCode: 204,
        responseHeaders: {
          entries: [
            { name: 'Access-Control-Allow-Origin', value: ALLOWED_ORIGIN },
            { name: 'Access-Control-Allow-Methods', value: 'GET, POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
            { name: 'Access-Control-Max-Age', value: '600' },
          ],
        },
      },
    },
    position: [460, 1200],
  },
});

const safetySticky = sticky(
  '## SAFETY_DRY_RUN = true\n\nThis workflow will NOT push to Storyblok.\nIt updates the campaign_blocks Data Table only.\n\nTo enable real Storyblok writes, change the SAFETY_DRY_RUN constant inside the Validate POST body Code node from true to false — and only after explicit human approval.\n\nThe Storyblok push (gated) HTTP node is wired but bypassed in dry-run mode.',
  [],
  { color: 3 }
);

const tokenSticky = sticky(
  '## Auth token (placeholder)\n\nBearer-style shared token: dev-token-change-me\n\nFrontend passes it as ?t=... (GET) or in the JSON body t field (POST). Both webhooks read both locations.\n\nRotate before production use. Update the EXPECTED_TOKEN constant in Validate GET token and Validate POST body Code nodes.',
  [],
  { color: 5 }
);

const corsSticky = sticky(
  '## CORS\n\nAllowed Origin: https://imin.github.io\n\nAll four webhooks (GET/POST/OPTIONS x2) emit identical CORS headers. OPTIONS endpoints respond 204 with Access-Control-Max-Age: 600.\n\nIf you need to loosen for dev, change ALLOWED_ORIGIN constant in the Code nodes and the responseHeaders.entries in each Respond node.',
  [],
  { color: 4 }
);

const archSticky = sticky(
  '## Architecture\n\n- GET /campaign-state — reads from Data Table, groups blocks, returns state.\n- POST /campaign-action — Switch by action, updates Data Table row, then dry-run gate.\n- OPTIONS — two dedicated triggers for CORS preflight (one per route).\n\nData Table: campaign_blocks (id wgKa7GSxjKjGrwQK).\n\nJSON columns (affected_fields, original_payload, proposed_payload, edited_payload, skip_reason, storyblok_response) are stringified on write and parsed on read inside the Code nodes.',
  [],
  { color: 7 }
);

export default workflow('wf-uibackend', 'Mass Actualization: UI Backend')
  .add(getStateWebhook)
  .to(
    validateGetRequest.to(
      checkGetAuth
        .onTrue(getTableRows.to(shapeStateResponse.to(respondGetOk)))
        .onFalse(buildGetError.to(respondGetErrorWebhook))
    )
  )
  .add(postActionWebhook)
  .to(
    validatePostBody.to(
      checkPostAuth
        .onTrue(
          routeByAction
            .onCase(0, updateAccept.to(checkDryRun.onTrue(dryRunLog.to(buildPostOkResponse.to(respondPostOk))).onFalse(storyblokCall.to(buildPostOkResponse))))
            .onCase(1, updateEdit.to(checkDryRun.onTrue(dryRunLog.to(buildPostOkResponse.to(respondPostOk))).onFalse(storyblokCall.to(buildPostOkResponse))))
            .onCase(2, updateSkip.to(checkDryRun.onTrue(dryRunLog.to(buildPostOkResponse.to(respondPostOk))).onFalse(storyblokCall.to(buildPostOkResponse))))
            .onCase(3, updateDelete.to(checkDryRun.onTrue(dryRunLog.to(buildPostOkResponse.to(respondPostOk))).onFalse(storyblokCall.to(buildPostOkResponse))))
        )
        .onFalse(buildPostErrorResponse.to(respondPostError))
    )
  )
  .add(optionsStateWebhook)
  .to(respondOptionsState)
  .add(optionsActionWebhook)
  .to(respondOptionsAction)
  .add(safetySticky)
  .add(tokenSticky)
  .add(corsSticky)
  .add(archSticky);
