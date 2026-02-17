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
    lastSnapshotAt: string | null;
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

export interface RegisterOrgxCliDeps {
  registerCli: (fn: (ctx: { program: any }) => void, options?: { commands?: string[] }) => void;
  client: OrgXClient;
  formatSnapshot: (snapshot: OrgSnapshot) => string;
  buildHealthReport: (input?: { probeRemote?: boolean }) => Promise<HealthReport>;
  apiKeySourceLabel: (source: ResolvedConfig["apiKeySource"]) => string;
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
        .action(async (opts: { memory?: string; dailyLog?: string } = {}) => {
          try {
            const resp = await deps.client.syncMemory({
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
    },
    { commands: ["orgx"] }
  );
}
