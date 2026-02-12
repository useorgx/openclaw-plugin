# /live CTA + conversion copy package

This folder is the draft copy package for the **OrgX Live Dashboard**.

Notes:
- The plugin route is `GET /orgx/live` (dashboard SPA).
- The task request says `/live`; treat that as the marketing entry route, and use this copy to drive users into `/orgx/live`.

## Primary CTA (recommended)
- Button: `Connect OrgX`
- Secondary: `Use API key`
- Links: `Explore demo dashboard` | `Continue offline` | `Setup guide`

## Core promise
"Orchestrate agents, approve decisions, and track progress from a single live dashboard."

## What to emphasize
- **Activity Timeline** (threaded sessions)
- **Decisions queue** (inline approve/reject)
- **Mission Control** (initiative progress)
- **Reliability** (buffering + replay visibility)

## Files
- `docs/marketing/live/orgx-live-dashboard-campaign.json`
- `docs/marketing/live/orgx-live-dashboard-content-pack.json`
- `docs/marketing/live/orgx-live-dashboard-nurture-sequence.json`

## Validation
Run:

```bash
python3 /Users/hopeatina/.codex/skills/marketing-agent/scripts/validate_marketing.py docs/marketing/live/orgx-live-dashboard-campaign.json --type campaign
python3 /Users/hopeatina/.codex/skills/marketing-agent/scripts/validate_marketing.py docs/marketing/live/orgx-live-dashboard-content-pack.json --type content
python3 /Users/hopeatina/.codex/skills/marketing-agent/scripts/validate_marketing.py docs/marketing/live/orgx-live-dashboard-nurture-sequence.json --type sequence
```
