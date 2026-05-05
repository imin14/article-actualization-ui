# Architecture: Mass Content Actualization Tool

## Why this exists

IMIN's content (~1000 stories in Storyblok across multiple primary locales) needs periodic mass updates triggered by external events: legal changes, program rule updates, statistical revisions. The Portugal Golden Visa rule change (5 → 10 years for citizenship) is the immediate trigger; the tool is built universally so any future rule change uses the same flow.

The tool replaces editor work that doesn't scale: today the head editor would have to find every affected article across locales and manually rewrite each block while keeping context coherent.

## High-level flow

```
[Editor]                 [n8n: WF-Search-PreProcess]            [Storyblok mAPI]
  │ Submit search form ──▶ Fetch stories (read-only) ─────────▶ │
  │                        │                                     │
  │                        │ Substring filter (JS, 0 tokens)    │
  │                        │ Paragraph chunking                 │
  │                        │ LLM context filter (cheap)         │
  │                        │ LLM rewrite proposals (cheap)      │
  │                        ▼                                     │
  │                     [n8n Data Table: campaign_blocks]
  │                        │
  │ Slack ping ◀───────── Send completion message
  │
  │ Open UI URL
  │   imin.github.io/article-actualization-ui
  │   ?campaign=<id>&api=<n8n base URL>&t=<token>
  │
  ▼
[Frontend SPA] ───── HTTPS ──────▶ [n8n: WF-UIBackend]
  │                                  GET /webhook/campaign-state
  │                                  POST /webhook/campaign-action
  │                                    │
  │                                    │ Read/write campaign_blocks
  │                                    │ (NO Storyblok writes — gated by SAFETY_DRY_RUN)
  │ Editor reviews diffs               │
  │ Per-block: Accept/Edit/Skip/Delete
  │
  └─ When all blocks reviewed: Done state shown
                                           │
                                           ▼
                              [Editor opens Storyblok admin]
                              [Reviews drafts manually]
                              [Publishes when ready]
                                           │
                                           ▼
                              [n8n: WF-Cascade] (existing workflow,
                                                  triggered explicitly)
                              translate-3-chunked → only into locales that
                              already exist in seo[0].languages (per-story).
                              EN-blog typically → DE/ES/TR. EN-program → +AR+RU.
                              RU originals → no cascade (RU stays RU by design).
```

## Components

### Frontend (this repo)

Static SPA hosted on GitHub Pages. Single `index.html`. Stack:
- **Alpine.js 3** — reactive UI without a build step
- **jsdiff** (via importmap) — word-level diffs in the browser
- **Tailwind 4 browser build** — utility CSS via CDN
- **Vitest** — unit tests for pure logic in `lib/` (Node-only; no browser tests required)

Pure modules in `lib/`:
- `lib/types.js` — JSDoc type contracts (BlockRow, Campaign, etc.)
- `lib/state.js` — derivation (groupByStory, computeProgress, applyAction, getNextPendingStory)
- `lib/diff.js` — word-level HTML diff with XSS-safe escape
- `lib/api.js` — API client factory: mock + real (fetch-based against n8n)
- `lib/mock-data.js` — hardcoded sample campaign for development

The frontend is a thin client. All state lives in n8n + the `campaign_blocks` Data Table.

### Pipeline (this repo, runs in n8n)

Modules in `pipeline/` are designed to be pasted into n8n Code nodes (or imported by an n8n function tool once that capability lands). They are NOT loaded by the frontend SPA — they live here only so the same CI tests them as the SPA. Sync to n8n manually for now.

- `pipeline/tokenize.js` — heuristic token counting (chars/4 Latin, /2 Cyrillic) + budget truncation
- `pipeline/chunking.js` — paragraph splitting + context window extraction
- `pipeline/search-strategy.js` — orchestration: per-block hit detection, classification prompt, rewrite prompt

### Backend: n8n Cloud Run workflows

#### WF-UIBackend (workflow ID `ORKhXHUFSANVF51w`)

Status: **built, validated, tested, INACTIVE.**

Two webhook endpoints + two OPTIONS preflight endpoints:
- `GET /webhook/campaign-state?campaign_id=<id>&t=<token>` — returns campaign + progress + blocks
- `POST /webhook/campaign-action` — body `{campaign_id, row_id, action, edited_payload?, skip_reason?, t}` — updates Data Table; returns `{status, new_status, row_id, dry_run}`

**Safety:** `SAFETY_DRY_RUN=true` by default. Storyblok HTTP write node is in the workflow (for future use) but gated behind an `if SAFETY_DRY_RUN === false` branch. In dry-run, the action only updates the Data Table row and logs the intended Storyblok call shape. The Storyblok node has never been executed (verified via `test_workflow` runs).

Auth: shared bearer token (placeholder `dev-token-change-me`). CORS configured for `https://imin.github.io`.

#### WF-Search-PreProcess (built tonight)

Status: **built and validated, INACTIVE.** Workflow ID listed in the morning report.

Form trigger with fields: `campaign_topic, campaign_id, keyword, context_description, source_locale, folder, content_type, rewrite_prompt, dry_run`. Pipeline:

1. Fetch all matching Storyblok stories via mAPI (read-only)
2. Flatten to per-locale block records
3. Substring filter (JS, no LLM cost)
4. LLM context filter (Gemini Flash, batched, structured output)
5. LLM rewrite proposals (Gemini Flash, batched, structured output)
6. Insert rows into `campaign_blocks` Data Table with `status=proposed`
7. Slack notification with the UI URL

**Token economy:** substring prefilter cuts ~80% of candidates before any LLM call. LLM prompts only see hit paragraphs (not whole blocks). Estimated cost: ~$1.20–$1.50 per 1000 stories scanned (Gemini Flash pricing).

**Safety:** Storyblok mAPI is read-only — no destructive ops. The workflow does NOT write to Storyblok at any step. Only writes are to the n8n Data Table and Slack.

#### WF-Cascade (existing — `Turkey Blocks Generator v3`, ID `lBCSrbEPX7BXx1CR`)

Reused, not rebuilt. Triggered explicitly by editor after manually publishing drafts in Storyblok admin. Translates published blocks via `/api/ai-tools/translate-3-chunked/`.

**Important — context-aware cascade.** The Storyblok content tree under `immigrantinvest/` (verified 2026-05-05 across 1019 article-stories) is **not** a uniform "RU → all-locales" model. Reality:

| Folder | Origin | Common cascade targets |
|---|---|---|
| `new-blog/` (489 stories) | RU | **None** — RU originals are RU-only by design (verified: 0 RU originals have any translations) |
| `new-blog/` (477 stories) | EN | DE, ES, TR (~85% of EN blog articles); AR almost never; RU rare |
| `programs/` (49 stories) | EN | DE, ES, TR, AR + RU in ~92% of cases (full 6-locale set) |
| `programs/` (4 stories) | RU | None |

**Cascade must be context-aware.** Don't fan out to a fixed "ES/DE/TR/AR" list. Instead, for each story:

```javascript
const targetLocales = (story.content.seo[0].languages || [])
  .filter(l => l !== story.content.seo[0].originalLanguage);
// cascade only into locales that already exist for this story.
// never CREATE a new translation locale — that's a separate workflow.
```

This means the same campaign reaches different locales depending on which articles are affected: a Portugal Golden Visa rule update touching `programs/portugal-*` cascades to AR+RU; the same campaign touching `new-blog/portugal-*` cascades only to DE/ES/TR.

### State: n8n Data Tables

**`campaign_blocks`** (ID `wgKa7GSxjKjGrwQK`): one row per affected block per locale per campaign. Schema:

| Column | Type | Notes |
|---|---|---|
| `row_id` | string | UUID, primary key for action API |
| `campaign_id` | string | Foreign key (one campaign = many rows) |
| `campaign_topic` | string | Human-readable |
| `campaign_started_at` | date | Used by cascade to detect publish-after-campaign |
| `source_locale` | string | `ru` or `en` |
| `story_id` | string | Storyblok ID |
| `story_full_slug` | string | For UI links + cascade |
| `story_name` | string | UI display |
| `block_uid` | string | Storyblok block UID |
| `block_path` | string | e.g. `body[2]` |
| `block_component` | string | Storyblok component name |
| `affected_fields` | string (JSON) | List of field names containing keyword |
| `original_payload` | string (JSON) | `{field_name: original_value}` |
| `llm_match_reason` | string | Phase 1 LLM output |
| `proposed_payload` | string (JSON) | `{field_name: proposed_value}` from Phase 1.5 LLM |
| `edited_payload` | string (JSON) | After Edit & Accept |
| `status` | string | `pending\|proposed\|accepted\|edited\|skipped\|deleted\|error` |
| `skip_reason` | string (JSON) | `{category, comment}` if skipped |
| `storyblok_response` | string (JSON) | Last Storyblok API response (for audit) |
| `error_message` | string | If status=error |
| `updated_at` | date | Last modification |
| `cascaded_at` | date | When cascade fired |

JSON-stringified columns are necessary because n8n Data Tables only support string/number/boolean/date primitives.

## Data flow per action

When the editor clicks ✅ Accept on a block in the UI:

1. Frontend calls `POST /webhook/campaign-action` with `{campaign_id, row_id, action: 'accept', t}`
2. WF-UIBackend validates the bearer token
3. WF-UIBackend updates the Data Table row: `status='accepted'`, `updated_at=now`
4. **`SAFETY_DRY_RUN` gate:**
   - If true (default): logs intended Storyblok call but does not execute it
   - If false: would call `POST /api/selected-blocks/?publish=0` with the block payload
5. WF-UIBackend returns `{status: 'ok', new_status: 'accepted', row_id, dry_run: true}`
6. Frontend optimistically updates its local view

Edit, Skip, Delete are analogous; each branches differently in the Switch node and writes different fields.

## Token economy

The pipeline is engineered to minimize LLM token cost:

- **Layer 1 — JS substring match:** ~50K total blocks → ~10K candidates after match. Zero LLM tokens.
- **Layer 2 — LLM context filter:** ~10K hits × ~200 tokens (hit paragraph only) = 2M tokens. ~$0.60 on Gemini Flash.
- **Layer 3 — LLM rewrite proposals:** ~5K matches × ~400 tokens (hit paragraphs + rewrite prompt) = 2M tokens. ~$0.60.

Total: **~$1.20 per 1000 stories scanned.** This is the cost of one campaign run.

Without the substring prefilter, layer 2 would alone be ~10M tokens (~$3). The prefilter saves ~80% on filter cost.

Without paragraph chunking, layer 3 would send full block text to the LLM — typically 5-10× longer than just hit paragraphs. This would scale rewrite cost from ~$0.60 to ~$5-6 per 1000 stories.

## Safety design

This system has three layers of safety against accidental Storyblok writes:

1. **WF-UIBackend `SAFETY_DRY_RUN=true`** — gates all Storyblok HTTP calls
2. **Workflows are INACTIVE by default** — no triggers fire until human activates
3. **No publish in any workflow** — accepted changes go to drafts (`publish=0`) only when SAFETY_DRY_RUN is flipped, with the explicit understanding that the editor still publishes manually in Storyblok admin

Translation cascade is a separate, explicitly-triggered workflow — not auto-fired upon publish.

## Deployment status

| Component | Status | Location |
|---|---|---|
| Frontend code | Complete | `article-actualization-ui/` repo |
| Frontend deploy | Pending — push to GitHub | `.github/workflows/pages.yml` ready |
| Frontend tests | 110 passing | `tests/*.test.js` + `pipeline/*.test.js` |
| WF-UIBackend | Built, validated, tested | n8n `ORKhXHUFSANVF51w` (inactive) |
| WF-Search-PreProcess | Built, validated | n8n (inactive) — see morning report for ID |
| WF-Cascade | Existing | n8n `lBCSrbEPX7BXx1CR` (Turkey Blocks Generator v3) |
| Data Table `campaign_blocks` | Created, seeded with 6 mock rows | n8n `wgKa7GSxjKjGrwQK` |

## To go live (morning checklist)

1. Push `article-actualization-ui/` to a GitHub repo with Pages enabled
2. Open the WF-Search-PreProcess workflow in n8n; review Storyblok mAPI credentials, LLM credentials, Slack creds
3. Replace placeholder bearer token in WF-UIBackend with a real token; rotate it on a schedule
4. Activate both workflows
5. Run a small test campaign on a sandbox Storyblok project before the real Portugal Golden Visa run
6. Open the UI URL `https://<org>.github.io/article-actualization-ui/?campaign=cmp-portugal-2026-05-04&api=<n8n base URL>&t=<token>`
7. Verify the editor can navigate, accept, edit, skip, delete with optimistic updates flowing back to the Data Table
8. **Only after all of the above:** flip `SAFETY_DRY_RUN=false` in WF-UIBackend, configure Storyblok write credentials, run for real
