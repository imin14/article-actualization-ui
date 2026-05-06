// Build Rows — replace ENTIRE Code body with this.
//
// Diff-edit architecture: LLM returns only `edits: [{old, new}]` pairs (not
// full rewritten text). This Code node finds each `old` substring in any of
// the block's affected_fields and replaces it with `new`. Eliminates:
//   - LLM truncation (we never overwrite full field — only patch substrings)
//   - LLM key-confusion (we don't ask LLM to specify field name; we search)
//   - Token waste (LLM output is tiny, just the diff)
//
// Failure modes surfaced as distinct statuses:
//   - 'proposed'         — at least one edit found and applied
//   - 'llm_no_change'    — match=true but no edit's `old` was found in payload
//                          (LLM hallucinated text, paraphrased, etc.)

const meta = $('Init Campaign Meta').first().json;
const story = $('Loop Over Stories').first().json;
const upstream = $input.first().json || {};

if (upstream.error || (!upstream.output && !upstream.verdicts)) {
  const now = new Date().toISOString();
  const rid = `${meta.campaign_id}__${story.story_id}____sentinel__`;
  return [{ json: { row_id: rid, campaign_id: meta.campaign_id, campaign_topic: meta.campaign_topic, campaign_started_at: meta.campaign_started_at, source_locale: meta.source_locale, story_id: story.story_id, story_full_slug: story.story_full_slug, story_name: story.story_name, block_uid: '__sentinel__', block_path: '', block_component: '__sentinel__', affected_fields: '[]', original_payload: '{}', original_content_hash: '', llm_match_reason: 'LLM call errored or returned no parseable output', proposed_payload: '{}', status: 'llm_error', updated_at: now } }];
}

const parsed = upstream.output || upstream;
const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
const verdictByIndex = {};
for (const v of verdicts) verdictByIndex[v.index] = v;

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const segs = String(path).split('.');
  let cur = obj;
  for (const seg of segs) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : cur[seg];
  }
  return cur;
}

function setByPath(obj, segs, val) {
  if (segs.length === 0) return;
  const seg = segs[0];
  if (segs.length === 1) { if (Array.isArray(obj)) obj[Number(seg)] = val; else obj[seg] = val; return; }
  const next = Array.isArray(obj) ? obj[Number(seg)] : obj[seg];
  if (next && typeof next === 'object') setByPath(next, segs.slice(1), val);
}

// Apply LLM-supplied diff edits. For each {old, new} pair, search every
// affected_field for the `old` substring; on first hit, replace ALL of its
// occurrences in that field with `new`. Returns counters for status decision.
function applyEdits(payload, affectedFields, edits) {
  const out = JSON.parse(JSON.stringify(payload));
  let appliedCount = 0;
  let failedCount = 0;
  for (const edit of (edits || [])) {
    if (!edit || typeof edit.old !== 'string' || typeof edit.new !== 'string') {
      failedCount++;
      console.warn('[Build Rows] edit malformed (missing old/new)');
      continue;
    }
    const oldStr = edit.old;
    const newStr = edit.new;
    if (oldStr.length === 0) {
      failedCount++;
      console.warn('[Build Rows] edit has empty `old`');
      continue;
    }
    let applied = false;
    for (const fieldPath of affectedFields) {
      const original = getByPath(out, fieldPath);
      if (typeof original !== 'string') continue;
      if (original.includes(oldStr)) {
        const updated = original.split(oldStr).join(newStr);
        setByPath(out, fieldPath.split('.'), updated);
        applied = true;
        break;
      }
    }
    if (applied) {
      appliedCount++;
    } else {
      failedCount++;
      const preview = oldStr.length > 100 ? oldStr.slice(0, 100) + '…' : oldStr;
      console.warn(`[Build Rows] edit not applied — "old" not found verbatim in any affected_field: "${preview}"`);
    }
  }
  return { patched: out, appliedCount, failedCount };
}

const matches = Array.isArray(story.matches) ? story.matches : [];
const out = [];
const now = new Date().toISOString();

for (let i = 0; i < matches.length; i++) {
  const m = matches[i];
  const v = verdictByIndex[i];
  if (!v || v.match !== true) continue;

  const affectedFields = Array.isArray(m.affected_fields) ? m.affected_fields : [];
  const rowId = `${meta.campaign_id}__${story.story_id}__${m._uid}`;
  const baseRow = {
    row_id: rowId,
    campaign_id: meta.campaign_id,
    campaign_topic: meta.campaign_topic,
    campaign_started_at: meta.campaign_started_at,
    source_locale: meta.source_locale,
    story_id: story.story_id,
    story_full_slug: story.story_full_slug,
    story_name: story.story_name,
    block_uid: m._uid,
    block_path: m.path,
    block_component: m.component,
    affected_fields: JSON.stringify(affectedFields),
    original_payload: JSON.stringify(m.payload),
    original_content_hash: m.content_hash,
    updated_at: now,
  };

  // DELETE branch — LLM proposes to remove the block entirely (e.g. an
  // "upcoming changes" section that has now happened). proposed_payload
  // stays as the original (so SPA can show what would be removed); status
  // signals the deletion intent. LIVE accept handler will skip this block
  // when rebuilding the story body.
  if (v.delete_block === true) {
    out.push({ json: Object.assign({}, baseRow, {
      llm_match_reason: String(v.reason || '').slice(0, 500),
      proposed_payload: JSON.stringify(m.payload),
      status: 'proposed_delete',
    }) });
    continue;
  }

  // EDIT branch — apply diff edits.
  const edits = Array.isArray(v.edits) ? v.edits : [];
  if (edits.length === 0) {
    console.warn(`[Build Rows] match=true but edits is empty (and delete_block=false) for block uid=${m._uid}`);
    continue;
  }

  const { patched: proposedPayload, appliedCount, failedCount } = applyEdits(m.payload, affectedFields, edits);
  const status = appliedCount > 0 ? 'proposed' : 'llm_no_change';
  const reasonSuffix = failedCount > 0 ? ` [${failedCount}/${edits.length} edits failed to match]` : '';

  out.push({ json: Object.assign({}, baseRow, {
    llm_match_reason: (String(v.reason || '') + reasonSuffix).slice(0, 500),
    proposed_payload: JSON.stringify(proposedPayload),
    status,
  }) });
}

if (out.length === 0) {
  const rowId = `${meta.campaign_id}__${story.story_id}____sentinel__`;
  out.push({ json: {
    row_id: rowId,
    campaign_id: meta.campaign_id,
    campaign_topic: meta.campaign_topic,
    campaign_started_at: meta.campaign_started_at,
    source_locale: meta.source_locale,
    story_id: story.story_id,
    story_full_slug: story.story_full_slug,
    story_name: story.story_name,
    block_uid: '__sentinel__',
    block_path: '',
    block_component: '__sentinel__',
    affected_fields: '[]',
    original_payload: '{}',
    original_content_hash: '',
    llm_match_reason: 'No relevant matches after LLM classification',
    proposed_payload: '{}',
    status: 'no_relevant',
    updated_at: now,
  } });
}
return out;
