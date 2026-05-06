// Validate webhook payload — replace ENTIRE Code body with this:
// Single change vs current: campaign_id auto-gen now includes sourceLocale.

const ALLOWED_ORIGINS = ['https://imin.github.io', 'http://localhost:8080'];
const DEFAULT_ORIGIN = 'https://imin.github.io';
const raw = $input.first().json || {};
const body = raw.body || raw;
const headers = raw.headers || {};
const originHeader = headers.origin || headers.Origin || '';
const corsOrigin = ALLOWED_ORIGINS.indexOf(originHeader) >= 0 ? originHeader : DEFAULT_ORIGIN;
const required = ['campaign_topic', 'keyword', 'context_description', 'rewrite_prompt'];
const missing = required.filter(k => !body[k] || String(body[k]).trim() === '');
if (missing.length) {
  return [{ json: { __error: 'missing fields: ' + missing.join(', '), __status: 400, __cors_origin: corsOrigin } }];
}
const sourceLocale = String(body.source_locale || 'ru').trim();
function slugify(s) { return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
const today = new Date().toISOString().slice(0, 10);
let campaignId = String(body.campaign_id || '').trim();
if (!campaignId) campaignId = 'cmp-' + slugify(String(body.campaign_topic)) + '-' + sourceLocale + '-' + today;
return [{ json: {
  campaign_topic: body.campaign_topic,
  campaign_id: campaignId,
  keyword: body.keyword,
  block_required_keywords: body.block_required_keywords || '',
  article_any_keywords: body.article_any_keywords || '',
  context_description: body.context_description,
  source_locale: sourceLocale,
  folder: body.folder || '',
  content_type: body.content_type || 'flatArticle',
  rewrite_prompt: body.rewrite_prompt,
  dry_run: body.dry_run !== false,
  __cors_origin: corsOrigin,
} }];
