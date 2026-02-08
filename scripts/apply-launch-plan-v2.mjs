#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const INITIATIVE_ID = process.env.ORGX_INITIATIVE_ID || 'aa6d16dc-d450-417f-8a17-fd89bd597195';
const PLAN_VERSION = 'launch-v2-2026-02-07';
const DUPLICATE_SIMILARITY_THRESHOLD = 0.88;

const WORKSTREAM_PLAN = {
  'Auth & User Identity': {
    gate: 'G1',
    owner: 'engineering-owner',
    due: '2026-02-08T23:59:00-06:00',
    dependsOn: [],
    exitCriteria:
      'Signup, login, session persistence, and protected routes verified in plugin onboarding and dashboard surfaces.',
    verificationSteps: [
      'Run signup/login/logout flow in plugin UI',
      'Confirm protected route redirect behavior for unauthenticated users',
      'Confirm reconnect session behavior after browser restart',
    ],
    requiredEvidence: [
      'Screenshots of each auth state',
      'API responses for /orgx/api/onboarding and /orgx/api/onboarding/status',
      'Short auth verification test log',
    ],
  },
  'Agent Launcher & Runtime': {
    gate: 'G2',
    owner: 'engineering-owner',
    due: '2026-02-10T18:00:00-06:00',
    dependsOn: ['Auth & User Identity'],
    exitCriteria:
      'User can launch at least two agents, observe status transitions, see output reflected in activity, and choose cloud-vs-local execution mode.',
    verificationSteps: [
      'Launch at least two agent runs from dashboard',
      'Verify status transitions queued -> running -> completed',
      'Verify output events appear in activity stream with initiative context',
      'Verify execution mode selector routes correctly (OrgX cloud on behalf vs local machine)',
    ],
    requiredEvidence: [
      'Run IDs for at least two runs',
      'Activity timestamps proving state transitions',
      'Screenshot or short recording of launch-to-output',
      'Evidence of mode-specific launch execution behavior',
    ],
  },
  'Payment & Billing Integration': {
    gate: 'G3',
    owner: 'engineering-owner',
    due: '2026-02-10T20:00:00-06:00',
    dependsOn: ['Auth & User Identity'],
    exitCriteria:
      'Checkout, webhook entitlement updates, billing portal, premium gating, and BYOK-aware paywall path are all verified in test mode.',
    verificationSteps: [
      'Complete test checkout end-to-end',
      'Replay webhook events and verify entitlement update',
      'Verify billing portal access and cancellation path',
      'Verify premium feature gates free vs paid correctly',
      'Verify paid user with BYOK can launch agents while unpaid user is paywalled',
    ],
    requiredEvidence: [
      'Stripe event IDs',
      'Entitlement state snapshot before/after',
      'Premium gate pass/fail proof',
      'BYOK + paywall launch matrix (paid/unpaid, key/no-key)',
    ],
  },
  'Onboarding & Value Demo': {
    gate: 'G1',
    owner: 'product-owner',
    due: '2026-02-09T23:59:00-06:00',
    dependsOn: ['Auth & User Identity', 'Agent Launcher & Runtime'],
    exitCriteria:
      'New user reaches first value in <= 60 seconds from first open with guided onboarding, BYOK setup clarity, and demo mode.',
    verificationSteps: [
      'Run timed first-run flow from clean state (3 runs minimum)',
      'Verify guided onboarding sequence and demo mode render',
      'Verify launch-first-agent CTA succeeds from onboarding path',
      'Verify settings UX clearly guides Anthropic/OpenAI/OpenRouter key entry',
    ],
    requiredEvidence: [
      'Stopwatch timestamps from three clean runs',
      'Flow recording or screenshots',
      'Onboarding completion metrics snapshot',
      'Key setup completion funnel metrics',
    ],
  },
  'Plugin Packaging & Distribution': {
    gate: 'G4',
    owner: 'product-owner',
    due: '2026-02-11T23:59:00-06:00',
    dependsOn: [
      'Auth & User Identity',
      'Agent Launcher & Runtime',
      'Payment & Billing Integration',
    ],
    exitCriteria:
      'Install docs are reproducible, package is installable in fresh environment, and listing assets are launch-ready.',
    verificationSteps: [
      'Run clean install in fresh environment using published docs',
      'Verify /orgx/live and onboarding endpoint health checks',
      'Validate listing copy/assets and installation commands',
    ],
    requiredEvidence: [
      'Terminal transcript from clean install',
      'Fresh-environment install checklist',
      'Listing draft link or artifact reference',
    ],
  },
  'Tweet Threads & Articles': {
    gate: 'G4',
    owner: 'marketing-owner',
    due: '2026-02-11T23:59:00-06:00',
    dependsOn: ['Onboarding & Value Demo', 'Agent Launcher & Runtime'],
    exitCriteria:
      'Three launch-ready threads and one article are complete with current screenshots and clear CTA.',
    verificationSteps: [
      'Review 3 threads + 1 article against launch messaging checklist',
      'Verify links and screenshots are current and accurate',
      'Verify CTA destination and UTM parameters',
    ],
    requiredEvidence: [
      'Final draft docs for threads and article',
      'UTM-tagged destination links',
      'Screenshot/GIF asset IDs',
    ],
  },
  'Twitter Ads Campaign': {
    gate: 'G4',
    owner: 'marketing-owner',
    due: '2026-02-12T23:59:00-06:00',
    dependsOn: ['Tweet Threads & Articles', 'Plugin Packaging & Distribution'],
    exitCriteria:
      'Ad campaign is configured, conversion tracking is active, and at least two creatives are approved.',
    verificationSteps: [
      'Verify audience setup and budget constraints',
      'Verify signup and payment conversions fire correctly',
      'Approve at least two creatives for launch',
    ],
    requiredEvidence: [
      'Campaign ID and settings snapshot',
      'Pixel/API conversion logs',
      'Creative IDs and spend cap configuration',
    ],
  },
  'Continuous Execution & Auto-Completion': {
    gate: 'G2',
    owner: 'engineering-owner',
    due: '2026-02-12T23:59:00-06:00',
    dependsOn: ['Auth & User Identity', 'Agent Launcher & Runtime'],
    exitCriteria:
      'Initiative execution can continue autonomously across next-up tasks until initiative completion or explicit token budget exhaustion.',
    verificationSteps: [
      'Run a seeded initiative and verify task auto-advancement across queued todo items',
      'Verify execution pauses only when blocked, completed, or budget/token guardrail is reached',
      'Verify manual resume continues from next-up task without duplicate execution',
    ],
    requiredEvidence: [
      'Run transcript showing at least 3 autonomous task transitions',
      'Stop reason evidence (completed, blocked, or budget_exhausted)',
      'Checkpoint/resume evidence for continuation from last stable state',
    ],
  },
  'Budget & Duration Forecasting': {
    gate: 'G4',
    owner: 'operations-owner',
    due: '2026-02-13T20:00:00-06:00',
    dependsOn: ['Continuous Execution & Auto-Completion', 'Launch Day Coordination'],
    exitCriteria:
      'Mission Control displays expected duration and budget at initiative/workstream/milestone/task levels with validated rollups.',
    verificationSteps: [
      'Set expected duration and budget values on representative entities',
      'Verify hierarchy table shows editable and persisted duration/budget values',
      'Verify initiative-level summary displays rollup totals for duration and budget',
    ],
    requiredEvidence: [
      'Screenshots of duration/budget values at task and workstream levels',
      'API payload snapshots confirming expected_duration_hours and expected_budget_usd persistence',
      'Before/after screenshot proving totals update when estimates change',
    ],
  },
  'Plugin + Core Codebase Unification': {
    gate: 'G4',
    owner: 'engineering-owner',
    due: '2026-02-21T23:59:00-06:00',
    dependsOn: ['Auth & User Identity', 'Agent Launcher & Runtime'],
    exitCriteria:
      'Standalone plugin and core package share one client/types/http surface with adapter layers for auth/pairing/outbox and orchestration.',
    verificationSteps: [
      'Map duplicated modules (client/types/http) and finalize target shared package boundaries',
      'Extract shared package contracts and migrate both codebases to shared imports',
      'Validate auth/outbox/pairing and orchestration/skill-sync paths in unified architecture',
    ],
    requiredEvidence: [
      'Code map showing removed duplicate modules and replacement imports',
      'Build/test output for both plugin codepaths after migration',
      'Adapter coverage checklist for auth/outbox/pairing/orchestration features',
    ],
  },
  'Dashboard Bundle Endpoint': {
    gate: 'G4',
    owner: 'engineering-owner',
    due: '2026-02-13T23:59:00-06:00',
    dependsOn: ['Auth & User Identity'],
    exitCriteria:
      'Dashboard consumes a single server-side merged bundle snapshot instead of multi-endpoint client fan-out polling.',
    verificationSteps: [
      'Implement dashboard-bundle endpoint merging cloud + local session data',
      'Refactor dashboard hook to consume bundle payload as primary data source',
      'Validate parity against previous data sources for initiatives, agents, sessions, activity, decisions, and runs',
    ],
    requiredEvidence: [
      'Before/after request count comparison under identical refresh interval',
      'Bundle payload schema snapshot and parity checklist',
      'Regression test proof for empty/degraded/partial data states',
    ],
  },
  'Real-Time Stream (SSE) Integration': {
    gate: 'G4',
    owner: 'engineering-owner',
    due: '2026-02-13T23:59:00-06:00',
    dependsOn: ['Dashboard Bundle Endpoint'],
    exitCriteria:
      'Dashboard receives live updates via SSE first with polling fallback and no stale-state regressions.',
    verificationSteps: [
      'Expose SSE stream mode for dashboard bundle updates',
      'Wire SSE-first data updates in dashboard with polling fallback path',
      'Validate reconnect/retry behavior and stale view recovery on stream interruptions',
    ],
    requiredEvidence: [
      'SSE event transcript with snapshot diff updates',
      'Fallback activation proof when stream is interrupted',
      'Latency comparison (event-to-UI) versus polling baseline',
    ],
  },
  'Self-Healing Auth & Warm Cache': {
    gate: 'G4',
    owner: 'engineering-owner',
    due: '2026-02-12T23:59:00-06:00',
    dependsOn: ['Auth & User Identity'],
    exitCriteria:
      'Dashboard detects auth failure globally, offers one-click reconnect, and serves last known good cloud snapshot during outage.',
    verificationSteps: [
      'Aggregate auth failures into unified connection status in dashboard state',
      'Expose reconnect banner + action that starts pairing/manual key flow inline',
      'Persist and load last successful cloud snapshot as warm cache on auth failure',
    ],
    requiredEvidence: [
      'Auth failure simulation showing reconnect banner and successful recovery',
      'Warm-cache snapshot file and replay proof',
      'Post-reconnect data freshness verification log',
    ],
  },
  'Orchestration Client Dependency Injection': {
    gate: 'G4',
    owner: 'engineering-owner',
    due: '2026-02-12T23:59:00-06:00',
    dependsOn: ['Plugin + Core Codebase Unification'],
    exitCriteria:
      'Orchestration layer consumes injected OrgXClient and removes duplicate fetch/request logic.',
    verificationSteps: [
      'Refactor orchestration constructor to accept OrgXClient dependency',
      'Delete duplicated fetch helper and route all orgx HTTP through shared client',
      'Validate orchestration flow with mock client tests and live integration smoke',
    ],
    requiredEvidence: [
      'Diff proving removal of duplicated request implementation',
      'Unit test evidence with mocked client responses',
      'Integration smoke log for orchestration actions using injected client',
    ],
  },
  'Launch Day Coordination': {
    gate: 'G4',
    owner: 'operations-owner',
    due: '2026-02-14T23:59:00-06:00',
    dependsOn: [
      'Auth & User Identity',
      'Agent Launcher & Runtime',
      'Payment & Billing Integration',
      'Onboarding & Value Demo',
      'Plugin Packaging & Distribution',
      'Tweet Threads & Articles',
      'Twitter Ads Campaign',
    ],
    exitCriteria:
      'Launch checklist executed in order, full funnel stable, and KPI snapshots recorded throughout launch window.',
    verificationSteps: [
      'Execute launch checklist sequence with timestamped checkpoints',
      'Monitor auth, launch runtime, and payment errors hourly',
      'Post launch updates and produce end-of-day KPI report',
    ],
    requiredEvidence: [
      'Launch checklist log',
      'Incident log (or no-incident declaration)',
      'End-of-day KPI report artifact',
    ],
  },
};

const VERIFICATION_SCENARIOS = [
  {
    title: 'Verification Scenario 01: New user signup succeeds from plugin onboarding',
    description: 'Execute onboarding signup from clean state and verify successful account creation plus transition to connected state.',
    workstream: 'Auth & User Identity',
    dueDate: '2026-02-09T12:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 02: Existing user login and session persistence after restart',
    description: 'Verify existing user login, browser restart, and session persistence with no re-auth required.',
    workstream: 'Auth & User Identity',
    dueDate: '2026-02-09T13:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 03: Unauthorized route redirects to auth gate',
    description: 'Validate that protected routes redirect unauthenticated users to the auth onboarding path.',
    workstream: 'Auth & User Identity',
    dueDate: '2026-02-09T14:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 04: Agent launch appears in live sessions',
    description: 'Launch agent run and verify run appears in live sessions with expected state transitions.',
    workstream: 'Agent Launcher & Runtime',
    dueDate: '2026-02-10T12:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 05: Agent output appears in activity stream with initiative context',
    description: 'Verify emitted output/event appears in activity feed and is linked to the launch initiative.',
    workstream: 'Agent Launcher & Runtime',
    dueDate: '2026-02-10T13:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 06: Stripe checkout success updates entitlement within SLA',
    description: 'Run test checkout and confirm entitlement flips within expected SLA window.',
    workstream: 'Payment & Billing Integration',
    dueDate: '2026-02-10T15:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 07: Stripe cancellation and update events downgrade entitlements',
    description: 'Replay cancellation/update webhook events and confirm entitlement downgrade behavior.',
    workstream: 'Payment & Billing Integration',
    dueDate: '2026-02-10T16:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 08: Premium gating blocks free and allows paid users',
    description: 'Validate premium-gated action fails for free plan and succeeds for paid plan user.',
    workstream: 'Payment & Billing Integration',
    dueDate: '2026-02-10T17:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 08b: Paid BYOK user can launch agents while unpaid user is blocked',
    description:
      'Verify paid user with valid provider key can launch agents and unpaid user is blocked by paywall with clear upgrade path.',
    workstream: 'Payment & Billing Integration',
    dueDate: '2026-02-10T17:30:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 09: Clean machine install reproduces docs exactly',
    description: 'Reproduce installation from docs in clean environment and confirm no undocumented steps required.',
    workstream: 'Plugin Packaging & Distribution',
    dueDate: '2026-02-11T12:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 10: /orgx/live and onboarding endpoints return healthy responses',
    description: 'Verify /orgx/live loads and /orgx/api/onboarding endpoints respond with healthy states.',
    workstream: 'Onboarding & Value Demo',
    dueDate: '2026-02-11T13:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 10b: Settings key UX supports Anthropic, OpenAI, and OpenRouter',
    description:
      'Verify settings flow clearly supports entering, validating, and saving Anthropic/OpenAI/OpenRouter keys with actionable errors.',
    workstream: 'Onboarding & Value Demo',
    dueDate: '2026-02-11T14:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 11: Thread and article links resolve with valid UTM tags',
    description: 'Validate all launch content links resolve correctly and UTM parameters are present and accurate.',
    workstream: 'Tweet Threads & Articles',
    dueDate: '2026-02-11T18:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 12: Ad conversion event records signup',
    description: 'Verify campaign tracking captures signup conversion event end-to-end.',
    workstream: 'Twitter Ads Campaign',
    dueDate: '2026-02-12T15:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 13: Ad conversion event records payment',
    description: 'Verify campaign tracking captures payment conversion event end-to-end.',
    workstream: 'Twitter Ads Campaign',
    dueDate: '2026-02-12T16:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 14: First visit to paid conversion without manual DB intervention',
    description: 'Run full funnel from first visit to paid account and verify no manual DB edits are needed.',
    workstream: 'Launch Day Coordination',
    dueDate: '2026-02-13T17:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 15: Rollback drill for billing or auth outage',
    description: 'Execute rollback drill procedure for simulated billing/auth outage and document outcome.',
    workstream: 'Launch Day Coordination',
    dueDate: '2026-02-13T18:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 16: Initiative auto-continues next-up tasks until completion or token cap',
    description:
      'Validate autonomous execution loop advances tasks in dependency order until initiative is done or budget/token guardrails stop execution.',
    workstream: 'Continuous Execution & Auto-Completion',
    dueDate: '2026-02-12T16:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 17: Mission Control displays expected budget and duration per hierarchy level',
    description:
      'Validate budget and duration values are visible and editable for initiative/workstream/milestone/task and persist across reload.',
    workstream: 'Budget & Duration Forecasting',
    dueDate: '2026-02-13T15:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 18: Initiative status auto-shifts to paused when no active tasks',
    description:
      'Validate initiative displays paused state when all tasks are todo/blocked and no active tasks are in progress.',
    workstream: 'Continuous Execution & Auto-Completion',
    dueDate: '2026-02-12T18:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 19: Shared plugin/core contracts remove duplicate client/types/http implementations',
    description:
      'Validate both plugin codepaths compile and run against unified shared contracts without drift in entity or API behavior.',
    workstream: 'Plugin + Core Codebase Unification',
    dueDate: '2026-02-20T17:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 20: Dashboard bundle endpoint replaces multi-call client fan-out',
    description:
      'Validate dashboard loads from a single bundle endpoint response with equivalent initiative/session/activity/decision coverage.',
    workstream: 'Dashboard Bundle Endpoint',
    dueDate: '2026-02-13T16:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 21: SSE stream updates dashboard with polling fallback',
    description:
      'Validate live updates arrive through SSE and fallback polling keeps dashboard current when stream disconnects.',
    workstream: 'Real-Time Stream (SSE) Integration',
    dueDate: '2026-02-13T18:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 22: Auth failure shows reconnect banner and warm cache',
    description:
      'Validate auth expiration triggers a single reconnect CTA and cached snapshot is shown until reconnection succeeds.',
    workstream: 'Self-Healing Auth & Warm Cache',
    dueDate: '2026-02-12T17:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Verification Scenario 23: Orchestration HTTP path is fully client-injected',
    description:
      'Validate orchestration no longer contains direct fetch helper logic and all calls route through injected OrgXClient.',
    workstream: 'Orchestration Client Dependency Injection',
    dueDate: '2026-02-12T19:00:00-06:00',
    priority: 'high',
  },
];

const BYOK_PAYWALL_EXECUTION_TASKS = [
  {
    title: 'Define paywall packaging for BYOK agent launch ($99/mo baseline + premium options)',
    description:
      'Define and document pricing strategy for mission board and BYOK-powered agent launch, including baseline $99/mo plan and higher tiers. Reuse existing OrgX billing plan definitions and pricing surfaces instead of duplicating pricing logic in the plugin.',
    workstream: 'Payment & Billing Integration',
    dueDate: '2026-02-10T12:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Implement launch paywall check before agent execution',
    description:
      'Before agent launch, enforce subscription entitlement check and route unpaid users to upgrade flow with clear value messaging. Reuse existing OrgX checkout/portal APIs (`/api/billing/checkout`, `/api/billing/portal`) for upgrade and billing management.',
    workstream: 'Payment & Billing Integration',
    dueDate: '2026-02-10T13:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Add BYOK settings panel for Anthropic/OpenAI/OpenRouter',
    description:
      'Integrate plugin settings with existing OrgX provider-config UX/API for Anthropic/OpenAI/OpenRouter keys (`ProviderConfigSection`, `/api/settings/agents/provider-config`) instead of building a duplicate settings backend.',
    workstream: 'Onboarding & Value Demo',
    dueDate: '2026-02-10T18:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Add key health and readiness checks in settings',
    description:
      'Expose per-provider key status, last validation time, and launch-readiness state in plugin UX by consuming existing OrgX credential/provider status responses where available.',
    workstream: 'Onboarding & Value Demo',
    dueDate: '2026-02-11T10:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Add secure key storage policy and key rotation UX',
    description:
      'Use existing OrgX user API credential storage and rotation patterns (no plugin-side secret persistence) while exposing masking, revoke/remove actions, and key-ownership boundaries in UX copy.',
    workstream: 'Auth & User Identity',
    dueDate: '2026-02-11T12:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Implement execution mode selector (OrgX cloud on behalf vs local machine)',
    description:
      'Add runtime execution mode setting with clear defaults and explanatory copy for cloud execution on behalf of user vs local execution.',
    workstream: 'Agent Launcher & Runtime',
    dueDate: '2026-02-11T15:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Wire provider routing to BYOK credentials at launch time',
    description:
      'Route launches to Anthropic/OpenAI/OpenRouter based on selected provider and stored BYOK credentials, with robust error handling.',
    workstream: 'Agent Launcher & Runtime',
    dueDate: '2026-02-11T17:00:00-06:00',
    priority: 'high',
  },
  {
    title: 'Instrument paywall and BYOK conversion funnel analytics',
    description:
      'Track settings key completion, paywall views, upgrade conversions, and first launch success to measure monetization and activation.',
    workstream: 'Launch Day Coordination',
    dueDate: '2026-02-12T18:00:00-06:00',
    priority: 'high',
  },
];

const CONTINUOUS_MODEL_AND_FORECAST_TASKS = [
  {
    title: 'Implement initiative auto-continue loop until completion or token budget exhaustion',
    description:
      'Continuously pick and dispatch next-up tasks until initiative completion, explicit stop, or token budget exhaustion.',
    workstream: 'Continuous Execution & Auto-Completion',
    dueDate: '2026-02-12T11:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 8,
    expectedBudgetUsd: 320,
  },
  {
    title: 'Add token budget guardrails and deterministic stop reasons for long-running initiatives',
    description:
      'Track token burn and enforce stop reasons (`budget_exhausted`, `blocked`, `completed`) to prevent runaway execution.',
    workstream: 'Continuous Execution & Auto-Completion',
    dueDate: '2026-02-12T12:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 6,
    expectedBudgetUsd: 240,
  },
  {
    title: 'Auto-select next-up task based on dependencies, priority, due date, and readiness',
    description:
      'Ensure todo queue ordering is readiness-first so dispatch always starts from the highest-priority unblocked task.',
    workstream: 'Continuous Execution & Auto-Completion',
    dueDate: '2026-02-12T14:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 5,
    expectedBudgetUsd: 200,
  },
  {
    title: 'Set initiative status to paused when no active tasks are running',
    description:
      'Derive mission control initiative state from task execution activity so inactive initiatives show paused by default.',
    workstream: 'Continuous Execution & Auto-Completion',
    dueDate: '2026-02-12T15:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 3,
    expectedBudgetUsd: 120,
  },
  {
    title: 'Add expected duration and budget fields to initiative/workstream/milestone/task entities',
    description:
      'Persist and update `expected_duration_hours` and `expected_budget_usd` values across hierarchy entities.',
    workstream: 'Budget & Duration Forecasting',
    dueDate: '2026-02-13T10:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 4,
    expectedBudgetUsd: 160,
  },
  {
    title: 'Render budget and duration columns in Mission Control hierarchy table',
    description:
      'Expose editable duration and budget fields in Mission Control to support planning and real-time cost visibility.',
    workstream: 'Budget & Duration Forecasting',
    dueDate: '2026-02-13T12:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 4,
    expectedBudgetUsd: 160,
  },
  {
    title: 'Show initiative-level rollup of expected duration and budget',
    description:
      'Aggregate expected values from child tasks to provide top-level time and budget visibility in mission control cards.',
    workstream: 'Budget & Duration Forecasting',
    dueDate: '2026-02-13T13:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 3,
    expectedBudgetUsd: 120,
  },
];

const PLATFORM_MULTIPLIER_TASKS = [
  {
    title: 'Map and de-duplicate OrgXClient/types/http-handler across standalone plugin and core package',
    description:
      'Produce a concrete migration map showing duplicated modules and target shared ownership boundaries.',
    workstream: 'Plugin + Core Codebase Unification',
    dueDate: '2026-02-14T16:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 6,
    expectedBudgetUsd: 240,
  },
  {
    title: 'Extract shared @orgx/types package and migrate both codebases to common contracts',
    description:
      'Create shared contract package and remove divergent duplicated type definitions from both repositories.',
    workstream: 'Plugin + Core Codebase Unification',
    dueDate: '2026-02-18T17:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 10,
    expectedBudgetUsd: 400,
  },
  {
    title: 'Layer standalone auth/pairing/outbox as adapters on top of core plugin runtime',
    description:
      'Integrate standalone production auth/offline features via adapters instead of maintaining forked runtime surfaces.',
    workstream: 'Plugin + Core Codebase Unification',
    dueDate: '2026-02-21T17:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 12,
    expectedBudgetUsd: 480,
  },
  {
    title: 'Implement /orgx/api/dashboard-bundle endpoint with cloud + local session merge',
    description:
      'Serve a single merged dashboard snapshot from server-side aggregator to replace seven client polling calls.',
    workstream: 'Dashboard Bundle Endpoint',
    dueDate: '2026-02-13T12:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 8,
    expectedBudgetUsd: 320,
  },
  {
    title: 'Refactor useLiveData to consume DashboardSnapshot from dashboard-bundle endpoint',
    description:
      'Collapse client merge/dedupe logic into bundle consumer path and retain resilient degraded state handling.',
    workstream: 'Dashboard Bundle Endpoint',
    dueDate: '2026-02-13T15:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 6,
    expectedBudgetUsd: 240,
  },
  {
    title: 'Wire SSE-first dashboard updates with polling fallback',
    description:
      'Subscribe to live bundle stream updates via SSE and apply snapshots directly into query cache, polling only as fallback.',
    workstream: 'Real-Time Stream (SSE) Integration',
    dueDate: '2026-02-13T19:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 6,
    expectedBudgetUsd: 240,
  },
  {
    title: 'Add unified connectionStatus and one-click reconnect banner for auth failures',
    description:
      'Aggregate consecutive 401 failures into a single dashboard auth state with explicit reconnect action.',
    workstream: 'Self-Healing Auth & Warm Cache',
    dueDate: '2026-02-12T15:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 4,
    expectedBudgetUsd: 160,
  },
  {
    title: 'Persist last successful cloud snapshot and load it as warm cache during auth outage',
    description:
      'Store previous good bundle response locally and serve it when cloud auth is unavailable to avoid blank dashboards.',
    workstream: 'Self-Healing Auth & Warm Cache',
    dueDate: '2026-02-12T18:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 4,
    expectedBudgetUsd: 160,
  },
  {
    title: 'Inject OrgXClient into orchestration and delete duplicate fetch layer',
    description:
      'Refactor orchestration to use injected shared client for all HTTP paths and remove local request implementation.',
    workstream: 'Orchestration Client Dependency Injection',
    dueDate: '2026-02-12T14:00:00-06:00',
    priority: 'high',
    expectedDurationHours: 4,
    expectedBudgetUsd: 160,
  },
];

function normalize(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function statusToVerificationStatus(status) {
  const normalized = normalize(status);
  if (normalized === 'done' || normalized === 'completed') return 'passed';
  if (normalized === 'active' || normalized === 'in_progress') return 'in_progress';
  if (normalized === 'blocked') return 'failed';
  return 'not_started';
}

function levenshtein(a, b) {
  const s = normalize(a);
  const t = normalize(b);
  if (!s.length) return t.length;
  if (!t.length) return s.length;

  const rows = s.length + 1;
  const cols = t.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i++) dp[i][0] = i;
  for (let j = 0; j < cols; j++) dp[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[s.length][t.length];
}

function similarity(a, b) {
  const aa = normalize(a);
  const bb = normalize(b);
  if (!aa.length && !bb.length) return 1;
  const dist = levenshtein(aa, bb);
  return 1 - dist / Math.max(aa.length, bb.length);
}

function canonicalMilestoneOrTaskKey(item) {
  return `${item.workstream_id || ''}::${normalize(item.title)}`;
}

function duplicateCountByCanonical(items, canonicalFn) {
  const counts = new Map();
  for (const item of items) {
    const key = canonicalFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].filter((n) => n > 1).length;
}

function snapshotCounts(state) {
  return {
    workstreams: state.workstreams.length,
    milestones: state.milestones.length,
    tasks: state.tasks.length,
    missingMilestoneDueDates: state.milestones.filter((m) => !m.due_date).length,
    missingTaskDueDates: state.tasks.filter((t) => !t.due_date).length,
    duplicateWorkstreamNames: duplicateCountByCanonical(state.workstreams, (w) => normalize(w.name)),
    duplicateMilestoneKeys: duplicateCountByCanonical(
      state.milestones,
      canonicalMilestoneOrTaskKey
    ),
    duplicateTaskKeys: duplicateCountByCanonical(state.tasks, canonicalMilestoneOrTaskKey),
  };
}

function deepEqualJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sanitizeExistingPlanText(input) {
  return String(input || '')
    .replace(/probe\[{2,}/gi, '')
    .replace(/\btemporary probe\b/gi, '')
    .trim();
}

class OrgxApi {
  constructor(baseUrl, headers = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.headers = headers;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'orgx-launch-plan-v2',
        ...this.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }

    return parsed;
  }

  async listEntities(type, initiativeId) {
    const q = new URLSearchParams({ type, initiative_id: initiativeId, limit: '1000' });
    const result = await this.request('GET', `/api/entities?${q.toString()}`);
    return Array.isArray(result?.data) ? result.data : [];
  }

  async updateEntity(type, id, updates) {
    if (!type || typeof type !== 'string') {
      throw new Error(`Invalid entity type for update: ${String(type)}`);
    }
    if (!id || typeof id !== 'string') {
      throw new Error(`Invalid entity id for update type ${type}: ${String(id)}`);
    }
    const payload = { type, id, ...updates };
    if (!payload.type || !payload.id) {
      throw new Error(
        `Invalid PATCH payload type/id after merge: ${JSON.stringify({ type: payload.type, id: payload.id, keys: Object.keys(payload) })}`
      );
    }
    const result = await this.request('PATCH', '/api/entities', payload);
    return result?.entity || result?.data || result;
  }

  async createEntity(type, payload) {
    const result = await this.request('POST', '/api/entities', { type, ...payload });
    return result?.entity || result?.data || result;
  }
}

function loadOrgxCredentials() {
  const envApiKey = process.env.ORGX_API_KEY?.trim();
  const envUserId = process.env.ORGX_USER_ID?.trim();
  const envBase = process.env.ORGX_BASE_URL?.trim();
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      userId: envUserId || '',
      baseUrl: envBase || 'https://www.useorgx.com',
      source: 'env',
    };
  }

  const openclawConfigPath = join(homedir(), '.openclaw', 'openclaw.json');
  if (!existsSync(openclawConfigPath)) {
    throw new Error(
      `ORGX_API_KEY is not set and ${openclawConfigPath} does not exist.`
    );
  }

  const raw = readFileSync(openclawConfigPath, 'utf8');
  const parsed = JSON.parse(raw);
  const cfg = parsed?.plugins?.entries?.orgx?.config ?? {};
  const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  const userId = typeof cfg.userId === 'string' ? cfg.userId.trim() : '';
  const baseUrl =
    typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim().length > 0
      ? cfg.baseUrl.trim()
      : 'https://www.useorgx.com';

  if (!apiKey) {
    throw new Error('OrgX API key missing in ~/.openclaw/openclaw.json');
  }

  return {
    apiKey,
    userId,
    baseUrl,
    source: 'openclaw_config',
  };
}

function dueDateForTask(taskTitle, workstreamName) {
  const title = normalize(taskTitle);

  if (workstreamName === 'Launch Day Coordination') {
    if (title.includes('final qa checklist')) return '2026-02-13T12:00:00-06:00';
    if (title.includes('publish launch announcement')) return '2026-02-14T09:00:00-06:00';
    if (title.includes('monitor sign-ups and payments')) return '2026-02-14T12:00:00-06:00';
    if (title.includes('community engagement')) return '2026-02-14T18:00:00-06:00';
    if (title.includes('post-launch metrics review')) return '2026-02-14T21:00:00-06:00';
    return '2026-02-14T23:00:00-06:00';
  }

  if (workstreamName === 'Auth & User Identity') return '2026-02-08T21:00:00-06:00';
  if (workstreamName === 'Onboarding & Value Demo') return '2026-02-09T18:00:00-06:00';
  if (workstreamName === 'Agent Launcher & Runtime') return '2026-02-10T16:00:00-06:00';
  if (workstreamName === 'Payment & Billing Integration') return '2026-02-10T18:00:00-06:00';
  if (workstreamName === 'Plugin Packaging & Distribution') return '2026-02-11T18:00:00-06:00';
  if (workstreamName === 'Tweet Threads & Articles') {
    if (title.includes('screenshot') || title.includes('gif') || title.includes('capture')) {
      return '2026-02-10T21:00:00-06:00';
    }
    return '2026-02-11T17:00:00-06:00';
  }
  if (workstreamName === 'Twitter Ads Campaign') {
    if (title.includes('conversion tracking')) return '2026-02-12T19:00:00-06:00';
    return '2026-02-12T17:00:00-06:00';
  }
  if (workstreamName === 'Continuous Execution & Auto-Completion') {
    return '2026-02-12T20:00:00-06:00';
  }
  if (workstreamName === 'Budget & Duration Forecasting') {
    return '2026-02-13T20:00:00-06:00';
  }
  if (workstreamName === 'Dashboard Bundle Endpoint') {
    return '2026-02-13T19:00:00-06:00';
  }
  if (workstreamName === 'Real-Time Stream (SSE) Integration') {
    return '2026-02-13T21:00:00-06:00';
  }
  if (workstreamName === 'Self-Healing Auth & Warm Cache') {
    return '2026-02-12T20:00:00-06:00';
  }
  if (workstreamName === 'Orchestration Client Dependency Injection') {
    return '2026-02-12T20:00:00-06:00';
  }
  if (workstreamName === 'Plugin + Core Codebase Unification') {
    return '2026-02-21T21:00:00-06:00';
  }

  return '2026-02-14T23:59:00-06:00';
}

function dueDateForMilestone(milestoneTitle, workstreamName) {
  const title = normalize(milestoneTitle);
  if (workstreamName === 'Launch Day Coordination') {
    if (title.includes('launched and live')) return '2026-02-14T21:00:00-06:00';
    return '2026-02-14T09:00:00-06:00';
  }

  const fallback = WORKSTREAM_PLAN[workstreamName]?.due;
  return fallback || '2026-02-14T23:59:00-06:00';
}

function buildSummary(existingSummary, planEntry, dependencyNames) {
  const dependencyText = dependencyNames.length ? dependencyNames.join(', ') : 'none';
  const marker = '[Launch Plan v2]';
  const steps = planEntry.verificationSteps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const evidence = planEntry.requiredEvidence
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n');
  const canonicalBlock = [
    marker,
    `Gate: ${planEntry.gate}`,
    `Due: ${planEntry.due}`,
    `Verification owner: ${planEntry.owner}`,
    `Depends on: ${dependencyText}`,
    `Exit criteria: ${planEntry.exitCriteria}`,
    'Verification steps:',
    steps,
    'Required evidence:',
    evidence,
    'Rule: do not mark done until verification evidence is attached and reviewed.',
  ].join('\n');

  const base = sanitizeExistingPlanText(existingSummary);
  if (!base) return canonicalBlock;
  if (base.includes(marker)) {
    return base.replace(new RegExp(`${marker}[\\s\\S]*$`), canonicalBlock).trim();
  }
  return `${base}\n\n${canonicalBlock}`;
}

function buildDescription(existingDescription, planEntry, dependencyNames, extraLines = []) {
  const dependencyText = dependencyNames.length ? dependencyNames.join(', ') : 'none';
  const marker = '[Launch Plan v2]';
  const steps = planEntry.verificationSteps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const evidence = planEntry.requiredEvidence
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n');
  const extras = extraLines.length ? `${extraLines.join('\n')}\n` : '';

  const canonicalBlock = [
    marker,
    `Gate: ${planEntry.gate}`,
    `Due: ${planEntry.due}`,
    `Verification owner: ${planEntry.owner}`,
    `Depends on: ${dependencyText}`,
    `Exit criteria: ${planEntry.exitCriteria}`,
    extras.trim(),
    'Verification steps:',
    steps,
    'Required evidence:',
    evidence,
  ]
    .filter(Boolean)
    .join('\n');

  const base = sanitizeExistingPlanText(existingDescription);
  if (!base) return canonicalBlock;
  if (base.includes(marker)) {
    return base.replace(new RegExp(`${marker}[\\s\\S]*$`), canonicalBlock).trim();
  }
  return `${base}\n\n${canonicalBlock}`;
}

function mergeById(items, id, updates) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return;
  items[index] = { ...items[index], ...updates };
}

function milestoneIsBacklogLike(milestone) {
  const title = normalize(milestone?.title);
  return title === 'backlog' || title.startsWith('deprecated: backlog');
}

function statusForSoftDelete(entityType) {
  const type = normalize(entityType);
  if (type === 'milestone') return 'cancelled';
  if (type === 'task') return 'cancelled';
  return 'deleted';
}

async function main() {
  const creds = loadOrgxCredentials();
  const api = new OrgxApi(creds.baseUrl, {
    Authorization: `Bearer ${creds.apiKey}`,
    ...(creds.userId ? { 'X-Orgx-User-Id': creds.userId } : {}),
  });
  console.error(
    `[launch-plan-v2] API target: ${creds.baseUrl} (credentials source: ${creds.source})`
  );

  const state = {
    workstreams: await api.listEntities('workstream', INITIATIVE_ID),
    milestones: await api.listEntities('milestone', INITIATIVE_ID),
    tasks: await api.listEntities('task', INITIATIVE_ID),
  };

  const initialSnapshot = snapshotCounts(state);

  const mutationSummary = {
    updatedWorkstreams: 0,
    updatedMilestones: 0,
    updatedTasks: 0,
    createdTasks: 0,
    dedupedScenarioTasksToExisting: 0,
    createdMilestones: 0,
    reassignedBacklogTasks: 0,
    cancelledBacklogMilestones: 0,
    retiredProbeEntities: 0,
    mutationLogsCreated: 0,
  };
  const mutationLogEntries = [];

  const workstreamByName = new Map(
    state.workstreams.map((ws) => [normalize(ws.name), ws])
  );

  for (const [workstreamName, plan] of Object.entries(WORKSTREAM_PLAN)) {
    if (!workstreamByName.has(normalize(workstreamName))) {
      const created = await api.createEntity('workstream', {
        title: workstreamName,
        initiative_id: INITIATIVE_ID,
        status: 'not_started',
        summary: `Auto-created by ${PLAN_VERSION} because expected launch workstream was missing.`,
      });
      const normalizedCreated = {
        id: created.id,
        name: created.name || created.title || workstreamName,
        summary: created.summary || '',
        status: created.status || 'not_started',
        initiative_id: INITIATIVE_ID,
      };
      state.workstreams.push(normalizedCreated);
      workstreamByName.set(normalize(workstreamName), normalizedCreated);
    }
  }

  const workstreamIdByName = new Map(
    state.workstreams.map((ws) => [normalize(ws.name), ws.id])
  );

  async function logMutation(context, before, after) {
    mutationLogEntries.push({
      entity_type: context.entityType,
      entity_id: context.entityId,
      action: context.action,
      before,
      after,
    });

    mutationSummary.mutationLogsCreated += 1;
  }

  // Workstream updates
  console.error(`[launch-plan-v2] Updating workstreams: ${state.workstreams.length}`);
  for (const ws of state.workstreams) {
    const plan = WORKSTREAM_PLAN[ws.name];
    if (!plan) continue;

    const dependencyIds = plan.dependsOn
      .map((name) => workstreamIdByName.get(normalize(name)))
      .filter(Boolean);

    const summary = buildSummary(ws.summary, plan, plan.dependsOn);

    const updates = {
      summary,
    };

    const before = snapshotCounts(state);
    await api.updateEntity('workstream', ws.id, updates);
    mergeById(state.workstreams, ws.id, updates);
    const after = snapshotCounts(state);

    mutationSummary.updatedWorkstreams += 1;
    await logMutation(
      {
        entityType: 'workstream',
        entityId: ws.id,
        action: 'update',
      },
      before,
      after
    );
  }

  // Milestone updates
  console.error(`[launch-plan-v2] Updating milestones: ${state.milestones.length}`);
  const workstreamNameById = new Map(state.workstreams.map((ws) => [ws.id, ws.name]));
  for (const milestone of state.milestones) {
    const wsName = workstreamNameById.get(milestone.workstream_id) || '';
    const plan = WORKSTREAM_PLAN[wsName];
    if (!plan) continue;

    const dependencyIds = plan.dependsOn
      .map((name) => workstreamIdByName.get(normalize(name)))
      .filter(Boolean);

    const updates = {
      due_date: dueDateForMilestone(milestone.title, wsName),
      description: buildDescription(milestone.description, plan, plan.dependsOn, [
        `Milestone title: ${milestone.title}`,
        `Milestone due date: ${dueDateForMilestone(milestone.title, wsName)}`,
      ]),
    };

    const before = snapshotCounts(state);
    await api.updateEntity('milestone', milestone.id, updates);
    mergeById(state.milestones, milestone.id, updates);
    const after = snapshotCounts(state);

    mutationSummary.updatedMilestones += 1;
    await logMutation(
      {
        entityType: 'milestone',
        entityId: milestone.id,
        action: 'update',
      },
      before,
      after
    );
  }

  // Task updates
  console.error(`[launch-plan-v2] Updating tasks: ${state.tasks.length}`);
  for (const task of state.tasks) {
    const wsName = workstreamNameById.get(task.workstream_id) || '';
    const plan = WORKSTREAM_PLAN[wsName];
    if (!plan) continue;

    const dependencyIds = plan.dependsOn
      .map((name) => workstreamIdByName.get(normalize(name)))
      .filter(Boolean);

    const updates = {
      due_date: dueDateForTask(task.title, wsName),
      description: buildDescription(task.description, plan, plan.dependsOn, [
        `Task title: ${task.title}`,
        `Task due date: ${dueDateForTask(task.title, wsName)}`,
      ]),
    };

    const before = snapshotCounts(state);
    await api.updateEntity('task', task.id, updates);
    mergeById(state.tasks, task.id, updates);
    const after = snapshotCounts(state);

    mutationSummary.updatedTasks += 1;
    await logMutation(
      {
        entityType: 'task',
        entityId: task.id,
        action: 'update',
      },
      before,
      after
    );
  }

  // Planned task creation with exact + near-duplicate checks.
  console.error(
    `[launch-plan-v2] Applying verification scenarios: ${VERIFICATION_SCENARIOS.length}`
  );
  const preferredMilestoneByWorkstreamId = new Map();
  for (const workstream of state.workstreams) {
    const milestonesForWorkstream = state.milestones.filter(
      (milestone) => milestone.workstream_id === workstream.id
    );
    const nonDeprecated = milestonesForWorkstream.filter((milestone) => {
      const title = normalize(milestone.title);
      const isBacklog = title === 'backlog' || title.startsWith('deprecated: backlog');
      const isCancelled = normalize(milestone.status) === 'cancelled';
      return !isBacklog && !isCancelled;
    });
    const fallback = milestonesForWorkstream.find(
      (milestone) => normalize(milestone.status) !== 'cancelled'
    );
    const preferred = nonDeprecated[0] || fallback || null;
    if (preferred?.id) {
      preferredMilestoneByWorkstreamId.set(workstream.id, preferred.id);
    }
  }

  async function ensurePreferredMilestone(workstreamId, workstreamName) {
    const currentPreferredId = preferredMilestoneByWorkstreamId.get(workstreamId);
    if (currentPreferredId) return currentPreferredId;

    const existing = state.milestones.find(
      (milestone) =>
        milestone.workstream_id === workstreamId &&
        normalize(milestone.status) !== 'cancelled' &&
        !milestoneIsBacklogLike(milestone)
    );
    if (existing?.id) {
      preferredMilestoneByWorkstreamId.set(workstreamId, existing.id);
      return existing.id;
    }

    const before = snapshotCounts(state);
    const created = await api.createEntity('milestone', {
      title: 'Launch Verification',
      description: `[Launch Plan v2]\nAuto-created verification milestone for ${workstreamName}.`,
      status: 'planned',
      due_date: WORKSTREAM_PLAN[workstreamName]?.due || '2026-02-14T23:59:00-06:00',
      workstream_id: workstreamId,
      initiative_id: INITIATIVE_ID,
    });
    const createdMilestone = {
      id: created.id,
      title: created.title || 'Launch Verification',
      description: created.description || '',
      status: created.status || 'planned',
      due_date: created.due_date || WORKSTREAM_PLAN[workstreamName]?.due || '2026-02-14T23:59:00-06:00',
      workstream_id: created.workstream_id || workstreamId,
      initiative_id: created.initiative_id || INITIATIVE_ID,
    };
    state.milestones.push(createdMilestone);
    preferredMilestoneByWorkstreamId.set(workstreamId, createdMilestone.id);
    const after = snapshotCounts(state);

    mutationSummary.createdMilestones += 1;
    await logMutation(
      {
        entityType: 'milestone',
        entityId: createdMilestone.id,
        action: 'create_launch_verification_milestone',
      },
      before,
      after
    );
    return createdMilestone.id;
  }

  async function applyPlannedTaskItem(item, kind) {
    const wsId = workstreamIdByName.get(normalize(item.workstream));
    if (!wsId) return;

    const plan = WORKSTREAM_PLAN[item.workstream];
    if (!plan) return;
    const preferredMilestoneId = await ensurePreferredMilestone(wsId, item.workstream);

    const exactKey = `${wsId}::${normalize(item.title)}`;
    const exact = state.tasks.find((task) => canonicalMilestoneOrTaskKey(task) === exactKey);

    if (exact) {
      const exactMilestone = state.milestones.find((milestone) => milestone.id === exact.milestone_id);
      const extraLines = [
        `${kind} requirement: ${item.description}`,
        `${kind} due date: ${item.dueDate}`,
      ];
      if (typeof item.expectedDurationHours === 'number') {
        extraLines.push(`${kind} expected duration: ${item.expectedDurationHours}h`);
      }
      if (typeof item.expectedBudgetUsd === 'number') {
        extraLines.push(`${kind} expected budget: $${item.expectedBudgetUsd}`);
      }
      const updates = {
        due_date: item.dueDate,
        priority: item.priority,
        milestone_id:
          !exact.milestone_id || milestoneIsBacklogLike(exactMilestone)
            ? preferredMilestoneId
            : exact.milestone_id,
        description: buildDescription(exact.description, plan, plan.dependsOn, extraLines),
      };
      const before = snapshotCounts(state);
      await api.updateEntity('task', exact.id, updates);
      mergeById(state.tasks, exact.id, updates);
      const after = snapshotCounts(state);
      mutationSummary.updatedTasks += 1;
      await logMutation(
        {
          entityType: 'task',
          entityId: exact.id,
          action: `update_${kind.toLowerCase().replace(/\\s+/g, '_')}_exact_match`,
        },
        before,
        after
      );
      return;
    }

    const candidates = state.tasks.filter((task) => task.workstream_id === wsId);
    let best = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = similarity(item.title, candidate.title);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best && bestScore >= DUPLICATE_SIMILARITY_THRESHOLD) {
      const bestMilestone = state.milestones.find((milestone) => milestone.id === best.milestone_id);
      const extraLines = [
        `${kind} requirement: ${item.description}`,
        `${kind} due date: ${item.dueDate}`,
        `Deduped from planned ${kind.toLowerCase()} title at similarity ${Number(bestScore.toFixed(4))}`,
      ];
      if (typeof item.expectedDurationHours === 'number') {
        extraLines.push(`${kind} expected duration: ${item.expectedDurationHours}h`);
      }
      if (typeof item.expectedBudgetUsd === 'number') {
        extraLines.push(`${kind} expected budget: $${item.expectedBudgetUsd}`);
      }
      const updates = {
        due_date: item.dueDate,
        priority: item.priority,
        milestone_id:
          !best.milestone_id || milestoneIsBacklogLike(bestMilestone)
            ? preferredMilestoneId
            : best.milestone_id,
        description: buildDescription(best.description, plan, plan.dependsOn, extraLines),
      };
      const before = snapshotCounts(state);
      await api.updateEntity('task', best.id, updates);
      mergeById(state.tasks, best.id, updates);
      const after = snapshotCounts(state);
      mutationSummary.updatedTasks += 1;
      mutationSummary.dedupedScenarioTasksToExisting += 1;
      await logMutation(
        {
          entityType: 'task',
          entityId: best.id,
          action: `update_${kind.toLowerCase().replace(/\\s+/g, '_')}_near_duplicate`,
          duplicateSimilarity: Number(bestScore.toFixed(4)),
        },
        before,
        after
      );
      return;
    }

    const extraLines = [
      `${kind} requirement: ${item.description}`,
      `${kind} due date: ${item.dueDate}`,
    ];
    if (typeof item.expectedDurationHours === 'number') {
      extraLines.push(`${kind} expected duration: ${item.expectedDurationHours}h`);
    }
    if (typeof item.expectedBudgetUsd === 'number') {
      extraLines.push(`${kind} expected budget: $${item.expectedBudgetUsd}`);
    }
    const before = snapshotCounts(state);
    const created = await api.createEntity('task', {
      title: item.title,
      description: buildDescription('', plan, plan.dependsOn, extraLines),
      status: 'todo',
      priority: item.priority,
      due_date: item.dueDate,
      milestone_id: preferredMilestoneId,
      workstream_id: wsId,
      initiative_id: INITIATIVE_ID,
    });

    const normalizedCreated = {
      id: created.id,
      title: created.title || item.title,
      description: created.description || item.description,
      status: created.status || 'todo',
      priority: created.priority || item.priority,
      due_date: created.due_date || item.dueDate,
      milestone_id: created.milestone_id || preferredMilestoneId,
      workstream_id: created.workstream_id || wsId,
      initiative_id: created.initiative_id || INITIATIVE_ID,
    };
    state.tasks.push(normalizedCreated);
    const after = snapshotCounts(state);

    mutationSummary.createdTasks += 1;
    await logMutation(
      {
        entityType: 'task',
        entityId: normalizedCreated.id,
        action: `create_${kind.toLowerCase().replace(/\\s+/g, '_')}_task`,
      },
      before,
      after
    );
  }

  for (const scenario of VERIFICATION_SCENARIOS) {
    await applyPlannedTaskItem(scenario, 'Scenario');
  }

  console.error(
    `[launch-plan-v2] Applying BYOK/paywall execution tasks: ${BYOK_PAYWALL_EXECUTION_TASKS.length}`
  );
  for (const taskItem of BYOK_PAYWALL_EXECUTION_TASKS) {
    await applyPlannedTaskItem(taskItem, 'Execution Task');
  }

  console.error(
    `[launch-plan-v2] Applying continuous execution + forecast tasks: ${CONTINUOUS_MODEL_AND_FORECAST_TASKS.length}`
  );
  for (const taskItem of CONTINUOUS_MODEL_AND_FORECAST_TASKS) {
    await applyPlannedTaskItem(taskItem, 'Execution Task');
  }

  console.error(
    `[launch-plan-v2] Applying platform multiplier tasks: ${PLATFORM_MULTIPLIER_TASKS.length}`
  );
  for (const taskItem of PLATFORM_MULTIPLIER_TASKS) {
    await applyPlannedTaskItem(taskItem, 'Execution Task');
  }

  // Cleanup pass: remove temporary probe entities and deprecate duplicate/auto backlog milestones.
  console.error('[launch-plan-v2] Running cleanup for probe entities and backlog duplicates');

  for (const workstream of state.workstreams) {
    const milestonesForWorkstream = state.milestones.filter(
      (milestone) => milestone.workstream_id === workstream.id
    );
    const backlogMilestones = milestonesForWorkstream.filter((milestone) =>
      milestoneIsBacklogLike(milestone)
    );
    if (backlogMilestones.length === 0) continue;

    const preferredMilestoneId = await ensurePreferredMilestone(workstream.id, workstream.name);
    for (const backlogMilestone of backlogMilestones) {
      const tasksOnBacklog = state.tasks.filter(
        (task) => task.milestone_id === backlogMilestone.id
      );
      for (const task of tasksOnBacklog) {
        const before = snapshotCounts(state);
        const updates = { milestone_id: preferredMilestoneId };
        await api.updateEntity('task', task.id, updates);
        mergeById(state.tasks, task.id, updates);
        const after = snapshotCounts(state);
        mutationSummary.updatedTasks += 1;
        mutationSummary.reassignedBacklogTasks += 1;
        await logMutation(
          {
            entityType: 'task',
            entityId: task.id,
            action: 'reassign_from_backlog_milestone',
          },
          before,
          after
        );
      }

      const before = snapshotCounts(state);
      const updates = {
        status: 'cancelled',
        title: `Deprecated Milestone Archive (${workstream.name})`,
      };
      await api.updateEntity('milestone', backlogMilestone.id, updates);
      mergeById(state.milestones, backlogMilestone.id, updates);
      const after = snapshotCounts(state);
      mutationSummary.updatedMilestones += 1;
      mutationSummary.cancelledBacklogMilestones += 1;
      await logMutation(
        {
          entityType: 'milestone',
          entityId: backlogMilestone.id,
          action: 'deprecate_backlog_milestone',
        },
        before,
        after
      );
    }
  }

  async function listEntitiesOptional(type) {
    try {
      return await api.listEntities(type, INITIATIVE_ID);
    } catch {
      return [];
    }
  }

  const probeCandidates = [];
  for (const type of ['plan_session', 'stream']) {
    const entities = await listEntitiesOptional(type);
    for (const entity of entities) {
      const title = normalize(entity.title || entity.name);
      const summary = normalize(entity.summary || entity.description);
      const looksProbe =
        title.startsWith('probe') ||
        title.includes('temporary probe') ||
        summary.includes('temporary probe');
      if (looksProbe) {
        probeCandidates.push({ type, entity });
      }
    }
  }

  for (const candidate of probeCandidates) {
    const before = snapshotCounts(state);
    const preferredStatus = statusForSoftDelete(candidate.type);
    const textField =
      candidate.type === 'task' || candidate.type === 'milestone'
        ? 'description'
        : 'summary';
    const existingText =
      textField === 'description'
        ? String(candidate.entity.description || '')
        : String(candidate.entity.summary || '');

    let updated = null;
    const candidateStatuses = [preferredStatus, 'cancelled', 'deleted', 'archived'];
    for (const status of candidateStatuses) {
      try {
        updated = await api.updateEntity(candidate.type, candidate.entity.id, {
          status,
          [textField]: `${existingText}\n\n[Launch Plan v2 cleanup] Retired temporary probe entity.`.trim(),
        });
        break;
      } catch {
        // Try fallback status if this type rejects the previous status value.
      }
    }
    if (!updated) continue;

    if (candidate.type === 'milestone') {
      mergeById(state.milestones, candidate.entity.id, updated);
      mutationSummary.updatedMilestones += 1;
    } else if (candidate.type === 'task') {
      mergeById(state.tasks, candidate.entity.id, updated);
      mutationSummary.updatedTasks += 1;
    }
    const after = snapshotCounts(state);
    mutationSummary.retiredProbeEntities += 1;
    await logMutation(
      {
        entityType: candidate.type,
        entityId: candidate.entity.id,
        action: 'retire_probe_entity',
      },
      before,
      after
    );
  }

  // Final verification
  const finalState = {
    workstreams: await api.listEntities('workstream', INITIATIVE_ID),
    milestones: await api.listEntities('milestone', INITIATIVE_ID),
    tasks: await api.listEntities('task', INITIATIVE_ID),
  };
  const finalSnapshot = snapshotCounts(finalState);

  const gateStatus = {
    G0:
      finalSnapshot.duplicateWorkstreamNames === 0 &&
      finalSnapshot.duplicateMilestoneKeys === 0 &&
      finalSnapshot.duplicateTaskKeys === 0 &&
      finalSnapshot.missingMilestoneDueDates === 0 &&
      finalSnapshot.missingTaskDueDates === 0,
  };

  // Run artifact summary
  await api.createEntity('stream', {
    title: `Launch Plan v2 implementation report (${new Date().toISOString()})`,
    summary: [
      `initiative_id: ${INITIATIVE_ID}`,
      `plan_version: ${PLAN_VERSION}`,
      `initial_snapshot: ${JSON.stringify(initialSnapshot)}`,
      `final_snapshot: ${JSON.stringify(finalSnapshot)}`,
      `mutation_summary: ${JSON.stringify(mutationSummary)}`,
      `mutation_log_sample: ${JSON.stringify(mutationLogEntries.slice(0, 50))}`,
      `gate_status: ${JSON.stringify(gateStatus)}`,
    ].join('\n'),
    initiative_id: INITIATIVE_ID,
    status: 'active',
  });

  const output = {
    ok: true,
    initiativeId: INITIATIVE_ID,
    planVersion: PLAN_VERSION,
    initialSnapshot,
    finalSnapshot,
    mutationSummary,
    gateStatus,
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2
    )
  );
  process.exit(1);
});
