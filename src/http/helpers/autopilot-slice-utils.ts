import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

import { writeFileAtomicSync } from "../../fs-utils.js";
import { parseJsonSafe } from "../../json-utils.js";
import { getOrgxPluginConfigDir } from "../../paths.js";

function ensurePrivateDirForFile(pathname: string): void {
  const dir = dirname(pathname);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

function autopilotSliceSchema(): Record<string, unknown> {
  // Strict enough to keep outputs predictable, but tolerant of older agents.
  const artifactProperties = {
    name: { type: "string", minLength: 1 },
    artifact_type: {
      type: "string",
      enum: ["pr", "commit", "document", "config", "report", "design", "retro", "other"],
    },
    confidence_score: { type: ["number", "null"], minimum: 0, maximum: 1 },
    description: { type: ["string", "null"] },
    url: { type: ["string", "null"] },
    verification_steps: { type: ["array", "null"], items: { type: "string" } },
    milestone_id: { type: ["string", "null"] },
    task_ids: { type: ["array", "null"], items: { type: "string" } },
  } as const;
  const decisionProperties = {
    question: { type: "string", minLength: 1 },
    summary: { type: ["string", "null"] },
    options: { type: ["array", "null"], items: { type: "string" } },
    urgency: {
      type: ["string", "null"],
      enum: ["low", "medium", "high", "urgent", null],
    },
    blocking: { type: "boolean" },
  } as const;
  const skillEvidenceProperties = {
    skill: { type: "string", minLength: 1 },
    skill_file: { type: ["string", "null"] },
    skill_sha256: { type: ["string", "null"] },
    skill_heading: { type: ["string", "null"] },
  } as const;
  const taskUpdateProperties = {
    task_id: { type: "string", minLength: 1 },
    status: { type: "string", enum: ["todo", "in_progress", "done", "blocked"] },
    reason: { type: ["string", "null"] },
  } as const;
  const milestoneUpdateProperties = {
    milestone_id: { type: "string", minLength: 1 },
    status: {
      type: "string",
      enum: ["planned", "in_progress", "completed", "at_risk", "cancelled"],
    },
    reason: { type: ["string", "null"] },
  } as const;
  const topLevelProperties = {
    status: {
      type: "string",
      enum: ["completed", "blocked", "needs_decision", "error"],
    },
    summary: { type: "string", minLength: 1 },
    workstream_id: { type: "string", minLength: 1 },
    workstream_title: { type: ["string", "null"] },
    slice_id: { type: ["string", "null"] },
    artifacts: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(artifactProperties),
        properties: artifactProperties,
      },
    },
    decisions_needed: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(decisionProperties),
        properties: decisionProperties,
      },
    },
    skill_evidence: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(skillEvidenceProperties),
        properties: skillEvidenceProperties,
      },
    },
    task_updates: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(taskUpdateProperties),
        properties: taskUpdateProperties,
      },
    },
    milestone_updates: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        required: Object.keys(milestoneUpdateProperties),
        properties: milestoneUpdateProperties,
      },
    },
    next_actions: { type: ["array", "null"], items: { type: "string" } },
  } as const;

  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(topLevelProperties),
    properties: topLevelProperties,
    // Keep schema within Codex structured-output subset (no combinators like allOf/if/then).
    // Status/decision consistency is enforced by coordinator post-parse.
  };
}

export function ensureAutopilotSliceSchemaPath(schemaFilename: string): string {
  const file = join(getOrgxPluginConfigDir(), schemaFilename);
  const nextSchemaRaw = JSON.stringify(autopilotSliceSchema(), null, 2);
  try {
    if (existsSync(file)) {
      try {
        const existingRaw = readFileSync(file, "utf8").trim();
        if (existingRaw === nextSchemaRaw) return file;
      } catch {
        // continue and rewrite
      }
    }
    ensurePrivateDirForFile(file);
    writeFileAtomicSync(file, nextSchemaRaw, { mode: 0o600 });
    return file;
  } catch {
    // Fall back to best-effort write.
    try {
      ensurePrivateDirForFile(file);
      writeFileSync(file, `${nextSchemaRaw}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // ignore
    }
    return file;
  }
}

export function parseSliceResult<T extends object>(raw: string): T | null {
  const unwrapStructuredOutput = (value: unknown): T | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const structured = record.structured_output;
    if (structured && typeof structured === "object") return structured as T;
    if (typeof structured === "string") {
      const parsedStructured = parseJsonSafe<T>(structured.trim());
      if (parsedStructured && typeof parsedStructured === "object") return parsedStructured;
    }
    // Claude text-mode envelopes can sometimes return JSON in `result`.
    if (typeof record.result === "string") {
      const parsedResult = parseJsonSafe<T>(record.result.trim());
      if (parsedResult && typeof parsedResult === "object") return parsedResult;
    }
    return record as T;
  };

  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = parseJsonSafe<unknown>(trimmed);
  const directUnwrapped = unwrapStructuredOutput(direct);
  if (directUnwrapped && typeof directUnwrapped === "object") return directUnwrapped;

  // Tolerant parse: extract the last complete top-level JSON object from mixed logs.
  const extractLastTopLevelObject = (text: string): string | null => {
    let inString = false;
    let escaped = false;
    let depth = 0;
    let start = -1;
    let lastObject: string | null = null;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
        continue;
      }
      if (ch === "}") {
        if (depth <= 0) continue;
        depth -= 1;
        if (depth === 0 && start >= 0) {
          lastObject = text.slice(start, i + 1);
          start = -1;
        }
      }
    }
    return lastObject;
  };

  const candidate = extractLastTopLevelObject(trimmed);
  if (candidate) {
    const parsed = parseJsonSafe<unknown>(candidate);
    const unwrapped = unwrapStructuredOutput(parsed);
    if (unwrapped && typeof unwrapped === "object") return unwrapped;
  }
  return null;
}

export function readSliceOutputFile(pathname: string): string | null {
  try {
    if (!existsSync(pathname)) return null;
    const raw = readFileSync(pathname, "utf8");
    return raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function readFileTailSafe(pathname: string, maxChars = 64_000): string {
  try {
    if (!existsSync(pathname)) return "";
    const raw = readFileSync(pathname, "utf8");
    if (raw.length <= maxChars) return raw;
    return raw.slice(raw.length - maxChars);
  } catch {
    return "";
  }
}

export function fileUpdatedAtEpochMs(pathname: string, fallbackEpochMs: number): number {
  try {
    const st = statSync(pathname);
    const mtimeMs = (st.mtimeMs as number) ?? 0;
    return Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : fallbackEpochMs;
  } catch {
    return fallbackEpochMs;
  }
}

export type CodexBinInfo = {
  bin: string;
  version: [number, number, number] | null;
  versionString: string | null;
};

export function normalizeCodexArgs(args: string[]): string[] {
  const normalized = Array.isArray(args) ? [...args] : [];
  const first = normalized[0];
  const looksLikeFlag = typeof first === "string" && first.startsWith("-");
  const looksLikeCommand =
    first === "exec" ||
    first === "e" ||
    first === "review" ||
    first === "resume" ||
    first === "help" ||
    first === "features" ||
    first === "mcp" ||
    first === "mcp-server" ||
    first === "app" ||
    first === "app-server" ||
    first === "debug" ||
    first === "cloud";

  // `codex` without a subcommand expects a TTY; autopilot is headless.
  if (!looksLikeCommand || looksLikeFlag) {
    normalized.unshift("exec");
  }

  if (!normalized.includes("--skip-git-repo-check")) {
    normalized.push("--skip-git-repo-check");
  }

  return normalized;
}

function parseCodexVersion(text: string): { version: [number, number, number] | null; raw: string | null } {
  const raw = (text ?? "").trim();
  if (!raw) return { version: null, raw: null };
  const match = raw.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return { version: null, raw };
  return {
    version: [Number(match[1]), Number(match[2]), Number(match[3])],
    raw,
  };
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function probeCodexBin(bin: string): CodexBinInfo | null {
  const trimmed = (bin ?? "").trim();
  if (!trimmed) return null;
  try {
    const env = { ...process.env };
    // NVM-installed codex scripts commonly use `#!/usr/bin/env node`. LaunchAgent PATH may not
    // include the corresponding node binary, so prefer the sibling bin dir for resolution.
    if (trimmed.includes(sep)) {
      const binDir = dirname(trimmed);
      env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir;
    }
    const result = spawnSync(trimmed, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const parsed = parseCodexVersion(combined || String(result.stdout ?? "").trim());
    return {
      bin: trimmed,
      version: parsed.version,
      versionString: parsed.raw,
    };
  } catch {
    return null;
  }
}

function listNvmCodexCandidates(): { candidates: string[]; summary: string | null } {
  try {
    const bases = new Set<string>();
    bases.add(join(homedir(), ".nvm", "versions", "node"));
    if (process.env.HOME && process.env.HOME.trim()) {
      bases.add(join(process.env.HOME.trim(), ".nvm", "versions", "node"));
    }

    for (const base of bases) {
      if (!existsSync(base)) continue;
      const raw = readdirSync(base);
      const versionNames = raw.filter((name) => /^v\d+\.\d+\.\d+$/.test(name));
      const entries: string[] = [];
      for (const name of versionNames) {
        try {
          if (statSync(join(base, name)).isDirectory()) entries.push(name);
        } catch {
          // ignore
        }
      }
      const summary = `base=${base} raw=${raw.length} versions=${versionNames.length} dirs=${entries.length}`;
      if (entries.length === 0) return { candidates: [], summary };

      const parsed = entries
        .map((name) => {
          const m = name.match(/^v(\d+)\.(\d+)\.(\d+)$/);
          if (!m) return null;
          return {
            name,
            ver: [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number],
          };
        })
        .filter((x): x is { name: string; ver: [number, number, number] } => Boolean(x));

      parsed.sort((a, b) => compareSemver(b.ver, a.ver));
      return {
        candidates: parsed
          .slice(0, 8)
          .map((entry) => join(base, entry.name, "bin", "codex")),
        summary,
      };
    }
    return { candidates: [], summary: null };
  } catch {
    return { candidates: [], summary: null };
  }
}

export function createCodexBinResolver() {
  let cachedCodexBinInfo: CodexBinInfo | null = null;
  let cachedCodexProbeSummary: string | null = null;

  function resolveCodexBinInfo(): CodexBinInfo {
    if (cachedCodexBinInfo) return cachedCodexBinInfo;

    const candidates: string[] = [];

    const explicit = (process.env.ORGX_CODEX_BIN ?? "").trim();
    if (explicit) candidates.push(explicit);

    const nvmBin = (process.env.NVM_BIN ?? "").trim();
    if (nvmBin) candidates.push(join(nvmBin, "codex"));

    // Whatever is on PATH for the gateway process.
    candidates.push("codex");

    // LaunchAgents often miss shell init (nvm), so check common per-user installs.
    const nvmScan = listNvmCodexCandidates();
    candidates.push(...nvmScan.candidates);

    // Homebrew / legacy paths.
    candidates.push("/opt/homebrew/bin/codex");
    candidates.push("/usr/local/bin/codex");

    const seen = new Set<string>();
    const unique = candidates.filter((candidate) => {
      const key = (candidate ?? "").trim();
      if (!key) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const probeSummary: string[] = [];
    try {
      const nvmBase = join(homedir(), ".nvm", "versions", "node");
      const nvmExists = existsSync(nvmBase);
      let nvmEntries = "";
      if (nvmExists) {
        try {
          nvmEntries = readdirSync(nvmBase).slice(0, 6).join(",");
        } catch {
          nvmEntries = "(readdir_failed)";
        }
      }
      probeSummary.push(`nvm_base=${nvmBase} exists=${nvmExists}${nvmEntries ? ` entries=${nvmEntries}` : ""}`);
    } catch {
      // best effort
    }
    probeSummary.push(
      `nvm_codex_candidates=${nvmScan.candidates.length}${nvmScan.candidates.length > 0 ? ` first=${nvmScan.candidates[0]}` : ""}`
    );
    if (nvmScan.summary) {
      probeSummary.push(`nvm_scan=${nvmScan.summary}`);
    }

    let best: CodexBinInfo | null = null;
    for (const candidate of unique) {
      const probed = probeCodexBin(candidate);
      probeSummary.push(
        `${candidate} => ${probed?.versionString ? probed.versionString.replace(/\s+/g, " ") : "unavailable"}`
      );
      if (!probed) continue;
      if (!best) {
        best = probed;
        continue;
      }
      if (probed.version && !best.version) {
        best = probed;
        continue;
      }
      if (!probed.version || !best.version) continue;
      if (compareSemver(probed.version, best.version) > 0) best = probed;
    }

    cachedCodexBinInfo = best ?? { bin: explicit || "codex", version: null, versionString: null };
    cachedCodexProbeSummary = probeSummary.slice(0, 14).join(" | ");
    return cachedCodexBinInfo;
  }

  function getCachedCodexProbeSummary(): string | null {
    return cachedCodexProbeSummary;
  }

  return {
    resolveCodexBinInfo,
    getCachedCodexProbeSummary,
  };
}

export function buildWorkstreamSlicePrompt(input: {
  initiativeTitle: string;
  initiativeId: string;
  workstreamId: string;
  workstreamTitle: string;
  milestoneSummaries: Array<{ id: string; title: string; status: string }>;
  taskSummaries: Array<{ id: string; title: string; status: string; milestoneId: string | null }>;
  executionPolicy: { domain: string; requiredSkills: string[] };
  behaviorConfig?: {
    configId?: string | null;
    version?: string | null;
    hash?: string | null;
    policySource?: string | null;
    context?: string | null;
  } | null;
  runId: string;
  schemaPath: string;
}): string {
  const normalizeSkillName = (skill: string): string => skill.replace(/^\$/, "").trim();
  const skillAliasesFor = (skill: string): string[] => {
    const normalized = normalizeSkillName(skill);
    if (!normalized) return [];
    const aliases = [normalized];
    if (normalized.startsWith("orgx-")) aliases.push(normalized.slice("orgx-".length));
    if (normalized.endsWith("-agent")) aliases.push(normalized.slice(0, -"-agent".length));
    return Array.from(new Set(aliases.filter(Boolean)));
  };
  const skillHints = input.executionPolicy.requiredSkills
    .map((skill) => {
      const normalized = normalizeSkillName(skill);
      const aliases = skillAliasesFor(normalized);
      const hintPaths = aliases
        .flatMap((alias) => [
          join(homedir(), ".codex", "skills", alias, "SKILL.md"),
          join(homedir(), ".agents", "skills", alias, "SKILL.md"),
        ])
        .filter(Boolean);
      return {
        skill: normalized,
        hintPaths: Array.from(new Set(hintPaths)),
      };
    })
    .filter((entry) => entry.skill.length > 0);

  const milestones = input.milestoneSummaries
    .map((m) => `- ${m.title} (${m.status}) [${m.id}]`)
    .slice(0, 10)
    .join("\n");
  const tasks = input.taskSummaries
    .map((t) => {
      const milestone = t.milestoneId ? ` milestone=${t.milestoneId}` : "";
      return `- ${t.title} (${t.status}) [${t.id}]${milestone}`;
    })
    .slice(0, 18)
    .join("\n");
  const behaviorConfigLines = [
    input.behaviorConfig?.configId
      ? `- behavior_config_id: ${input.behaviorConfig.configId}`
      : null,
    input.behaviorConfig?.version
      ? `- behavior_config_version: ${input.behaviorConfig.version}`
      : null,
    input.behaviorConfig?.hash
      ? `- behavior_config_hash: ${input.behaviorConfig.hash}`
      : null,
    input.behaviorConfig?.policySource
      ? `- policy_source: ${input.behaviorConfig.policySource}`
      : null,
    input.behaviorConfig?.context
      ? `- behavior_context: ${input.behaviorConfig.context}`
      : null,
  ].filter((line): line is string => Boolean(line));

  return [
    "You are an OrgX execution agent running ONE workstream slice in a background autonomous session.",
    "",
    `Execution policy: ${input.executionPolicy.domain}`,
    `Required skills: ${input.executionPolicy.requiredSkills.map((s) => (s.startsWith("$") ? s : `$${s}`)).join(", ")}`,
    "",
    `Initiative: ${input.initiativeTitle} [${input.initiativeId}]`,
    `Workstream: ${input.workstreamTitle} [${input.workstreamId}]`,
    `Slice run: ${input.runId}`,
    ...(behaviorConfigLines.length > 0
      ? [
          "",
          "Behavior config (plugin-injected context):",
          ...behaviorConfigLines,
        ]
      : []),
    "",
    "Milestones (context):",
    milestones || "- (none found)",
    "",
    "Candidate tasks (context only; do NOT assume status is updated unless you explicitly request it in output):",
    tasks || "- (none found)",
    "",
    "Reporting:",
    "- You MUST emit progress at least twice (start + completion) using an OrgX progress tool.",
    "- Preferred tool: orgx_report_progress. Equivalent aliases are valid (for example mcp__orgx__update_stream_progress).",
    "- If no OrgX progress tool is available, include a blocking decisions_needed entry describing the missing tool.",
    "- Do NOT hunt for OrgX mutation tools to mark tasks done. Instead, request status changes in your FINAL JSON via task_updates/milestone_updates; the coordinator will apply them.",
    "",
    "What to do:",
    "- Choose a coherent slice of work you can complete end-to-end in this run.",
    "- Execute the work (code/docs/config) and produce verifiable outcomes.",
    "- Self-assess confidence when saving artifacts and include `confidence_score` in [0,1].",
    "- If blocked, be explicit about what decision/info is required.",
    "- Keep this run focused: stay inside the current repository/workdir and avoid unrelated exploration.",
    "- Execution budget: prefer <=12 shell commands and <=6 minutes wall time.",
    "- Verification budget: run only targeted checks for changed files. Avoid full-suite commands (for example `npm run test:hooks`, `npm test`, `npm run build`) unless the task explicitly requires them.",
    "- If you hit sandbox/env blockers after one retry, stop and return `status=needs_decision` with the blocker and the smallest unblocking action.",
    "- For each required skill, read the skill document and collect proof (path + sha256 + heading).",
    "",
    "Output requirements:",
    "- Print ONLY a single JSON object as the final output (no interim JSON status messages).",
    `- Your JSON MUST conform to this schema file: ${input.schemaPath}`,
    "- Artifacts must be verifiable: include URLs or local paths, plus verification steps.",
    "- Include `confidence_score` for each artifact (`0` to `1`; use `null` when unknown).",
    "- If you need a human decision, include it in decisions_needed.",
    "- For every decisions_needed entry, ALWAYS set blocking explicitly (true or false).",
    "- If status is blocked, needs_decision, or error: include at least one decisions_needed entry with blocking=true.",
    "- Status/decision consistency is strict:",
    "  - If any decision is blocking=true, status MUST be needs_decision or blocked (never completed).",
    "  - Only use status=completed when all listed decisions are non-blocking follow-ups.",
    "- Never return status=completed with zero artifacts and zero task/milestone updates.",
    "- skill_evidence is mandatory. Include one object per required skill with:",
    "  - skill (exact required skill id without leading $)",
    "  - skill_file (absolute SKILL.md path used)",
    "  - skill_sha256 (lowercase SHA-256 hex of that file)",
    "  - skill_heading (first markdown heading or first non-empty line)",
    "- If you cannot locate/verify a required skill file, return status=needs_decision and a blocking decisions_needed entry.",
    "Skill file hints:",
    ...(skillHints.length > 0
      ? skillHints.flatMap((entry) => [
          `- ${entry.skill}:`,
          ...entry.hintPaths.map((path) => `  - ${path}`),
        ])
      : ["- (none)"]),
    "- If you are confident OrgX statuses should change, include task_updates and/or milestone_updates (with a short reason).",
    "  - task_updates.status must be one of: todo, in_progress, done, blocked",
    "  - milestone_updates.status must be one of: planned, in_progress, completed, at_risk, cancelled",
  ].join("\n");
}
