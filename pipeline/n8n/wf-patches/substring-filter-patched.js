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
//
// 2026-05-06 patch: when a matched block sits inside a table (component
// table_cell / its container has a `rows` array), attach `table_context` so
// the LLM can disambiguate the cell text using the column header + row
// label. Without this the LLM misclassifies cells like "Через 5 лет" inside
// "Возврат инвестиций / Антигуа и Барбуда" as Portugal-naturalisation hits.

const meta = $('Init Campaign Meta').first().json;
const stories = $input.all();
const keywordLc = meta.keyword_lc;
const sourceLocale = String(meta.source_locale || '').toLowerCase();
const articleAny = Array.isArray(meta.article_any_keywords_lc) ? meta.article_any_keywords_lc : [];
const blockRequired = Array.isArray(meta.block_required_keywords_lc) ? meta.block_required_keywords_lc : [];

function isTextLeaf(s) {
  const t = String(s).trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^\/\//.test(t)) return false;
  if (/\.(jpe?g|png|gif|svg|webp|avif|mp4|webm|pdf|woff2?|ttf|css|js|json)(\?|$)/i.test(t)) return false;
  if (/^[\d\s,.\-+()%]+$/.test(t)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return false;
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

// Threads `parentTable` through recursion so emitted table_cell blocks know
// which table they sit in. A block becomes the new `parentTable` if it has a
// `rows` array (covers Storyblok native table + flat_table + custom variants).
function walkBlocks(arr, prefix, out, parentTable) {
  if (!Array.isArray(arr)) return;
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    if (!b || typeof b !== 'object') continue;
    const path = prefix ? `${prefix}[${i}]` : `body[${i}]`;
    if (b._uid && b.component) {
      const emitted = { _uid: b._uid, component: b.component, path, payload: b };
      if (parentTable && /table[_-]?cell|cell/i.test(b.component || '')) emitted._parentTable = parentTable;
      out.push(emitted);
    }
    const isTableLike = Array.isArray(b.rows) && b.rows.length && typeof b.rows[0] === 'object';
    const nextParent = isTableLike ? b : parentTable;
    for (const k of Object.keys(b)) {
      if (Array.isArray(b[k]) && b[k].length && typeof b[k][0] === 'object') walkBlocks(b[k], `${path}.${k}`, out, nextParent);
    }
  }
}

// Best-effort flat-text extractor for nested TipTap-style structures
// ({type, content:[...], text}) and for Storyblok rich-text payloads.
function extractFlatText(obj) {
  if (obj == null) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number') return String(obj);
  if (Array.isArray(obj)) return obj.map(extractFlatText).join(' ');
  if (typeof obj === 'object') {
    let parts = [];
    if (typeof obj.text === 'string') parts.push(obj.text);
    if (typeof obj.textMarkdown === 'string') parts.push(obj.textMarkdown);
    if (Array.isArray(obj.content)) parts.push(extractFlatText(obj.content));
    if (Array.isArray(obj.cells)) parts.push(extractFlatText(obj.cells));
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

// From a path like "body[8].body[1].rows[3].cells[3]" + parent table object,
// derive { column, row_label, row_index, cell_index }. Returns null if the
// path doesn't end in a row/cell pattern or the table is malformed.
function buildTableContext(parentTable, blockPath) {
  if (!parentTable) return null;
  const m = String(blockPath || '').match(/\.rows\[(\d+)\]\.cells\[(\d+)\]$/);
  if (!m) return null;
  const rowIdx = Number(m[1]);
  const cellIdx = Number(m[2]);
  const rows = parentTable.rows;
  if (!Array.isArray(rows)) return null;
  const headerRow = rows[0];
  const dataRow = rows[rowIdx];
  let column = '';
  let rowLabel = '';
  if (headerRow && Array.isArray(headerRow.cells) && headerRow.cells[cellIdx]) {
    column = extractFlatText(headerRow.cells[cellIdx]).slice(0, 200);
  }
  if (dataRow && Array.isArray(dataRow.cells) && dataRow.cells[0]) {
    rowLabel = extractFlatText(dataRow.cells[0]).slice(0, 200);
  }
  if (!column && !rowLabel) return null;
  return { column, row_label: rowLabel, row_index: rowIdx, cell_index: cellIdx };
}

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

  if (sourceLocale === 'ru' || sourceLocale === 'en') {
    const detected = detectLang(story.content);
    if (detected && detected !== sourceLocale) {
      droppedByLocale++;
      console.log(`[Substring] LOCALE-FILTER drop story=${story.story_id} (${story.story_full_slug}) detected=${detected} expected=${sourceLocale}`);
      out.push({ json: emptyResult(story) });
      continue;
    }
  }

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

  const allBlocks = [];
  walkBlocks(story.content && story.content.body, 'body', allBlocks, null);

  const matched = [];
  for (const block of allBlocks) {
    const leaves = [];
    walkLeaves(block.payload, '', leaves);

    if (blockRequired.length > 0) {
      let blockTextLc = '';
      for (const l of leaves) {
        if (typeof l.value === 'string' && isTextLeaf(l.value)) blockTextLc += ' ' + l.value.toLowerCase();
      }
      const allPresent = blockRequired.every(kw => blockTextLc.includes(kw));
      if (!allPresent) continue;
    }

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

    const tableContext = buildTableContext(block._parentTable, block.path);

    matched.push({
      _uid: block._uid,
      component: block.component,
      path: block.path,
      payload: block.payload,
      affected_fields: matchedFields,
      field_hits: fieldHits,
      table_context: tableContext,
      content_hash: hashPayload(block.payload),
    });
  }

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
