#!/usr/bin/env node

/**
 * Adds UX-focused workstreams + per-component milestones/tasks to the
 * "OrgX OpenClaw Plugin - Saturday Launch" initiative in the OrgX database.
 *
 * Goal: a premium, design-led deep dive (Activity view + Mission Control)
 * with explicit verification/evidence gates and a state/flow audit.
 *
 * Safe-by-default behavior:
 * - Creates missing entities idempotently (by normalized title/name).
 * - Does not overwrite existing descriptions/summaries unless they contain the marker.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const INITIATIVE_ID =
  process.env.ORGX_INITIATIVE_ID || "aa6d16dc-d450-417f-8a17-fd89bd597195";
const PLAN_VERSION = "premium-ux-v1-2026-02-09";
const MARKER = "[Premium UX Workstream v1]";

function normalize(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function hasMarker(text) {
  return String(text || "").includes(MARKER);
}

function upsertMarkedBlock(existingText, block) {
  const base = String(existingText || "").trim();
  if (!base) return block.trim();
  if (hasMarker(base)) {
    return base
      .replace(new RegExp(`\\${MARKER}[\\s\\S]*$`), block.trim())
      .trim();
  }
  return `${base}\n\n${block.trim()}`.trim();
}

function buildWorkstreamSummary(plan) {
  const dependencyText = plan.dependsOn.length
    ? plan.dependsOn.join(", ")
    : "none";
  const steps = plan.verificationSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const evidence = plan.requiredEvidence.map((e, i) => `${i + 1}. ${e}`).join("\n");
  const antiSlop = [
    "Anti-slop rules:",
    "1. No \"good enough\" spacing. Align to a grid; measure and standardize paddings/gaps.",
    "2. No random motion. Define motion tokens; respect prefers-reduced-motion.",
    "3. No vague states. Every empty/loading/error/reconnecting state must answer: what is happening + what can I do.",
    "4. No inconsistent hierarchy. One primary action per surface; secondary actions de-emphasized.",
  ].join("\n");

  return [
    MARKER,
    `Plan: ${PLAN_VERSION}`,
    `Due: ${plan.due}`,
    `Verification owner: ${plan.owner}`,
    `Depends on: ${dependencyText}`,
    `Exit criteria: ${plan.exitCriteria}`,
    antiSlop,
    "Verification steps:",
    steps,
    "Required evidence:",
    evidence,
    "Rule: do not mark done until evidence is attached and reviewed.",
  ].join("\n");
}

function buildMilestoneDescription(plan, milestone, extraLines = []) {
  const dependencyText = plan.dependsOn.length
    ? plan.dependsOn.join(", ")
    : "none";
  const steps = (milestone.verificationSteps || plan.verificationSteps)
    .map((s, i) => `${i + 1}. ${s}`)
    .join("\n");
  const evidence = (milestone.requiredEvidence || plan.requiredEvidence)
    .map((e, i) => `${i + 1}. ${e}`)
    .join("\n");

  const extras = extraLines.length
    ? `\n\nNotes:\n${extraLines.map((l) => `- ${l}`).join("\n")}`.trimEnd()
    : "";

  return [
    MARKER,
    `Plan: ${PLAN_VERSION}`,
    `Workstream: ${plan.name}`,
    `Milestone: ${milestone.title}`,
    `Due: ${milestone.due}`,
    `Depends on (workstream): ${dependencyText}`,
    milestone.outcome ? `Outcome: ${milestone.outcome}` : null,
    "Verification steps:",
    steps,
    "Required evidence:",
    evidence,
    "Rule: do not mark done until evidence is attached and reviewed.",
  ]
    .filter(Boolean)
    .join("\n")
    .concat(extras ? `\n${extras}\n` : "\n");
}

function buildTaskDescription(plan, milestone, task) {
  const checklist =
    Array.isArray(task.checklist) && task.checklist.length > 0
      ? `\n\nChecklist:\n${task.checklist.map((c) => `- ${c}`).join("\n")}`
      : "";

  return [
    MARKER,
    `Plan: ${PLAN_VERSION}`,
    `Workstream: ${plan.name}`,
    `Milestone: ${milestone.title}`,
    `Task: ${task.title}`,
    task.outcome ? `Outcome: ${task.outcome}` : null,
    task.definitionOfDone ? `Definition of done: ${task.definitionOfDone}` : null,
  ]
    .filter(Boolean)
    .join("\n")
    .concat(checklist ? `${checklist}\n` : "\n");
}

class OrgxApi {
  constructor(baseUrl, headers = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = headers;
  }

  async request(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "orgx-premium-ux-plan",
        ...this.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText}: ${
          typeof parsed === "string" ? parsed : JSON.stringify(parsed)
        }`
      );
    }

    return parsed;
  }

  async listEntities(type, initiativeId) {
    const q = new URLSearchParams({
      type,
      initiative_id: initiativeId,
      limit: "1000",
    });
    const result = await this.request("GET", `/api/entities?${q.toString()}`);
    return Array.isArray(result?.data) ? result.data : [];
  }

  async createEntity(type, payload) {
    const result = await this.request("POST", "/api/entities", { type, ...payload });
    return result?.entity || result?.data || result;
  }

  async updateEntity(type, id, updates) {
    const payload = { type, id, ...updates };
    const result = await this.request("PATCH", "/api/entities", payload);
    return result?.entity || result?.data || result;
  }
}

function loadOrgxCredentials() {
  const envApiKey =
    process.env.ORGX_API_KEY?.trim() || process.env.ORGX_SERVICE_KEY?.trim() || "";
  const envUserId = process.env.ORGX_USER_ID?.trim() || "";
  const envBase = process.env.ORGX_BASE_URL?.trim() || "";

  if (envApiKey) {
    return {
      apiKey: envApiKey,
      userId: envUserId,
      baseUrl: envBase || "https://www.useorgx.com",
      source: "env",
    };
  }

  const openclawConfigPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(openclawConfigPath)) {
    throw new Error("Missing OrgX credentials: set ORGX_API_KEY (or ORGX_SERVICE_KEY).");
  }

  const raw = readFileSync(openclawConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const cfg = parsed?.plugins?.entries?.orgx?.config ?? {};
  const apiKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
  const userId = typeof cfg.userId === "string" ? cfg.userId.trim() : "";
  const baseUrl =
    typeof cfg.baseUrl === "string" && cfg.baseUrl.trim().length > 0
      ? cfg.baseUrl.trim()
      : "https://www.useorgx.com";

  if (!apiKey) {
    throw new Error("OrgX API key missing in ~/.openclaw/openclaw.json");
  }

  return {
    apiKey,
    userId,
    baseUrl,
    source: "openclaw_config",
  };
}

const WORKSTREAM_PLANS = [
  {
    name: "UX Deep Dive - Activity View (Johnny Ive Pass)",
    owner: "design-owner",
    due: "2026-02-13T23:59:00-06:00",
    dependsOn: [],
    exitCriteria:
      "Activity view feels premium: consistent spacing + hierarchy, clear active-vs-past run affordances, unambiguous connection states, polished motion, and correct OpenClaw branding + avatars.",
    verificationSteps: [
      "Run through: select session -> view timeline -> open detail -> focus session -> run controls -> launcher.",
      "Validate active vs past sessions: the UI always answers 'what can I do now?'",
      "Validate connection states with forced SSE failure + degraded snapshot + offline mode.",
      "Validate motion quality at 60fps and reduced-motion compliance.",
      "Validate desktop + mobile layouts (no cramped controls, no clipped content).",
    ],
    requiredEvidence: [
      "Before/after screenshot grid for each major component (desktop + mobile).",
      "Short screen recording showing entry/exit animations and run interactions.",
      "State inventory doc (empty/loading/error/reconnecting/idle + actions).",
      "A11y quick pass notes (focus, keyboard nav, contrast).",
    ],
    milestones: [
      {
        title: "Activity UX: State Inventory + Value Flow",
        due: "2026-02-10T18:00:00-06:00",
        outcome:
          "A concrete state/action matrix for Activity view (active vs past runs) and a prioritized list of new states/features required to make intervention obvious.",
        tasks: [
          {
            title: "Audit: Document Activity view state/action matrix (active vs past)",
            due: "2026-02-10T12:00:00-06:00",
            priority: "high",
            outcome:
              "A written matrix covering: empty/loading/error/reconnecting/idle + per-state user actions + expected copy.",
            definitionOfDone:
              "Matrix includes at least 12 states and explicitly lists CTAs and fallbacks for each.",
            checklist: [
              "Define 'active run' vs 'past run' affordances.",
              "Define what clicking an activity item should do in each state.",
              "Capture current UI screenshots as baseline evidence.",
            ],
          },
          {
            title: "Spec: Define intervention UX (message agent, change goal, add/remove tasks)",
            due: "2026-02-10T18:00:00-06:00",
            priority: "high",
            outcome:
              "A spec for interventions with constraints (safe actions, confirmations, audit trail) and UI placements (detail modal, inspector, mission control).",
            definitionOfDone:
              "Spec includes: interaction entry points, permission model, and a minimal MVP slice for launch.",
            checklist: [
              "List the top 5 intervention intents (message, redirect, pause/resume, cancel, rollback).",
              "Define UI placements and microcopy.",
              "Identify backend/API deltas required.",
            ],
          },
        ],
      },
      {
        title: "Activity UX: Top Bar + Connection Status Semantics",
        due: "2026-02-10T23:00:00-06:00",
        outcome:
          "Connection badge + copy reflect real meaning (live/degraded/reconnecting/offline/idle) and show last successful snapshot time.",
        tasks: [
          {
            title: "Design + copy: Connection status meanings (live vs idle vs reconnecting)",
            due: "2026-02-10T20:00:00-06:00",
            priority: "high",
            outcome:
              "Precise definitions and user-facing labels/tooltips for each connection state.",
            definitionOfDone:
              "Each status answers: what is happening + what the user should do (if anything).",
            checklist: [
              "Separate 'idle' (no new events) from 'reconnecting' (transport degraded).",
              "Add tooltip copy for 'degraded' data (fallback polling).",
            ],
          },
          {
            title: "Implementation: Update header badge + tooltip + last good snapshot timestamp",
            due: "2026-02-10T23:00:00-06:00",
            priority: "high",
            outcome:
              "Header shows correct state and timestamp without false 'reconnecting' during normal idle periods.",
            definitionOfDone:
              "Verified via forced SSE failure and by leaving dashboard idle for 5+ minutes.",
            checklist: [
              "Instrument last successful snapshot time in live data hook.",
              "Render a tooltip (hover/click) explaining state and last update time.",
              "Respect reduced motion (no aggressive ping when idle).",
            ],
          },
        ],
      },
      {
        title: "Activity UX: Agents & Sessions Panel (AgentsChatsPanel)",
        due: "2026-02-11T18:00:00-06:00",
        outcome:
          "Agent/session list reads cleanly: clear hierarchy, consistent spacing, premium hover/selection, and obvious active vs archived grouping.",
        tasks: [
          {
            title: "Audit + redesign: Session rows + group headers + offline filters",
            due: "2026-02-11T12:00:00-06:00",
            priority: "high",
            outcome:
              "A component-level critique and a concrete redesign plan (spacing, typography, labels, chips, icons).",
            definitionOfDone:
              "Before/after annotated screenshots for at least 3 states (running, blocked, archived).",
            checklist: [
              "Normalize row density and typography across groups.",
              "Fix 'no summary yet' copy to be concise and helpful.",
              "Make archived disclosure feel intentional, not hidden.",
            ],
          },
          {
            title: "Implementation: Apply redesigned layout + states (including empty/error)",
            due: "2026-02-11T18:00:00-06:00",
            priority: "high",
            outcome:
              "AgentsChatsPanel matches the redesign and feels coherent with the rest of the dashboard.",
            definitionOfDone:
              "No layout jitter on expand/collapse and no truncated controls on mobile.",
            checklist: [
              "Use shared tokens for spacing and muted text colors.",
              "Add subtle, consistent row hover/selection treatment.",
            ],
          },
        ],
      },
      {
        title: "Activity UX: Activity Timeline (List)",
        due: "2026-02-11T23:00:00-06:00",
        outcome:
          "Timeline list is readable at a glance: strong type hierarchy, consistent chips, and smooth scrolling under load.",
        tasks: [
          {
            title: "Audit + redesign: Timeline header controls + filter chips + search",
            due: "2026-02-11T15:00:00-06:00",
            priority: "high",
            outcome:
              "A crisp control hierarchy (primary/secondary), consistent chip styling, and predictable layout.",
            definitionOfDone:
              "Controls remain usable at narrow widths and do not reflow awkwardly.",
            checklist: [
              "Reduce visual noise in sort/collapse controls.",
              "Standardize chip sizes and focus/hover states.",
            ],
          },
          {
            title: "Implementation: Improve timeline row layout + grouping readability",
            due: "2026-02-11T23:00:00-06:00",
            priority: "high",
            outcome:
              "Each row communicates (who/what/when/status) with minimal clutter.",
            definitionOfDone:
              "Verified on 200+ events and in single-session thread mode.",
            checklist: [
              "Align chip spacing and label ordering across rows.",
              "Ensure long titles wrap gracefully without breaking layout.",
              "Keep render performance acceptable (no jank when filtering).",
            ],
          },
        ],
      },
      {
        title: "Activity UX: Activity Detail + Thread View (What do I do now?)",
        due: "2026-02-12T18:00:00-06:00",
        outcome:
          "Detail view answers 'what can I do' with contextual CTAs and differentiates active vs past items.",
        tasks: [
          {
            title: "Design: Detail view CTAs (focus session, run controls, copy ids)",
            due: "2026-02-12T12:00:00-06:00",
            priority: "high",
            outcome:
              "A clear CTA set and placement for each activity type and run state.",
            definitionOfDone:
              "CTA matrix covers active vs past and avoids showing impossible actions.",
            checklist: [
              "Add 'Focus session' as the default primary action when applicable.",
              "Provide one-click copy for run id + timestamp.",
            ],
          },
          {
            title: "Implementation: Add contextual CTAs to Activity detail modal",
            due: "2026-02-12T18:00:00-06:00",
            priority: "high",
            outcome:
              "Users can go from a past activity item to the relevant session/actions without hunting.",
            definitionOfDone:
              "Works for both single-session thread view and global timeline.",
            checklist: [
              "Wire CTA actions to existing run endpoints (pause/resume/cancel/rollback) where available.",
              "Guard actions by session status (no 'resume' on completed).",
            ],
          },
        ],
      },
      {
        title: "Activity UX: Session Inspector (Run Control) Premium Pass",
        due: "2026-02-12T23:00:00-06:00",
        outcome:
          "Run control actions feel premium: clear hierarchy, safe confirmations, and understandable checkpoints/rollback affordances.",
        tasks: [
          {
            title: "Audit: Session inspector hierarchy (summary, breadcrumbs, actions)",
            due: "2026-02-12T15:00:00-06:00",
            priority: "high",
            outcome:
              "A re-layout plan that reduces clutter and improves action clarity.",
            definitionOfDone:
              "Annotated before/after with explicit spacing and type scale decisions.",
            checklist: [
              "Ensure one primary action (Resume/Continue) is obvious.",
              "De-emphasize destructive actions; add confirmations where needed.",
            ],
          },
          {
            title: "Implementation: Apply inspector layout + action hierarchy improvements",
            due: "2026-02-12T23:00:00-06:00",
            priority: "high",
            outcome:
              "Inspector matches the premium system (tokens, chips, spacing) and reduces cognitive load.",
            definitionOfDone:
              "No ambiguous labels; actions report success/failure clearly.",
            checklist: [
              "Add microcopy for checkpoints + rollback (what it does).",
              "Standardize button sizing and spacing with other panels.",
            ],
          },
        ],
      },
      {
        title: "Activity UX: Agent Launcher Modal Premium Pass",
        due: "2026-02-13T12:00:00-06:00",
        outcome:
          "Agent launch feels futuristic and calm: progressive disclosure, strong defaults, and clear feedback for in-progress runs.",
        tasks: [
          {
            title: "Audit + redesign: Agent launch flow (steps, defaults, error states)",
            due: "2026-02-13T10:00:00-06:00",
            priority: "high",
            outcome:
              "A simplified flow with reduced form noise and clearer outcome states.",
            definitionOfDone:
              "At least 2 alternative layouts explored; choose one and document rationale.",
            checklist: [
              "Reduce cognitive load: hide advanced options behind 'Advanced'.",
              "Clarify 'launch' vs 'resume' vs 'dispatch' language.",
            ],
          },
          {
            title: "Implementation: Apply launcher redesign + premium motion",
            due: "2026-02-13T12:00:00-06:00",
            priority: "high",
            outcome:
              "Launcher modal feels coherent with the rest of the dashboard and handles loading/error states gracefully.",
            definitionOfDone:
              "Verified on mobile and desktop; no overflow/clipping.",
            checklist: [
              "Add subtle step transition motion; respect reduced motion.",
              "Improve 'in progress' feedback with precise copy.",
            ],
          },
        ],
      },
      {
        title: "Activity UX: Branding + Avatars (OpenClaw mark, agent visuals)",
        due: "2026-02-13T18:00:00-06:00",
        outcome:
          "OpenClaw branding is correct and avatar usage is intentional; the agent pane no longer feels like a mess.",
        tasks: [
          {
            title: "Audit: Branding usage (logos, avatars, provider marks) and inconsistencies",
            due: "2026-02-13T15:00:00-06:00",
            priority: "high",
            outcome:
              "A list of exact places where OpenClaw/OrgX branding is wrong or missing and a fix plan.",
            definitionOfDone:
              "Includes file/component references and proposed replacements.",
            checklist: [
              "Confirm OpenClaw mark usage in header and agent visuals.",
              "Verify avatars resolve correctly for core agents and providers.",
            ],
          },
          {
            title: "Implementation: Update header/logo treatment + avatar mapping usage",
            due: "2026-02-13T18:00:00-06:00",
            priority: "high",
            outcome:
              "Header uses the correct mark(s) and avatar treatments align across Activity and Mission Control.",
            definitionOfDone:
              "Verified in both dashboard views and in exported marketing screenshots.",
            checklist: [
              "Use openclaw-mark.svg (or updated asset) where appropriate.",
              "Ensure fallback initials still look premium (border/contrast).",
            ],
          },
        ],
      },
      {
        title: "Activity UX: Motion + QA Verification",
        due: "2026-02-13T23:00:00-06:00",
        outcome:
          "Motion system is consistent and the Activity view passes a premium QA checklist without regressions.",
        tasks: [
          {
            title: "Implementation: Motion tokens + consistent entry/exit variants",
            due: "2026-02-13T20:00:00-06:00",
            priority: "high",
            outcome:
              "Shared motion variants used across panels, rows, and modals (no random easing/durations).",
            definitionOfDone:
              "prefers-reduced-motion is respected everywhere; no stacked animations.",
            checklist: [
              "Define a small set of easings + durations.",
              "Remove duplicate/competing animations (tailwind + framer).",
            ],
          },
          {
            title: "QA: Screenshot grid + flow recording (desktop + mobile)",
            due: "2026-02-13T23:00:00-06:00",
            priority: "high",
            outcome:
              "Evidence bundle for launch (screenshots + short recording) and a list of remaining polish items.",
            definitionOfDone:
              "Covers all major components and at least 2 failure states.",
            checklist: [
              "Capture baseline + final for: agents panel, timeline, detail modal, inspector, launcher.",
              "Force an error state and document copy/CTA quality.",
            ],
          },
        ],
      },
    ],
  },
  {
    name: "UX Deep Dive - Mission Control (Johnny Ive Pass)",
    owner: "design-owner",
    due: "2026-02-13T23:59:00-06:00",
    dependsOn: [],
    exitCriteria:
      "Mission Control feels premium: hierarchy table readability, consistent spacing and actions, clear dependency visualization, polished empty/loading states, and coherent motion.",
    verificationSteps: [
      "Validate: expand/collapse rows, edit entities, open detail modals, and dependency map interactions.",
      "Validate readability: scan for next-up tasks and blockers within 10 seconds.",
      "Validate motion quality and reduced-motion compliance.",
      "Validate empty/loading/error states with missing entities and disconnected OrgX.",
    ],
    requiredEvidence: [
      "Before/after screenshot grid (hierarchy table, dependency map, detail modals).",
      "Short screen recording showing expand/collapse + modal motion.",
      "A11y quick pass notes (keyboard nav, focus management for modals).",
    ],
    milestones: [
      {
        title: "Mission Control UX: State Inventory + Core Flow",
        due: "2026-02-10T18:00:00-06:00",
        outcome:
          "Documented user flow for Mission Control (scan -> drill down -> act) and a state matrix for empty/loading/error/disconnected modes.",
        tasks: [
          {
            title: "Audit: Mission Control flow + state matrix (empty/loading/error/disconnected)",
            due: "2026-02-10T18:00:00-06:00",
            priority: "high",
            outcome:
              "A written matrix describing expected content + CTAs per state.",
            definitionOfDone:
              "Includes actionable copy recommendations and at least 6 distinct states.",
            checklist: [
              "Ensure empty state suggests creating workstreams/tasks or reconnecting API key.",
              "Define how blockers and dependencies should surface at a glance.",
            ],
          },
        ],
      },
      {
        title: "Mission Control UX: Filters + Overview Layout",
        due: "2026-02-11T18:00:00-06:00",
        outcome:
          "Filters and overview layout feel calm and intentional; the first screen answers 'what should I do next?'.",
        tasks: [
          {
            title: "Audit + redesign: Filters + overview hierarchy (what matters first)",
            due: "2026-02-11T12:00:00-06:00",
            priority: "high",
            outcome:
              "A layout proposal that reduces noise and improves next-up clarity.",
            definitionOfDone:
              "Proposed hierarchy includes a single recommended action cluster for the selected initiative.",
            checklist: [
              "Clarify selected initiative context and key metrics.",
              "Reduce visual competition between panels (map/table/todos).",
            ],
          },
          {
            title: "Implementation: Apply filter/overview polish and align tokens",
            due: "2026-02-11T18:00:00-06:00",
            priority: "high",
            outcome:
              "Mission Control header/filters look and behave consistently with Activity view.",
            definitionOfDone:
              "No clipping on small widths; focus styles are visible and consistent.",
            checklist: [
              "Standardize spacing + chip treatments",
              "Improve empty filter states",
            ],
          },
        ],
      },
      {
        title: "Mission Control UX: Hierarchy Table Premium Pass",
        due: "2026-02-12T18:00:00-06:00",
        outcome:
          "Hierarchy rows read like a product: clear type scale, consistent indentation, obvious status, and premium hover/selection.",
        tasks: [
          {
            title: "Audit + redesign: Hierarchy table row density, indentation, and action placement",
            due: "2026-02-12T12:00:00-06:00",
            priority: "high",
            outcome:
              "A concrete row spec (padding, typography, icons, action affordances).",
            definitionOfDone:
              "Spec includes expand/collapse behavior and keyboard focus order.",
            checklist: [
              "Ensure statuses are readable without relying only on color.",
              "Reduce visual clutter in columns and inline controls.",
            ],
          },
          {
            title: "Implementation: Apply table polish + motion + accessibility fixes",
            due: "2026-02-12T18:00:00-06:00",
            priority: "high",
            outcome:
              "Table looks premium and interactions are smooth and accessible.",
            definitionOfDone:
              "Expand/collapse motion feels consistent and focus does not jump unexpectedly.",
            checklist: [
              "Add consistent hover/selected states.",
              "Ensure focus ring + keyboard nav works across rows and actions.",
            ],
          },
        ],
      },
      {
        title: "Mission Control UX: Dependency Map + Visual Coherence",
        due: "2026-02-12T23:00:00-06:00",
        outcome:
          "Dependency visualization is legible and coherent with the rest of the UI (no 'demo graph' vibes).",
        tasks: [
          {
            title: "Audit + redesign: Dependency map legibility and interactions",
            due: "2026-02-12T20:00:00-06:00",
            priority: "high",
            outcome:
              "A refined visual style (nodes/edges/colors) and interaction model (hover/select/zoom).",
            definitionOfDone:
              "Map is readable for 30+ nodes and avoids overlap at typical sizes.",
            checklist: [
              "Define node sizing and label truncation rules.",
              "Ensure zoom/pan does not fight scroll on trackpads.",
            ],
          },
          {
            title: "Implementation: Apply dependency map styling + motion polish",
            due: "2026-02-12T23:00:00-06:00",
            priority: "high",
            outcome:
              "Map interactions feel smooth and align with dashboard motion tokens.",
            definitionOfDone:
              "Reduced motion mode shows minimal/no animated transitions.",
            checklist: [
              "Standardize easing/duration",
              "Add subtle selection highlights",
            ],
          },
        ],
      },
      {
        title: "Mission Control UX: Entity Detail Modals Premium Pass",
        due: "2026-02-13T18:00:00-06:00",
        outcome:
          "Entity modals feel like Apple-level forms: clear hierarchy, precise microcopy, and no layout jitter.",
        tasks: [
          {
            title: "Audit + redesign: Entity modal layout and form hierarchy",
            due: "2026-02-13T12:00:00-06:00",
            priority: "high",
            outcome:
              "A form spec: spacing, labels, grouping, and default focus behavior.",
            definitionOfDone:
              "Spec covers initiative/workstream/milestone/task modal variants.",
            checklist: [
              "Improve saving feedback and error messages.",
              "Ensure keyboard focus management is correct on open/close.",
            ],
          },
          {
            title: "Implementation: Apply modal polish + focus management + motion",
            due: "2026-02-13T18:00:00-06:00",
            priority: "high",
            outcome:
              "Modals feel stable and premium; no accidental scroll traps.",
            definitionOfDone:
              "Verified with keyboard-only and at least one screen reader smoke test.",
            checklist: [
              "Ensure focus returns to triggering element on close.",
              "Respect reduced motion for modal transitions.",
            ],
          },
        ],
      },
      {
        title: "Mission Control UX: QA Verification",
        due: "2026-02-13T23:00:00-06:00",
        outcome:
          "Mission Control passes a premium QA checklist with evidence captured for launch.",
        tasks: [
          {
            title: "QA: Screenshot grid + flow recording (table, map, modals)",
            due: "2026-02-13T23:00:00-06:00",
            priority: "high",
            outcome:
              "Evidence bundle + remaining polish punch list (if any).",
            definitionOfDone:
              "Covers at least 2 initiatives and includes an empty/disconnected state.",
            checklist: [
              "Capture before/after for table, dependency map, and entity modals.",
              "Test narrow-width layout and confirm no clipped controls.",
            ],
          },
        ],
      },
    ],
  },
];

async function main() {
  const creds = loadOrgxCredentials();
  const api = new OrgxApi(creds.baseUrl, {
    Authorization: `Bearer ${creds.apiKey}`,
    ...(creds.userId ? { "X-Orgx-User-Id": creds.userId } : {}),
  });

  const [workstreams, milestones, tasks] = await Promise.all([
    api.listEntities("workstream", INITIATIVE_ID),
    api.listEntities("milestone", INITIATIVE_ID),
    api.listEntities("task", INITIATIVE_ID),
  ]);

  const workstreamByName = new Map(
    workstreams.map((ws) => [normalize(ws.name || ws.title), ws])
  );

  const summary = {
    createdWorkstreams: 0,
    createdMilestones: 0,
    createdTasks: 0,
    updatedWorkstreams: 0,
    updatedMilestones: 0,
    dedupedExistingMilestones: 0,
    dedupedExistingTasks: 0,
  };

  for (const plan of WORKSTREAM_PLANS) {
    const wsKey = normalize(plan.name);
    let ws = workstreamByName.get(wsKey) || null;

    if (!ws) {
      const created = await api.createEntity("workstream", {
        title: plan.name,
        initiative_id: INITIATIVE_ID,
        status: "active",
        summary: buildWorkstreamSummary(plan),
      });
      ws = created;
      workstreamByName.set(wsKey, ws);
      summary.createdWorkstreams += 1;
      console.error(`[premium-ux] Created workstream: ${plan.name}`);
    } else {
      const nextSummary = upsertMarkedBlock(ws.summary, buildWorkstreamSummary(plan));
      if (nextSummary !== String(ws.summary || "")) {
        await api.updateEntity("workstream", ws.id, { summary: nextSummary });
        ws.summary = nextSummary;
        summary.updatedWorkstreams += 1;
        console.error(`[premium-ux] Updated workstream summary: ${plan.name}`);
      }
    }

    const wsId = ws.id;
    if (!wsId) {
      throw new Error(`Workstream missing id after ensure: ${plan.name}`);
    }

    const existingMilestones = milestones.filter((m) => m.workstream_id === wsId);
    const milestoneByTitle = new Map(existingMilestones.map((m) => [normalize(m.title), m]));

    for (const milestonePlan of plan.milestones) {
      const msKey = normalize(milestonePlan.title);
      const existing = milestoneByTitle.get(msKey) || null;

      const descriptionBlock = buildMilestoneDescription(plan, milestonePlan);
      if (!existing) {
        const created = await api.createEntity("milestone", {
          title: milestonePlan.title,
          description: descriptionBlock,
          status: "planned",
          due_date: milestonePlan.due,
          workstream_id: wsId,
          initiative_id: INITIATIVE_ID,
        });
        milestones.push(created);
        milestoneByTitle.set(msKey, created);
        summary.createdMilestones += 1;
        console.error(`[premium-ux] Created milestone: ${milestonePlan.title}`);
      } else {
        summary.dedupedExistingMilestones += 1;
        // Only update if this milestone already carries our marker.
        if (hasMarker(existing.description)) {
          const nextDesc = upsertMarkedBlock(existing.description, descriptionBlock);
          const updates = {};
          if (nextDesc !== String(existing.description || "")) updates.description = nextDesc;
          if (milestonePlan.due && milestonePlan.due !== existing.due_date) updates.due_date = milestonePlan.due;
          if (Object.keys(updates).length > 0) {
            await api.updateEntity("milestone", existing.id, updates);
            Object.assign(existing, updates);
            summary.updatedMilestones += 1;
            console.error(`[premium-ux] Updated milestone: ${milestonePlan.title}`);
          }
        }
      }

      const milestoneEntity = milestoneByTitle.get(msKey);
      if (!milestoneEntity?.id) {
        throw new Error(`Milestone missing id after ensure: ${milestonePlan.title}`);
      }

      // Tasks under this milestone.
      const existingTasks = tasks.filter(
        (t) => t.workstream_id === wsId && t.milestone_id === milestoneEntity.id
      );
      const taskByTitle = new Map(existingTasks.map((t) => [normalize(t.title), t]));

      for (const taskPlan of milestonePlan.tasks || []) {
        const tKey = normalize(taskPlan.title);
        const existingTask = taskByTitle.get(tKey) || null;
        if (existingTask) {
          summary.dedupedExistingTasks += 1;
          continue;
        }

        const created = await api.createEntity("task", {
          title: taskPlan.title,
          description: buildTaskDescription(plan, milestonePlan, taskPlan),
          status: "todo",
          // Keep priority conservative until we confirm the full enum on this OrgX build.
          priority: "medium",
          due_date: taskPlan.due || milestonePlan.due,
          milestone_id: milestoneEntity.id,
          workstream_id: wsId,
          initiative_id: INITIATIVE_ID,
        });
        tasks.push(created);
        taskByTitle.set(tKey, created);
        summary.createdTasks += 1;
        console.error(`[premium-ux] Created task: ${taskPlan.title}`);
      }
    }
  }

  console.error(`[premium-ux] Done: ${JSON.stringify(summary)}`);
}

main().catch((err) => {
  console.error(`[premium-ux] Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
