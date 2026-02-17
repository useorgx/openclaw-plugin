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
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "summary", "workstream_id"],
    properties: {
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
          required: ["name", "artifact_type"],
          properties: {
            name: { type: "string", minLength: 1 },
            artifact_type: {
              type: "string",
              enum: ["pr", "commit", "document", "config", "report", "design", "other"],
            },
            description: { type: ["string", "null"] },
            url: { type: ["string", "null"] },
            verification_steps: { type: ["array", "null"], items: { type: "string" } },
            milestone_id: { type: ["string", "null"] },
            task_ids: { type: ["array", "null"], items: { type: "string" } },
          },
        },
      },
      decisions_needed: {
        type: ["array", "null"],
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question"],
          properties: {
            question: { type: "string", minLength: 1 },
            summary: { type: ["string", "null"] },
            options: { type: ["array", "null"], items: { type: "string" } },
            urgency: {
              type: ["string", "null"],
              enum: ["low", "medium", "high", "urgent", null],
            },
            blocking: { type: ["boolean", "null"] },
          },
        },
      },
      task_updates: {
        type: ["array", "null"],
        items: {
          type: "object",
          additionalProperties: false,
          required: ["task_id", "status"],
          properties: {
            task_id: { type: "string", minLength: 1 },
            status: { type: "string", minLength: 1 },
            reason: { type: ["string", "null"] },
          },
        },
      },
      milestone_updates: {
        type: ["array", "null"],
        items: {
          type: "object",
          additionalProperties: false,
          required: ["milestone_id", "status"],
          properties: {
            milestone_id: { type: "string", minLength: 1 },
            status: { type: "string", minLength: 1 },
            reason: { type: ["string", "null"] },
          },
        },
      },
      next_actions: { type: ["array", "null"], items: { type: "string" } },
    },
  };
}

export function ensureAutopilotSliceSchemaPath(schemaFilename: string): string {
  const file = join(getOrgxPluginConfigDir(), schemaFilename);
  try {
    if (existsSync(file)) return file;
    ensurePrivateDirForFile(file);
    writeFileAtomicSync(file, JSON.stringify(autopilotSliceSchema(), null, 2), { mode: 0o600 });
    return file;
  } catch {
    // Fall back to best-effort write.
    try {
      ensurePrivateDirForFile(file);
      writeFileSync(file, `${JSON.stringify(autopilotSliceSchema(), null, 2)}\n`, {
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
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = parseJsonSafe<T>(trimmed);
  if (direct && typeof direct === "object") return direct;

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
    const parsed = parseJsonSafe<T>(candidate);
    if (parsed && typeof parsed === "object") return parsed;
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
  runId: string;
  schemaPath: string;
}): string {
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

  return [
    "You are an OrgX execution agent running ONE workstream slice in a background codex session.",
    "",
    `Execution policy: ${input.executionPolicy.domain}`,
    `Required skills: ${input.executionPolicy.requiredSkills.map((s) => (s.startsWith("$") ? s : `$${s}`)).join(", ")}`,
    "",
    `Initiative: ${input.initiativeTitle} [${input.initiativeId}]`,
    `Workstream: ${input.workstreamTitle} [${input.workstreamId}]`,
    `Slice run: ${input.runId}`,
    "",
    "Milestones (context):",
    milestones || "- (none found)",
    "",
    "Candidate tasks (context only; do NOT assume status is updated unless you explicitly request it in output):",
    tasks || "- (none found)",
    "",
    "Reporting:",
    "- Prefer using the MCP tool orgx_report_progress for progress updates (if it is available in your tool list).",
    "- Do NOT hunt for OrgX mutation tools to mark tasks done. Instead, request status changes in your FINAL JSON via task_updates/milestone_updates; the coordinator will apply them.",
    "",
    "What to do:",
    "- Choose a coherent slice of work you can complete end-to-end in this run.",
    "- Execute the work (code/docs/config) and produce verifiable outcomes.",
    "- If blocked, be explicit about what decision/info is required.",
    "",
    "Output requirements:",
    "- Print ONLY a single JSON object as the final output.",
    `- Your JSON MUST conform to this schema file: ${input.schemaPath}`,
    "- Artifacts must be verifiable: include URLs or local paths, plus verification steps.",
    "- If you need a human decision, include it in decisions_needed.",
    "- For every decisions_needed entry, ALWAYS set blocking explicitly (true or false).",
    "- Status/decision consistency is strict:",
    "  - If any decision is blocking=true, status MUST be needs_decision or blocked (never completed).",
    "  - Only use status=completed when all listed decisions are non-blocking follow-ups.",
    "- If you are confident OrgX statuses should change, include task_updates and/or milestone_updates (with a short reason).",
    "  - task_updates.status must be one of: todo, in_progress, done, blocked",
    "  - milestone_updates.status must be one of: planned, in_progress, completed, at_risk, cancelled",
  ].join("\n");
}
