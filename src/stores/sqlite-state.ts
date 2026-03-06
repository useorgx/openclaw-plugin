import Database from "better-sqlite3";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "../paths.js";
import { ensureStoreDirSync, parseJsonSafe } from "./json-store.js";

const STATE_DB_FILENAME = "orgx-state.sqlite";
const USER_VERSION = 1;

let dbInstance: Database.Database | null = null;
let dbInstancePath = "";
let stateDbHooksRegistered = false;

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
  const db = new Database(nextPath);
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
