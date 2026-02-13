#!/usr/bin/env node
/**
 * Daily Agents Refresh
 *
 * Goal: read today's Codex + Claude session logs, synthesize "what went wrong / what was asked",
 * and update auto-generated "daily notes" blocks in:
 * - ~/.codex/AGENTS.md
 * - ~/.claude/AGENTS.md (created if missing)
 *
 * By default this uses `codex exec` (read-only) to generate the daily notes from a redacted digest.
 * Fallback: heuristic notes if Codex CLI isn't available.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

const CODE_ROOT = path.join(os.homedir(), "Code");
const CODEX_HOME = path.join(os.homedir(), ".codex");
const CLAUDE_HOME = path.join(os.homedir(), ".claude");

const MARKER_BEGIN = "<!-- BEGIN AUTO-GENERATED: daily-guardrails -->";
const MARKER_END = "<!-- END AUTO-GENERATED: daily-guardrails -->";

const KEYWORDS = [
  "commit",
  "pr",
  "merge",
  "verify",
  "blocker",
  "initiative",
  "playwright",
  "mcp",
  "orgx",
  "openclaw",
  "fix",
  "tests",
  "typecheck",
  "build",
  "deploy",
  "timeout",
  "render",
  "mobile",
  "layout",
];

function usage() {
  return [
    "Usage: node scripts/daily-agents-refresh.mjs [options]",
    "",
    "Options:",
    "  --date=YYYY-MM-DD             Day to scan (default: today local time)",
    "  --apply=true|false            Write updates to agents files (default: true)",
    "  --engine=codex|heuristic      How to generate notes (default: codex if available)",
    "  --scope=code|all              Include only sessions with cwd under ~/Code (default: code)",
    "  --max_samples=<n>             Max text samples to include in digest (default: 120)",
    "  --max_chars=<n>               Max chars per sample (default: 400)",
    "",
  ].join("\n");
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseBool(value, fallback) {
  if (typeof value !== "string") return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function parseIntSafe(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function ymdFromDate(d) {
  const yyyy = String(d.getFullYear()).padStart(4, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function toCodexSessionDir(ymd) {
  const [yyyy, mm, dd] = ymd.split("-");
  return path.join(CODEX_HOME, "sessions", yyyy, mm, dd);
}

function redact(text) {
  if (!text) return text;
  let out = String(text);

  // Redact common token formats.
  out = out.replace(/\bgho_[A-Za-z0-9_]+\b/g, "gho_…redacted");
  out = out.replace(/\boxk_[A-Za-z0-9_]+\b/g, "oxk_…redacted");
  out = out.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "sk-…redacted");
  out = out.replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "jwt_…redacted");

  // Redact anything that looks like a cookie blob.
  out = out.replace(/\b(_session|sessionid|connect\.sid)=([^;\\s]+)/gi, "$1=…redacted");
  return out;
}

function normalizeWhitespace(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function clip(text, maxChars) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, Math.max(0, maxChars - 1)) + "…";
}

function countKeywords(texts) {
  const counts = Object.fromEntries(KEYWORDS.map((k) => [k, 0]));
  for (const raw of texts) {
    const t = String(raw ?? "").toLowerCase();
    for (const k of KEYWORDS) {
      if (t.includes(k)) counts[k] += 1;
    }
  }
  return counts;
}

function isCodeScopedCwd(cwd, scope) {
  if (scope !== "code") return true;
  const c = pickString(cwd);
  if (!c) return false;
  const normalized = path.resolve(c);
  return normalized === CODE_ROOT || normalized.startsWith(CODE_ROOT + path.sep);
}

function extractTextFromContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        if (typeof part?.input_text === "string") return part.input_text;
        if (typeof part?.type === "string" && part.type === "input_text" && typeof part.text === "string") {
          return part.text;
        }
        if (typeof part?.type === "string" && part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

async function readJsonl(filePath, onObject) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    try {
      await onObject(obj);
    } catch {
      // Best-effort parsing; never fail the daily job on one bad record.
    }
  }
}

async function collectCodexDigest({ ymd, scope, maxSamples, maxChars }) {
  const sessionDir = toCodexSessionDir(ymd);
  let files = [];
  try {
    files = (await fsp.readdir(sessionDir))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(sessionDir, name));
  } catch {
    files = [];
  }

  const userTexts = [];
  const assistantErrorSnippets = [];
  const sampleTexts = [];
  let totalLines = 0;

  for (const file of files) {
    let inferredCwd = null;
    await readJsonl(file, async (obj) => {
      totalLines += 1;

      // Codex sessions sometimes don't carry `cwd` as a field; infer it from the environment_context payload.
      if (obj?.type === "message" && obj?.role === "user") {
        const text = extractTextFromContent(obj?.content);
        const match = text.match(/<cwd>\s*([^<]+?)\s*<\/cwd>/i);
        if (match?.[1]) inferredCwd = match[1].trim();
      }

      const cwd = pickString(
        obj?.cwd,
        obj?.payload?.cwd,
        obj?.payload?.metadata?.cwd,
        inferredCwd
      );
      if (!isCodeScopedCwd(cwd, scope)) return;

      // Common Codex session formats.
      const role =
        pickString(
          obj?.payload?.role,
          obj?.role,
          obj?.payload?.message?.role,
          obj?.payload?.item?.role
        ) ?? "";

      const content =
        obj?.payload?.content ??
        obj?.payload?.message?.content ??
        obj?.payload?.item?.content ??
        obj?.payload?.input ??
        obj?.message?.content ??
        obj?.content;

      const text = extractTextFromContent(content);
      const clipped = clip(redact(text), maxChars);
      if (!clipped) return;

      if (role === "user") {
        userTexts.push(clipped);
        if (sampleTexts.length < maxSamples) sampleTexts.push(clipped);
      }

      // Capture tool/command-ish failures so we can add guardrails.
      const err =
        pickString(obj?.payload?.error?.message, obj?.error?.message, obj?.payload?.tool_error, obj?.tool_error) ??
        "";
      const lower = (clipped + " " + err).toLowerCase();
      if (lower.includes("error") || lower.includes("traceback") || lower.includes("tool_use_error")) {
        if (assistantErrorSnippets.length < 40) assistantErrorSnippets.push(clip(redact(clipped || err), maxChars));
      }
    });
  }

  return {
    source: "codex",
    ymd,
    sessionDir,
    fileCount: files.length,
    totalLines,
    userCount: userTexts.length,
    keywordCounts: countKeywords(userTexts),
    samples: sampleTexts,
    errorSamples: assistantErrorSnippets,
  };
}

async function collectClaudeDigest({ ymd, scope, maxSamples, maxChars }) {
  const start = new Date(`${ymd}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const projectRoot = path.join(CLAUDE_HOME, "projects");
  const files = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!p.endsWith(".jsonl")) continue;
      let st;
      try {
        st = await fsp.stat(p);
      } catch {
        continue;
      }
      const m = st.mtime;
      if (m >= start && m < end) files.push(p);
    }
  }
  await walk(projectRoot);

  const userTexts = [];
  const toolErrorSnippets = [];
  const sampleTexts = [];
  let totalLines = 0;

  for (const file of files) {
    await readJsonl(file, async (obj) => {
      totalLines += 1;
      const cwd = pickString(obj?.cwd, obj?.data?.cwd, obj?.message?.cwd);
      if (!isCodeScopedCwd(cwd, scope)) return;

      // Claude formats:
      // - { type: "user"|"assistant", message: { role, content } }
      // - { type: "progress", data: { message: { type: "user"|"assistant", message: { role, content:[...] } } } }
      let role = null;
      let content = null;
      let isError = false;

      if (obj?.type === "user" || obj?.type === "assistant") {
        role = pickString(obj?.message?.role);
        content = obj?.message?.content;
      } else if (obj?.type === "progress") {
        role = pickString(obj?.data?.message?.message?.role, obj?.data?.message?.type);
        content = obj?.data?.message?.message?.content;
        isError = Boolean(obj?.data?.message?.message?.is_error) || Boolean(obj?.data?.message?.message?.isError);
      }

      const text = extractTextFromContent(content);
      const clipped = clip(redact(text), maxChars);
      if (!clipped) return;

      if (role === "user" || role === "type:user") {
        userTexts.push(clipped);
        if (sampleTexts.length < maxSamples) sampleTexts.push(clipped);
      }

      const lower = clipped.toLowerCase();
      if (isError || lower.includes("tool_use_error") || lower.includes("inputvalidationerror")) {
        if (toolErrorSnippets.length < 40) toolErrorSnippets.push(clipped);
      }
    });
  }

  return {
    source: "claude",
    ymd,
    projectRoot,
    fileCount: files.length,
    totalLines,
    userCount: userTexts.length,
    keywordCounts: countKeywords(userTexts),
    samples: sampleTexts,
    errorSamples: toolErrorSnippets,
  };
}

function codexAvailable() {
  const res = spawnSync("codex", ["--version"], { stdio: "ignore" });
  return res.status === 0;
}

function runCodexToGenerateNotes({ ymd, digest }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-refresh-"));
  const outFile = path.join(tmpDir, "codex-last-message.txt");

  const prompt = [
    "You are generating a daily, auto-updated section for an AI agent guardrails file.",
    "",
    "Constraints:",
    "- Output ONLY Markdown content (no surrounding code fences).",
    "- Be concise and actionable.",
    "- Do NOT include any secrets, tokens, cookies, or long user text excerpts.",
    "- Prefer rules that prevent repeated mistakes (wrong repo, unverified 'done', tool substitution, etc.).",
    "- If data indicates a recurring tool error pattern, add a guardrail to avoid it.",
    "",
    `Date: ${ymd}`,
    "",
    "Write these sections in order:",
    "1) `## Daily Auto-Notes (YYYY-MM-DD)`",
    "2) `### Volume` (counts by source + files scanned)",
    "3) `### Recurring User Asks` (3-8 bullets, paraphrased)",
    "4) `### Error/Regression Signals` (0-6 bullets)",
    "5) `### Guardrail Tweaks (If Needed)` (only if a NEW rule would materially reduce repeats)",
    "",
    "Here is the redacted digest JSON:",
    JSON.stringify(digest, null, 2),
    "",
  ].join("\n");

  const res = spawnSync(
    "codex",
    [
      "-a",
      "untrusted",
      "exec",
      "--ephemeral",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "--output-last-message",
      outFile,
      "-",
    ],
    { input: prompt, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
  );

  if (res.status !== 0) {
    const stderr = pickString(res.stderr) ?? "";
    throw new Error(`codex exec failed (${res.status}): ${stderr.slice(0, 500)}`);
  }

  const notes = fs.readFileSync(outFile, "utf8").trim();
  if (!notes) throw new Error("codex exec produced empty notes");
  return notes;
}

function generateHeuristicNotes({ ymd, digest }) {
  const totalUser = (digest?.codex?.userCount ?? 0) + (digest?.claude?.userCount ?? 0);
  const counts = {};
  for (const k of KEYWORDS) counts[k] = 0;
  for (const src of ["codex", "claude"]) {
    const kc = digest?.[src]?.keywordCounts ?? {};
    for (const k of KEYWORDS) counts[k] += kc[k] ?? 0;
  }

  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .filter(([, v]) => v > 0);

  const errCount =
    (digest?.codex?.errorSamples?.length ?? 0) + (digest?.claude?.errorSamples?.length ?? 0);

  const bullets = [];
  if (counts.pr > 10 || counts.merge > 5 || counts.commit > 5) {
    bullets.push("When asked to `commit/PR/merge`, follow the repo protocol and do not claim merged without checks.");
  }
  if (counts.verify > 5 || counts.blocker > 2 || counts.initiative > 10) {
    bullets.push("For initiatives/blockers: pick one unverified item, reproduce, fix, and re-verify before moving on.");
  }
  if (counts.layout > 10 || counts.render > 10 || counts.mobile > 2) {
    bullets.push("UI changes must be verified on desktop + 375px mobile, and evidence captured (Playwright if available).");
  }
  if (errCount > 0) {
    bullets.push("Tool errors observed: slow down and validate tool schemas/inputs; do not pass extra keys.");
  }

  const lines = [];
  lines.push(`## Daily Auto-Notes (${ymd})`);
  lines.push("");
  lines.push("### Volume");
  lines.push(
    `- Codex: ${digest.codex.fileCount} files, ${digest.codex.userCount} user messages`
  );
  lines.push(
    `- Claude: ${digest.claude.fileCount} files, ${digest.claude.userCount} user messages`
  );
  lines.push(`- Total user messages considered: ${totalUser}`);
  lines.push("");
  lines.push("### Recurring User Asks");
  if (top.length) {
    lines.push(
      `- Top keywords: ${top.map(([k, v]) => `${k}=${v}`).join(", ")}`
    );
  } else {
    lines.push("- No strong recurring keyword signal detected.");
  }
  for (const b of bullets.slice(0, 8)) lines.push(`- ${b}`);
  lines.push("");
  lines.push("### Error/Regression Signals");
  lines.push(errCount ? `- Tool/error signals: ${errCount}` : "- None detected.");
  lines.push("");
  lines.push("### Guardrail Tweaks (If Needed)");
  lines.push("- (Heuristic mode) Prefer Codex engine for higher-quality edits.");
  return lines.join("\n");
}

async function ensureParentDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function atomicWrite(filePath, content) {
  await ensureParentDir(filePath);
  const tmp = `${filePath}.tmp.${Date.now()}`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, filePath);
}

function upsertMarkedBlock(existing, block) {
  const src = String(existing ?? "");
  const beginIdx = src.indexOf(MARKER_BEGIN);
  const endIdx = src.indexOf(MARKER_END);
  const replacement = `${MARKER_BEGIN}\n${block.trim()}\n${MARKER_END}`;

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = src.slice(0, beginIdx).trimEnd();
    const after = src.slice(endIdx + MARKER_END.length).trimStart();
    return [before, replacement, after].filter(Boolean).join("\n\n") + "\n";
  }

  const trimmed = src.trimEnd();
  if (!trimmed) return replacement + "\n";
  return trimmed + "\n\n" + replacement + "\n";
}

async function readFileOrEmpty(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function backupFileIfExists(filePath, ymd) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  const backup = `${filePath}.bak.${ymd}.${Date.now()}`;
  await fsp.copyFile(filePath, backup);
  return backup;
}

async function ensureClaudeAgentsFile(filePath) {
  const existing = await readFileOrEmpty(filePath);
  if (existing.trim()) return existing;
  return [
    "# Claude Guardrails (Hope Workspace)",
    "",
    "These rules are shared guardrails for Claude-based agents in this workspace.",
    "Repo-level `AGENTS.md` files (when present) still take precedence for that repo.",
    "",
  ].join("\n");
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const idx = arg.indexOf("=");
      if (idx === -1) return [arg.replace(/^--/, ""), "true"];
      return [arg.slice(0, idx).replace(/^--/, ""), arg.slice(idx + 1)];
    })
  );

  if (args.help || args.h) {
    console.log(usage());
    process.exit(0);
  }

  const ymd = pickString(args.date) ?? ymdFromDate(new Date());
  const apply = parseBool(args.apply, true);
  const scope = pickString(args.scope) ?? "code";
  const maxSamples = parseIntSafe(args.max_samples, 120);
  const maxChars = parseIntSafe(args.max_chars, 400);

  const requestedEngine = pickString(args.engine);
  const engine =
    requestedEngine ??
    (codexAvailable() ? "codex" : "heuristic");

  const [codexDigest, claudeDigest] = await Promise.all([
    collectCodexDigest({ ymd, scope, maxSamples, maxChars }),
    collectClaudeDigest({ ymd, scope, maxSamples, maxChars }),
  ]);

  const digest = {
    date: ymd,
    scope,
    codex: codexDigest,
    claude: claudeDigest,
  };

  // Write a local report (always).
  const reportsDir = path.join(CODEX_HOME, "reports", "agents-refresh");
  const reportPath = path.join(reportsDir, `${ymd}.json`);
  await atomicWrite(reportPath, JSON.stringify(digest, null, 2) + "\n");

  let notes = "";
  if (engine === "codex") {
    notes = runCodexToGenerateNotes({ ymd, digest });
  } else {
    notes = generateHeuristicNotes({ ymd, digest });
  }

  const codexAgentsPath = path.join(CODEX_HOME, "AGENTS.md");
  const claudeAgentsPath = path.join(CLAUDE_HOME, "AGENTS.md");

  const codexAgents = await readFileOrEmpty(codexAgentsPath);
  const claudeAgentsBase = await ensureClaudeAgentsFile(claudeAgentsPath);

  const codexUpdated = upsertMarkedBlock(codexAgents, notes);
  const claudeUpdated = upsertMarkedBlock(claudeAgentsBase, notes);

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          apply: false,
          engine,
          date: ymd,
          reportPath,
          wouldUpdate: [codexAgentsPath, claudeAgentsPath],
        },
        null,
        2
      )
    );
    return;
  }

  await backupFileIfExists(codexAgentsPath, ymd);
  await backupFileIfExists(claudeAgentsPath, ymd);
  await atomicWrite(codexAgentsPath, codexUpdated);
  await atomicWrite(claudeAgentsPath, claudeUpdated);

  console.log(
    JSON.stringify(
      {
        ok: true,
        apply: true,
        engine,
        date: ymd,
        reportPath,
        updated: [codexAgentsPath, claudeAgentsPath],
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(`[agents-refresh] fatal: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
