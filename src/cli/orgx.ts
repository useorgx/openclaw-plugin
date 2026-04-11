import type { OrgXClient } from "../api.js";
import type { OnboardingState, OrgSnapshot } from "../types.js";
import type { ResolvedConfig } from "../config/resolution.js";

type DoctorCheckStatus = "pass" | "warn" | "fail";
type ReplayStatus = "idle" | "running" | "success" | "error";

interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
}

export interface HealthReport {
  ok: boolean;
  status: "ok" | "degraded" | "error";
  generatedAt: string;
  checks: DoctorCheck[];
  plugin: {
    version: string;
    installationId: string;
    enabled: boolean;
    dashboardEnabled: boolean;
    baseUrl: string;
  };
  auth: {
    hasApiKey: boolean;
    keySource: ResolvedConfig["apiKeySource"];
    userIdConfigured: boolean;
    onboardingStatus: OnboardingState["status"];
  };
  sync: {
    serviceRunning: boolean;
    inFlight: boolean;
    backgroundInFlight: boolean;
    lastSnapshotAt: string | null;
    lastBackgroundSyncAt: string | null;
    lastBackgroundSyncError: string | null;
  };
  outbox: {
    pendingTotal: number;
    pendingByQueue: Record<string, number>;
    oldestEventAt: string | null;
    newestEventAt: string | null;
    replayStatus: ReplayStatus;
    lastReplayAttemptAt: string | null;
    lastReplaySuccessAt: string | null;
    lastReplayFailureAt: string | null;
    lastReplayError: string | null;
  };
  remote: {
    enabled: boolean;
    reachable: boolean | null;
    latencyMs: number | null;
    error: string | null;
  };
}

export interface UpdateInitiativeInput {
  title?: string;
  summary?: string;
  status?: "draft" | "active" | "paused" | "completed" | "archived";
  priority?: "critical" | "active" | "maintenance" | "hold";
}

/** Shape returned by getLiveInitiatives for each initiative entry. */
interface InitiativeRecord {
  id: string;
  title: string;
  status: string;
  progress?: number;
  summary?: string;
  priority?: string;
  workstreams?: string[];
  [key: string]: unknown;
}

export interface RegisterOrgxCliDeps {
  registerCli: (fn: (ctx: { program: any }) => void, options?: { commands?: string[] }) => void;
  client: OrgXClient;
  formatSnapshot: (snapshot: OrgSnapshot) => string;
  buildHealthReport: (input?: { probeRemote?: boolean }) => Promise<HealthReport>;
  apiKeySourceLabel: (source: ResolvedConfig["apiKeySource"]) => string;
  /** Patch an initiative via the OrgX API. Injected by the caller. */
  patchInitiative?: (id: string, input: UpdateInitiativeInput) => Promise<void>;
}

export function registerOrgxCli(deps: RegisterOrgxCliDeps): void {
  deps.registerCli(
    ({ program }: { program: any }) => {
      const cmd = program.command("orgx").description("OrgX integration commands");

      cmd
        .command("status")
        .description("Show current OrgX org status")
        .action(async () => {
          try {
            const snap = await deps.client.getOrgSnapshot();
            console.log(deps.formatSnapshot(snap));
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
        .option(
          "--agents-json <json>",
          "JSON array of local agent states to include (id,name,domain,status)"
        )
        .action(
          async (
            opts: { memory?: string; dailyLog?: string; agentsJson?: string } = {}
          ) => {
          try {
            let agents:
              | Array<{
                  id: string;
                  name: string;
                  domain: string;
                  status: "active" | "idle" | "throttled";
                  currentTask?: string;
                  lastActive?: string;
                }>
              | undefined;
            if (typeof opts.agentsJson === "string" && opts.agentsJson.trim().length > 0) {
              const parsed = JSON.parse(opts.agentsJson);
              if (!Array.isArray(parsed)) {
                throw new Error("--agents-json must be a JSON array");
              }
              agents = parsed as typeof agents;
            }
            const resp = await deps.client.syncMemory({
              memory: opts.memory,
              dailyLog: opts.dailyLog,
              agents,
            });
            console.log("Sync complete:");
            console.log(`  Initiatives: ${resp.initiatives?.length ?? 0}`);
            console.log(`  Agents: ${resp.agents?.length ?? 0}`);
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
          }
        );

      cmd
        .command("doctor")
        .description("Run plugin diagnostics and connectivity checks")
        .option("--json", "Print the report as JSON")
        .option("--no-remote", "Skip remote OrgX API reachability probe")
        .action(async (opts: { json?: boolean; remote?: boolean } = {}) => {
          try {
            const report = await deps.buildHealthReport({
              probeRemote: opts.remote !== false,
            });

            if (opts.json) {
              console.log(JSON.stringify(report, null, 2));
              if (!report.ok) process.exit(1);
              return;
            }

            console.log("OrgX Doctor");
            console.log(`  Status: ${report.status.toUpperCase()}`);
            console.log(`  Plugin: v${report.plugin.version}`);
            console.log(`  Base URL: ${report.plugin.baseUrl}`);
            console.log(
              `  API Key Source: ${deps.apiKeySourceLabel(report.auth.keySource)}`
            );
            console.log(`  Outbox Pending: ${report.outbox.pendingTotal}`);
            console.log("");
            console.log("Checks:");
            for (const check of report.checks) {
              const prefix =
                check.status === "pass"
                  ? "[PASS]"
                  : check.status === "warn"
                    ? "[WARN]"
                    : "[FAIL]";
              console.log(`  ${prefix} ${check.message}`);
            }

            if (report.remote.enabled) {
              if (report.remote.reachable === true) {
                console.log(
                  `  Remote probe latency: ${report.remote.latencyMs ?? "?"}ms`
                );
              } else if (report.remote.reachable === false) {
                console.log(
                  `  Remote probe error: ${report.remote.error ?? "Unknown error"}`
                );
              } else {
                console.log("  Remote probe: skipped");
              }
            }

            if (!report.ok) {
              process.exit(1);
            }
          } catch (err: unknown) {
            console.error(
              `Doctor failed: ${err instanceof Error ? err.message : err}`
            );
            process.exit(1);
          }
        });

      // ── orgx initiative ──────────────────────────────────────────────────
      const initiativeCmd = cmd
        .command("initiative")
        .description("Manage OrgX initiatives");

      initiativeCmd
        .command("list")
        .description("List all live initiatives")
        .option("--json", "Output as JSON")
        .action(async (opts: { json?: boolean } = {}) => {
          try {
            const result = await deps.client.getLiveInitiatives();
            const initiatives = result.initiatives as InitiativeRecord[];

            if (opts.json) {
              console.log(JSON.stringify(initiatives, null, 2));
              return;
            }

            if (initiatives.length === 0) {
              console.log("No initiatives found.");
              return;
            }

            // Plain-text table
            const colWidths = {
              id: Math.max(4, ...initiatives.map((i) => String(i.id ?? "").length)),
              title: Math.max(5, ...initiatives.map((i) => String(i.title ?? "").length)),
              status: Math.max(6, ...initiatives.map((i) => String(i.status ?? "").length)),
              progress: 8,
            };

            const pad = (s: string, n: number) => s.padEnd(n);
            const header = [
              pad("ID", colWidths.id),
              pad("TITLE", colWidths.title),
              pad("STATUS", colWidths.status),
              pad("PROGRESS", colWidths.progress),
            ].join("  ");
            const divider = "-".repeat(header.length);

            console.log(header);
            console.log(divider);
            for (const ini of initiatives) {
              const progress =
                ini.progress != null ? `${ini.progress}%` : "-";
              console.log(
                [
                  pad(String(ini.id ?? ""), colWidths.id),
                  pad(String(ini.title ?? ""), colWidths.title),
                  pad(String(ini.status ?? ""), colWidths.status),
                  pad(progress, colWidths.progress),
                ].join("  ")
              );
            }
            console.log(`\nTotal: ${result.total}`);
          } catch (err: unknown) {
            console.error(
              `Error listing initiatives: ${err instanceof Error ? err.message : err}`
            );
            process.exit(1);
          }
        });

      initiativeCmd
        .command("show <id>")
        .description("Show details of a single initiative")
        .action(async (id: string) => {
          try {
            const result = await deps.client.getLiveInitiatives({ id });
            const initiatives = result.initiatives as InitiativeRecord[];

            if (initiatives.length === 0) {
              console.error(`Initiative not found: ${id}`);
              process.exit(1);
              return;
            }

            const ini = initiatives[0];
            console.log(`Initiative: ${ini.title}`);
            console.log(`  ID:       ${ini.id}`);
            console.log(`  Status:   ${ini.status}`);
            if (ini.priority != null) {
              console.log(`  Priority: ${ini.priority}`);
            }
            if (ini.progress != null) {
              console.log(`  Progress: ${ini.progress}%`);
            }
            if (ini.summary) {
              console.log(`  Summary:  ${ini.summary}`);
            }
            if (Array.isArray(ini.workstreams) && ini.workstreams.length > 0) {
              console.log(`  Workstreams:`);
              for (const ws of ini.workstreams) {
                console.log(`    - ${ws}`);
              }
            }
          } catch (err: unknown) {
            console.error(
              `Error fetching initiative: ${err instanceof Error ? err.message : err}`
            );
            process.exit(1);
          }
        });

      initiativeCmd
        .command("update <id>")
        .description("Update an initiative's fields")
        .option("--title <text>", "New title")
        .option("--summary <text>", "New summary")
        .option(
          "--status <value>",
          "New status (draft|active|paused|completed|archived)"
        )
        .option(
          "--priority <value>",
          "New priority (critical|active|maintenance|hold)"
        )
        .action(
          async (
            id: string,
            opts: {
              title?: string;
              summary?: string;
              status?: string;
              priority?: string;
            } = {}
          ) => {
            try {
              if (!deps.patchInitiative) {
                console.error(
                  "patchInitiative is not configured for this installation."
                );
                process.exit(1);
                return;
              }

              const input: UpdateInitiativeInput = {};
              if (opts.title !== undefined) input.title = opts.title;
              if (opts.summary !== undefined) input.summary = opts.summary;
              if (opts.status !== undefined) {
                const validStatuses = [
                  "draft",
                  "active",
                  "paused",
                  "completed",
                  "archived",
                ] as const;
                if (
                  !validStatuses.includes(
                    opts.status as (typeof validStatuses)[number]
                  )
                ) {
                  console.error(
                    `Invalid status "${opts.status}". Must be one of: ${validStatuses.join(", ")}`
                  );
                  process.exit(1);
                  return;
                }
                input.status =
                  opts.status as UpdateInitiativeInput["status"];
              }
              if (opts.priority !== undefined) {
                const validPriorities = [
                  "critical",
                  "active",
                  "maintenance",
                  "hold",
                ] as const;
                if (
                  !validPriorities.includes(
                    opts.priority as (typeof validPriorities)[number]
                  )
                ) {
                  console.error(
                    `Invalid priority "${opts.priority}". Must be one of: ${validPriorities.join(", ")}`
                  );
                  process.exit(1);
                  return;
                }
                input.priority =
                  opts.priority as UpdateInitiativeInput["priority"];
              }

              if (Object.keys(input).length === 0) {
                console.error(
                  "No fields to update. Use --title, --summary, --status, or --priority."
                );
                process.exit(1);
                return;
              }

              await deps.patchInitiative(id, input);
              console.log(`Initiative ${id} updated successfully.`);
              const changed = Object.entries(input)
                .map(([k, v]) => `  ${k}: ${v}`)
                .join("\n");
              console.log(changed);
            } catch (err: unknown) {
              console.error(
                `Error updating initiative: ${err instanceof Error ? err.message : err}`
              );
              process.exit(1);
            }
          }
        );

      initiativeCmd
        .command("launch <id>")
        .description("Launch an initiative (set status to active)")
        .action(async (id: string) => {
          try {
            if (!deps.patchInitiative) {
              console.error(
                "patchInitiative is not configured for this installation."
              );
              process.exit(1);
              return;
            }
            await deps.patchInitiative(id, { status: "active" });
            console.log(`Initiative ${id} launched (status → active).`);
          } catch (err: unknown) {
            console.error(
              `Error launching initiative: ${err instanceof Error ? err.message : err}`
            );
            process.exit(1);
          }
        });

      initiativeCmd
        .command("pause <id>")
        .description("Pause an initiative (set status to paused)")
        .action(async (id: string) => {
          try {
            if (!deps.patchInitiative) {
              console.error(
                "patchInitiative is not configured for this installation."
              );
              process.exit(1);
              return;
            }
            await deps.patchInitiative(id, { status: "paused" });
            console.log(`Initiative ${id} paused (status → paused).`);
          } catch (err: unknown) {
            console.error(
              `Error pausing initiative: ${err instanceof Error ? err.message : err}`
            );
            process.exit(1);
          }
        });
    },
    { commands: ["orgx"] }
  );
}
