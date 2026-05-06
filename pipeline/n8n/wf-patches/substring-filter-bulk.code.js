// Substring Filter (bulk) — replace ENTIRE Code body with this.
//
// FOUR-tier filter (cheapest first), all on text-only content (URLs/asset paths/colors excluded):
//   0. Locale check — detect actual content language (cyrillic vs latin ratio).
//      Drops stories whose content language doesn't match meta.source_locale.
//   1. Article-level OR (article_any_keywords) — must contain any in actual text.
//   2. Block-level AND (block_required_keywords) — block must contain all in its text.
//   3. Main keyword substring — at least one match in block leaves.
//
// Block dedup: path-based (drop ANCESTOR if any DESCENDANT is in the matched
// list). Storyblok _uids of nested blocks are not always derived from parent
// _uid, so path is the reliable hierarchy signal.

const meta = $('Init Campaign Meta').first().json;
const stories = $input.all();
const keywordLc = meta.keyword_lc;
const sourceLocale = String(meta.source_locale || '').toLowerCase();
const articleAny = Array.isArray(meta.article_any_keywords_lc) ? meta.article_any_keywords_lc : [];
const blockRequired = Array.isArray(meta.block_required_keywords_lc) ? meta.block_required_keywords_lc : [];

function isTextLeaf(s) {
  const t = String(s).trim();
  if (!t) return false;
  // URLs.
  if (/^https?:\/\//i.test(t)) return false;
  if (/^\/\//.test(t)) return false;
  // Asset filenames.
  if (/\.(jpe?g|png|gif|svg|webp|avif|mp4|webm|pdf|woff2?|ttf|css|js|json)(\?|$)/i.test(t)) return false;
  // Pure numeric/punct strings.
  if (/^[\d\s,.\-+()%]+$/.test(t)) return false;
  // UUIDs.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false;
  // Hex color codes (#fff, #1155CC, #FFFFFFFF).
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return false;
  // Storyblok TipTap doc node type names.
  if (/^(doc|paragraph|text|bold|italic|underline|link|textStyle|table|table_row|table_cell|heading|bullet_list|list_item|ordered_list)$/i.test(t)) return false;
  return true;
}

function walkLeaves(obj, prefix, out) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === 'string' || typeof obj === 'number') { out.push({ path: prefix, value: String(obj) }); return; }
  if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) walkLeaves(obj[i], prefix ? `${prefix}.${i}` : String(i), out); return; }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k === '_uid' || k === '_editable' || k === 'component') continue;
      walkLeaves(obj[k], prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

function walkBlocks(arr, prefix, out) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (!b || typeof b !== 'object') continue;
    const path = prefix ? `${prefix}[${i}]` : `body[${i}]`;
    if (b._uid && b.component) out.push({ _uid: b._uid, component: b.component, path, payload: b });
    for (const k of Object.keys(b)) {
      if (Array.isArray(b[k]) && b[k].length && typeof b[k][0] === 'object') walkBlocks(b[k], `${path}.${k}`, out);
    }
  }
}

// Whitespace-bounded match — keyword must be preceded AND followed by
// whitespace (or string boundary). Avoids false positives like "$5,000" or
// "150" or "(5)" matching the digit keyword "5". Trade-off: misses cases
// like "5." at sentence end — acceptable for typical editorial copy.
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function isWordBoundedMatch(text, kwLc) {
  const re = new RegExp('(^|\\s)' + escapeRegex(kwLc) + '(\\s|$)', 'i');
  return re.test(text);
}

function paragraphContext(text, kwLc) {
  const re = new RegExp('(^|\\s)' + escapeRegex(kwLc) + '(\\s|$)', 'i');
  const paras = String(text).split(/\n\s*\n/);
  const hits = [];
  for (let i = 0; i < paras.length; i++) {
    if (re.test(paras[i])) {
      const start = Math.max(0, i - 1);
      const end = Math.min(paras.length - 1, i + 1);
      hits.push({ para_index: i, context: paras.slice(start, end + 1).join('\n\n') });
    }
  }
  return hits;
}

function hashPayload(p) {
  const s = JSON.stringify(p);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}

function detectLang(content) {
  const sample = JSON.stringify(content || {}).slice(0, 10000);
  const cyr = (sample.match(/[а-яёА-ЯЁ]/g) || []).length;
  const lat = (sample.match(/[a-zA-Z]/g) || []).length;
  const total = cyr + lat;
  if (total < 50) return null;
  if (cyr / total > 0.30) return 'ru';
  if (lat / total > 0.95) return 'en';
  return null;
}

// Returns true if `parent.path` is a strict ancestor of `child.path` in the
// content tree (e.g. body[0] is parent of body[0].body[0] and body[0].body[1]).
function isPathAncestor(parent, child) {
  if (!parent.path || !child.path || parent === child) return false;
  return child.path.startsWith(parent.path + '.') || child.path.startsWith(parent.path + '[');
}

function emptyResult(story) {
  return { story_id: story.story_id, story_full_slug: story.story_full_slug, story_name: story.story_name, matches: [], match_count: 0 };
}

const out = [];
let droppedByLocale = 0;
let droppedByArticle = 0;
let withMatches = 0;

for (const item of stories) {
  const story = item.json;
  if (!story || !story.story_id) continue;

  // 0. Locale check.
  if (sourceLocale === 'ru' || sourceLocale === 'en') {
    const detected = detectLang(story.content);
    if (detected && detected !== sourceLocale) {
      droppedByLocale++;
      console.log(`[Substring] LOCALE-FILTER drop story=${story.story_id} (${story.story_full_slug}) detected=${detected} expected=${sourceLocale}`);
      out.push({ json: emptyResult(story) });
      continue;
    }
  }

  // 1. Article-level OR.
  if (articleAny.length > 0) {
    const allLeaves = [];
    walkLeaves(story.content || {}, '', allLeaves);
    let articleTextLc = '';
    for (const l of allLeaves) {
      if (typeof l.value === 'string' && isTextLeaf(l.value)) articleTextLc += ' ' + l.value.toLowerCase();
    }
    const hit = articleAny.some(kw => articleTextLc.includes(kw));
    if (!hit) {
      droppedByArticle++;
      console.log(`[Substring] ARTICLE-FILTER drop story=${story.story_id} (${story.story_full_slug})`);
      out.push({ json: emptyResult(story) });
      continue;
    }
  }

  // Walk all blocks recursively, then path-based dedup: keep only LEAF blocks
  // (those with no descendant in the matched list).
  const allBlocks = [];
  walkBlocks(story.content && story.content.body, 'body', allBlocks);

  const matched = [];
  for (const block of allBlocks) {
    const leaves = [];
    walkLeaves(block.payload, '', leaves);

    // 2. Block-level AND.
    if (blockRequired.length > 0) {
      let blockTextLc = '';
      for (const l of leaves) {
        if (typeof l.value === 'string' && isTextLeaf(l.value)) blockTextLc += ' ' + l.value.toLowerCase();
      }
      const allPresent = blockRequired.every(kw => blockTextLc.includes(kw));
      if (!allPresent) continue;
    }

    // 3. Main keyword — whitespace-bounded match (not substring). Catches
    //    "5 years" and "от 5 до", but not "$5,000" / "150" / "(5)".
    const matchedFields = [];
    const fieldHits = {};
    for (const leaf of leaves) {
      if (typeof leaf.value !== 'string') continue;
      if (!isTextLeaf(leaf.value)) continue;
      if (!isWordBoundedMatch(leaf.value, keywordLc)) continue;
      matchedFields.push(leaf.path);
      fieldHits[leaf.path] = paragraphContext(leaf.value, keywordLc);
    }
    if (matchedFields.length === 0) continue;

    matched.push({
      _uid: block._uid,
      component: block.component,
      path: block.path,
      payload: block.payload,
      affected_fields: matchedFields,
      field_hits: fieldHits,
      content_hash: hashPayload(block.payload),
    });
  }

  // Path-based dedup: drop ancestors that have any descendant also matched.
  // Result: only the smallest atomic blocks remain — best for LLM judgment
  // and surgical patching at LIVE accept time.
  const dedupedMatches = matched.filter(parent =>
    !matched.some(child => isPathAncestor(parent, child))
  );
  const droppedAsAncestors = matched.length - dedupedMatches.length;
  if (droppedAsAncestors > 0) {
    console.log(`[Substring] dedup story=${story.story_id} dropped ${droppedAsAncestors} ancestor block(s), kept ${dedupedMatches.length}`);
  }

  if (dedupedMatches.length > 0) withMatches++;

  out.push({ json: {
    story_id: story.story_id,
    story_full_slug: story.story_full_slug,
    story_name: story.story_name,
    matches: dedupedMatches,
    match_count: dedupedMatches.length,
  } });
}

console.log(`[Substring Bulk] processed=${stories.length} droppedByLocale=${droppedByLocale} droppedByArticle=${droppedByArticle} withMatches=${withMatches}`);
return out;
