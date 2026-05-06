// Lightweight i18n for the SPA. Flat key dict + reactive Alpine integration.
//
// Usage in templates:  x-text="t('auth.title')"
// Usage in JS:          this.t('overview.banner.ready')
// With params:          t('publish.banner.partial', { count: 12 })
//
// Locale lives on appRoot.locale (Alpine reactive). Methods that read
// translations also read this.locale to register a reactivity dependency,
// so changing locale re-renders all bindings.

const LOCALE_STORAGE_KEY = 'actualization_ui_locale_v1';
export const SUPPORTED_LOCALES = ['ru', 'en'];
export const DEFAULT_LOCALE = 'ru';

export function readStoredLocale() {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && SUPPORTED_LOCALES.includes(stored)) return stored;
  } catch {}
  // Auto-detect from browser language. Fallback to default.
  const lang = (typeof navigator !== 'undefined' ? (navigator.language || '') : '').slice(0, 2).toLowerCase();
  return SUPPORTED_LOCALES.includes(lang) ? lang : DEFAULT_LOCALE;
}

export function writeStoredLocale(loc) {
  if (!SUPPORTED_LOCALES.includes(loc)) return;
  try { localStorage.setItem(LOCALE_STORAGE_KEY, loc); } catch {}
}

// Translate a key with optional `{name}` substitutions in the string.
// Falls back to default locale, then to the key itself if entirely missing.
export function translate(dict, key, locale, params = {}) {
  const entry = dict[key];
  if (!entry) {
    if (typeof console !== 'undefined') console.warn('[i18n] missing key:', key);
    return key;
  }
  let value = entry[locale] || entry[DEFAULT_LOCALE] || key;
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      value = value.replaceAll(`{${k}}`, String(v));
    }
  }
  return value;
}

// =============================================================================
// TRANSLATION DICT
//
// Flat keys, hierarchical naming. Add new keys here as you extract more
// strings. Convention: `area.subarea.specific`.
// =============================================================================

export const TRANSLATIONS = {
  // ─── Common ─────────────────────────────────────────────────────────────
  'common.cancel':      { ru: 'Cancel',  en: 'Cancel' },
  'common.save':        { ru: 'Save',    en: 'Save' },
  'common.close':       { ru: 'Close',   en: 'Close' },
  'common.loading':     { ru: 'Загрузка…', en: 'Loading…' },
  'common.error_prefix': { ru: 'Ошибка: ', en: 'Error: ' },
  'common.error':        { ru: 'Ошибка',     en: 'Error' },
  'common.click_to_dismiss': { ru: 'click чтобы скрыть', en: 'click to dismiss' },

  // ─── Header / nav ──────────────────────────────────────────────────────
  'header.campaign':    { ru: 'CAMPAIGN',  en: 'CAMPAIGN' },
  'header.search':      { ru: 'SEARCH',    en: 'SEARCH' },
  'header.progress':    { ru: 'PROGRESS',  en: 'PROGRESS' },
  'header.logout':      { ru: 'Выйти',     en: 'Sign out' },
  'header.logout_title':{ ru: 'Удалить токен из этого браузера', en: 'Remove token from this browser' },
  'header.lang_switch_title': { ru: 'Switch language', en: 'Switch language' },
  'header.back_to_campaigns_title': { ru: 'К списку кампаний', en: 'Back to campaigns list' },
  'header.app_name':    { ru: 'Mass Actualization', en: 'Mass Actualization' },
  'header.brand_alt':   { ru: 'Immigrant Invest',   en: 'Immigrant Invest' },
  'footer.tagline':     { ru: 'Mass Actualization · Internal tool', en: 'Mass Actualization · Internal tool' },

  // ─── Auth gate ─────────────────────────────────────────────────────────
  'auth.title':           { ru: 'Доступ к Mass Actualization', en: 'Mass Actualization access' },
  'auth.subtitle':        { ru: 'Введите токен доступа, который вы получили от администратора. Он сохранится только в этом браузере.', en: 'Enter the access token you received from the administrator. It will be stored only in this browser.' },
  'auth.token_label':     { ru: 'Токен',     en: 'Token' },
  'auth.token_placeholder': { ru: 'Вставьте токен сюда', en: 'Paste your token here' },
  'auth.submit':          { ru: 'Войти',     en: 'Sign in' },
  'auth.submitting':      { ru: 'Проверяем…', en: 'Verifying…' },
  'auth.empty_token_error': { ru: 'Введите токен', en: 'Enter a token' },
  'auth.footer_note':       { ru: 'Токен хранится локально в этом браузере (localStorage). Если работаете на чужом компьютере — нажмите "Выйти" в шапке после завершения работы.', en: 'Token is stored locally in this browser (localStorage). If you are on a shared machine, click "Sign out" in the header when you are done.' },

  // ─── Loading skeleton ─────────────────────────────────────────────────
  'loading.title':        { ru: 'Загружаем кампанию…', en: 'Loading campaign…' },

  // ─── Error screen ─────────────────────────────────────────────────────
  'error.title':          { ru: 'Не удалось загрузить', en: 'Failed to load' },
  'error.retry':          { ru: 'Повторить',  en: 'Retry' },

  // ─── Done screen ──────────────────────────────────────────────────────
  'done.title':           { ru: 'Все блоки прошли review',  en: 'All blocks reviewed' },
  'done.subtitle':        { ru: 'Кампания готова к публикации.', en: 'Campaign is ready to publish.' },
  'done.back_to_overview': { ru: '← К списку stories', en: '← Back to stories' },

  // ─── Campaigns picker ─────────────────────────────────────────────────
  'campaigns.title':         { ru: 'Кампании', en: 'Campaigns' },
  'campaigns.count':         { ru: '{count} кампаний в работе', en: '{count} campaigns in flight' },
  'campaigns.refresh':       { ru: 'Обновить', en: 'Refresh' },
  'campaigns.new':           { ru: 'Новая кампания', en: 'New campaign' },
  'campaigns.empty':         { ru: 'Пока нет кампаний', en: 'No campaigns yet' },
  'campaigns.empty_subtitle': { ru: 'Запусти первый поиск — это создаст кампанию.', en: 'Run your first search to create one.' },
  'campaigns.empty_cta':     { ru: 'Запустить поиск', en: 'Start a search' },
  'campaigns.item.blocks':       { ru: 'блоков', en: 'blocks' },
  'campaigns.item.updated':      { ru: 'обновлено', en: 'updated' },
  'campaigns.status.empty':  { ru: 'empty',   en: 'empty' },
  'campaigns.status.running':{ ru: 'running', en: 'running' },
  'campaigns.status.ready':  { ru: 'ready',   en: 'ready' },
  'campaigns.status.idle':   { ru: 'idle',    en: 'idle' },
  'campaigns.fmt.reviewed_total': { ru: '{reviewed} из {total} reviewed', en: '{reviewed} of {total} reviewed' },
  'campaigns.fmt.locale':    { ru: 'локаль:', en: 'locale:' },

  // ─── Overview (story list) ────────────────────────────────────────────
  'overview.back':           { ru: 'Все кампании', en: 'All campaigns' },
  'overview.stories_title':  { ru: 'Stories',  en: 'Stories' },
  'overview.stories_subtitle': { ru: '{stories} stories · {blocks} blocks', en: '{stories} stories · {blocks} blocks' },
  'overview.search.running':         { ru: 'Поиск работает в n8n', en: 'Search is running in n8n' },
  'overview.search.idle':            { ru: 'Поиск не запущен',     en: 'Search is idle' },
  'overview.search.empty':           { ru: 'Кампания пуста — поиск ещё не запускали', en: 'Campaign is empty — search not started yet' },
  'overview.search.last_activity':   { ru: 'Последняя активность: {time}', en: 'Last activity: {time}' },
  'overview.search.skip_processed':  { ru: 'Уже обработанные сторис будут пропущены', en: 'Already-processed stories will be skipped' },
  'overview.search.start':           { ru: 'Запустить поиск', en: 'Start search' },
  'overview.search.resume':          { ru: 'Возобновить поиск', en: 'Resume search' },
  'overview.publish.banner.ready':       { ru: 'Готово к публикации', en: 'Ready to publish' },
  'overview.publish.banner.partial':     { ru: 'Готово к частичной публикации', en: 'Ready to partial-publish' },
  'overview.publish.banner.subtitle':    { ru: '{count} блоков можно пушить в Storyblok.', en: '{count} blocks ready for Storyblok.' },
  'overview.publish.banner.unreviewed':  { ru: ' Ещё {count} ждут review — их можно опубликовать позже отдельным заходом.', en: ' Another {count} still need review — you can publish them later in a separate run.' },
  'overview.publish.button':             { ru: '🚀 Опубликовать {count} {word}', en: '🚀 Publish {count} {word}' },
  'overview.publish.button_word_one':    { ru: 'блок',  en: 'block' },
  'overview.publish.button_word_many':   { ru: 'блоков', en: 'blocks' },
  'overview.cascade.banner.title':       { ru: 'Опубликовано в Storyblok (draft)', en: 'Published to Storyblok (draft)' },
  'overview.cascade.banner.subtitle':    { ru: '{count} блоков опубликованы. Проверь в Storyblok admin и опубликуй вручную.', en: '{count} blocks published. Review in Storyblok admin and promote manually.' },
  'overview.cascade.rollback_campaign':  { ru: '↶ Откатить кампанию', en: '↶ Roll back campaign' },
  'overview.story.badge.published':           { ru: '✓ опубликовано',          en: '✓ published' },
  'overview.story.badge.published_partial':   { ru: '✓ опубликовано (частично)', en: '✓ published (partial)' },
  'overview.story.badge.published_title':     { ru: 'В Storyblok как draft',    en: 'Stored in Storyblok as draft' },
  'overview.story.badge.published_partial_title': { ru: 'Часть блоков опубликована, остальные ещё ждут review', en: 'Some blocks published, others still need review' },
  'overview.story.rollback_title':            { ru: 'Откатить эту story в Storyblok к состоянию до публикации (вернётся в очередь review для повторной публикации)', en: 'Roll back this story in Storyblok to pre-publish state (returns to review queue for re-publishing)' },
  'overview.story.translate.queued':       { ru: '🌍 Перевод в очереди…',                  en: '🌍 Translation queued…' },
  'overview.story.translate.triggered':    { ru: '🌍 Переводы запущены: {locales}',        en: '🌍 Translations triggered: {locales}' },
  'overview.story.translate.no_targets':   { ru: '🌍 Переводы не нужны (нет существующих локалей)', en: '🌍 No translations needed (no existing locales)' },
  'overview.story.translate.stale':        { ru: '⚠ Перевод запущен давно — возможно завис', en: '⚠ Translation started a while ago — may be stuck' },
  'overview.story.translate.stale_action': { ru: 'Click чтобы перезапустить', en: 'Click to retry' },
  'overview.story.translate.skipped':      { ru: '🌍 Переводы выключены при cascade', en: '🌍 Translations skipped at cascade time' },
  'overview.story.translate.master.draft':     { ru: '📝 Сохранено как draft', en: '📝 Saved as draft' },
  'overview.story.translate.master.published': { ru: '🚀 Опубликовано в live', en: '🚀 Published live' },
  'overview.story.translate.master_label':     { ru: 'Master: {locale}', en: 'Master: {locale}' },
  'overview.story.translate.triggered_at':     { ru: 'Триггер: {time}', en: 'Triggered: {time}' },
  'overview.resume.message': { ru: 'Запущен. Уже обработанные сторис будут пропущены автоматически.', en: 'Started. Already-processed stories will be skipped automatically.' },
  'overview.resume.no_config': { ru: 'Не нашёл сохранённый конфиг этой кампании в этом браузере. Запусти новую (форма поиска) с тем же campaign_id.', en: 'No saved config for this campaign in this browser. Start a new search with the same campaign_id.' },
  'overview.config.title':       { ru: 'Конфиг поиска',  en: 'Search config' },

  // ─── Story screen (block list) ────────────────────────────────────────
  'story.back':                   { ru: '← Все stories', en: '← All stories' },
  'story.bulk_accept':            { ru: 'Accept all ({count})', en: 'Accept all ({count})' },
  'story.bulk_accepting':         { ru: 'Accepting…', en: 'Accepting…' },
  'story.next_story':             { ru: 'К следующей story →', en: 'Next story →' },
  'story.nothing_left':           { ru: 'В этой story все решено.', en: 'Everything in this story is decided.' },
  'story.field.no_changes':       { ru: '⚠ no changes proposed', en: '⚠ no changes proposed' },
  'story.delete_confirm.title':   { ru: 'Удалить блок?', en: 'Delete block?' },
  'story.delete_confirm.body':    { ru: 'Этот блок будет удалён из story в Storyblok (как draft). Действие отменяемо вручную в Storyblok admin.', en: 'This block will be removed from the story in Storyblok (as draft). Reversible manually in Storyblok admin.' },
  'story.delete_confirm.confirm': { ru: 'Удалить', en: 'Delete' },
  'story.proposed_delete.title':  { ru: 'LLM предлагает удалить весь блок', en: 'LLM proposes to remove the whole block' },
  'story.proposed_delete.body':   { ru: 'Блок устарел и должен быть полностью убран из статьи. Подтверди удаление, либо оставь блок (Skip), либо отредактируй вручную.', en: 'This block is obsolete and should be removed from the article entirely. Confirm deletion, keep it (Skip), or edit manually.' },
  'story.action.accept':            { ru: 'Accept',     en: 'Accept' },
  'story.action.edit':              { ru: 'Edit',       en: 'Edit' },
  'story.action.skip':              { ru: 'Skip',       en: 'Skip' },
  'story.action.delete':            { ru: 'Delete block', en: 'Delete block' },
  'story.action.confirm_delete':    { ru: 'Подтвердить удаление', en: 'Confirm deletion' },
  'story.action.edit_instead':      { ru: 'Отредактировать вместо удаления', en: 'Edit instead of deleting' },
  'story.action.skip_keep':         { ru: 'Skip — оставить блок', en: 'Skip — keep the block' },
  'story.action.save_apply':        { ru: 'Save & Apply', en: 'Save & Apply' },
  'story.action.revert_decision':   { ru: '↶ Откатить решение', en: '↶ Revert decision' },
  'story.action.revert_decision_title': { ru: 'Откатить решение редактора и вернуть блок в очередь', en: 'Revert editor decision and return block to queue' },
  'story.action.rollback_publish':  { ru: '↶ Откатить публикацию', en: '↶ Roll back publish' },
  'story.action.rollback_publish_title': { ru: 'Откатить публикацию ЭТОГО блока (вернёт в Storyblok состояние до cascade\'а; блок снова станет publishable)', en: 'Roll back THIS block\'s publish (restores pre-cascade state in Storyblok; block becomes publishable again)' },
  'story.decided':                  { ru: 'Decided · ', en: 'Decided · ' },
  'story.published_badge':          { ru: '✓ published', en: '✓ published' },
  'story.published_badge_title':    { ru: 'В Storyblok как draft (или published — зависит от mode)', en: 'In Storyblok as draft (or published — depends on mode)' },

  // ─── Skip modal ───────────────────────────────────────────────────────
  'skip.modal.title':       { ru: 'Skip this block', en: 'Skip this block' },
  'skip.modal.subtitle':    { ru: 'Why are you skipping it? (optional but helpful for audit)', en: 'Why are you skipping it? (optional but useful for audit)' },
  'skip.modal.comment_placeholder': { ru: 'Комментарий (опционально)', en: 'Comment (optional)' },
  'skip.modal.submit':      { ru: 'Skip', en: 'Skip' },
  'skip.reason.llm_misunderstood': { ru: 'LLM не понял контекст', en: 'LLM misunderstood the context' },
  'skip.reason.fact_recheck':      { ru: 'Нужна перепроверка фактов', en: 'Needs fact re-check' },
  'skip.reason.complex_case':      { ru: 'Сложный кейс — требует ручной правки', en: 'Complex case — needs manual editing' },
  'skip.reason.other':             { ru: 'Другое', en: 'Other' },

  // ─── Status badges ───────────────────────────────────────────────────
  'status.pending':         { ru: 'pending',         en: 'pending' },
  'status.proposed':        { ru: 'proposed',        en: 'proposed' },
  'status.proposed_delete': { ru: 'proposed_delete', en: 'proposed_delete' },
  'status.accepted':        { ru: 'accepted',        en: 'accepted' },
  'status.edited':          { ru: 'edited',          en: 'edited' },
  'status.skipped':         { ru: 'skipped',         en: 'skipped' },
  'status.deleted':         { ru: 'deleted',         en: 'deleted' },
  'status.error':           { ru: 'error',           en: 'error' },
  'status.to_remove':       { ru: 'to remove',       en: 'to remove' },

  // ─── Search form ─────────────────────────────────────────────────────
  'search.title':           { ru: 'Новая кампания поиска', en: 'New search campaign' },
  'search.subtitle':        { ru: 'Опишите что искать в Storyblok и какие правки предложить.', en: 'Describe what to search for in Storyblok and what edits to propose.' },
  'search.fill_example':    { ru: 'Заполнить пример (Portugal Golden Visa)', en: 'Fill example (Portugal Golden Visa)' },
  'search.field.topic':     { ru: 'Тема кампании', en: 'Campaign topic' },
  'search.field.topic_hint': { ru: 'Короткое название для рассылки в Slack и идентификации', en: 'Short name for Slack notifications and identification' },
  'search.field.campaign_id': { ru: 'ID кампании (auto)', en: 'Campaign ID (auto)' },
  'search.field.campaign_id_hint': { ru: 'Уникальный slug. Дефолт: cmp-<topic-slug>-<locale>-<date>', en: 'Unique slug. Default: cmp-<topic-slug>-<locale>-<date>' },
  'search.field.keyword':   { ru: 'Ключевое слово/фраза для substring-фильтра', en: 'Keyword / phrase for substring filter' },
  'search.field.keyword_hint': { ru: 'Должно быть в блоке, иначе блок отбрасывается. Только дешёвый substring match (без LLM).', en: 'Must appear in the block or it gets discarded. Cheap substring match only (no LLM).' },
  'search.field.block_required': { ru: 'Доп. слова в блоке (опционально, через запятую)', en: 'Extra block-level keywords (optional, comma-separated)' },
  'search.field.block_required_hint': { ru: 'AND-фильтр: ВСЕ перечисленные слова должны быть в блоке.', en: 'AND filter: ALL listed words must appear in the block.' },
  'search.field.article_any':    { ru: 'Слова которые ДОЛЖНЫ быть в статье (опционально, через запятую)', en: 'Words that MUST appear in the article (optional, comma-separated)' },
  'search.field.article_any_hint': { ru: 'OR-фильтр: ХОТЯ БЫ ОДНО из слов в любом блоке статьи.', en: 'OR filter: AT LEAST ONE of the words in any block of the article.' },
  'search.field.context':   { ru: 'Контекст для LLM (когда правка применима)', en: 'Context for the LLM (when the edit applies)' },
  'search.field.context_hint': { ru: 'LLM использует это для отсева false positive matches. Опиши когда правка нужна, а когда — нет.', en: 'LLM uses this to filter out false positive matches. Describe when the edit is needed and when not.' },
  'search.field.locale':    { ru: 'Source locale', en: 'Source locale' },
  'search.field.folder':    { ru: 'Storyblok folder', en: 'Storyblok folder' },
  'search.field.folder_hint': { ru: 'Префикс пути. Пусто = весь space.', en: 'Path prefix. Empty = entire space.' },
  'search.field.content_type': { ru: 'Тип контента (Storyblok component)', en: 'Content type (Storyblok component)' },
  'search.field.rewrite':   { ru: 'Промпт для LLM rewrite (как переписать)', en: 'LLM rewrite prompt (how to rewrite)' },
  'search.field.rewrite_hint': { ru: 'Этот промпт LLM использует для каждого matched-блока. Editor сможет override через Edit & Accept.', en: 'LLM uses this prompt on each matched block. Editor can override via Edit & Accept.' },
  'search.field.dry_run':   { ru: 'Dry run (без записи в Storyblok)', en: 'Dry run (no writes to Storyblok)' },
  'search.field.dry_run_hint': { ru: 'Прогон без записи в Storyblok (только в campaign_blocks Data Table). Editor затем review\'ит и approves\'ит. Default ON — снимать только после явного подтверждения.', en: 'Run without writing to Storyblok (only the campaign_blocks Data Table). Editor reviews and approves later. Default ON — uncheck only after explicit confirmation.' },
  'search.submit':          { ru: 'Запустить поиск', en: 'Start search' },
  'search.submitting':      { ru: 'Запускаем…', en: 'Starting…' },
  'search.cancel_back':     { ru: '← Назад', en: '← Back' },
  'search.progress.queued':     { ru: 'Поставлено в очередь…', en: 'Queued…' },
  'search.progress.fetching':   { ru: 'Грузим stories из Storyblok…', en: 'Fetching stories from Storyblok…' },
  'search.progress.filtering':  { ru: 'LLM context filter…', en: 'LLM context filter…' },
  'search.progress.rewriting':  { ru: 'LLM rewrite proposals…', en: 'LLM rewrite proposals…' },
  'search.progress.real_note':  { ru: 'Запускаем pipeline: mAPI fetch → substring filter → LLM context filter → LLM rewrite. Обычно 5–15 минут для всего blog-tree (~1000 stories), может больше при долгом cold start n8n.', en: 'Starting pipeline: mAPI fetch → substring filter → LLM context filter → LLM rewrite. Usually 5–15 min for the whole blog tree (~1000 stories), longer if n8n is cold-starting.' },
  'search.done.title':      { ru: 'Поиск запущен', en: 'Search started' },
  'search.done.subtitle':   { ru: 'Pipeline работает в фоне. Slack-уведомление в #translation-reports когда proposals готовы — это 5–15 минут типично.', en: 'Pipeline running in background. Slack ping in #translation-reports once proposals are ready — typically 5–15 min.' },
  'search.done.campaign_id_label': { ru: 'campaign_id', en: 'campaign_id' },
  'search.done.queued_at_label':   { ru: 'queued at',   en: 'queued at' },
  'search.done.new':        { ru: 'Новая campaign', en: 'New campaign' },
  'search.done.open_review':{ ru: 'Открыть очередь review →', en: 'Open review queue →' },
  'search.done.empty_note': { ru: 'Очередь будет пустой пока pipeline не закончит запись в campaign_blocks. Откроется автоматически когда строки появятся.', en: 'Queue will be empty until the pipeline finishes writing to campaign_blocks. Opens automatically once rows appear.' },

  // ─── Publish (cascade) modal ─────────────────────────────────────────
  'publish.modal.title':         { ru: '🚀 Опубликовать кампанию', en: '🚀 Publish campaign' },
  'publish.modal.intro':         { ru: 'В Storyblok через management API будут запушены ', en: 'Via the Storyblok management API we will push ' },
  'publish.modal.intro_count':   { ru: ' уже принятых/изменённых/удалённых блока.', en: ' already-decided (accepted/edited/deleted) blocks.' },
  'publish.modal.intro_unreviewed': { ru: ' Ещё {count} блоков ждут твоего решения — они не попадут в этот pуш и останутся видимыми в очереди review.', en: ' Another {count} blocks still need your decision — they will not be included in this push and remain in the review queue.' },
  'publish.modal.intro_phase2b': { ru: 'Перевод на другие локали — отдельным шагом, пока только source-локаль.', en: 'Translation to other locales is a separate step; for now, source locale only.' },
  'publish.modal.source_label':  { ru: 'Источник', en: 'Source' },
  'publish.modal.source_master_suffix': { ru: ' (master)', en: ' (master)' },
  'publish.modal.source_hint':   { ru: 'Запись идёт в базовые поля Storyblok без __i18n__ суффикса.', en: 'Writes go to base Storyblok fields without __i18n__ suffix.' },
  'publish.modal.mode_label':    { ru: 'Режим', en: 'Mode' },
  'publish.modal.mode_draft':    { ru: 'Draft (рекомендуется)', en: 'Draft (recommended)' },
  'publish.modal.mode_draft_hint': { ru: 'Сохранить как draft в Storyblok. Редактор открывает Storyblok admin, проверяет визуально, публикует руками.', en: 'Save as draft in Storyblok. Editor opens Storyblok admin, reviews visually, publishes manually.' },
  'publish.modal.mode_publish':  { ru: '⚡ Опубликовать сразу', en: '⚡ Publish immediately' },
  'publish.modal.mode_publish_hint': { ru: 'Изменения немедленно становятся live на сайте. Откат возможен через snapshot, но между cascade и rollback зрители увидят новую версию.', en: 'Changes go live on the site immediately. Rollback via snapshot is possible, but between cascade and rollback viewers will see the new version.' },
  'publish.modal.safety_note':   { ru: 'Безопасность: до cascade\'а каждой story сохраняется снапшот её предыдущего состояния. Можно откатить отдельную story или всю кампанию из overview.', en: 'Safety: before each story\'s cascade we snapshot its previous state. You can roll back a single story or the whole campaign from overview.' },
  'publish.modal.submit_draft':  { ru: 'Сохранить draft', en: 'Save as draft' },
  'publish.modal.submit_publish': { ru: '⚡ Опубликовать сразу', en: '⚡ Publish immediately' },
  'publish.modal.submitting':    { ru: 'Запускаем…', en: 'Starting…' },

  // ─── Help modal ──────────────────────────────────────────────────────
  'help.title':            { ru: 'Keyboard shortcuts', en: 'Keyboard shortcuts' },
  'help.section.story':    { ru: 'Story review',  en: 'Story review' },
  'help.section.overview': { ru: 'Overview',      en: 'Overview' },
  'help.section.anywhere': { ru: 'Anywhere',      en: 'Anywhere' },
  'help.shortcut.next_block':       { ru: 'Focus next block',           en: 'Focus next block' },
  'help.shortcut.prev_block':       { ru: 'Focus previous block',       en: 'Focus previous block' },
  'help.shortcut.accept':           { ru: 'Accept focused block',       en: 'Accept focused block' },
  'help.shortcut.bulk_accept':      { ru: 'Accept all remaining in this story', en: 'Accept all remaining in this story' },
  'help.shortcut.edit':             { ru: 'Edit & Accept',              en: 'Edit & Accept' },
  'help.shortcut.skip':             { ru: 'Skip focused block',         en: 'Skip focused block' },
  'help.shortcut.delete':           { ru: 'Delete focused block',       en: 'Delete focused block' },
  'help.shortcut.undo':             { ru: 'Откатить решение по блоку (undo)', en: 'Undo block decision' },
  'help.shortcut.next_story':       { ru: 'Save & Next Story',          en: 'Save & Next Story' },
  'help.shortcut.back':             { ru: 'Back to overview',           en: 'Back to overview' },
  'help.shortcut.escape':           { ru: 'Close modal / cancel edit / unfocus', en: 'Close modal / cancel edit / unfocus' },
  'help.shortcut.next_story_o':     { ru: 'Focus next story',           en: 'Focus next story' },
  'help.shortcut.prev_story':       { ru: 'Focus previous story',       en: 'Focus previous story' },
  'help.shortcut.open_story':       { ru: 'Open focused story',         en: 'Open focused story' },
  'help.shortcut.help_toggle':      { ru: 'Toggle this help',           en: 'Toggle this help' },
  'help.shortcut.help_close':       { ru: 'Close help overlay',         en: 'Close help overlay' },

  // ─── Toast / errors (dynamic) ────────────────────────────────────────
  'toast.action_failed':           { ru: 'Действие не сохранилось: {message}. Состояние возвращено.', en: 'Action did not save: {message}. State restored.' },
  'toast.cascade_started_draft':   { ru: 'Cascade запущен: контент сохранён как draft. {tail}', en: 'Cascade started: content saved as draft. {tail}' },
  'toast.cascade_started_publish': { ru: 'Cascade запущен: контент опубликован. {tail}', en: 'Cascade started: content published. {tail}' },
  'toast.cascade_queued_tail':     { ru: 'Ждём бэк (полминуты-минута).', en: 'Waiting for backend (30–60s).' },
  'toast.story_rolled_back':       { ru: 'Story откачена.', en: 'Story rolled back.' },
  'toast.campaign_rolled_back':    { ru: 'Кампания откачена.', en: 'Campaign rolled back.' },
  'toast.block_rolled_back':       { ru: 'Блок откачен.', en: 'Block rolled back.' },
  'toast.translate_triggered':     { ru: 'Перевод триггернут.', en: 'Translation triggered.' },
  'confirm.rollback_block':        { ru: 'Откатить этот блок к состоянию до публикации? Остальные блоки story не тронем.', en: 'Roll back this block to pre-publish state? Other blocks of the story will not be affected.' },
  'confirm.rollback_story':        { ru: 'Откатить story {id} в Storyblok к состоянию до публикации?', en: 'Roll back story {id} in Storyblok to pre-publish state?' },
  'confirm.rollback_campaign':     { ru: 'Откатить ВСЮ кампанию в Storyblok к состоянию до публикации? Это затронет все опубликованные stories.', en: 'Roll back the ENTIRE campaign in Storyblok to pre-publish state? This affects every published story.' },

  // ─── Story footer / done (extras for templates) ──────────────────────
  'story.footer.back_to_stories':  { ru: '← Список stories', en: '← Stories list' },
  'story.footer.accept_remaining': { ru: 'Accept all remaining ({count})', en: 'Accept all remaining ({count})' },
  'story.footer.accepting':        { ru: 'Accepting…', en: 'Accepting…' },
  'story.footer.save_next':        { ru: 'Save & Next Story →', en: 'Save & Next Story →' },
  'done.title_alt':                { ru: 'Campaign reviewed', en: 'Campaign reviewed' },
  'done.subtitle_alt':             { ru: 'Все блоки кампании рассмотрены. Drafts записаны в Storyblok. Опубликовать драфты вручную в Storyblok admin, потом запустить cascade-translation workflow в n8n.', en: 'All blocks of this campaign have been reviewed. Drafts saved to Storyblok. Publish them manually in Storyblok admin, then run the cascade-translation workflow in n8n.' },
  'done.metric.accepted_edited':   { ru: 'accepted / edited', en: 'accepted / edited' },
  'done.metric.skipped':           { ru: 'skipped', en: 'skipped' },
  'done.metric.deleted':           { ru: 'deleted', en: 'deleted' },
  'done.metric.errors':            { ru: 'errors', en: 'errors' },

  // ─── Search form (extras to match current template) ──────────────────
  'search.back':                   { ru: 'Назад', en: 'Back' },
  'search.section.new_campaign':   { ru: 'New campaign', en: 'New campaign' },
  'search.section.find_articles':  { ru: 'Find affected articles', en: 'Find affected articles' },
  'search.intro':                  { ru: 'Запусти поиск кандидатов в Storyblok для массовой актуализации. LLM rewrite предлагается автоматически и попадает в очередь review.', en: 'Start a candidate search in Storyblok for mass actualisation. LLM rewrite is proposed automatically and lands in the review queue.' },
  'search.section.campaign_meta':  { ru: 'Campaign meta', en: 'Campaign meta' },
  'search.section.search':         { ru: 'Search', en: 'Search' },
  'search.section.rewrite_policy': { ru: 'Rewrite policy', en: 'Rewrite policy' },
  'search.fill_example_short':     { ru: 'Заполнить примером', en: 'Fill with example' },
  'search.field.topic_label':      { ru: 'Campaign topic', en: 'Campaign topic' },
  'search.field.topic_hint_alt':   { ru: 'Человеческое имя кампании. Используется в Sheet и Slack.', en: 'Human-readable campaign name. Used in the Sheet and Slack.' },
  'search.field.campaign_id_label': { ru: 'Campaign ID', en: 'Campaign ID' },
  'search.field.optional_paren':   { ru: '(опционально)', en: '(optional)' },
  'search.field.campaign_id_hint_alt': { ru: 'Если пусто — генерится из topic + даты.', en: 'If empty, generated from topic + date.' },
  'search.field.keyword_label':    { ru: 'Keyword', en: 'Keyword' },
  'search.field.keyword_hint_alt': { ru: 'JS substring match (case-insensitive). Пре-фильтр перед LLM — отсеивает ~80% блоков бесплатно.', en: 'JS substring match (case-insensitive). Pre-filter before the LLM — drops ~80% of blocks for free.' },
  'search.field.block_required_label': { ru: 'Block must also contain (AND)', en: 'Block must also contain (AND)' },
  'search.field.block_required_hint_alt': { ru: 'Comma-separated. Блок попадёт в выборку только если в нём есть Keyword <strong>и</strong> ВСЕ эти термы (case-insensitive). Пусто → проверяется только Keyword.', en: 'Comma-separated. A block is selected only if it contains Keyword <strong>and</strong> ALL these terms (case-insensitive). Empty → only Keyword is checked.' },
  'search.field.article_any_label': { ru: 'Article must contain at least one of (OR)', en: 'Article must contain at least one of (OR)' },
  'search.field.article_any_hint_alt': { ru: 'Comma-separated. Стори целиком пропускается если в её body нет ни одного из этих термов. Самый дешёвый и эффективный способ отсеять не-релевантные статьи.', en: 'Comma-separated. The whole story is skipped if its body has none of these terms. Cheapest and most effective way to drop irrelevant articles.' },
  'search.field.context_label':    { ru: 'Context description', en: 'Context description' },
  'search.field.context_hint_alt': { ru: 'Промпт для LLM — определяет какие hits релевантны. Чем точнее, тем меньше false positives.', en: 'Prompt for the LLM — determines which hits are relevant. The more precise, the fewer false positives.' },
  'search.field.source_locale_label': { ru: 'Source locale', en: 'Source locale' },
  'search.field.source_locale_hint': { ru: 'Фильтр по seo[0].originalLanguage.', en: 'Filter by seo[0].originalLanguage.' },
  'search.field.locale_opt_ru':    { ru: 'RU — Russian originals (493 articles)', en: 'RU — Russian originals (493 articles)' },
  'search.field.locale_opt_en':    { ru: 'EN — English originals (526 articles)', en: 'EN — English originals (526 articles)' },
  'search.field.folder_label':     { ru: 'Folder', en: 'Folder' },
  'search.field.folder_hint_alt':  { ru: 'Storyblok starts_with filter.', en: 'Storyblok starts_with filter.' },
  'search.field.content_type_label': { ru: 'Content type', en: 'Content type' },
  'search.field.rewrite_label':    { ru: 'Global rewrite prompt', en: 'Global rewrite prompt' },
  'search.field.rewrite_hint_alt': { ru: 'Этот промпт LLM использует для каждого matched-блока. Editor сможет override через Edit & Accept.', en: 'LLM uses this prompt on each matched block. Editor can override via Edit & Accept.' },
  'search.field.dry_run_label':    { ru: 'Dry-run mode', en: 'Dry-run mode' },
  'search.field.dry_run_hint_alt': { ru: 'Прогон без записи в Storyblok (только в campaign_blocks Data Table). Editor затем review\'ит и approves\'ит. <strong>Default ON</strong> — снимать только после явного подтверждения.', en: 'Run without writing to Storyblok (only the campaign_blocks Data Table). Editor reviews and approves later. <strong>Default ON</strong> — uncheck only after explicit confirmation.' },
  'search.cancel':                 { ru: 'Отмена', en: 'Cancel' },
  'search.submit_alt':             { ru: 'Запустить поиск', en: 'Start search' },
  'search.error_prefix':           { ru: 'Не удалось запустить: ', en: 'Failed to start: ' },
  'search.progress.queued_label':  { ru: 'Triggering n8n workflow…', en: 'Triggering n8n workflow…' },
  'search.progress.fetching_label': { ru: 'Fetching Storyblok stories…', en: 'Fetching Storyblok stories…' },
  'search.progress.filtering_label': { ru: 'LLM context filter…', en: 'LLM context filter…' },
  'search.progress.rewriting_label': { ru: 'LLM rewrite proposals…', en: 'LLM rewrite proposals…' },
  'search.progress.untitled':      { ru: 'Untitled campaign', en: 'Untitled campaign' },
  'search.progress.long_note':     { ru: 'Запускаем pipeline: mAPI fetch → substring filter → LLM context filter → LLM rewrite. Обычно <strong class="text-[var(--imin-text)]">5–15 минут</strong> для всего blog-tree (~1000 stories), может больше при долгом cold start n8n.', en: 'Starting pipeline: mAPI fetch → substring filter → LLM context filter → LLM rewrite. Usually <strong class="text-[var(--imin-text)]">5–15 min</strong> for the whole blog tree (~1000 stories), longer if n8n is cold-starting.' },
  'search.done.slack_note':        { ru: 'Pipeline работает в фоне. Slack-уведомление в <code class="font-mono text-xs bg-[var(--imin-fill)] px-1.5 py-0.5 rounded">#translation-reports</code> когда proposals готовы — это 5–15 минут типично.', en: 'Pipeline running in background. Slack ping in <code class="font-mono text-xs bg-[var(--imin-fill)] px-1.5 py-0.5 rounded">#translation-reports</code> once proposals are ready — typically 5–15 min.' },

  // ─── Publish modal (extras to match current template wording) ────────
  'publish.modal.intro_phase2b_alt': { ru: 'Перевод на другие локали — отдельным шагом (Phase 2B), пока только source-локаль.', en: 'Translation to other locales is a separate step (Phase 2B); for now, source locale only.' },
  'publish.modal.source_label_alt': { ru: 'Источник', en: 'Source' },
  'publish.modal.mode_label_alt':  { ru: 'Режим', en: 'Mode' },
  'publish.modal.safety_prefix':   { ru: 'Безопасность:', en: 'Safety:' },
  'publish.modal.safety_body':     { ru: ' до cascade\'а каждой story сохраняется снапшот её предыдущего состояния. Можно откатить отдельную story или всю кампанию из overview.', en: ' before each story\'s cascade we snapshot its previous state. You can roll back a single story or the whole campaign from overview.' },

  // ─── Global error toast ──────────────────────────────────────────────
  'toast.global_error_title':      { ru: 'Ошибка', en: 'Error' },
  'toast.click_to_dismiss':        { ru: 'click to dismiss', en: 'click to dismiss' },

  // ─── Skip reasons (used in app.js skipReasonOptions) ─────────────────
  // Already covered by skip.reason.* keys above.
};

/**
 * Format an ISO date for tooltips/UI text using the active locale.
 * Falls back to ISO if Intl is not available.
 */
export function formatDateTime(iso, locale) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const tag = locale === 'en' ? 'en-US' : 'ru-RU';
    return d.toLocaleString(tag);
  } catch {
    return iso;
  }
}
