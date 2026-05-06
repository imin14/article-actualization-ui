# Patch: добавить `revert` action в WF-UIBackend

Это позволит редактору откатывать решения по блокам (вернуть в `proposed`).

## 1. Validate POST body — обновить Code

В ноде **`Validate POST body`** заменить тело Code на:

```js
const ALLOWED_ORIGINS = ['https://imin.github.io', 'http://localhost:8080'];
const DEFAULT_ORIGIN = 'https://imin.github.io';
const VALID_ACTIONS = ['accept', 'edit', 'skip', 'delete', 'revert'];
const SAFETY_DRY_RUN = true;
const item = $input.first().json || {};
const headers = item.headers || {};
const origin = headers.origin || headers.Origin || '';
const corsOrigin = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : DEFAULT_ORIGIN;
const body = item.body || {};
const rowId = String(body.row_id || '').trim();
const action = String(body.action || '').trim();
const campaignId = String(body.campaign_id || '').trim();
if (!rowId || !action) {
  return [{ json: { __error: 'row_id and action are required', __status: 400, __cors_origin: corsOrigin } }];
}
if (VALID_ACTIONS.indexOf(action) < 0) {
  return [{ json: { __error: 'invalid action; expected accept|edit|skip|delete|revert', __status: 400, __cors_origin: corsOrigin } }];
}
const editedPayloadStr = body.edited_payload ? JSON.stringify(body.edited_payload) : '';
const skipReasonStr = body.skip_reason ? JSON.stringify(body.skip_reason) : '';
const newStatus = action === 'accept' ? 'accepted'
  : action === 'edit' ? 'edited'
  : action === 'skip' ? 'skipped'
  : action === 'delete' ? 'deleted'
  : 'proposed'; // revert → back to proposed
return [{ json: { row_id: rowId, campaign_id: campaignId, action, new_status: newStatus, edited_payload_str: editedPayloadStr, skip_reason_str: skipReasonStr, updated_at: new Date().toISOString(), safety_dry_run: SAFETY_DRY_RUN, __cors_origin: corsOrigin } }];
```

## 2. Route by action — добавить 5-й rule

В switchCase ноде **`Route by action`** добавить новое правило (Add rule):
- Output Name: `revert`
- Conditions: `{{ $json.action }}` equals `revert`

## 3. Создать ноду `Update row → reverted`

Скопировать ноду **`Update row → deleted`** (правый клик → Duplicate), переименовать в `Update row → reverted`, и в **Columns to send** добавить:

| Column        | Type       | Value                                        |
|---------------|------------|----------------------------------------------|
| status        | (string)   | `={{ $json.new_status }}` *(уже есть)*       |
| updated_at    | (date)     | `={{ $json.updated_at }}` *(уже есть)*       |
| edited_payload| (string)   | *(пустая строка — оставить value пустым)*    |
| skip_reason   | (string)   | *(пустая строка — оставить value пустым)*    |

Это очистит и `edited_payload`, и `skip_reason` при откате — следующее решение редактора начинается с чистого листа.

## 4. Подключить новую ноду

- Соединить выход **`revert`** ноды `Route by action` → вход `Update row → reverted`
- Соединить выход `Update row → reverted` → вход `Build POST ok`

## 5. Сохранить + activate

После этого SPA сможет дёргать `/webhook/campaign-action` с `action: 'revert'` и блок вернётся в `proposed`.

## Проверка после деплоя

В DevTools браузера на странице кампании:

```js
const API = new URLSearchParams(location.search).get('api');
const TOKEN = localStorage.getItem('actualization_ui_token_v1');
const CAMPAIGN = new URLSearchParams(location.search).get('campaign');
// Возьми любой row_id со статусом 'accepted' или 'skipped' и подставь:
const ROW = '<paste row_id here>';
const r = await fetch(`${API}/webhook/campaign-action`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: TOKEN },
  body: JSON.stringify({ campaign_id: CAMPAIGN, row_id: ROW, action: 'revert' }),
});
console.log(r.status, await r.json());
// Ожидаем: 200, { status: 'ok', new_status: 'proposed', row_id: ROW, dry_run: true }
```
