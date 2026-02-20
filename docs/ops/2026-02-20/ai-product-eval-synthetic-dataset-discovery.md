# AI Product Evaluation Framework: Synthetic Dataset Generation Discovery

Date: 2026-02-20  
Initiative: AI Product Evaluation Framework (Ankur Method) (`9cb1ce04-03f0-4562-ab3a-ae839b8e8e33`)  
Workstream: Evaluation Dataset Construction (`f2daedd9-f994-44a4-92d0-01e30e18533c`)  
Task context: Synthetic Dataset Generation: Discovery (`29236c41-034a-4bbc-9351-20b79db43580`)

## Scope

Define a smallest-shippable synthetic dataset spec for evaluation artifacts so engineering can generate labeled examples with reproducible quality gates.

## Outputs Produced In This Slice

1. Dataset record schema and controlled vocab draft:
- `docs/ops/2026-02-20/ai-product-eval-dataset-schema-v1.json`

2. Generation and QA workflow with release gates:
- This document (`...synthetic-dataset-discovery.md`)

## Dataset Unit Definition

Each row is one evaluated artifact instance with:

- immutable IDs (`dataset_id`, `record_id`)
- generation context (`source_mode`, `generator_model`, `prompt_version`)
- label payload (`artifact_type`, `scores`, `failure_tags`)
- adjudication status (`label_status`, optional reviewer metadata)

Primary row shape and enums are defined in `ai-product-eval-dataset-schema-v1.json`.

## Artifact Types In Scope (v1)

1. `pr`
2. `document`
3. `config`
4. `report`
5. `design`
6. `retro`
7. `other`

These map directly to artifact categories already used in this plugin ecosystem.

## Scoring Rubric Shape (Per Row)

Scores are normalized integer buckets (`1-5`) to support rapid calibration and stable model targets:

1. `clarity`
2. `correctness`
3. `completeness`
4. `actionability`
5. `policy_compliance`

Optional top-level `overall` score (`1-5`) is reserved for downstream weighting experiments.

## Failure Taxonomy (v1)

Use controlled tags (zero or more per row):

1. `hallucination`
2. `missing_evidence`
3. `incorrect_scope`
4. `unsafe_instruction`
5. `format_violation`
6. `non_actionable_output`
7. `incomplete_delivery`

## Synthetic Generation Plan

1. Seed scenario catalog:
- 15-20 task prompts per artifact type, stratified by complexity (`low|medium|high`).

2. Multi-pass candidate generation:
- Pass A: baseline prompts.
- Pass B: adversarial perturbations (ambiguous constraints, conflicting requirements).
- Pass C: recovery prompts targeting known failure tags.

3. Labeling:
- Auto-label with deterministic heuristics where possible (`format_violation`, schema validity).
- Human/domain review for semantic labels (`correctness`, `actionability`, `hallucination`).

4. Adjudication:
- Require `label_status=adjudicated` for release set.
- Disagreements tracked via `adjudication_notes`.

## Release Gates (Discovery Definition of Done)

1. Schema validity:
- `ai-product-eval-dataset-schema-v1.json` parses as valid JSON and includes row + enum contracts.

2. Coverage:
- At least one scenario defined for every `artifact_type`.

3. Label integrity:
- No release row with missing required score dimensions.

4. Traceability:
- Every row has prompt/version provenance (`prompt_version`, `generator_model`, timestamp).

## Risks And Mitigations

1. Risk: synthetic rows overfit expected formats.
- Mitigation: include adversarial prompts and real-issue inspired perturbations.

2. Risk: weak semantic label consistency.
- Mitigation: enforce adjudication for disputed rows and maintain label-status lineage.

3. Risk: class imbalance (too many "good" samples).
- Mitigation: quota failure-tag coverage per artifact type before freeze.

## Verification Steps (Executed)

1. Created schema file and cross-checked this document against the same enum and score vocabulary.
2. Validated schema file parses as JSON.
3. Verified discovery task ID, workstream ID, and initiative ID are present and accurate in this artifact.
