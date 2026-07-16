import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeFileAtomicSync } from "./fs-utils.js";
import { parseJsonSafe } from "./json-utils.js";
import { getOpenClawDir } from "./paths.js";

type OpenClawAgentEntry = {
  id?: string;
  name?: string;
  default?: boolean;
  workspace?: string;
  tools?: Record<string, unknown>;
};

type OpenClawConfig = {
  agents?: {
    list?: OpenClawAgentEntry[];
  };
  [key: string]: unknown;
};

export type OrgxSuiteDomain =
  | "engineering"
  | "product"
  | "design"
  | "marketing"
  | "sales"
  | "operations"
  | "orchestration";

export type OrgxSuiteAgentSpec = {
  id: string;
  name: string;
  domain: OrgxSuiteDomain;
};

export type OrgxManagedRuntimeContract = {
  executionLayer: "orgx-managed-agents";
  substrate: "remote-managed-runtime";
  languages: {
    nodejs: string;
    python: string;
  };
  commonTools: string[];
  commonPackages: {
    javascript: string[];
    python: string[];
  };
  preferredAuthPath: "browser-pairing";
  fallbackAuthPath: "direct-api-byok";
  fallbackProviders: string[];
};

export type OrgxAgentConfigHealthStatus = "healthy" | "needs_apply" | "conflict";

export const ORGX_AGENT_SUITE_PACK_ID = "orgx-agent-suite";

export const ORGX_AGENT_SUITE_AGENTS: OrgxSuiteAgentSpec[] = [
  { id: "orgx-engineering", name: "OrgX Engineering", domain: "engineering" },
  { id: "orgx-product", name: "OrgX Product", domain: "product" },
  { id: "orgx-design", name: "OrgX Design", domain: "design" },
  { id: "orgx-marketing", name: "OrgX Marketing", domain: "marketing" },
  { id: "orgx-sales", name: "OrgX Sales", domain: "sales" },
  { id: "orgx-operations", name: "OrgX Operations", domain: "operations" },
  { id: "orgx-orchestrator", name: "OrgX Orchestrator", domain: "orchestration" },
];

const ORGX_AGENT_BASE_TOOLS = [
  "orgx_status",
  "orgx_sync",
  "orgx_get_morning_brief",
  "orgx_query_org_memory",
  "orgx_recommend_next_action",
  "orgx_emit_activity",
  "orgx_report_progress",
  "orgx_register_artifact",
  "orgx_request_attention",
  "orgx_poll_attention",
  "orgx_ack_attention",
  "orgx_request_decision",
  "orgx_spawn_check",
  "orgx_quality_score",
  "orgx_proof_status",
  "orgx_record_outcome",
  "orgx_get_outcome_attribution",
  "orgx_verify_completion",
];

export const ORGX_AGENT_SCOPED_TOOLS: Record<OrgxSuiteDomain, string[]> = {
  engineering: [...ORGX_AGENT_BASE_TOOLS],
  product: [...ORGX_AGENT_BASE_TOOLS],
  design: [...ORGX_AGENT_BASE_TOOLS],
  marketing: [...ORGX_AGENT_BASE_TOOLS],
  sales: [...ORGX_AGENT_BASE_TOOLS],
  operations: [
    ...ORGX_AGENT_BASE_TOOLS,
    "orgx_apply_changeset",
    "orgx_reassign_stream",
  ],
  orchestration: [
    ...ORGX_AGENT_BASE_TOOLS,
    "orgx_apply_changeset",
    "orgx_reassign_stream",
  ],
};

export const ORGX_MANAGED_RUNTIME_CONTRACT: OrgxManagedRuntimeContract = {
  executionLayer: "orgx-managed-agents",
  substrate: "remote-managed-runtime",
  languages: {
    nodejs: "22",
    python: "3.11",
  },
  commonTools: ["node", "npm", "pnpm", "python3", "pip3", "git"],
  commonPackages: {
    javascript: ["typescript", "tsx", "zod", "undici"],
    python: ["httpx", "pydantic", "pytest"],
  },
  preferredAuthPath: "browser-pairing",
  fallbackAuthPath: "direct-api-byok",
  fallbackProviders: ["anthropic", "openai", "google", "cursor"],
};

const SUITE_WORKSPACE_DIRNAME = "agents";
const SUITE_MANAGED_DIR = join(".orgx", "managed");
const SUITE_LOCAL_DIR = join(".orgx", "local");

const SUITE_FILES = [
  "AGENTS.md",
  "TOOLS.md",
  "IDENTITY.md",
  "SKILL.md",
  "SOUL.md",
  "USER.md",
  "HEARTBEAT.md",
] as const;

export type OrgxSkillPackOverrides = {
  source: "builtin" | "server";
  name: string;
  version: string;
  checksum: string;
  etag?: string | null;
  updated_at?: string | null;
  openclaw_skills: Partial<Record<OrgxSuiteDomain, string>>;
};

export type OrgxAgentSuiteStatus = {
  packId: string;
  packVersion: string;
  openclawConfigPath: string;
  suiteWorkspaceRoot: string;
  skillPack?: {
    source: "builtin" | "server";
    name: string;
    version: string;
    checksum: string;
    etag?: string | null;
    updated_at?: string | null;
  } | null;
  skillPackRemote?: {
    name: string;
    version: string;
    checksum: string;
    updated_at?: string | null;
  } | null;
  skillPackPolicy?: {
    frozen: boolean;
    pinnedChecksum: string | null;
  } | null;
  skillPackUpdateAvailable?: boolean;
  agents: Array<{
    id: string;
    name: string;
    domain: OrgxSuiteDomain;
    workspace: string;
    configuredInOpenclaw: boolean;
    workspaceExists: boolean;
    configHealth: {
      status: OrgxAgentConfigHealthStatus;
      lastChangedAt: string | null;
      evalPassRate: number;
      totalChecks: number;
      passedChecks: number;
      failedChecks: number;
    };
  }>;
};

export type OrgxAgentSuitePlan = OrgxAgentSuiteStatus & {
  openclawConfigWouldUpdate: boolean;
  openclawConfigAddedAgents: string[];
  workspaceFiles: Array<{
    agentId: string;
    file: typeof SUITE_FILES[number];
    managedPath: string;
    localPath: string;
    compositePath: string;
    action: "create" | "update" | "noop" | "conflict";
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isSafeAgentId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[a-z0-9][a-z0-9_-]*$/.test(trimmed);
}

function openclawConfigPath(openclawDir: string): string {
  return join(openclawDir, "openclaw.json");
}

function readOpenclawConfig(openclawDir: string): {
  path: string;
  parsed: OpenClawConfig | null;
  fileMode: number;
} {
  const path = openclawConfigPath(openclawDir);
  try {
    const mode = statSync(path).mode & 0o777;
    const raw = readFileSync(path, "utf8");
    const parsed = parseJsonSafe<OpenClawConfig>(raw);
    return { path, parsed: parsed && typeof parsed === "object" ? parsed : null, fileMode: mode || 0o600 };
  } catch {
    return { path, parsed: null, fileMode: 0o600 };
  }
}

function resolveSuiteWorkspaceRoot(openclaw: OpenClawConfig | null): string {
  const list = Array.isArray(openclaw?.agents?.list) ? openclaw?.agents?.list : [];
  const orgx = list.find((entry) => String(entry?.id ?? "").trim() === "orgx") ?? null;
  const configured =
    orgx && typeof orgx.workspace === "string" && orgx.workspace.trim().length > 0
      ? orgx.workspace.trim()
      : "";
  const base = configured || join(homedir(), "clawd", "workspaces", "orgx");
  return join(base, SUITE_WORKSPACE_DIRNAME);
}

function ensureDir(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function managedHeader(input: {
  packId: string;
  packVersion: string;
  file: string;
  managedSha: string;
}): string {
  const { packId, packVersion, file, managedSha } = input;
  return [
    `# === ORGX MANAGED (pack: ${packId}@${packVersion}, file: ${file}, sha256: ${managedSha}) ===`,
    "",
  ].join("\n");
}

function localHeader(): string {
  return [
    "",
    "# === ORGX LOCAL OVERRIDES (appended verbatim; never overwritten) ===",
    "",
  ].join("\n");
}

const LOCAL_OVERRIDE_MARKER = "# === ORGX LOCAL OVERRIDES";
const MANAGED_HEADER_PATTERN =
  /^# === ORGX MANAGED \(pack: [^,\n]+, file: ([^,\n]+), sha256: ([a-f0-9]{64})\) ===\n/;

function buildCompositeFile(input: { managed: string; localOverride: string | null }): string {
  if (!input.localOverride) return input.managed;
  return `${input.managed}${localHeader()}${input.localOverride.trimEnd()}\n`;
}

function extractLocalOverridesFromComposite(composite: string): string | null {
  const idx = composite.indexOf(LOCAL_OVERRIDE_MARKER);
  if (idx < 0) return null;
  const after = composite.slice(idx);
  const markerEnd = after.indexOf("\n\n");
  const start = markerEnd >= 0 ? idx + markerEnd + 2 : idx;
  const candidate = composite.slice(start).trim();
  return candidate ? `${candidate}\n` : null;
}

function isPristineManagedComposite(composite: string, expectedFile: string): boolean {
  const normalized = normalizeNewlines(composite);
  const match = normalized.match(MANAGED_HEADER_PATTERN);
  if (!match || match[1] !== expectedFile) return false;
  const managedBody = normalized.slice(match[0].length);
  return sha256(managedBody) === match[2];
}

function loadTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function readFileMtimeMs(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function roundRate(value: number): number {
  return Number(value.toFixed(3));
}

function domainPersona(domain: OrgxSuiteDomain): {
  headline: string;
  voice: string[];
  autonomy: string[];
  care: string[];
  defaults: string[];
} {
  switch (domain) {
    case "engineering":
      return {
        headline: "Build correct software with proof.",
        voice: ["Direct, calm, technical.", "Prefer concrete evidence over confidence."],
        autonomy: ["Default to implementing the fix.", "Escalate only when a decision is truly required."],
        care: ["Respect time: minimize churn and surprises.", "Explain tradeoffs without lecturing."],
        defaults: [
          "Reproduce before fixing.",
          "Add tests when feasible.",
          "Keep diffs small.",
          "Register artifacts as engineering.commit with commit_sha and verification signals.",
        ],
      };
    case "product":
      return {
        headline: "Turn ambiguity into shippable outcomes.",
        voice: ["Clear, structured, user-centered.", "Make decisions explicit; avoid fuzzy scope."],
        autonomy: ["Propose a smallest viable slice.", "Write acceptance criteria before building."],
        care: ["Call out risks and non-goals early.", "Optimize for the user's confidence and clarity."],
        defaults: [
          "Define success metrics.",
          "Document assumptions.",
          "Keep language concrete.",
          "Register artifacts as product.spec with acceptance_criteria and success_metric.",
        ],
      };
    case "design":
      return {
        headline: "Make it feel inevitable and usable.",
        voice: ["Precise, opinionated, kind.", "Avoid generic UI patterns and 'AI slop'."],
        autonomy: ["Iterate fast with constraints.", "Verify mobile + critical states."],
        care: ["Protect coherence of the design system.", "Prioritize accessibility as a baseline."],
        defaults: [
          "Use tokens.",
          "Avoid new visual language.",
          "Capture QA evidence.",
          "Register artifacts as design.component with evidence_url and tokens_referenced.",
        ],
      };
    case "marketing":
      return {
        headline: "Position, prove, and ship to channels.",
        voice: ["Specific, energetic, grounded in reality.", "No generic claims without proof."],
        autonomy: ["Pick a target audience and promise.", "Deliver channel-ready outputs."],
        care: ["Avoid hype that creates trust debt.", "Respect brand voice; keep it crisp."],
        defaults: [
          "Audience -> promise -> proof -> CTA.",
          "Include measurement hooks.",
          "Register artifacts as marketing.asset with audience, channel, and measurement_hook.",
        ],
      };
    case "sales":
      return {
        headline: "Help buyers decide with clarity.",
        voice: ["Concise, empathetic, commercially sharp.", "Anticipate objections; answer plainly."],
        autonomy: ["Start with ICP + disqualifiers.", "Write talk tracks that sound human."],
        care: ["Never overclaim.", "Optimize for trust and next steps."],
        defaults: [
          "MEDDIC-style qualification.",
          "Objection handling + CTA.",
          "Register artifacts as sales.qualification with buyer_stage and next_action.",
        ],
      };
    case "operations":
      return {
        headline: "Keep systems safe, reliable, and reversible.",
        voice: ["Cautious, thorough, pragmatic.", "Prefer runbooks over heroics."],
        autonomy: ["Default to reversible changes.", "Add guardrails before speed."],
        care: ["Assume production is fragile unless proven otherwise.", "Reduce on-call burden."],
        defaults: [
          "Rollback paths.",
          "Detection + alerting.",
          "Post-incident learning.",
          "Register artifacts as operations.runbook with rollback_path and affected_systems.",
        ],
      };
    case "orchestration":
      return {
        headline: "Coordinate workstreams into finished outcomes.",
        voice: ["Structured, decisive, transparent.", "Keep boundaries straight (OrgX vs OpenClaw vs plugin)."],
        autonomy: ["Decompose into verifiable tasks.", "Sequence work to keep momentum."],
        care: ["Minimize context switching.", "Keep stakeholders informed."],
        defaults: [
          "One unverified item at a time.",
          "Reference the canonical plan.",
          "Update statuses with proof.",
          "Register artifacts as orchestration.routing with rationale and unblocked_work.",
        ],
      };
    default:
      return {
        headline: "Execute with clarity.",
        voice: ["Direct, pragmatic."],
        autonomy: ["Proceed by default."],
        care: ["Respect time and context."],
        defaults: ["Verify work."],
      };
  }
}

function buildManagedFileContent(input: {
  agent: OrgxSuiteAgentSpec;
  file: typeof SUITE_FILES[number];
  packId: string;
  packVersion: string;
  skillPack?: OrgxSkillPackOverrides | null;
}): string {
  const persona = domainPersona(input.agent.domain);
  const baseBody = (() => {
    if (input.file === "IDENTITY.md") {
      return [
        `# ${input.agent.name}`,
        "",
        `Domain: ${input.agent.domain}`,
        "",
        `Headline: ${persona.headline}`,
        "",
        "## Voice",
        ...persona.voice.map((line) => `- ${line}`),
        "",
        "## Autonomy",
        ...persona.autonomy.map((line) => `- ${line}`),
        "",
        "## Consideration",
        ...persona.care.map((line) => `- ${line}`),
        "",
        "## Defaults",
        ...persona.defaults.map((line) => `- ${line}`),
        "",
        "## Universal Rules",
        "- Use OrgX as source of truth for tasks/decisions/artifacts when present.",
        "- Verify before claiming done (commands/tests/evidence).",
        "- Keep scope tight; do not over-engineer.",
        "- If blocked, propose options and ask for a decision.",
        "",
      ].join("\n");
    }

    if (input.file === "TOOLS.md") {
      const scopeKey = `orgx-openclaw-${input.agent.domain}`;
      return [
        "# Tools",
        "",
        "Primary tool surface (OrgX MCP tools exposed by this plugin):",
        "- orgx_status",
        "- orgx_sync",
        "- orgx_get_morning_brief",
        "- orgx_query_org_memory",
        "- orgx_recommend_next_action",
        "- orgx_emit_activity",
        "- orgx_apply_changeset",
        "- orgx_register_artifact",
        "- orgx_request_attention / orgx_poll_attention / orgx_ack_attention",
        "- orgx_request_decision (legacy decision-create alias)",
        "- orgx_spawn_check",
        "- orgx_quality_score",
        "- orgx_proof_status",
        "- orgx_record_outcome",
        "- orgx_get_outcome_attribution",
        "- orgx_verify_completion",
        "- orgx_reassign_stream",
        "",
        "## Scoped MCP (Recommended)",
        `If your client supports MCP server selection, prefer the scoped server key: \`${scopeKey}\`.`,
        "This enforces a default-safe allowlist for your domain (high-risk tools are hidden/blocked).",
        "",
        "Scoped allowlist:",
        ...ORGX_AGENT_SCOPED_TOOLS[input.agent.domain].map((tool) => `- ${tool}`),
        "",
        "Rules:",
        "- Return structured JSON for tool outputs when applicable.",
        "- Do not print secrets (API keys, tokens, cookies). Mask as `oxk_...abcd`.",
        "- When calling `orgx_register_artifact`, self-assess and include `confidence_score` in [0,1].",
        "- If a tool fails, capture the exact error and fix root cause.",
        "- Prefer dry-run/previews when writing to user config.",
        "",
      ].join("\n");
    }

    if (input.file === "AGENTS.md") {
      return [
        "# Agent Guardrails",
        "",
        "These rules exist to prevent repeat failures: wrong repo/branch, unverified “done”, tool substitution, and shipping without evidence.",
        "",
        "## Humanity",
        "- Be direct and respectful. No shame, no fluff.",
        "- When the user is stressed or blocked, reduce cognitive load: summarize, propose, decide.",
        "",
        "## Read Before You Write",
        "- Read relevant source files before implementing.",
        "- Read primary docs/specs before coding against an integration.",
        "",
        "## Verification Standards",
        "- Run typecheck and the most relevant tests before claiming a fix is verified.",
        "- UI changes: verify desktop + mobile (375px) and key states (loading/error/empty).",
        "",
        "## Repo Hygiene",
        "- Confirm `pwd` and `git status -sb` before edits.",
        "- Prefer feature branches for non-trivial changes.",
        "",
      ].join("\n");
    }

    if (input.file === "HEARTBEAT.md") {
      const canonicalAgentId =
        input.agent.domain === "orchestration"
          ? "orchestrator-agent"
          : `${input.agent.domain}-agent`;
      return [
        "# Heartbeat",
        "",
        "On every wake:",
        `1. Call \`orgx_status\` with \`agent_id=${canonicalAgentId}\`, \`domain=${input.agent.domain}\`, and \`canonical_only=true\`.`,
        `2. Call \`orgx_recommend_next_action\` with \`entity_type=workspace\`, \`agent_id=${canonicalAgentId}\`, \`domain=${input.agent.domain}\`, and \`canonical_only=true\`.`,
        "3. Select exactly one active, goal-linked task explicitly assigned to this agent or domain.",
        "4. If no runnable task exists, use `heartbeat_respond` with `notify=false` and stop. Do not invent work from memory or old chats.",
        "5. Before acting, require explicit execution context in the task: a repository and working directory, a durable source URL, or an `orgx_only` execution mode. Do not infer it from old chats.",
        "6. If execution context is missing, emit one blocked activity with `blocker_code=missing_execution_context`, name the exact missing field, use `heartbeat_respond` with `notify=false`, and stop.",
        "7. If the task is runnable, complete one bounded step that changes its state or produces durable proof. Use at most 5 total tool calls after discovery, including proof and reporting calls, then call `heartbeat_respond` once and stop. Do not switch tasks.",
        "8. Emit OrgX activity at intent, execution, review, and completed checkpoints. Include the goal, initiative, workstream, and task IDs when available.",
        "9. Register durable output with `orgx_register_artifact`, always passing the selected task as `entity_type=task` and its exact `entity_id`. A status message alone is not progress.",
        "10. When blocked by a human choice, request one typed attention item with options, tradeoffs, a recommendation, and preserved continuation context. Poll that same item; acknowledge resumed only after new execution evidence. Report provider or credential failures against Agent Operational Health, not as owner decisions.",
        "11. Never claim a test, query, deployment, or production result unless its successful tool output was observed in this heartbeat. Existing source or old chat context is unverified evidence.",
        "12. Before recording a successful outcome, emitting a completed activity, updating an entity to done/completed, or using `heartbeat_respond` with `outcome=done`, call `orgx_verify_completion` for the selected task. Only report success or done when it returns both `ready=true` and `verified=true`; otherwise report progress or blocked and preserve the task state.",
        "",
        "Safety:",
        "- Never reopen or downgrade a done/completed task because a runtime, provider, or heartbeat is unavailable.",
        "- Never use `find`, broad `grep`, home-directory search, browser discovery, or filesystem reads outside the task's explicit working directory during a heartbeat.",
        "- Do not send outbound messages, spend money, deploy, or publish unless the task policy or a human decision explicitly allows it.",
        "- When you change direction, explain why in one sentence before switching.",
        "",
      ].join("\n");
    }

    if (input.file === "USER.md") {
      return [
        "# User Preferences",
        "",
        "Default assumptions:",
        "- Prefer concise, actionable updates.",
        "- Ask only when necessary; otherwise proceed and show proof.",
        "- Surface assumptions and risks early (before time-consuming work).",
        "- End with next-step options when multiple paths exist.",
        "",
      ].join("\n");
    }

    if (input.file === "SKILL.md") {
      const override = input.skillPack?.openclaw_skills?.[input.agent.domain] ?? null;
      const provenance = input.skillPack
        ? `SkillPack: ${input.skillPack.name}@${input.skillPack.version} (${input.skillPack.source}, sha256:${input.skillPack.checksum.slice(0, 12)}...)`
        : "SkillPack: builtin (no server pack applied)";

      const generated = [
        `# ${input.agent.name} — Skill`,
        "",
        `Domain: ${input.agent.domain}`,
        "",
        "## Purpose",
        `- ${persona.headline}`,
        "",
        "## Persona",
        "Voice:",
        ...persona.voice.map((line) => `- ${line}`),
        "",
        "Autonomy:",
        ...persona.autonomy.map((line) => `- ${line}`),
        "",
        "Consideration:",
        ...persona.care.map((line) => `- ${line}`),
        "",
        "Defaults:",
        ...persona.defaults.map((line) => `- ${line}`),
        "",
        "## Operating Loop",
        "- Clarify the goal and constraints (one sentence each).",
        "- Propose the next 1-3 steps with an explicit recommendation.",
        "- Execute with proof: commands run, files changed, tests/evidence captured.",
        "- When blocked: show the exact error, then offer options with tradeoffs.",
        "",
        "## Reporting",
        "- Post progress at natural checkpoints: intent, execution, review, completed.",
        "- Prefer concrete updates over vibes (what changed, where, how verified).",
        "- If you made a decision, record it as a decision request/result upstream (OrgX).",
        "",
        "## Boundaries",
        "- Do not print secrets. Mask keys as `oxk_...abcd`.",
        "- Avoid destructive git ops unless explicitly requested.",
        "- Keep scope tight: do the asked work, then stop.",
        "",
        "## Team Awareness",
        "- Your prompt may include a \"Team Activity\" section showing other agents' recent work.",
        "- Reference team outputs naturally when relevant (\"Building on the auth endpoints\" not \"The Engineering agent completed...\").",
        "- If your task connects to recent team work, mention the connection briefly.",
        "- Do not duplicate work another agent has completed.",
        "",
        "## Provenance",
        `- ${provenance}`,
        "",
      ].join("\n");

      // If a server pack provides a SKILL.md, prefer it; otherwise use the generated baseline.
      return override ? String(override).trimEnd() + "\n" : generated + "\n";
    }

    if (input.file === "SOUL.md") {
      return [
        "# Soul",
        "",
        "OrgX agents are spirits/light entities: responsible + fun, never juvenile.",
        "Avoid cartoonish mascots. Keep tone professional, direct, and pragmatic.",
        "",
        "Metaphor:",
        "- Threads, prisms, workstreams, light, and organizational flow.",
        "- Enhance the claw: armor on top of the claw, not replacement.",
        "",
      ].join("\n");
    }

    return `# ${input.agent.name}\n`;
  })();

  const normalized = normalizeNewlines(baseBody).trimEnd() + "\n";
  const bodySha = sha256(normalized);
  return `${managedHeader({
    packId: input.packId,
    packVersion: input.packVersion,
    file: input.file,
    managedSha: bodySha,
  })}${normalized}`;
}

function upsertSuiteAgentsIntoConfig(input: {
  openclaw: OpenClawConfig | null;
  suiteWorkspaceRoot: string;
}): { updated: boolean; next: OpenClawConfig; addedAgentIds: string[] } {
  const openclaw: OpenClawConfig = input.openclaw && typeof input.openclaw === "object" ? input.openclaw : {};

  const pluginsObj = isRecord(openclaw.plugins)
    ? (openclaw.plugins as Record<string, unknown>)
    : {};
  const entriesObj = isRecord(pluginsObj.entries)
    ? (pluginsObj.entries as Record<string, unknown>)
    : {};
  const orgxEntry = isRecord(entriesObj.orgx)
    ? (entriesObj.orgx as Record<string, unknown>)
    : {};
  const hooksObj = isRecord(orgxEntry.hooks)
    ? (orgxEntry.hooks as Record<string, unknown>)
    : {};
  const conversationHookUpdated = hooksObj.allowConversationAccess !== true;

  const agentsObj = isRecord(openclaw.agents) ? (openclaw.agents as Record<string, unknown>) : {};
  const currentListRaw = Array.isArray(agentsObj.list) ? agentsObj.list : [];
  const currentList: OpenClawAgentEntry[] = currentListRaw
    .map((entry) => (entry && typeof entry === "object" ? (entry as OpenClawAgentEntry) : null))
    .filter((entry): entry is OpenClawAgentEntry => Boolean(entry));

  const nextList: OpenClawAgentEntry[] = [...currentList];
  const added: string[] = [];
  let updatedExisting = false;

  for (const agent of ORGX_AGENT_SUITE_AGENTS) {
    if (!isSafeAgentId(agent.id)) continue;
    const existingIndex = nextList.findIndex(
      (entry) => String(entry?.id ?? "").trim() === agent.id
    );
    const requiredTools = ORGX_AGENT_SCOPED_TOOLS[agent.domain];
    if (existingIndex >= 0) {
      const existing = nextList[existingIndex];
      const existingTools = isRecord(existing.tools) ? existing.tools : {};
      const currentAlsoAllow = Array.isArray(existingTools.alsoAllow)
        ? existingTools.alsoAllow.filter(
            (tool): tool is string => typeof tool === "string" && tool.trim().length > 0
          )
        : [];
      const nextAlsoAllow = Array.from(
        new Set([...currentAlsoAllow, ...requiredTools])
      );
      if (nextAlsoAllow.length !== currentAlsoAllow.length) {
        nextList[existingIndex] = {
          ...existing,
          tools: {
            ...existingTools,
            alsoAllow: nextAlsoAllow,
          },
        };
        updatedExisting = true;
      }
      continue;
    }

    const workspace = join(input.suiteWorkspaceRoot, agent.id);
    nextList.push({
      id: agent.id,
      name: agent.name,
      workspace,
      tools: {
        alsoAllow: [...requiredTools],
      },
    });
    added.push(agent.id);
  }

  if (added.length === 0 && !updatedExisting && !conversationHookUpdated) {
    return { updated: false, next: openclaw, addedAgentIds: [] };
  }

  const nextAgents = { ...(agentsObj as any), list: nextList };
  const next = {
    ...openclaw,
    agents: nextAgents,
    plugins: {
      ...pluginsObj,
      entries: {
        ...entriesObj,
        orgx: {
          ...orgxEntry,
          hooks: {
            ...hooksObj,
            allowConversationAccess: true,
          },
        },
      },
    },
  };
  return { updated: true, next, addedAgentIds: added };
}

export function computeOrgxAgentSuitePlan(input: {
  packVersion: string;
  openclawDir?: string;
  skillPack?: OrgxSkillPackOverrides | null;
  skillPackRemote?: OrgxAgentSuiteStatus["skillPackRemote"] | null;
  skillPackPolicy?: OrgxAgentSuiteStatus["skillPackPolicy"] | null;
  skillPackUpdateAvailable?: boolean;
}): OrgxAgentSuitePlan {
  const packVersion = input.packVersion.trim() || "0.0.0";
  const openclawDir = input.openclawDir ?? getOpenClawDir();
  const { path: cfgPath, parsed } = readOpenclawConfig(openclawDir);

  const suiteWorkspaceRoot = resolveSuiteWorkspaceRoot(parsed);
  const upsert = upsertSuiteAgentsIntoConfig({ openclaw: parsed, suiteWorkspaceRoot });

  const baseAgents = ORGX_AGENT_SUITE_AGENTS.map((agent) => {
    const workspace = join(suiteWorkspaceRoot, agent.id);
    const list = Array.isArray(parsed?.agents?.list) ? parsed?.agents?.list : [];
    const configured = list.some((entry) => String(entry?.id ?? "").trim() === agent.id);
    return {
      ...agent,
      workspace,
      configuredInOpenclaw: configured || upsert.addedAgentIds.includes(agent.id),
      workspaceExists: existsSync(workspace),
    };
  });

  const workspaceFiles: OrgxAgentSuitePlan["workspaceFiles"] = [];
  const healthStats = new Map<
    string,
    { totalChecks: number; passedChecks: number; failedChecks: number; lastChangedMs: number | null }
  >();
  for (const agent of baseAgents) {
    for (const file of SUITE_FILES) {
      const managedPath = join(agent.workspace, SUITE_MANAGED_DIR, file);
      const localPath = join(agent.workspace, SUITE_LOCAL_DIR, file);
      const compositePath = join(agent.workspace, file);

      const managedContent = buildManagedFileContent({
        agent,
        file,
        packId: ORGX_AGENT_SUITE_PACK_ID,
        packVersion,
        skillPack: input.skillPack ?? null,
      });
      const existingComposite = loadTextFile(compositePath);
      const embeddedOverride = existingComposite ? extractLocalOverridesFromComposite(existingComposite) : null;
      const localOverride = loadTextFile(localPath) ?? embeddedOverride;
      const compositeContent = buildCompositeFile({ managed: managedContent, localOverride });
      const pristineManagedComposite = existingComposite
        ? isPristineManagedComposite(existingComposite, file)
        : false;

      const action =
        !existsSync(compositePath)
          ? "create"
          : normalizeNewlines(existingComposite ?? "") !== normalizeNewlines(compositeContent)
            ? localOverride || pristineManagedComposite
              ? "update"
              : "conflict"
            : "noop";

      workspaceFiles.push({
        agentId: agent.id,
        file,
        managedPath,
        localPath,
        compositePath,
        action,
      });

      const stats = healthStats.get(agent.id) ?? {
        totalChecks: 0,
        passedChecks: 0,
        failedChecks: 0,
        lastChangedMs: null,
      };
      stats.totalChecks += 1;
      if (action === "noop") {
        stats.passedChecks += 1;
      }
      if (action === "conflict") {
        stats.failedChecks += 1;
      }
      const changedMs = readFileMtimeMs(compositePath);
      if (typeof changedMs === "number" && (stats.lastChangedMs == null || changedMs > stats.lastChangedMs)) {
        stats.lastChangedMs = changedMs;
      }
      healthStats.set(agent.id, stats);
    }
  }

  const agents: OrgxAgentSuiteStatus["agents"] = baseAgents.map((agent) => {
    const stats = healthStats.get(agent.id) ?? {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      lastChangedMs: null,
    };
    const status: OrgxAgentConfigHealthStatus =
      stats.failedChecks > 0
        ? "conflict"
        : stats.totalChecks > 0 && stats.passedChecks === stats.totalChecks
          ? "healthy"
          : "needs_apply";
    const evalPassRate = stats.totalChecks > 0 ? roundRate(stats.passedChecks / stats.totalChecks) : 0;
    return {
      ...agent,
      configHealth: {
        status,
        lastChangedAt: stats.lastChangedMs == null ? null : new Date(stats.lastChangedMs).toISOString(),
        evalPassRate,
        totalChecks: stats.totalChecks,
        passedChecks: stats.passedChecks,
        failedChecks: stats.failedChecks,
      },
    };
  });

  return {
    packId: ORGX_AGENT_SUITE_PACK_ID,
    packVersion,
    openclawConfigPath: cfgPath,
    suiteWorkspaceRoot,
    skillPack: input.skillPack
      ? {
          source: input.skillPack.source,
          name: input.skillPack.name,
          version: input.skillPack.version,
          checksum: input.skillPack.checksum,
          etag: input.skillPack.etag ?? null,
          updated_at: input.skillPack.updated_at ?? null,
        }
      : null,
    skillPackRemote: input.skillPackRemote ?? null,
    skillPackPolicy: input.skillPackPolicy ?? null,
    skillPackUpdateAvailable: Boolean(input.skillPackUpdateAvailable),
    agents,
    openclawConfigWouldUpdate: upsert.updated,
    openclawConfigAddedAgents: upsert.addedAgentIds,
    workspaceFiles,
  };
}

export function applyOrgxAgentSuitePlan(input: {
  plan: OrgxAgentSuitePlan;
  dryRun?: boolean;
  openclawDir?: string;
  skillPack?: OrgxSkillPackOverrides | null;
}): { ok: true; applied: boolean; plan: OrgxAgentSuitePlan } {
  const dryRun = input.dryRun ?? false;
  if (dryRun) return { ok: true, applied: false, plan: input.plan };

  const openclawDir = input.openclawDir ?? getOpenClawDir();
  const read = readOpenclawConfig(openclawDir);
  const suiteWorkspaceRoot = input.plan.suiteWorkspaceRoot;

  const upsert = upsertSuiteAgentsIntoConfig({
    openclaw: read.parsed,
    suiteWorkspaceRoot,
  });

  if (upsert.updated) {
    // Preserve the original file mode when possible.
    writeFileAtomicSync(
      read.path,
      `${JSON.stringify(upsert.next, null, 2)}\n`,
      { mode: read.fileMode || 0o600, encoding: "utf8" }
    );
  }

  // Workspaces + files
  const actionByFileKey = new Map<string, OrgxAgentSuitePlan["workspaceFiles"][number]["action"]>();
  for (const entry of input.plan.workspaceFiles ?? []) {
    actionByFileKey.set(`${entry.agentId}:${entry.file}`, entry.action);
  }

  for (const agent of input.plan.agents) {
    ensureDir(agent.workspace, 0o700);
    ensureDir(join(agent.workspace, SUITE_MANAGED_DIR), 0o700);
    ensureDir(join(agent.workspace, SUITE_LOCAL_DIR), 0o700);

    for (const file of SUITE_FILES) {
      const action = actionByFileKey.get(`${agent.id}:${file}`) ?? "update";
      if (action === "conflict") {
        // Do not clobber files that appear to have out-of-band edits.
        continue;
      }

      const managedPath = join(agent.workspace, SUITE_MANAGED_DIR, file);
      const localPath = join(agent.workspace, SUITE_LOCAL_DIR, file);
      const compositePath = join(agent.workspace, file);

      const managed = buildManagedFileContent({
        agent,
        file,
        packId: ORGX_AGENT_SUITE_PACK_ID,
        packVersion: input.plan.packVersion,
        skillPack: input.skillPack ?? null,
      });
      let localOverride = loadTextFile(localPath);
      if (!localOverride) {
        const existingComposite = loadTextFile(compositePath);
        const embedded = existingComposite
          ? extractLocalOverridesFromComposite(existingComposite)
          : null;
        if (embedded) {
          // Preserve user edits that were appended to the composite but never moved into `.orgx/local/*`.
          ensureDir(dirname(localPath), 0o700);
          writeFileAtomicSync(localPath, embedded, { mode: 0o600, encoding: "utf8" });
          localOverride = embedded;
        }
      }
      const composite = buildCompositeFile({ managed, localOverride });

      // Managed file always updated to match current pack content.
      ensureDir(dirname(managedPath), 0o700);
      writeFileAtomicSync(managedPath, managed, { mode: 0o600, encoding: "utf8" });

      // Composite file updated iff needed.
      const existing = loadTextFile(compositePath);
      if (!existing || normalizeNewlines(existing) !== normalizeNewlines(composite)) {
        writeFileAtomicSync(compositePath, composite, { mode: 0o600, encoding: "utf8" });
      }

      // Ensure local override file exists only if user created it; do not create it.
      void localPath;
    }
  }

  return { ok: true, applied: true, plan: input.plan };
}

export function generateAgentSuiteOperationId(): string {
  return `suite:${Date.now()}:${randomUUID().slice(0, 8)}`;
}
