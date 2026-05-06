const meta = $input.first().json;
const processedIds = Array.isArray(meta.processed_story_ids) ? meta.processed_story_ids : [];
const excludingIds = processedIds.join(',');
const MAX_PAGES = 10;
const out = [];
for (let p = 1; p <= MAX_PAGES; p++) {
  out.push({ json: {
    page: p,
    folder: meta.folder,
    source_locale: meta.source_locale,
    excluding_ids: excludingIds,
  } });
}
return out;
