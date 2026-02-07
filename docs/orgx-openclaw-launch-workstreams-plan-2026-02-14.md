# OrgX OpenClaw Launch Workstreams Plan (No-Duplicate)

Updated: 2026-02-07 (CST)
Target launch window: Sunday, 2026-02-08 through Saturday, 2026-02-14

## Scope
This plan is for the OrgX OpenClaw plugin launch objective:
- users can sign up and log in
- users can launch OrgX agents and see value
- users can pay
- launch marketing runs (threads, articles, X ads)

## Existing Initiative Audit
Source checked first: local OrgX API endpoints on `http://127.0.0.1:18789`

Primary initiative to use (already exists):
- `aa6d16dc-d450-417f-8a17-fd89bd597195` — `OrgX OpenClaw Plugin — Saturday Launch` (active)

Current shape under that initiative:
- 8 workstreams
- 16 milestones
- 40 tasks
- 16/16 milestones missing `due_date`
- 40/40 tasks missing `due_date`

Other active initiatives with overlap risk (do not duplicate work into these):
- `ec0c17a7-880b-422e-9e00-79c9932a86fd` — `Clawdbot Plugin — OrgX Deep Integration`
- `be087e5c-c909-47c9-883d-43ef520d03b2` — `OrgX Distribution — From Invisible to Everywhere`
- `a4d94c84-7df6-47eb-b555-e8e87d3f4163` — `OrgX × Moltbot Deep Integration: Marketing-Led Launch`

## No-Duplicate Rules
1. Use initiative `aa6d16dc-d450-417f-8a17-fd89bd597195` as the single source of truth.
2. Do not create any new launch initiative unless this one is closed.
3. For workstreams, match by normalized name first; update existing instead of creating.
4. For milestones/tasks, match by `(workstream_id + normalized title)`; update due dates/status instead of adding duplicates.
5. Only create new entities for true gaps after match check returns no candidate.

## Workstream Dependency Map
1. `Auth & User Identity`
- Prerequisite for all gated flows.

2. `Agent Launcher & Runtime`
- Depends on: `Auth & User Identity`.

3. `Payment & Billing Integration`
- Depends on: `Auth & User Identity`.

4. `Onboarding & Value Demo`
- Depends on: `Auth & User Identity`, `Agent Launcher & Runtime`.

5. `Plugin Packaging & Distribution`
- Depends on: `Auth & User Identity`, `Agent Launcher & Runtime`, `Payment & Billing Integration`.

6. `Tweet Threads & Articles`
- Depends on: final screenshots/GIFs from `Onboarding & Value Demo` and `Agent Launcher & Runtime`.

7. `Twitter Ads Campaign`
- Depends on: `Tweet Threads & Articles` and `Plugin Packaging & Distribution`.

8. `Launch Day Coordination`
- Depends on: all workstreams above.

## Dated Execution Plan (This Week)

### 2026-02-08 (Sun)
- Add due dates to all 16 milestones and 40 tasks in initiative `aa6d...`.
- Finalize Auth MVP path (provider choice, signup/login/session, protected routes).
- Start Stripe setup and product definitions.

### 2026-02-09 (Mon)
- Complete auth acceptance path end-to-end.
- Implement one-click agent launch and live status updates.
- Create first usable onboarding flow (guided setup + demo mode baseline).

### 2026-02-10 (Tue)
- Complete payment checkout + webhook + entitlement gate.
- Wire premium plan check for gated features.
- Produce screenshot/GIF capture set for marketing.

### 2026-02-11 (Wed)
- Complete packaging/distribution assets:
  - install docs
  - README quick start
  - release package
- Draft launch thread + value thread + build-in-public thread.
- Draft long-form article.

### 2026-02-12 (Thu)
- Finalize marketing creative and ad variants.
- Configure X ads account, targeting, budget, conversion tracking.
- Internal QA run of complete funnel:
  - sign up -> login -> launch agent -> see value -> pay

### 2026-02-13 (Fri)
- Freeze release candidate.
- Pre-launch dry run with rollback checklist.
- Schedule posts and confirm ad campaign start times.

### 2026-02-14 (Sat, Target Date)
- Launch execution window.
- Publish thread/article/ad campaigns.
- Live monitor signups, payments, runtime errors.
- End-of-day KPI review and next-iteration list.

## Minimum KPI Targets For 2026-02-14
- Auth conversion: >= 70% of landing visitors complete signup/login.
- Activation: >= 40% of signed-in users launch at least one OrgX agent.
- Monetization: >= 10 paid conversions by end of launch day.
- Marketing: >= 3 launch threads + >= 1 article + >= 2 ad creatives live.

## Immediate Next Operations (Plan-First)
1. Patch due dates and dependency metadata on the existing entities in `aa6d...`.
2. Normalize statuses (`not_started`, `active`, `done`) based on real progress.
3. Add explicit prerequisite links in summaries/metadata so dashboard tracking is truthful.
4. Only then create missing tasks (if any) found by idempotent dedupe check.

## Implementation Notes (2026-02-07)
- Executed via direct OrgX API (`https://www.useorgx.com/api/entities`) using local OpenClaw plugin credentials.
- Local gateway route `PATCH /orgx/api/entities` currently rejected request bodies in this environment, so direct API was used.
- Strict field validation on OrgX entity types rejected custom metadata keys like `depends_on_workstreams`, `launch_gate`, and `verification_status`.
- Fallback applied per plan assumptions:
  - Workstream verification contract stored in `summary` with `[Launch Plan v2]` marker.
  - Milestone/task verification contract stored in `description` with `[Launch Plan v2]` marker.
  - Due dates applied using valid native `due_date` fields.
- Verification scenario tasks were created idempotently with exact-title and near-duplicate checks.
