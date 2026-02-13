import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeFileAtomicSync } from "./fs-utils.js";
import { getOpenClawDir } from "./paths.js";

type OpenClawAgentEntry = {
  id?: string;
  name?: string;
  default?: boolean;
  workspace?: string;
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

function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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
        defaults: ["Reproduce before fixing.", "Add tests when feasible.", "Keep diffs small."],
      };
    case "product":
      return {
        headline: "Turn ambiguity into shippable outcomes.",
        voice: ["Clear, structured, user-centered.", "Make decisions explicit; avoid fuzzy scope."],
        autonomy: ["Propose a smallest viable slice.", "Write acceptance criteria before building."],
        care: ["Call out risks and non-goals early.", "Optimize for the user's confidence and clarity."],
        defaults: ["Define success metrics.", "Document assumptions.", "Keep language concrete."],
      };
    case "design":
      return {
        headline: "Make it feel inevitable and usable.",
        voice: ["Precise, opinionated, kind.", "Avoid generic UI patterns and 'AI slop'."],
        autonomy: ["Iterate fast with constraints.", "Verify mobile + critical states."],
        care: ["Protect coherence of the design system.", "Prioritize accessibility as a baseline."],
        defaults: ["Use tokens.", "Avoid new visual language.", "Capture QA evidence."],
      };
    case "marketing":
      return {
        headline: "Position, prove, and ship to channels.",
        voice: ["Specific, energetic, grounded in reality.", "No generic claims without proof."],
        autonomy: ["Pick a target audience and promise.", "Deliver channel-ready outputs."],
        care: ["Avoid hype that creates trust debt.", "Respect brand voice; keep it crisp."],
        defaults: ["Audience -> promise -> proof -> CTA.", "Include measurement hooks."],
      };
    case "sales":
      return {
        headline: "Help buyers decide with clarity.",
        voice: ["Concise, empathetic, commercially sharp.", "Anticipate objections; answer plainly."],
        autonomy: ["Start with ICP + disqualifiers.", "Write talk tracks that sound human."],
        care: ["Never overclaim.", "Optimize for trust and next steps."],
        defaults: ["MEDDIC-style qualification.", "Objection handling + CTA."],
      };
    case "operations":
      return {
        headline: "Keep systems safe, reliable, and reversible.",
        voice: ["Cautious, thorough, pragmatic.", "Prefer runbooks over heroics."],
        autonomy: ["Default to reversible changes.", "Add guardrails before speed."],
        care: ["Assume production is fragile unless proven otherwise.", "Reduce on-call burden."],
        defaults: ["Rollback paths.", "Detection + alerting.", "Post-incident learning."],
      };
    case "orchestration":
      return {
        headline: "Coordinate workstreams into finished outcomes.",
        voice: ["Structured, decisive, transparent.", "Keep boundaries straight (OrgX vs OpenClaw vs plugin)."],
        autonomy: ["Decompose into verifiable tasks.", "Sequence work to keep momentum."],
        care: ["Minimize context switching.", "Keep stakeholders informed."],
        defaults: ["One unverified item at a time.", "Reference the canonical plan.", "Update statuses with proof."],
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
      return [
        "# Tools",
        "",
        "Primary tool surface (OrgX MCP tools exposed by this plugin):",
        "- orgx_status",
        "- orgx_sync",
        "- orgx_emit_activity",
        "- orgx_apply_changeset",
        "- orgx_register_artifact",
        "- orgx_request_decision",
        "- orgx_spawn_check",
        "",
        "Rules:",
        "- Return structured JSON for tool outputs when applicable.",
        "- Do not print secrets (API keys, tokens, cookies). Mask as `oxk_...abcd`.",
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
      return [
        "# Heartbeat",
        "",
        "Cadence:",
        "- Emit OrgX activity at natural checkpoints: intent, execution, review, completed.",
        "- When blocked: request a decision with options, tradeoffs, and a recommendation.",
        "- When you change direction: explain why in one sentence before switching.",
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

  const agentsObj = isRecord(openclaw.agents) ? (openclaw.agents as Record<string, unknown>) : {};
  const currentListRaw = Array.isArray(agentsObj.list) ? agentsObj.list : [];
  const currentList: OpenClawAgentEntry[] = currentListRaw
    .map((entry) => (entry && typeof entry === "object" ? (entry as OpenClawAgentEntry) : null))
    .filter((entry): entry is OpenClawAgentEntry => Boolean(entry));

  const byId = new Map<string, OpenClawAgentEntry>();
  for (const entry of currentList) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    byId.set(id, entry);
  }

  const nextList: OpenClawAgentEntry[] = [...currentList];
  const added: string[] = [];

  for (const agent of ORGX_AGENT_SUITE_AGENTS) {
    if (!isSafeAgentId(agent.id)) continue;
    if (byId.has(agent.id)) continue;

    const workspace = join(input.suiteWorkspaceRoot, agent.id);
    nextList.push({
      id: agent.id,
      name: agent.name,
      workspace,
    });
    added.push(agent.id);
  }

  if (added.length === 0) {
    return { updated: false, next: openclaw, addedAgentIds: [] };
  }

  const nextAgents = { ...(agentsObj as any), list: nextList };
  const next = { ...openclaw, agents: nextAgents };
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

  const agents = ORGX_AGENT_SUITE_AGENTS.map((agent) => {
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
  for (const agent of agents) {
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

      const action =
        !existsSync(compositePath)
          ? "create"
          : normalizeNewlines(existingComposite ?? "") !== normalizeNewlines(compositeContent)
            ? localOverride
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
    }
  }

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
