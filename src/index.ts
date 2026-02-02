/**
 * OrgX Clawdbot Plugin — Main Entry Point
 *
 * This is the canonical entry point for the OrgX plugin.
 * It exports the plugin interface for Clawdbot consumption.
 *
 * Registers:
 *   - Background sync service ("orgx-sync")
 *   - MCP Tools (orgx_status, orgx_sync, orgx_spawn_check, etc.)
 *   - CLI command ("orgx" with status/sync subcommands)
 *   - HTTP handler for dashboard + API proxy
 */

import { OrgXClient } from "./api.js";
import type { OrgXConfig, OrgSnapshot } from "./types.js";
import { createHttpHandler } from "./http-handler.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Re-export types for consumers
export type { OrgXConfig, OrgSnapshot } from "./types.js";
export { OrgXClient } from "./api.js";

// =============================================================================
// PLUGIN INTERFACE TYPES
// =============================================================================

export interface PluginAPI {
  config?: {
    plugins?: {
      entries?: {
        orgx?: {
          config?: Partial<OrgXConfig & { dashboardEnabled: boolean }>;
        };
      };
    };
  };
  log?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
    debug?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  registerService: (service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool: (
    tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: (callId: string, params?: any) => Promise<ToolResult>;
    },
    options?: { optional?: boolean }
  ) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerCli: (
    fn: (ctx: { program: any }) => void,
    options?: { commands?: string[] }
  ) => void;
  registerHttpHandler: (handler: unknown) => void;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

// =============================================================================
// HELPERS
// =============================================================================

function resolveConfig(api: PluginAPI): OrgXConfig & { dashboardEnabled: boolean } {
  const pluginConf = api.config?.plugins?.entries?.orgx?.config ?? {};

  let apiKey = pluginConf.apiKey || process.env.ORGX_API_KEY || "";
  if (!apiKey) {
    try {
      const envPath = join(homedir(), "Code", "orgx", "orgx", ".env.local");
      const envContent = readFileSync(envPath, "utf-8");
      const match = envContent.match(
        /^ORGX_(?:API_KEY|SERVICE_KEY)=["']?([^"'\n]+)["']?$/m
      );
      if (match) apiKey = match[1].trim();
    } catch {
      // .env.local not found
    }
  }

  // Resolve user ID for X-Orgx-User-Id header
  let userId = pluginConf.userId || process.env.ORGX_USER_ID || "";
  if (!userId) {
    try {
      const envPath = join(homedir(), "Code", "orgx", "orgx", ".env.local");
      const envContent = readFileSync(envPath, "utf-8");
      const match = envContent.match(
        /^ORGX_USER_ID=["']?([^"'\n]+)["']?$/m
      );
      if (match) userId = match[1].trim();
    } catch {
      // .env.local not found
    }
  }

  return {
    apiKey,
    userId,
    baseUrl:
      pluginConf.baseUrl ||
      process.env.ORGX_BASE_URL ||
      "https://www.useorgx.com",
    syncIntervalMs: pluginConf.syncIntervalMs ?? 300_000,
    enabled: pluginConf.enabled ?? true,
    dashboardEnabled: pluginConf.dashboardEnabled ?? true,
  };
}

function text(s: string): ToolResult {
  return { content: [{ type: "text" as const, text: s }] };
}

function json(label: string, data: unknown): ToolResult {
  return text(`${label}\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
}

function formatSnapshot(snap: OrgSnapshot): string {
  const lines: string[] = ["# OrgX Status\n"];

  if (snap.initiatives?.length) {
    lines.push("## Initiatives");
    for (const init of snap.initiatives) {
      const pct = init.progress != null ? ` (${init.progress}%)` : "";
      lines.push(`- **${init.title}** — ${init.status}${pct}`);
    }
    lines.push("");
  }

  if (snap.agents?.length) {
    lines.push("## Agents");
    for (const a of snap.agents) {
      const task = a.currentTask ? ` → ${a.currentTask}` : "";
      lines.push(`- **${a.name}** [${a.domain}]: ${a.status}${task}`);
    }
    lines.push("");
  }

  if (snap.activeTasks?.length) {
    lines.push("## Active Tasks");
    for (const t of snap.activeTasks) {
      const tier = t.modelTier ? ` (${t.modelTier})` : "";
      lines.push(`- ${t.title} — ${t.status}${tier}`);
    }
    lines.push("");
  }

  if (snap.pendingDecisions?.length) {
    lines.push("## Pending Decisions");
    for (const d of snap.pendingDecisions) {
      lines.push(`- [${d.urgency.toUpperCase()}] ${d.title}`);
    }
    lines.push("");
  }

  if (snap.syncedAt) lines.push(`_Last synced: ${snap.syncedAt}_`);
  return lines.join("\n");
}

// =============================================================================
// PLUGIN STATE
// =============================================================================

let cachedSnapshot: OrgSnapshot | null = null;
let lastSnapshotAt = 0;

// =============================================================================
// PLUGIN ENTRY — DEFAULT EXPORT
// =============================================================================

/**
 * Plugin registration function.
 * Called by Clawdbot when the plugin is loaded.
 *
 * @param api - The Clawdbot plugin API
 */
export default function register(api: PluginAPI): void {
  const config = resolveConfig(api);

  if (!config.enabled) {
    api.log?.info?.("[orgx] Plugin disabled");
    return;
  }

  if (!config.apiKey) {
    api.log?.warn?.(
      "[orgx] No API key. Set plugins.entries.orgx.config.apiKey, ORGX_API_KEY env, or ~/Code/orgx/orgx/.env.local"
    );
  }

  const client = new OrgXClient(config.apiKey, config.baseUrl, config.userId);

  // ---------------------------------------------------------------------------
  // 1. Background Sync Service
  // ---------------------------------------------------------------------------

  let syncTimer: ReturnType<typeof setInterval> | null = null;

  async function doSync(): Promise<void> {
    try {
      cachedSnapshot = await client.getOrgSnapshot();
      lastSnapshotAt = Date.now();
      api.log?.debug?.("[orgx] Sync OK");
    } catch (err: unknown) {
      api.log?.warn?.(
        `[orgx] Sync failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  api.registerService({
    id: "orgx-sync",
    start: async () => {
      api.log?.info?.("[orgx] Starting sync service", {
        interval: config.syncIntervalMs,
      });
      await doSync();
      syncTimer = setInterval(doSync, config.syncIntervalMs);
    },
    stop: async () => {
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
    },
  });

  // ---------------------------------------------------------------------------
  // 2. MCP Tools (Model Context Protocol compatible)
  // ---------------------------------------------------------------------------

  // --- orgx_status ---
  api.registerTool(
    {
      name: "orgx_status",
      description:
        "Get current OrgX org status: active initiatives, agent states, pending decisions, active tasks.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      async execute(_callId: string) {
        if (
          !cachedSnapshot ||
          Date.now() - lastSnapshotAt > config.syncIntervalMs
        ) {
          await doSync();
        }
        if (!cachedSnapshot) {
          return text(
            "❌ Failed to fetch OrgX status. Check API key and connectivity."
          );
        }
        return text(formatSnapshot(cachedSnapshot));
      },
    },
    { optional: true }
  );

  // --- orgx_sync ---
  api.registerTool(
    {
      name: "orgx_sync",
      description:
        "Push/pull memory sync with OrgX. Send local memory/daily log; receive initiatives, tasks, decisions, model routing policy.",
      parameters: {
        type: "object",
        properties: {
          memory: {
            type: "string",
            description: "Local memory snapshot to push",
          },
          dailyLog: {
            type: "string",
            description: "Today's session log to push",
          },
        },
      },
      async execute(
        _callId: string,
        params: { memory?: string; dailyLog?: string } = {}
      ) {
        try {
          const resp = await client.syncMemory({
            memory: params.memory,
            dailyLog: params.dailyLog,
          });
          return json("Sync complete:", resp);
        } catch (err: unknown) {
          return text(
            `❌ Sync failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_spawn_check ---
  api.registerTool(
    {
      name: "orgx_spawn_check",
      description:
        "Check quality gate + get model routing before spawning a sub-agent. Returns allowed/denied, model tier, and check details.",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description:
              "Agent domain (engineering, product, marketing, data, operations, design)",
          },
          taskId: {
            type: "string",
            description: "OrgX task ID to check",
          },
        },
        required: ["domain"],
      },
      async execute(
        _callId: string,
        params: { domain: string; taskId?: string } = { domain: "" }
      ) {
        try {
          const result = await client.checkSpawnGuard(
            params.domain,
            params.taskId
          );
          const status = result.allowed ? "✅ Allowed" : "🚫 Blocked";
          return json(`${status} — model tier: ${result.modelTier}`, result);
        } catch (err: unknown) {
          return text(
            `❌ Spawn check failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_quality_score ---
  api.registerTool(
    {
      name: "orgx_quality_score",
      description:
        "Record a quality score (1-5) for completed agent work. Used to gate future spawns and track performance.",
      parameters: {
        type: "object",
        properties: {
          taskId: {
            type: "string",
            description: "ID of the completed task",
          },
          domain: {
            type: "string",
            description: "Agent domain that did the work",
          },
          score: {
            type: "number",
            description: "Quality 1 (poor) to 5 (excellent)",
            minimum: 1,
            maximum: 5,
          },
          notes: {
            type: "string",
            description: "Notes on the assessment",
          },
        },
        required: ["taskId", "domain", "score"],
      },
      async execute(
        _callId: string,
        params: {
          taskId: string;
          domain: string;
          score: number;
          notes?: string;
        } = { taskId: "", domain: "", score: 0 }
      ) {
        try {
          await client.recordQuality(params);
          return text(
            `✅ Quality score recorded: ${params.score}/5 for task ${params.taskId} (${params.domain})`
          );
        } catch (err: unknown) {
          return text(
            `❌ Quality recording failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_create_entity ---
  api.registerTool(
    {
      name: "orgx_create_entity",
      description:
        "Create an OrgX entity (initiative, workstream, task, decision, milestone, etc.).",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Entity type: initiative, workstream, task, decision, milestone, artifact, agent, blocker",
          },
          title: {
            type: "string",
            description: "Entity title",
          },
          summary: {
            type: "string",
            description: "Description",
          },
          status: {
            type: "string",
            description: "Initial status (active, not_started, todo)",
          },
          initiative_id: {
            type: "string",
            description: "Parent initiative ID (for workstreams/tasks)",
          },
          workstream_id: {
            type: "string",
            description: "Parent workstream ID (for tasks)",
          },
          command_center_id: {
            type: "string",
            description: "Command center ID (for initiatives)",
          },
        },
        required: ["type", "title"],
      },
      async execute(_callId: string, params: Record<string, unknown> = {}) {
        try {
          const { type, ...data } = params;
          const entity = await client.createEntity(type as string, data);
          return json(
            `✅ Created ${type}: ${entity.title ?? entity.id}`,
            entity
          );
        } catch (err: unknown) {
          return text(
            `❌ Creation failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_update_entity ---
  api.registerTool(
    {
      name: "orgx_update_entity",
      description: "Update an existing OrgX entity by type and ID.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Entity type",
          },
          id: {
            type: "string",
            description: "Entity UUID",
          },
          status: {
            type: "string",
            description: "New status",
          },
          title: {
            type: "string",
            description: "New title",
          },
          summary: {
            type: "string",
            description: "New summary",
          },
        },
        required: ["type", "id"],
      },
      async execute(_callId: string, params: Record<string, unknown> = {}) {
        try {
          const { type, id, ...updates } = params;
          const entity = await client.updateEntity(
            type as string,
            id as string,
            updates
          );
          return json(
            `✅ Updated ${type} ${(id as string).slice(0, 8)}`,
            entity
          );
        } catch (err: unknown) {
          return text(
            `❌ Update failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // --- orgx_list_entities ---
  api.registerTool(
    {
      name: "orgx_list_entities",
      description:
        "List OrgX entities of a given type with optional status filter.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description:
              "Entity type: initiative, workstream, task, decision, agent",
          },
          status: {
            type: "string",
            description: "Filter by status",
          },
          limit: {
            type: "number",
            description: "Max results (default 20)",
            default: 20,
          },
        },
        required: ["type"],
      },
      async execute(
        _callId: string,
        params: { type: string; status?: string; limit?: number } = { type: "" }
      ) {
        try {
          const { type, ...filters } = params;
          const resp = await client.listEntities(type, filters);
          const entities = resp.data ?? resp;
          const count = Array.isArray(entities) ? entities.length : "?";
          return json(`${count} ${type}(s):`, entities);
        } catch (err: unknown) {
          return text(
            `❌ List failed: ${err instanceof Error ? err.message : err}`
          );
        }
      },
    },
    { optional: true }
  );

  // ---------------------------------------------------------------------------
  // 3. CLI Command
  // ---------------------------------------------------------------------------

  api.registerCli(
    ({ program }: { program: any }) => {
      const cmd = program.command("orgx").description("OrgX integration commands");

      cmd
        .command("status")
        .description("Show current OrgX org status")
        .action(async () => {
          try {
            const snap = await client.getOrgSnapshot();
            console.log(formatSnapshot(snap));
          } catch (err: unknown) {
            console.error(`Error: ${err instanceof Error ? err.message : err}`);
            process.exit(1);
          }
        });

      cmd
        .command("sync")
        .description("Trigger manual memory sync")
        .option("--memory <text>", "Memory to push")
        .option("--daily-log <text>", "Daily log to push")
        .action(async (opts: { memory?: string; dailyLog?: string } = {}) => {
          try {
            const resp = await client.syncMemory({
              memory: opts.memory,
              dailyLog: opts.dailyLog,
            });
            console.log("Sync complete:");
            console.log(`  Initiatives: ${resp.initiatives?.length ?? 0}`);
            console.log(`  Active tasks: ${resp.activeTasks?.length ?? 0}`);
            console.log(
              `  Pending decisions: ${resp.pendingDecisions?.length ?? 0}`
            );
          } catch (err: unknown) {
            console.error(
              `Sync failed: ${err instanceof Error ? err.message : err}`
            );
            process.exit(1);
          }
        });
    },
    { commands: ["orgx"] }
  );

  // ---------------------------------------------------------------------------
  // 4. HTTP Handler — Dashboard + API proxy
  // ---------------------------------------------------------------------------

  const httpHandler = createHttpHandler(config, client, () => cachedSnapshot);
  api.registerHttpHandler(httpHandler);

  api.log?.info?.("[orgx] Plugin registered", {
    baseUrl: config.baseUrl,
    hasApiKey: !!config.apiKey,
    dashboardEnabled: config.dashboardEnabled,
  });
}

// =============================================================================
// NAMED EXPORT FOR FLEXIBILITY
// =============================================================================

export { register };
