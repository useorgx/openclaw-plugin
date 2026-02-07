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
      'User can launch at least two agents, observe status transitions, and see output reflected in activity.',
    verificationSteps: [
      'Launch at least two agent runs from dashboard',
      'Verify status transitions queued -> running -> completed',
      'Verify output events appear in activity stream with initiative context',
    ],
    requiredEvidence: [
      'Run IDs for at least two runs',
      'Activity timestamps proving state transitions',
      'Screenshot or short recording of launch-to-output',
    ],
  },
  'Payment & Billing Integration': {
    gate: 'G3',
    owner: 'engineering-owner',
    due: '2026-02-10T20:00:00-06:00',
    dependsOn: ['Auth & User Identity'],
    exitCriteria:
      'Checkout, webhook entitlement updates, billing portal, and premium gating all verified in test mode.',
    verificationSteps: [
      'Complete test checkout end-to-end',
      'Replay webhook events and verify entitlement update',
      'Verify billing portal access and cancellation path',
      'Verify premium feature gates free vs paid correctly',
    ],
    requiredEvidence: [
      'Stripe event IDs',
      'Entitlement state snapshot before/after',
      'Premium gate pass/fail proof',
    ],
  },
  'Onboarding & Value Demo': {
    gate: 'G1',
    owner: 'product-owner',
    due: '2026-02-09T23:59:00-06:00',
    dependsOn: ['Auth & User Identity', 'Agent Launcher & Runtime'],
    exitCriteria:
      'New user reaches first value in <= 60 seconds from first open with guided onboarding and demo mode.',
    verificationSteps: [
      'Run timed first-run flow from clean state (3 runs minimum)',
      'Verify guided onboarding sequence and demo mode render',
      'Verify launch-first-agent CTA succeeds from onboarding path',
    ],
    requiredEvidence: [
      'Stopwatch timestamps from three clean runs',
      'Flow recording or screenshots',
      'Onboarding completion metrics snapshot',
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

  const base = String(existingSummary || '').trim();
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

  const base = String(existingDescription || '').trim();
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
    mutationLogsCreated: 0,
  };

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
        created_by_plan_version: PLAN_VERSION,
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
    const title = `Launch Plan v2 mutation: ${context.entityType} ${context.entityId}`;
    const summary = [
      `Plan version: ${PLAN_VERSION}`,
      `Entity: ${context.entityType}/${context.entityId}`,
      `Action: ${context.action}`,
      `Before: ${JSON.stringify(before)}`,
      `After: ${JSON.stringify(after)}`,
    ].join('\n');

    await api.createEntity('stream', {
      title,
      summary,
      initiative_id: INITIATIVE_ID,
      status: 'active',
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

  // Scenario task creation with exact + near-duplicate checks.
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

  for (const scenario of VERIFICATION_SCENARIOS) {
    const wsId = workstreamIdByName.get(normalize(scenario.workstream));
    if (!wsId) continue;

    const plan = WORKSTREAM_PLAN[scenario.workstream];
    const dependencyIds = plan.dependsOn
      .map((name) => workstreamIdByName.get(normalize(name)))
      .filter(Boolean);

    const exactKey = `${wsId}::${normalize(scenario.title)}`;
    const exact = state.tasks.find((task) => canonicalMilestoneOrTaskKey(task) === exactKey);

    if (exact) {
      const updates = {
        due_date: scenario.dueDate,
        priority: scenario.priority,
        description: buildDescription(exact.description, plan, plan.dependsOn, [
          `Scenario requirement: ${scenario.description}`,
          `Scenario due date: ${scenario.dueDate}`,
        ]),
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
          action: 'update_scenario_exact_match',
        },
        before,
        after
      );
      continue;
    }

    const candidates = state.tasks.filter((task) => task.workstream_id === wsId);
    let best = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      const score = similarity(scenario.title, candidate.title);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best && bestScore >= DUPLICATE_SIMILARITY_THRESHOLD) {
      const updates = {
        due_date: scenario.dueDate,
        priority: scenario.priority,
        description: buildDescription(best.description, plan, plan.dependsOn, [
          `Scenario requirement: ${scenario.description}`,
          `Scenario due date: ${scenario.dueDate}`,
          `Deduped from planned scenario title at similarity ${Number(bestScore.toFixed(4))}`,
        ]),
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
          action: 'update_scenario_near_duplicate',
          duplicateSimilarity: Number(bestScore.toFixed(4)),
        },
        before,
        after
      );
      continue;
    }

    const before = snapshotCounts(state);
    const created = await api.createEntity('task', {
      title: scenario.title,
      description: buildDescription('', plan, plan.dependsOn, [
        `Scenario requirement: ${scenario.description}`,
        `Scenario due date: ${scenario.dueDate}`,
      ]),
      status: 'todo',
      priority: scenario.priority,
      due_date: scenario.dueDate,
      milestone_id: preferredMilestoneByWorkstreamId.get(wsId) || null,
      workstream_id: wsId,
      initiative_id: INITIATIVE_ID,
    });

    const normalizedCreated = {
      id: created.id,
      title: created.title || scenario.title,
      description: created.description || scenario.description,
      status: created.status || 'todo',
      priority: created.priority || scenario.priority,
      due_date: created.due_date || scenario.dueDate,
      milestone_id: created.milestone_id || preferredMilestoneByWorkstreamId.get(wsId) || null,
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
        action: 'create_scenario_task',
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
