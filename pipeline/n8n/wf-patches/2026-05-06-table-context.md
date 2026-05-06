# Patch: table-cell context for LLM (2026-05-06)

Fixes LLM false-positives when a table cell ("Через 5 лет") matches a keyword
but its meaning is anchored to the column header / row label of the table —
which the LLM can't see because we only pass the cell's payload.

Editor reported: in `citizenship-argentina` story the LLM flagged Antigua's
and Saint Lucia's "Через 5 лет" (investment-return period) as Portugal
naturalisation hits. The cell text alone is ambiguous; with column
"Возврат инвестиций" + row "Антигуа и Барбуда" it's obvious.

## Two-node manual patch

Until the SDK source is reconciled with prod, paste these by hand into the
deployed workflow `jIVm69uTSn9iL3GX`.

### 1. "Substring Filter (bulk)" — replace jsCode

See `substring-filter-patched.js` next to this file.

Changes vs. deployed:
- `walkBlocks` now threads a `parentTable` argument through recursion.
  Whenever a block has a `rows` array (table / flat_table), it becomes the
  parent for descendants. Emitted blocks carry `_parentTable` when they are
  cells inside a table.
- New helpers `extractFlatText` and `buildTableContext` derive
  `{column, row_label, row_index, cell_index}` from the parent table + path.
- Just before each `matched.push(...)` we attach `table_context` to the
  matched record (null for non-table blocks).
- `_parentTable` is stripped before push (debug-only, not persisted).

### 2. "LLM Classify + Rewrite" prompt — two edits

In the user prompt (the long `text` field), in the line that builds
MATCHED BLOCKS JSON, add `table_context: m.table_context` to the mapped
fields:

  Before:
    {{ JSON.stringify(($json.matches || []).map((m, i) => ({
      index: i, _uid: m._uid, component: m.component,
      affected_fields: m.affected_fields,
      hit_paragraphs: m.field_hits,
      original_field_text: m.payload
    }))) }}

  After:
    {{ JSON.stringify(($json.matches || []).map((m, i) => ({
      index: i, _uid: m._uid, component: m.component,
      affected_fields: m.affected_fields,
      hit_paragraphs: m.field_hits,
      table_context: m.table_context,
      original_field_text: m.payload
    }))) }}

In the system message, append this paragraph before "## VERDICT RULES":

  ## TABLE CELLS

  When a block has `table_context` (column + row_label), the cell text
  must be interpreted IN THAT CONTEXT, not in isolation. A cell saying
  "Через 5 лет" in column "Возврат инвестиций" / row "Антигуа и
  Барбуда" refers to investment-return period for Antigua — NOT to the
  campaign's keyword scope. Set match=false. Only set match=true when
  the column AND row label both align with the campaign topic
  (e.g. column "Срок натурализации" / row "Португалия" with cell
  "5 лет" — that is a hit).

Save → re-publish.
