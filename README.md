# Mass Actualization UI

Static SPA for reviewing LLM-proposed rewrites of Storyblok blocks during mass content actualization campaigns. See `docs/superpowers/specs/2026-05-04-mass-actualization-tool-design.md` for the full design.

## Local development

```
npm install
npm run serve         # serves index.html at http://localhost:8080
npm test              # run unit tests
npm run test:watch    # tests in watch mode
```

## Deployment

Push to `main` of the GitHub repo. GitHub Pages will serve `index.html` from the root.

The product is a single static HTML page. No build step. Files are loaded directly by the browser via ES modules.

## Backend contract

The frontend talks to n8n webhooks defined in `lib/api.js`. While the backend is being built, the API client runs in mock mode (set in `lib/api.js`). To switch to real backend, change the `API_MODE` constant and provide the backend URL + bearer token.
