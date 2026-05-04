# Mass Actualization UI

Static SPA for reviewing LLM-proposed rewrites of Storyblok blocks during mass content actualization campaigns. See `../docs/superpowers/specs/2026-05-04-mass-actualization-tool-design.md` for the full design.

## Architecture

- **No build step.** Single `index.html` served as-is, ES modules loaded directly by the browser.
- **Stack:** Alpine.js 3 (CDN), jsdiff (CDN via importmap), Tailwind 4 (CDN play build).
- **Pure logic in `lib/`** is unit-tested with Vitest in Node — same code runs in the browser.
- **State** lives in n8n + Google Sheets on the backend; the frontend is a thin client.

## Local development

```
npm install
npm run serve         # serves index.html at http://localhost:8080
npm test              # run unit tests (27 tests across state/diff/api)
npm run test:watch    # tests in watch mode
```

Open `http://localhost:8080` to drive the mock campaign. State resets on each reload — that's the mock client's behavior, not a bug.

## Production usage

Once deployed, editors open a URL like:

```
https://imin.github.io/article-actualization-ui/?campaign=<campaign_id>&api=<n8n base URL>&t=<bearer token>
```

URL params:
- `?campaign=<id>` — which campaign to load (Sheet name resolves on the backend)
- `?api=<https://n8n.imin.run.app>` — n8n Cloud Run base URL. **Without this param the app stays in mock mode.**
- `?t=<token>` — shared bearer token, validated on every n8n webhook call

The editor receives the URL via Slack from the WF-PreProcess workflow once LLM rewrite proposals are ready.

## Deployment

GitHub Actions workflow at `.github/workflows/pages.yml` deploys `main` to GitHub Pages on every push.

Manual trigger: Actions → "Deploy to Pages" → Run workflow.

To enable Pages on a fresh repo: Settings → Pages → Source = "GitHub Actions".

## File map

```
index.html            — single page, Alpine SPA shell
app.js                — Alpine root + screen factories (overview/story/blockCard/blockActions)
styles.css            — diff-del/diff-ins coloring, x-cloak hiding
lib/types.js          — JSDoc type contracts (BlockRow, Campaign, ActionPayload, etc.)
lib/state.js          — pure state derivation (groupByStory, computeProgress, applyAction, getNextPendingStory)
lib/diff.js           — word-level HTML diff with XSS-safe escape
lib/api.js            — API client factory: mock + real (fetch-based)
lib/mock-data.js      — hardcoded sample campaign for development
tests/*.test.js       — Vitest unit tests for lib modules
pipeline/             — n8n Code-node logic (NOT loaded by the SPA). See pipeline/README.md.
  tokenize.js          — heuristic token counting + budget truncation
  chunking.js          — paragraph splitting + context window extraction
  search-strategy.js   — per-block hit detection + classification/rewrite prompts
  *.test.js            — Vitest unit tests, run by the same CI
.github/workflows/pages.yml — GitHub Pages CI
```

## Backend contract

The frontend expects two n8n webhook endpoints:

- `GET ${baseURL}/webhook/campaign-state?campaign_id=<id>` → returns the campaign as JSON. Shape:
  ```json
  {
    "campaign": { "id", "topic", "started_at", "source_locale", "rewrite_prompt" },
    "progress": { "total", "reviewed", "by_status": { ... } },
    "blocks": [ { "row_id", "story_id", "story_name", "story_full_slug", "locale",
                  "block_uid", "block_path", "block_component", "affected_fields",
                  "original_payload", "llm_match_reason", "proposed_payload",
                  "edited_payload", "status", "skip_reason" } ]
  }
  ```

- `POST ${baseURL}/webhook/campaign-action` → applies one action and returns:
  ```json
  { "status": "ok", "new_status": "<accepted|edited|skipped|deleted>", "row_id": "..." }
  ```
  Body:
  ```json
  { "campaign_id": "...", "row_id": "...", "action": "accept|edit|skip|delete",
    "edited_payload"?: { ... }, "skip_reason"?: { "category", "comment" } }
  ```

Both endpoints validate `Authorization: Bearer <token>` from the URL param.

CORS: webhook nodes must return `Access-Control-Allow-Origin` matching the GitHub Pages origin.

## Safety

- **Drafts only.** Every accepted/edited/deleted action writes to Storyblok with `publish: 0`.
- **No automatic publish.** Editor must publish drafts manually in Storyblok admin.
- **No automatic translation cascade.** Cascade is a separate n8n workflow triggered explicitly after manual publish.
- **Optimistic updates revert** if the backend webhook fails — the user sees a global error toast and the row returns to its prior status.
