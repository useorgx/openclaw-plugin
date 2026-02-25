# WS1 Slice d86724b9 - Autopilot Output Schema Checklist

Date: 2026-02-25
Scope: Initiative 1 / Workstream 1 / slice `d86724b9-dee8-41bb-96ef-c67bbd10f919`

## Goal
Capture an engineering-quality checklist for producing output that conforms to the autopilot slice JSON schema at:

`~/.config/useorgx/openclaw-plugin/autopilot-slice-schema.json`

## Required Top-Level Fields
The final payload must always include:

- `status`
- `summary`
- `workstream_id`
- `workstream_title`
- `slice_id`
- `artifacts`
- `decisions_needed`
- `skill_evidence`
- `task_updates`
- `milestone_updates`
- `next_actions`

## Status/Decision Consistency Rules
- If any decision has `blocking: true`, `status` must be `needs_decision` or `blocked`.
- `status: completed` is valid only when all listed decisions are non-blocking.
- If status is `blocked`, `needs_decision`, or `error`, include at least one blocking decision entry.

## Skill Evidence Rules
For each required skill, include:

- `skill` (exact skill id without leading `$`)
- `skill_file` (absolute path)
- `skill_sha256` (lowercase SHA-256)
- `skill_heading` (first markdown heading, or first non-empty line)

## Artifact Quality Rules
Each artifact entry should include:

- `name`
- `artifact_type`
- `confidence_score` in `[0,1]` (or `null` only when unknown)
- verifiable `url` or local path
- concrete `verification_steps`

## Minimal Validation Command
From the repo root, validate generated output JSON with the dependency-free verifier:

```bash
node ./scripts/verify-autopilot-slice-output.mjs \
  /tmp/slice-output.json \
  ~/.config/useorgx/openclaw-plugin/autopilot-slice-schema.json
```

## Verification Evidence (this slice)
- Schema inspected directly from `~/.config/useorgx/openclaw-plugin/autopilot-slice-schema.json`.
- Required skill file discovered and hashed:
  - `/Users/hopeatina/.codex/skills/engineering-agent/SKILL.md`
  - SHA-256: `f6c2b9411afc35eaa2b413d3023dbfd8c5e55567a2592399502906b8bf0a7292`
