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
  const decisionOptionProperties = {
    id: { type: ["string", "null"] },
    label: { type: "string", minLength: 1 },
    description: { type: ["string", "null"] },
    consequences: { type: ["string", "null"] },
    implied_status: {
      type: ["string", "null"],
      enum: ["approved", "declined", "cancelled", "rejected", null],
    },
    action_type: { type: ["string", "null"] },
    requires_note: { type: ["boolean", "null"] },
  } as const;
  const decisionProperties = {
    question: { type: "string", minLength: 1 },
    summary: { type: ["string", "null"] },
    options: {
      type: ["array", "null"],
      items: {
        type: ["string", "object"],
        minLength: 1,
        additionalProperties: false,
        required: Object.keys(decisionOptionProperties),
        properties: decisionOptionProperties,
      },
    },
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

export function ensureAutopilotSliceSchemaPath(
  schemaFilename: string,
  pluginConfigDir = getOrgxPluginConfigDir()
): string {
  const file = join(pluginConfigDir, schemaFilename);
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
  const allowedStatuses = new Set(["completed", "blocked", "needs_decision", "error"]);
  const normalizeStatusValue = (value: unknown): string => {
    if (typeof value !== "string") return "";
    const normalized = value.trim().toLowerCase();
    return allowedStatuses.has(normalized) ? normalized : "";
  };
  const stripUtf8Bom = (text: string): string => text.replace(/^\uFEFF/, "");
  const extractTopLevelObjects = (text: string): string[] => {
    let inString = false;
    let escaped = false;
    let depth = 0;
    let start = -1;
    const objects: string[] = [];

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
          objects.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
    return objects;
  };
  const extractMarkdownJsonFences = (text: string): string[] => {
    const matches = text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi);
    const fences: string[] = [];
    for (const match of matches) {
      const inner = typeof match[1] === "string" ? match[1].trim() : "";
      if (inner.length > 0) fences.push(inner);
    }
    return fences;
  };
  const stripMarkdownJsonFence = (text: string): string => {
    const fenceCount = text.match(/```/g)?.length ?? 0;
    if (fenceCount !== 2) return text;
    const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenced || typeof fenced[1] !== "string") return text;
    return fenced[1].trim();
  };
  const parseSliceJsonText = (text: string): T | null => {
    const normalized = stripUtf8Bom(stripMarkdownJsonFence(text.trim()));
    const parsed = parseJsonSafe<T>(normalized);
    if (parsed && typeof parsed === "object" && isLikelySliceResult(parsed)) {
      return normalizeSliceResult(parsed);
    }
    const fencedCandidates = extractMarkdownJsonFences(normalized);
    for (let i = fencedCandidates.length - 1; i >= 0; i -= 1) {
      const parsedInner = parseJsonSafe<T>(stripUtf8Bom(fencedCandidates[i]!));
      if (parsedInner && typeof parsedInner === "object" && isLikelySliceResult(parsedInner)) {
        return normalizeSliceResult(parsedInner);
      }
    }
    const objectCandidates = extractTopLevelObjects(normalized);
    for (let i = objectCandidates.length - 1; i >= 0; i -= 1) {
      const parsedObject = parseJsonSafe<T>(stripUtf8Bom(objectCandidates[i]!));
      if (parsedObject && typeof parsedObject === "object" && isLikelySliceResult(parsedObject)) {
        return normalizeSliceResult(parsedObject);
      }
    }
    return null;
  };

  const isLikelySliceResult = (value: unknown): value is T => {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    const status = normalizeStatusValue(record.status);
    const workstreamId = typeof record.workstream_id === "string" ? record.workstream_id : "";
    const summary = typeof record.summary === "string" ? record.summary : "";

    return (
      allowedStatuses.has(status) &&
      summary.trim().length > 0 &&
      workstreamId.trim().length > 0
    );
  };

  const normalizeSliceResult = (value: T): T => {
    const record = value as Record<string, unknown>;
    const status = normalizeStatusValue(record.status);
    const decisions = record.decisions_needed;
    let changed = false;
    let nextRecord: Record<string, unknown> = status ? { ...record, status } : record;

    if (status && record.status !== status) {
      changed = true;
    }

    if (Array.isArray(decisions)) {
      const normalized = decisions.map((decision) => {
        if (!decision || typeof decision !== "object") return decision;
        const decisionRecord = decision as Record<string, unknown>;
        if (typeof decisionRecord.blocking === "boolean") return decision;
        changed = true;
        return { ...decisionRecord, blocking: false };
      });
      if (changed) nextRecord = { ...nextRecord, decisions_needed: normalized };
    }

    const hasBlockingDecision = (input: Record<string, unknown>): boolean =>
      Array.isArray(input.decisions_needed) &&
      input.decisions_needed.some((decision) => {
        if (!decision || typeof decision !== "object") return false;
        return (decision as Record<string, unknown>).blocking === true;
      });

    if (hasBlockingDecision(nextRecord) && status === "completed") {
      changed = true;
      nextRecord = { ...nextRecord, status: "needs_decision" };
    }

    const normalizedStatus =
      typeof nextRecord.status === "string" ? nextRecord.status : status;

    if (normalizedStatus === "completed") {
      const artifactsCount = Array.isArray(nextRecord.artifacts) ? nextRecord.artifacts.length : 0;
      const taskUpdatesCount = Array.isArray(nextRecord.task_updates)
        ? nextRecord.task_updates.length
        : 0;
      const milestoneUpdatesCount = Array.isArray(nextRecord.milestone_updates)
        ? nextRecord.milestone_updates.length
        : 0;
      const hasOutcomes =
        artifactsCount > 0 ||
        taskUpdatesCount > 0 ||
        milestoneUpdatesCount > 0;
      if (!hasOutcomes) {
        changed = true;
        nextRecord = { ...nextRecord, status: "error" };
      }
    }

    const finalStatus = typeof nextRecord.status === "string" ? nextRecord.status : "";
    const requiresBlockingDecision =
      finalStatus === "blocked" || finalStatus === "needs_decision" || finalStatus === "error";
    if (requiresBlockingDecision && !hasBlockingDecision(nextRecord)) {
      const nextDecisions = Array.isArray(nextRecord.decisions_needed)
        ? [...nextRecord.decisions_needed]
        : [];
      nextDecisions.push({
        question: "Missing required blocking decision for non-completed status",
        summary:
          "Parser inserted a blocking decision because blocked/needs_decision/error statuses require blocking=true.",
        options: null,
        urgency: "medium",
        blocking: true,
      });
      changed = true;
      nextRecord = { ...nextRecord, decisions_needed: nextDecisions };
    }

    return changed ? (nextRecord as T) : value;
  };

  const unwrapStructuredOutput = (value: unknown): T | null => {
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const parseEmbeddedText = (candidate: unknown): T | null => {
      if (typeof candidate === "string") {
        const direct = parseSliceJsonText(candidate);
        if (direct) return direct;
        // Some envelopes embed worker logs/prose with a trailing JSON object.
        return parseSliceResult<T>(candidate);
      }
      if (Array.isArray(candidate)) {
        for (let i = candidate.length - 1; i >= 0; i -= 1) {
          const parsed = parseEmbeddedText(candidate[i]);
          if (parsed) return parsed;
        }
        return null;
      }
      if (!candidate || typeof candidate !== "object") return null;
      const candidateRecord = candidate as Record<string, unknown>;
      const fromValue = parseEmbeddedText(candidateRecord.value);
      if (fromValue) return fromValue;
      const fromText = parseEmbeddedText(candidateRecord.text);
      if (fromText) return fromText;
      const fromContent = parseEmbeddedText(candidateRecord.content);
      if (fromContent) return fromContent;
      const fromOutputText = parseEmbeddedText(candidateRecord.output_text);
      if (fromOutputText) return fromOutputText;
      return null;
    };
    const finalOutput = record.final_output;
    if (finalOutput && typeof finalOutput === "object") {
      if (isLikelySliceResult(finalOutput)) return normalizeSliceResult(finalOutput as T);
      const parsedFinalOutput = parseEmbeddedText(finalOutput);
      if (parsedFinalOutput) return parsedFinalOutput;
    }
    if (typeof finalOutput === "string") {
      const parsedFinalOutput = parseSliceJsonText(finalOutput);
      if (parsedFinalOutput) return parsedFinalOutput;
    }
    const structured = record.structured_output;
    if (structured && typeof structured === "object") {
      if (isLikelySliceResult(structured)) return normalizeSliceResult(structured as T);
      const parsedStructured = parseEmbeddedText(structured);
      if (parsedStructured) return parsedStructured;
    }
    if (typeof structured === "string") {
      const parsedStructured = parseSliceJsonText(structured);
      if (parsedStructured) return parsedStructured;
    }
    // Claude text-mode envelopes can sometimes return JSON in `result`.
    const parsedResultObject = parseEmbeddedText(record.result);
    if (parsedResultObject) return parsedResultObject;
    if (typeof record.result === "string") {
      const parsedResult = parseSliceJsonText(record.result);
      if (parsedResult) return parsedResult;
    }
    const parsedTopLevelOutputText = parseEmbeddedText(record.output_text);
    if (parsedTopLevelOutputText) return parsedTopLevelOutputText;
    // Responses-style envelopes can return text in output/message/content arrays.
    const output = record.output;
    if (Array.isArray(output)) {
      for (let i = output.length - 1; i >= 0; i -= 1) {
        const item = output[i];
        if (!item || typeof item !== "object") continue;
        const itemRecord = item as Record<string, unknown>;
        const directText = parseEmbeddedText(itemRecord.text);
        if (directText) return directText;
        const outputText = parseEmbeddedText(itemRecord.output_text);
        if (outputText) return outputText;
        if (!Array.isArray(itemRecord.content)) continue;
        for (let j = itemRecord.content.length - 1; j >= 0; j -= 1) {
          const content = itemRecord.content[j];
          if (!content || typeof content !== "object") continue;
          const contentRecord = content as Record<string, unknown>;
          const contentDirect = parseEmbeddedText(contentRecord);
          if (contentDirect) return contentDirect;
          const contentText = parseEmbeddedText(contentRecord.text);
          if (contentText) return contentText;
          const contentOutputText = parseEmbeddedText(contentRecord.output_text);
          if (contentOutputText) return contentOutputText;
        }
      }
    }
    return isLikelySliceResult(record) ? normalizeSliceResult(record as T) : null;
  };

  const trimmed = stripUtf8Bom(raw).trim();
  if (!trimmed) return null;

  const direct = parseJsonSafe<unknown>(stripMarkdownJsonFence(trimmed));
  const directUnwrapped = unwrapStructuredOutput(direct);
  if (directUnwrapped && typeof directUnwrapped === "object") return directUnwrapped;
  const directTextParsed = parseSliceJsonText(trimmed);
  if (directTextParsed && typeof directTextParsed === "object") return directTextParsed;

  // Tolerant parse: extract the last complete top-level JSON object from mixed logs.
  const candidates = extractTopLevelObjects(trimmed);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const candidate = candidates[i]!;
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

// ---------------------------------------------------------------------------
// Session ID extraction (for session resume support)
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Extract a CLI session ID from structured output JSON (Claude/Codex envelope).
 * Looks for `session_id`, `sessionId`, or `conversation_id` fields.
 */
export function extractSessionIdFromOutput(raw: string, _sourceClient?: string): string | null {
  if (!raw || typeof raw !== "string") return null;
  const extractUuid = (value: string): string | null => {
    const match = value.trim().match(UUID_RE);
    return match?.[0] ?? null;
  };
  const findSessionId = (candidate: unknown): string | null => {
    if (!candidate) return null;
    if (typeof candidate === "string") {
      const parsedCandidate = parseJsonSafe<Record<string, unknown>>(candidate.trim());
      if (parsedCandidate) return findSessionId(parsedCandidate);
      return null;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const found = findSessionId(item);
        if (found) return found;
      }
      return null;
    }
    if (typeof candidate !== "object") return null;

    const record = candidate as Record<string, unknown>;
    for (const key of ["session_id", "sessionId", "conversation_id"]) {
      const value = record[key];
      if (typeof value === "string") {
        const uuid = extractUuid(value);
        if (uuid) return uuid;
      }
    }

    return (
      findSessionId(record.value) ??
      findSessionId(record.text) ??
      findSessionId(record.content) ??
      findSessionId(record.output_text) ??
      null
    );
  };

  const parsed = parseJsonSafe<Record<string, unknown>>(raw.trim());

  if (parsed && typeof parsed === "object") {
    const found = findSessionId([
      parsed,
      parsed.result,
      parsed.structured_output,
      parsed.final_output,
      parsed.output_text,
      parsed.output,
    ]);
    if (found) {
      return found;
    }
  }

  // Fallback: scan raw text for session_id: <uuid> pattern
  const inline = raw.match(
    /session_id\s*[:=]\s*"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/i,
  );
  if (inline && typeof inline[1] === "string") return inline[1];

  return null;
}

/**
 * Extract a CLI session ID from worker log text.
 * Matches patterns emitted by Claude Code and Codex CLIs.
 */
export function extractSessionIdFromLog(logContent: string, _sourceClient?: string): string | null {
  if (!logContent || typeof logContent !== "string") return null;

  // Claude Code: "Resume this session with: claude --resume <uuid>"
  const claudeResume = logContent.match(
    /claude\s+--resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (claudeResume && typeof claudeResume[1] === "string") return claudeResume[1];

  // Codex: "codex resume <uuid>"
  const codexResume = logContent.match(
    /codex\s+resume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (codexResume && typeof codexResume[1] === "string") return codexResume[1];

  // Generic: "Session: <uuid>", "session_id: <uuid>", "saving session <uuid>"
  const generic = logContent.match(
    /(?:Session|session_id|saving\s+session)\s*[:=]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (generic && typeof generic[1] === "string") return generic[1];

  return null;
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
    const passthroughIndex = normalized.indexOf("--");
    if (passthroughIndex > -1) {
      normalized.splice(passthroughIndex, 0, "--skip-git-repo-check");
    } else {
      normalized.push("--skip-git-repo-check");
    }
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

function normalizeSkillName(skill: string): string {
  return skill.replace(/^\$/, "").trim();
}

function skillAliasesFor(skill: string): string[] {
  const normalized = normalizeSkillName(skill);
  if (!normalized) return [];
  const aliases = [normalized];
  if (normalized.startsWith("orgx-")) aliases.push(normalized.slice("orgx-".length));
  if (normalized.endsWith("-agent")) aliases.push(normalized.slice(0, -"-agent".length));
  return Array.from(new Set(aliases.filter(Boolean)));
}

function buildSkillHints(requiredSkills: string[]): Array<{ skill: string; hintPaths: string[] }> {
  return requiredSkills
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
}

export function buildSliceOutputInstructions(input: {
  runId: string;
  schemaPath: string;
  requiredSkills: string[];
}): string {
  const skillHints = buildSkillHints(input.requiredSkills);
  return [
    "# Slice Execution",
    "",
    `Slice run: ${input.runId}`,
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
    "- Prefer structured decision options objects with: id, label, description, consequences, implied_status, action_type, requires_note.",
    "- String options are still accepted, but structured options are required for precise decision routing.",
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
  const skillHints = buildSkillHints(input.executionPolicy.requiredSkills);

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
    "- Prefer structured decision options objects with: id, label, description, consequences, implied_status, action_type, requires_note.",
    "- String options are still accepted, but structured options are required for precise decision routing.",
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

// ---------------------------------------------------------------------------
// Per-scope prompt directive
// ---------------------------------------------------------------------------

export type BuildScopeDirectiveScope = "task" | "milestone" | "workstream";

export function buildScopeDirective(
  scope: BuildScopeDirectiveScope,
  meta: {
    milestoneTitles?: string[];
    workstreamTitle?: string;
    taskCount: number;
  }
): string {
  switch (scope) {
    case "milestone":
      return (
        `You are completing milestone "${meta.milestoneTitles?.[0] ?? "Unknown"}" ` +
        `(${meta.taskCount} tasks). Complete all tasks to close the milestone. Report per-task progress.`
      );
    case "workstream":
      return (
        `You are advancing the entire "${meta.workstreamTitle ?? "Unknown"}" workstream ` +
        `(${meta.taskCount} tasks across ${meta.milestoneTitles?.length ?? 0} milestones). ` +
        `Prioritize by dependency order. Report per-milestone progress.`
      );
    default:
      return "";
  }
}
