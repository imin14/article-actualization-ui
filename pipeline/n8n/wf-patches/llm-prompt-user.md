=Story: {{ $json.story_full_slug }}
Topic: {{ $('Init Campaign Meta').first().json.context_description }}
Keyword (substring): {{ $('Init Campaign Meta').first().json.keyword }}
Rewrite instruction: {{ $('Init Campaign Meta').first().json.rewrite_prompt }}

MATCHED BLOCKS ({{ $json.match_count }}):
{{ JSON.stringify(($json.matches || []).map((m, i) => ({ index: i, _uid: m._uid, component: m.component, affected_fields: m.affected_fields, hit_paragraphs: m.field_hits, original_field_text: m.payload }))) }}

Return EXACTLY {{ $json.match_count }} verdicts in input order.

⚠ YOU CHOOSE ONE ACTION PER BLOCK: EDIT (diff-style {old,new}) OR DELETE (whole block) ⚠

For each verdict:

- index: integer 0..{{ $json.match_count - 1 }} matching input order.

- match: boolean.
  - true ONLY when the keyword refers to the topic AND action is needed.
  - false for unrelated mentions ("5 stars", "топ-5", brand names, different jurisdictions, statistics, "5 лет" про родителей/инвестиции и т.п.)

- delete_block: boolean (default false).
  - Set true ONLY when the ENTIRE block is obsolete per the topic context (e.g., "Possible upcoming changes" section when the change has already happened).
  - When true → `edits: []` (deletion supersedes editing).
  - When false → use edits to make surgical changes.

- reason: ONE short sentence explaining the verdict.

- edits: array of `{old, new}` pairs.
  - When match=false OR delete_block=true: `[]` empty.
  - When match=true and delete_block=false: one or more pairs.
    * `old` = VERBATIM substring from original (5-15 words context for uniqueness).
    * `new` = same phrase with ONLY spec-conflicting words changed.

  Examples:

  ✅ EDIT — surgical replacement:
  ```
  {"index": 0, "match": true, "delete_block": false,
   "reason": "Block states 5-year naturalisation timeline that needs updating to 10",
   "edits": [
     {"old": "После 5 лет резиденции открывается путь к гражданству",
      "new": "После 10 лет резиденции открывается путь к гражданству (7 лет — для граждан Евросоюза и португалоязычных стран)"}
   ]}
  ```

  ✅ DELETE — entire block obsolete:
  ```
  {"index": 1, "match": true, "delete_block": true,
   "reason": "This 'Possible changes' section is obsolete — law was signed 3 May 2026 and is now in effect",
   "edits": []}
  ```

  ✅ SKIP — unrelated:
  ```
  {"index": 2, "match": false, "delete_block": false,
   "reason": "5-year mention here refers to parent's residence requirement for child citizenship — separate rule, unchanged",
   "edits": []}
  ```

  ❌ WRONG — too short edit, would replace unrelated "5":
  ```
  "edits": [{"old": "5", "new": "10"}]
  ```

  ❌ WRONG — paraphrased, won't match verbatim:
  ```
  "edits": [{"old": "после пяти лет жизни в стране", "new": "после десяти лет жизни"}]
  ```

  ❌ WRONG — full block rewrite (this is the OLD behavior):
  ```
  "edits": [{"old": "<entire 2000-char block>", "new": "<entire 2000-char block with one word changed>"}]
  ```
