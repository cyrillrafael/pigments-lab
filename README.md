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
