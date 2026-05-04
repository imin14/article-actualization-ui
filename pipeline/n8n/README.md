# n8n workflow source archive

These `.workflow.js` files are the n8n Workflow SDK source for the workflows that live in production n8n. They're stored here as a versioned audit record.

## Currently archived

### `wf-search-preprocess.workflow.js`

**Live workflow IDs in n8n:**
- `jIVm69uTSn9iL3GX` — **canonical** definition (kept by the build agent; matches the SDK source archived here)
- `m0HxFfubActwbKBh` — duplicate from a 500-error-then-success retry; **delete this one** in morning cleanup. Both are inactive.

**Display name:** "Mass Actualization: Search & Pre-Process"
**Status:** INACTIVE (will not auto-trigger)
**Trigger:** Form submission with fields `campaign_topic`, `campaign_id`, `keyword`, `context_description`, `source_locale`, `folder`, `content_type`, `rewrite_prompt`, `dry_run`

**Pipeline:**
1. Form trigger
2. HTTP `mAPI list stories` (Storyblok read-only)
3. Code `flatten to blocks`
4. Code `substring filter + paragraph chunking`
5. SplitInBatches (batch size 10)
6. AI Agent `context filter` (Gemini Flash, structured output)
7. Code `drop non-matches`
8. AI Agent `rewrite proposal` (Gemini Flash, structured output)
9. Code `build campaign_blocks rows`
10. Data Table insert (campaign_blocks)
11. Slack notification

**Token economy:** ~$1.20–$1.50 per 1000 stories scanned. Substring prefilter cuts ~80% of LLM filter cost. LLM prompts only see hit paragraphs (paragraph chunking), not whole blocks.

**Safety:** Storyblok mAPI is read-only — no destructive ops. Workflow does NOT write to Storyblok at any step. Only writes are to:
- n8n Data Table `campaign_blocks` (ID `wgKa7GSxjKjGrwQK`)
- Slack notifications channel

## How these stay in sync with n8n

This is a manual sync today. When you change the SDK source here, run `update_workflow` in n8n MCP with the new code. When you change the workflow in n8n's UI, dump the SDK back here.

A future improvement is bidirectional sync via CI, but not in v1.

## Why these aren't built or run in CI

- No npm dependencies — these are reference text, not executable code in this repo.
- The SDK code only runs inside n8n's worker.
- Vitest doesn't import these files.
