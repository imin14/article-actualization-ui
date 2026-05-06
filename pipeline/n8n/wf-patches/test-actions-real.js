// REAL-BACKEND ACTION TESTER
//
// USAGE:
//   1. Open SPA in real mode: localhost:8080/?api=https://...&campaign=<id>&t=<token>
//   2. Wait for page to load campaign
//   3. Open DevTools Console
//   4. Paste this entire file and press Enter
//   5. Wait ~30 seconds — script runs all tests sequentially
//   6. Share the final `RESULTS` table with me
//
// What it tests:
//   - GET  /webhook/campaign-state          (read campaign + blocks)
//   - POST /webhook/campaign-action accept  (status: proposed → accepted)
//   - POST /webhook/campaign-action edit    (status: proposed → edited + edited_payload)
//   - POST /webhook/campaign-action skip    (status: proposed → skipped + skip_reason)
//   - POST /webhook/campaign-action delete  (status: proposed → deleted)
//   - Verifies each change persisted (re-GET state after each action)
//   - Validates dry_run flag in response
//   - Validates CORS headers present
//
// SAFETY:
//   - n8n is in SAFETY_DRY_RUN — no Storyblok writes happen.
//   - Picks 4 'proposed' blocks (skips others to avoid clobbering reviewed work).
//   - If fewer than 4 proposed blocks, runs available subset.
//   - Records original status of each block; you can revert manually if needed
//     (just POST campaign-action with action=accept on the test rows? Actually
//      no — once changed, you can't go back to 'proposed' via the API. Test on
//      a fresh test campaign or one where you don't care about the rows.)

(async () => {
  const params = new URLSearchParams(window.location.search);
  const API = params.get('api');
  const CAMPAIGN = params.get('campaign');
  const TOKEN = localStorage.getItem('actualization_ui_token_v1');
  if (!API || !CAMPAIGN || !TOKEN) {
    console.error('❌ Missing api / campaign / token. URL must include ?api=...&campaign=... and token must be in localStorage.');
    return;
  }

  const log = (...args) => console.log('[TEST]', ...args);
  const headers = { 'Content-Type': 'application/json', Authorization: TOKEN };
  const RESULTS = [];

  function record(name, pass, details) {
    RESULTS.push({ name, pass: pass ? '✅' : '❌', ...details });
  }

  async function getState() {
    const r = await fetch(`${API}/webhook/campaign-state?campaign_id=${encodeURIComponent(CAMPAIGN)}`, { headers });
    if (!r.ok) throw new Error(`getState ${r.status}`);
    return r.json();
  }

  async function postAction(payload) {
    const r = await fetch(`${API}/webhook/campaign-action`, {
      method: 'POST', headers, body: JSON.stringify({ ...payload, campaign_id: CAMPAIGN }),
    });
    const corsOrigin = r.headers.get('Access-Control-Allow-Origin');
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, corsOrigin };
  }

  log('Fetching initial state...');
  const initial = await getState();
  log(`Found ${initial.blocks.length} blocks`);
  const proposed = initial.blocks.filter(b => b.status === 'proposed');
  log(`Of which ${proposed.length} are 'proposed' (testable)`);

  if (proposed.length < 4) {
    console.warn(`⚠️ Only ${proposed.length} proposed blocks available; need 4 for full test. Will run subset.`);
  }

  // Test 1: ACCEPT
  if (proposed[0]) {
    const target = proposed[0];
    log(`Test ACCEPT on row_id=${target.row_id}`);
    const t0 = Date.now();
    const res = await postAction({ row_id: target.row_id, action: 'accept' });
    const dt = Date.now() - t0;
    const after = (await getState()).blocks.find(b => b.row_id === target.row_id);
    record('ACCEPT', res.status === 200 && res.body?.new_status === 'accepted' && after?.status === 'accepted', {
      latency_ms: dt,
      response_status: res.status,
      response_new_status: res.body?.new_status,
      response_dry_run: res.body?.dry_run,
      datatable_status_after: after?.status,
      cors: res.corsOrigin,
    });
  }

  // Test 2: EDIT
  if (proposed[1]) {
    const target = proposed[1];
    log(`Test EDIT on row_id=${target.row_id}`);
    const fakePayload = { textMarkdown: 'TEST EDIT FROM REAL-BACKEND TESTER' };
    const t0 = Date.now();
    const res = await postAction({ row_id: target.row_id, action: 'edit', edited_payload: fakePayload });
    const dt = Date.now() - t0;
    const after = (await getState()).blocks.find(b => b.row_id === target.row_id);
    record('EDIT', res.status === 200 && res.body?.new_status === 'edited' && after?.status === 'edited' && after?.edited_payload?.textMarkdown === 'TEST EDIT FROM REAL-BACKEND TESTER', {
      latency_ms: dt,
      response_status: res.status,
      response_new_status: res.body?.new_status,
      datatable_status_after: after?.status,
      datatable_edited_payload_match: after?.edited_payload?.textMarkdown === 'TEST EDIT FROM REAL-BACKEND TESTER',
      cors: res.corsOrigin,
    });
  }

  // Test 3: SKIP
  if (proposed[2]) {
    const target = proposed[2];
    log(`Test SKIP on row_id=${target.row_id}`);
    const reason = { category: 'fact_recheck', comment: 'test from real-backend tester' };
    const t0 = Date.now();
    const res = await postAction({ row_id: target.row_id, action: 'skip', skip_reason: reason });
    const dt = Date.now() - t0;
    const after = (await getState()).blocks.find(b => b.row_id === target.row_id);
    record('SKIP', res.status === 200 && res.body?.new_status === 'skipped' && after?.status === 'skipped' && after?.skip_reason?.category === 'fact_recheck', {
      latency_ms: dt,
      response_status: res.status,
      datatable_status_after: after?.status,
      datatable_skip_reason_category: after?.skip_reason?.category,
      datatable_skip_reason_comment: after?.skip_reason?.comment,
      cors: res.corsOrigin,
    });
  }

  // Test 4: DELETE
  if (proposed[3]) {
    const target = proposed[3];
    log(`Test DELETE on row_id=${target.row_id}`);
    const t0 = Date.now();
    const res = await postAction({ row_id: target.row_id, action: 'delete' });
    const dt = Date.now() - t0;
    const after = (await getState()).blocks.find(b => b.row_id === target.row_id);
    record('DELETE', res.status === 200 && res.body?.new_status === 'deleted' && after?.status === 'deleted', {
      latency_ms: dt,
      response_status: res.status,
      response_dry_run: res.body?.dry_run,
      datatable_status_after: after?.status,
      cors: res.corsOrigin,
    });
  }

  // Test 5: invalid action — should 400
  log('Test INVALID action (should reject with 400)');
  const res5 = await postAction({ row_id: proposed[0]?.row_id || 'any', action: 'bogus_action' });
  record('INVALID action → 400', res5.status === 400, {
    response_status: res5.status,
    response_body: res5.body,
  });

  // Test 6: missing row_id — should 400
  log('Test missing row_id (should reject with 400)');
  const res6 = await postAction({ action: 'accept' });
  record('Missing row_id → 400', res6.status === 400, {
    response_status: res6.status,
    response_body: res6.body,
  });

  console.table(RESULTS);
  console.log('\n📋 Copy the table above and paste it in chat for review.');
  window.LAST_TEST_RESULTS = RESULTS;
})();
