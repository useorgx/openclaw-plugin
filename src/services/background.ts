export interface RegisterServiceApi {
  registerService: (service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }) => void;
  log?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface RegisterSyncServiceDeps {
  api: RegisterServiceApi;
  syncIntervalMs: number;
  ensureGatewayWatchdog: (logger: Record<string, unknown>) => { started: boolean; pid?: number | null };
  stopGatewayWatchdog?: () => Promise<{ pid: number | null; wasRunning: boolean; stopped: boolean }>;
  stopTrackedAgentRuns?: () => Promise<{
    attempted: number;
    stopped: number;
    failed: number;
    markedStopped: number;
  }>;
  doSync: () => Promise<void>;
  scheduleNextSync: () => void;
  setSyncServiceRunning: (running: boolean) => void;
  clearSyncTimer: () => void;
}

export function registerSyncService(deps: RegisterSyncServiceDeps): void {
  deps.api.registerService({
    id: "orgx-sync",
    start: async () => {
      deps.setSyncServiceRunning(true);
      const watchdog = deps.ensureGatewayWatchdog((deps.api.log ?? {}) as Record<string, unknown>);
      if (watchdog.started) {
        deps.api.log?.info?.("[orgx] Gateway watchdog started", {
          pid: watchdog.pid,
        });
      }
      deps.api.log?.info?.("[orgx] Starting sync service", {
        interval: deps.syncIntervalMs,
      });
      await deps.doSync();
      deps.scheduleNextSync();
    },
    stop: async () => {
      deps.setSyncServiceRunning(false);
      deps.clearSyncTimer();
      if (deps.stopTrackedAgentRuns) {
        try {
          const result = await deps.stopTrackedAgentRuns();
          deps.api.log?.info?.("[orgx] Stopped tracked agent runs on plugin stop", result);
        } catch (err: unknown) {
          deps.api.log?.info?.("[orgx] Failed stopping tracked agent runs on plugin stop", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (deps.stopGatewayWatchdog) {
        try {
          const result = await deps.stopGatewayWatchdog();
          deps.api.log?.info?.("[orgx] Gateway watchdog teardown on plugin stop", result);
        } catch (err: unknown) {
          deps.api.log?.info?.("[orgx] Failed stopping watchdog on plugin stop", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  });
}
