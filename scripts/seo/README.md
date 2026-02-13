# SEO Pipeline (Keywords Everywhere + DataForSEO)

This is a repo-local SEO automation pipeline driven by a config JSON + `.env`.

## Env

Create `.env` (already gitignored) with:

- `KEYWORDS_EVERYWHERE_API_KEY=...`
- `DATAFORSEO_LOGIN=...`
- `DATAFORSEO_PASSWORD=...`

Example: `docs/seo/seo.env.example`

## Config

Start from `docs/seo/seo.config.example.json` and set:

- `target.domain`
- `seedKeywords`
- `competitors`
- optional `verticals`

## Run

Dry run (no API calls, generates placeholder artifacts):

```bash
node scripts/seo/run.mjs --config=docs/seo/seo.config.example.json --mode=all --dry-run=true
```

Live run (calls KE + DataForSEO):

```bash
node scripts/seo/run.mjs --config=docs/seo/seo.config.example.json --mode=all
```

## Outputs

Writes to `artifacts/seo/<run-id>/`:

- `universe.keywords.json` / `.txt`
- `metrics.keyword_overview.json` / `.csv`
- `calendar.rows.csv` + `calendar.clusters.json`
- `pages/` + `pages.manifest.json` (draft landing pages)
- `serp.gaps.csv` + `serp.top.json`
- `linkgap.domain_intersection.raw.json`
- `audit.onpage.instant_pages.raw.json`
- `run.summary.json`

## Notes

- Link building output is intentionally “prep”: it does not scrape personal emails or send email automatically.
- Technical audit output is a raw On-Page payload starter. Once you point this at a website repo/framework, we can generate concrete patches.
