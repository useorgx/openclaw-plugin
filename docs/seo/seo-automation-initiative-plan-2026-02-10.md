# SEO Automation Initiative Plan (Keywords Everywhere + DataForSEO)

Updated: 2026-02-10

Goal: build an end-to-end SEO “automation loop” you can run from a repo with a `.env` containing:
- `KEYWORDS_EVERYWHERE_API_KEY`
- DataForSEO credentials (`DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD`)

Outputs (checked into `artifacts/seo/<run>/` or exported elsewhere):
- Full keyword universe (expanded via KE related + PASF)
- Keyword metrics (volume/KD/etc from DataForSEO Labs keyword overview)
- SERP gap analysis (who ranks, where you rank, SERP features)
- Clustered content calendar (prioritized)
- Programmatic landing-page drafts (Markdown/MDX + schema)
- Link gap list (domains linking to competitors but not you)
- Internal linking map suggestions
- Technical audit report (DataForSEO On-Page) + fix plan (recommendations)

Non-goals (for this repo): automatically committing fixes into your production website codebase (we can generate patches once the website repo/framework is available).

## Workstreams

1) Keyword Universe
- Expand seed keywords via:
  - Keywords Everywhere related keywords
  - Keywords Everywhere People Also Search For (PASF)
- Deduplicate, normalize, and persist.

2) Metrics + Prioritization
- Fetch keyword metrics via DataForSEO Labs keyword overview (search volume, CPC, competition, keyword difficulty where available).
- Produce a priority score for each term and cluster.

3) SERP Gap Analysis
- For selected keywords (top by priority / intent), pull SERPs via DataForSEO SERP API.
- Determine:
  - Is target domain ranking (and at what position)?
  - Competitors dominating?
  - SERP features (PAA, videos, local pack, etc).

4) Content Calendar + Clustering
- Cluster keywords into topics.
- Assign suggested “page type” (landing page, comparison, integration, guide, template).
- Output calendar rows with recommended slug, title/H1, meta description stub, primary/secondary keywords.

5) Programmatic Landing Pages
- From clusters + verticals, generate landing-page drafts with:
  - semantic term expansion
  - FAQ stubs
  - JSON-LD schema stubs

6) Link Gap + Outreach Prep
- Use DataForSEO Backlinks domain intersection:
  - “domains linking to competitors but not to us”
- Output an outreach queue (no automated emailing; include placeholders + compliance notes).

7) Internal Linking Map
- Use clusters to propose a hub-and-spoke linking graph.
- Output suggested internal links (pillar -> spokes, spokes -> pillar, adjacent clusters).

8) Technical Audit + Fix Plan
- Use DataForSEO On-Page API for crawl / instant pages.
- Output issue list and a prioritized fix plan (recommendations + target files once website repo is provided).

## Repo Entry Points

- Pipeline runner: `node scripts/seo/run.mjs --config docs/seo/seo.config.example.json --mode all`
- OrgX plan application (creates the initiative/tasks in OrgX): `node scripts/apply-seo-plan-v1.mjs`

