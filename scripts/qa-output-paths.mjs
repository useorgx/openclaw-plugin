import path from "node:path";
import process from "node:process";

function readArgValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return "";
  return String(argv[index + 1] || "").trim();
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function sanitizeSegment(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

function resolveDateSegment(rawValue) {
  const value = String(rawValue || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Date().toISOString().slice(0, 10);
}

function defaultRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function resolveQaRunDir({
  argv = process.argv,
  suite,
  envOutputDirVar = "",
  includeRunId = true,
  rootDir = path.join(process.cwd(), "docs", "qa"),
} = {}) {
  if (!suite) {
    throw new Error("resolveQaRunDir requires a suite name.");
  }

  const cliOutDir = readArgValue(argv, "--out-dir");
  if (cliOutDir) return path.resolve(process.cwd(), cliOutDir);

  const envOutDir = envOutputDirVar ? String(process.env[envOutputDirVar] || "").trim() : "";
  if (envOutDir) return path.resolve(process.cwd(), envOutDir);

  const dateArg = readArgValue(argv, "--date") || String(process.env.ORGX_QA_DATE || "").trim();
  const runIdArg = readArgValue(argv, "--run-id") || String(process.env.ORGX_QA_RUN_ID || "").trim();
  const dateSegment = resolveDateSegment(dateArg);
  const suiteSegment = sanitizeSegment(suite, "qa");

  if (!includeRunId) {
    return path.join(rootDir, dateSegment, suiteSegment);
  }

  const runSegment = sanitizeSegment(runIdArg, defaultRunId());
  return path.join(rootDir, dateSegment, suiteSegment, runSegment);
}

export function shouldDryRun(argv = process.argv) {
  return hasFlag(argv, "--dry-run");
}

export async function loadChromium() {
  try {
    const playwright = await import("playwright");
    if (playwright?.chromium) return playwright.chromium;
  } catch {
    // Fallback to playwright-core below.
  }

  try {
    const playwrightCore = await import("playwright-core");
    if (playwrightCore?.chromium) return playwrightCore.chromium;
  } catch {
    // Throw a clearer message below.
  }

  throw new Error(
    'Missing browser runtime. Install "playwright" or "playwright-core" to run QA capture scripts.',
  );
}
