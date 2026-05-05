# n8n workflow source archive

These `.workflow.js` files are the n8n Workflow SDK source for the workflows that live in production n8n. They're stored here as a versioned audit record.

## Currently archived

### `wf-search-preprocess.workflow.js`

**Live workflow ID:** `jIVm69uTSn9iL3GX`
**Display name:** Mass Actualization: Search & Pre-Process

**Triggers:**
- Form submission (legacy, for n8n-internal testing)
- POST `/webhook/search-trigger` (consumed by SPA — `Authorization: <token>` header, no `Bearer ` prefix; Cloud Run intercepts the `Bearer` scheme)

**Pipeline:**
1. Trigger
2. Validate webhook payload (auth done upstream by trigger's headerAuth)
3. Init Campaign Meta — normalise input, generate campaign_id, set safety flag
4. Storyblok mAPI: List Stories — single call (per_page=1000) with `seo.0.originalLanguage[in]=<source_locale>` filter
5. Flatten + Substring Filter — JS-only keyword match, attach hit-paragraphs
6. Loop Over Block Batches (10 at a time): prepare batch, LLM filter (Gemini Flash), drop non-matches, prepare rewrite batch, LLM rewrite (Gemini Flash), build rows, Data Table insert, next batch
7. Slack: Campaign Ready for Review — once, after the loop completes

**Locale model (verified 2026-05-05):** Storyblok i18n is field-level. RU originals (493) never cascade — `languages=['ru']` only by design. EN originals (526) cascade per their `seo[0].languages` (typically DE/ES/TR for blog, +AR/RU for programs). This workflow finds candidates for ONE source locale per run; cascade is a separate workflow.

**Token economy:** ~$1.20–$1.50 per 1000 stories scanned. Substring prefilter cuts ~80% of LLM filter cost. LLM prompts only see hit paragraphs, not whole blocks.

**Safety:** Read-only against Storyblok. Only writes are to campaign_blocks Data Table (id `wgKa7GSxjKjGrwQK`) + Slack notifications.

### `wf-uibackend.workflow.js`

**Live workflow ID:** `ORKhXHUFSANVF51w`
**Display name:** Mass Actualization: UI Backend

**Triggers:**
- GET `/webhook/campaign-state?campaign_id=<id>` → `{ campaign, progress, blocks }`
- POST `/webhook/campaign-action` → `{ status: 'ok', new_status, row_id, dry_run }`

Both use `Authorization: <token>` header (Header Auth credential `Actualization UI Webhook`). Cloud Run reverse proxy intercepts any `Bearer ...` value as a Google IAM token, so the SPA sends the raw secret without a scheme prefix.

**Pipeline:**

GET path:
1. Validate query param (campaign_id required)
2. Fetch all rows from `campaign_blocks` where `campaign_id = ?`
3. Shape response (parse JSON columns, compute progress)
4. Respond with `{ campaign, progress, blocks }`

POST path:
1. Validate body (row_id + action required, action ∈ {accept, edit, skip, delete})
2. switchCase by action → 4 separate Data Table update nodes (different actions write different columns)
3. Build OK response
4. Respond with `{ status: 'ok', new_status, row_id, dry_run }`

**Safety:** SAFETY_DRY_RUN=true is forced inside `Validate POST body`. Status updates land in the Data Table only — no Storyblok writes until LIVE.

## Auth credential

Both workflows reference the n8n credential **`Actualization UI Webhook`** (Header Auth type). Editor pastes the raw secret (no `Bearer ` prefix) into the SPA → SPA sends `Authorization: <token>` header → n8n's built-in Header Auth check on the trigger compares against the credential's stored value → 401 before workflow execution if mismatch.

**The credential MUST be manually bound to each webhook trigger in the n8n UI.** The SDK's `update_workflow` does not auto-bind credentials. After deploying, open each trigger in n8n UI → select the credential from the dropdown → save. Required for each new trigger (3 total: search-trigger, campaign-state, campaign-action).

## How these stay in sync with n8n

This is a manual sync today. When you change the SDK source here, run `update_workflow` in n8n MCP with the new code. When you change the workflow in n8n's UI, dump the SDK back here.

A future improvement is bidirectional sync via CI, but not in v1.

## Why these aren't built or run in CI

- No npm dependencies — these are reference text, not executable code in this repo.
- The SDK code only runs inside n8n's worker.
- Vitest doesn't import these files.
