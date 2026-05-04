# pipeline/

These modules are designed to be pasted into n8n Code nodes (or imported by an n8n function tool when n8n grows that capability). They are NOT loaded by the frontend SPA.

They live here so they're tested by the same CI as the SPA. Sync changes to n8n manually for now.

## Modules

- `tokenize.js` — heuristic token counting (chars/4 Latin, /2 Cyrillic) + budget truncation
- `chunking.js` — paragraph splitting + context window extraction
- `search-strategy.js` — orchestration: per-block hit detection, classification prompt, rewrite prompt

## Tests

Tests sit beside their modules (`*.test.js`). Run via `npm test` from the repo root — Vitest picks them up via the `pipeline/**/*.test.js` glob in `vitest.config.js`.
