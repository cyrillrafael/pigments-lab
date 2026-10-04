# pigments-lab

Working notebook alongside [cyrillrafael.org](https://cyrillrafael.org) — pigment chemistry research, sketchbook pages, backstage workshop material, and residency/grant reports.

Static Jekyll site, same visual language (Menlo, gradient, tints) as the portfolio. Deploys to GitHub Pages on push to `main` via `.github/workflows/jekyll.yml`.

## Structure

- `pigments.md`, `sketchbooks.md`, `workshop.md` — image galleries, driven by `_data/{category}.json`
- `reports.md` — grant reports / notes, grouped by residency, driven by `_data/reports.json`
- `_data/residencies.json` — known residencies/journeys (slug, label, place, year); extensible
- `admin.md` + `assets/js/admin.js` — password-gated upload form that commits files straight to the repo via the GitHub Contents API (see the warning on that page — it's obscurity, not real security; the actual write boundary is a GitHub token the admin supplies each session)

## Adding content without the admin page

Drop an image into `pigments/`, `sketchbooks/`, or `workshop/`, and add a matching entry to the corresponding `_data/*.json`:

```json
{ "file": "your-image.jpg", "caption": "optional", "residency": "general", "date": "2026-09-11" }
```

For `reports/`, same idea in `_data/reports.json`, with a `"title"` instead of relying on the filename.

## Local dev

```
bundle install
bundle exec jekyll serve
```

## Weights (Open Weight Watch)

`/weights/` reads open-weight language models as paint: each published weight set is a **pigment** (a lab's hue, rated for lightfastness = licence tier, transparency = training-data disclosure, granulation = mixture-of-experts), and each piece of software built from them is a **mosaic** whose tesserae are evidence of use (derivative repos in the runtime's native format, or models a Hugging Face Space declares).

- `scripts/openweightwatch/registry/` — curated inputs: `labs.json` (lab → pigment), `pigments.json` (weight sets with openness fields and Hub ids or search hints), `runtimes.json` (GitHub projects → formats), `licenses.json`
- `scripts/openweightwatch/fetch.mjs` — pulls live data from the Hugging Face Hub and GitHub and writes `weights/data/watch.json` (not committed). Zero dependencies, Node 20+. Per-item failures fall back to the last published values.
- `weights.html` + `assets/js/weights.js` — the browseable page
- `.github/workflows/jekyll.yml` rebuilds the site every 3 hours (`17 */3 * * *`) so the data lags by at most a few hours. An optional `HF_TOKEN` repository secret raises Hub rate limits. `weights-check.yml` runs the pipeline on feature branches without deploying.

```
node --test scripts/openweightwatch/*.test.mjs   # unit + end-to-end tests (no network)
node scripts/openweightwatch/fetch.mjs           # live build into weights/data/watch.json
```

To add a weight set, append an entry to `registry/pigments.json`; to add a mosaic, append to `registry/runtimes.json`.
