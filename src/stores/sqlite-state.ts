import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { sanitizedChildProcessEnv } from "../child-process-env.js";
import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "../paths.js";
import { ensureStoreDirSync, parseJsonSafe } from "./json-store.js";

const STATE_DB_FILENAME = "orgx-state.sqlite";
const USER_VERSION = 1;
const BETTER_SQLITE3_REPAIR_MARKER = ".orgx-runtime-deps-version";

let dbInstance: Database.Database | null = null;
let dbInstancePath = "";
let stateDbHooksRegistered = false;
let databaseConstructor: typeof Database | null = null;
let runtimeDepsRepairAttempted = false;
const require = createRequire(import.meta.url);

function currentModuleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function findPluginRoot(startDir: string): string {
  let cursor = startDir;
  while (true) {
    const packageJsonPath = join(cursor, "package.json");
    if (existsSync(packageJsonPath)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return startDir;
    cursor = parent;
  }
}

function readExpectedRuntimeDepVersion(pluginRoot: string): string {
  try {
    const raw = readFileSync(join(pluginRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw);
    return String(parsed?.dependencies?.["better-sqlite3"] || "").trim();
  } catch {
    return "";
  }
}

function writeRuntimeDepMarker(pluginRoot: string): void {
  const expected = readExpectedRuntimeDepVersion(pluginRoot);
  if (!expected) return;
  try {
    writeFileSync(join(pluginRoot, BETTER_SQLITE3_REPAIR_MARKER), expected, "utf8");
  } catch {
    // best effort
  }
}

function betterSqlite3Installed(pluginRoot: string): boolean {
  return existsSync(join(pluginRoot, "node_modules", "better-sqlite3", "package.json"));
}

function resolveBetterSqlite3InstallRoot(pluginRoot: string): string {
  try {
    const packageJsonPath = require.resolve("better-sqlite3/package.json");
    return dirname(dirname(dirname(packageJsonPath)));
  } catch {
    return pluginRoot;
  }
}

function isRecoverableBetterSqlite3Error(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not locate the bindings file|cannot find module ['"]better-sqlite3['"]|no native build was found/i.test(
    message
  );
}

function resolveNpmCommand(): {
  command: string;
  argsPrefix: string[];
} {
  const npmCliPath = join(
    dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  if (existsSync(npmCliPath)) {
    return {
      command: process.execPath,
      argsPrefix: [npmCliPath],
    };
  }
  return {
    command: "npm",
    argsPrefix: [],
  };
}

function repairBetterSqlite3Binding(pluginRoot: string): void {
  const installRoot = resolveBetterSqlite3InstallRoot(pluginRoot);
  const { command, argsPrefix } = resolveNpmCommand();
  const args = betterSqlite3Installed(installRoot)
    ? [...argsPrefix, "rebuild", "better-sqlite3", "--foreground-scripts"]
    : [...argsPrefix, "install", "--omit=dev"];

  try {
    execFileSync(command, args, {
      cwd: installRoot,
      env: sanitizedChildProcessEnv(process.env),
      stdio: "pipe",
    });
    writeRuntimeDepMarker(pluginRoot);
  } catch (error) {
    const stderr =
      error &&
      typeof error === "object" &&
      "stderr" in error &&
      Buffer.isBuffer((error as { stderr?: unknown }).stderr)
        ? (error as { stderr: Buffer }).stderr.toString("utf8").trim()
        : "";
    const stdout =
      error &&
      typeof error === "object" &&
      "stdout" in error &&
      Buffer.isBuffer((error as { stdout?: unknown }).stdout)
        ? (error as { stdout: Buffer }).stdout.toString("utf8").trim()
        : "";
    const detail = stderr || stdout;
    const suffix = detail ? ` (${detail})` : "";
    throw new Error(`Failed to repair better-sqlite3 runtime dependency${suffix}`);
  }
}

function resetDatabaseConstructorCache(): void {
  try {
    const resolved = require.resolve("better-sqlite3");
    delete require.cache[resolved];
  } catch {
    // best effort
  }
  databaseConstructor = null;
}

function loadDatabaseConstructor(): typeof Database {
  if (databaseConstructor) return databaseConstructor;
  try {
    databaseConstructor = require("better-sqlite3") as typeof Database;
    return databaseConstructor;
  } catch (error) {
    if (!runtimeDepsRepairAttempted && isRecoverableBetterSqlite3Error(error)) {
      runtimeDepsRepairAttempted = true;
      const pluginRoot = findPluginRoot(currentModuleDir());
      repairBetterSqlite3Binding(pluginRoot);
      resetDatabaseConstructorCache();
      databaseConstructor = require("better-sqlite3") as typeof Database;
      return databaseConstructor;
    }
    throw error;
  }
}

function stateDbPath(): string {
  return getOrgxPluginConfigPath(STATE_DB_FILENAME);
}

function ensureStateDbDir(): void {
  ensureStoreDirSync(getOrgxPluginConfigDir());
}

function initializeDatabase(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  const currentVersion = Number(db.pragma("user_version", { simple: true }) ?? 0);
  if (currentVersion >= USER_VERSION) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_instances (
      id TEXT PRIMARY KEY,
      source_client TEXT NOT NULL,
      display_name TEXT NOT NULL,
      provider_logo TEXT NOT NULL,
      state TEXT NOT NULL,
      event TEXT NOT NULL,
      run_id TEXT,
      correlation_id TEXT,
      initiative_id TEXT,
      workstream_id TEXT,
      task_id TEXT,
      agent_id TEXT,
      agent_name TEXT,
      phase TEXT,
      progress_pct INTEGER,
      current_task TEXT,
      last_heartbeat_at TEXT,
      last_event_at TEXT NOT NULL,
      last_message TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_instances_last_event
      ON runtime_instances(last_event_at DESC);

    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      pid INTEGER,
      message TEXT,
      provider TEXT,
      model TEXT,
      initiative_id TEXT,
      initiative_title TEXT,
      workstream_id TEXT,
      task_id TEXT,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at
      ON agent_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS outbox_events (
      event_id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      activity_item_json TEXT NOT NULL,
      replay_failures INTEGER NOT NULL DEFAULT 0,
      last_replay_error TEXT,
      last_replay_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_queue_timestamp
      ON outbox_events(queue_id, timestamp ASC, event_id ASC);
    CREATE INDEX IF NOT EXISTS idx_outbox_timestamp
      ON outbox_events(timestamp DESC, event_id DESC);

    CREATE TABLE IF NOT EXISTS materialized_snapshots (
      cache_key TEXT PRIMARY KEY,
      generation INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_materialized_snapshots_expires_at
      ON materialized_snapshots(expires_at ASC);
  `);

  db.pragma(`user_version = ${USER_VERSION}`);
}

export function closeStateDb(): void {
  if (!dbInstance) return;
  try {
    dbInstance.pragma("optimize");
  } catch {
    // best effort
  }
  try {
    dbInstance.close();
  } catch {
    // best effort
  }
  dbInstance = null;
  dbInstancePath = "";
}

function ensureStateDbProcessHooks(): void {
  if (stateDbHooksRegistered) return;
  stateDbHooksRegistered = true;
  const shutdown = () => {
    closeStateDb();
  };
  process.once("beforeExit", shutdown);
  process.once("exit", shutdown);
}

export function getStateDb(): Database.Database {
  const nextPath = stateDbPath();
  if (dbInstance && dbInstancePath === nextPath) return dbInstance;
  if (dbInstance && dbInstancePath !== nextPath) {
    closeStateDb();
  }
  ensureStateDbDir();
  let DatabaseCtor = loadDatabaseConstructor();
  let db: Database.Database;
  try {
    db = new DatabaseCtor(nextPath);
  } catch (error) {
    if (!runtimeDepsRepairAttempted && isRecoverableBetterSqlite3Error(error)) {
      runtimeDepsRepairAttempted = true;
      const pluginRoot = findPluginRoot(currentModuleDir());
      repairBetterSqlite3Binding(pluginRoot);
      resetDatabaseConstructorCache();
      DatabaseCtor = loadDatabaseConstructor();
      db = new DatabaseCtor(nextPath);
    } else {
      throw error;
    }
  }
  initializeDatabase(db);
  dbInstance = db;
  dbInstancePath = nextPath;
  ensureStateDbProcessHooks();
  return db;
}

export function readStateMeta<T>(key: string): T | null {
  const normalizedKey = key.trim();
  if (!normalizedKey) return null;
  const row = getStateDb()
    .prepare<[string], { value_json: string }>(
      "SELECT value_json FROM kv_meta WHERE key = ?"
    )
    .get(normalizedKey);
  if (!row || typeof row.value_json !== "string") return null;
  return parseJsonSafe<T>(row.value_json);
}

export function writeStateMeta(key: string, value: unknown): void {
  const normalizedKey = key.trim();
  if (!normalizedKey) return;
  const nowIso = new Date().toISOString();
  getStateDb()
    .prepare<[string, string, string]>(
      `INSERT INTO kv_meta (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`
    )
    .run(normalizedKey, JSON.stringify(value ?? null), nowIso);
}

export function deleteStateMeta(key: string): void {
  const normalizedKey = key.trim();
  if (!normalizedKey) return;
  getStateDb()
    .prepare<[string]>("DELETE FROM kv_meta WHERE key = ?")
    .run(normalizedKey);
}
