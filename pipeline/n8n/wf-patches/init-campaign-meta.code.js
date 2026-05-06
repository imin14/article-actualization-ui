// Init Campaign Meta — replace ENTIRE Code body with this:
// Single change vs current: campaign_id auto-gen now includes sourceLocale,
// so cmp-portugal-golden-visa-5-10-years-2026-05-05 (ambiguous)
// becomes cmp-portugal-golden-visa-5-10-years-en-2026-05-05 vs ...-ru-...

const SAFETY_DRY_RUN = true;
const item = $input.first().json;
const topic = String(item.campaign_topic || "").trim();
if (!topic) throw new Error("campaign_topic is required");
const keyword = String(item.keyword || "").trim();
if (!keyword) throw new Error("keyword is required");
const contextDescription = String(item.context_description || "").trim();
const rewritePrompt = String(item.rewrite_prompt || "").trim();
if (!contextDescription) throw new Error("context_description is required");
if (!rewritePrompt) throw new Error("rewrite_prompt is required");
const sourceLocale = String(item.source_locale || "ru").trim();
const folder = String(item.folder || "").trim();
const contentType = String(item.content_type || "article").trim();
const userChoseDryRun = Array.isArray(item.dry_run) ? item.dry_run.length > 0 : Boolean(item.dry_run);
const dryRunEffective = SAFETY_DRY_RUN || userChoseDryRun;
function parseKeywordList(s) { return String(s || "").split(",").map(t => t.trim().toLowerCase()).filter(Boolean); }
const blockRequiredRaw = String(item.block_required_keywords || "").trim();
const articleAnyRaw = String(item.article_any_keywords || "").trim();
const blockRequiredLc = parseKeywordList(blockRequiredRaw);
const articleAnyLc = parseKeywordList(articleAnyRaw);
function slugify(s) { return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40); }
const today = new Date().toISOString().slice(0, 10);
let campaignId = String(item.campaign_id || "").trim();
if (!campaignId) campaignId = `cmp-${slugify(topic)}-${sourceLocale}-${today}`;
const startedAt = new Date().toISOString();
return [{ json: {
  safety_dry_run: SAFETY_DRY_RUN,
  dry_run_effective: dryRunEffective,
  campaign_id: campaignId,
  campaign_topic: topic,
  campaign_started_at: startedAt,
  keyword: keyword,
  keyword_lc: keyword.toLowerCase(),
  block_required_keywords: blockRequiredRaw,
  article_any_keywords: articleAnyRaw,
  block_required_keywords_lc: blockRequiredLc,
  article_any_keywords_lc: articleAnyLc,
  context_description: contextDescription,
  rewrite_prompt: rewritePrompt,
  source_locale: sourceLocale,
  folder: folder,
  content_type: contentType,
} }];
