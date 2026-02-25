import test from "node:test";
import assert from "node:assert/strict";

test("registerSyncService start boots sync and watchdog", async () => {
  const { registerSyncService } = await import("../../dist/services/background.js");

  let service = null;
  let doSyncCount = 0;
  let scheduleCount = 0;
  let runningState = null;

  registerSyncService({
    api: {
      registerService: (input) => {
        service = input;
      },
    },
    syncIntervalMs: 1000,
    ensureGatewayWatchdog: () => ({ started: true, pid: 321 }),
    doSync: async () => {
      doSyncCount += 1;
    },
    scheduleNextSync: () => {
      scheduleCount += 1;
    },
    setSyncServiceRunning: (running) => {
      runningState = running;
    },
    clearSyncTimer: () => {},
  });

  assert.ok(service, "service should be registered");
  await service.start();

  assert.equal(runningState, true);
  assert.equal(doSyncCount, 1);
  assert.equal(scheduleCount, 1);
});

test("registerSyncService stop tears down tracked runs and watchdog", async () => {
  const { registerSyncService } = await import("../../dist/services/background.js");

  let service = null;
  let runningState = null;
  let clearTimerCount = 0;
  let stopTrackedCount = 0;
  let stopWatchdogCount = 0;

  registerSyncService({
    api: {
      registerService: (input) => {
        service = input;
      },
      log: {
        info: () => {},
      },
    },
    syncIntervalMs: 1000,
    ensureGatewayWatchdog: () => ({ started: false, pid: null }),
    stopTrackedAgentRuns: async () => {
      stopTrackedCount += 1;
      return { attempted: 2, stopped: 2, failed: 0, markedStopped: 2 };
    },
    stopGatewayWatchdog: async () => {
      stopWatchdogCount += 1;
      return { pid: 999, wasRunning: true, stopped: true };
    },
    doSync: async () => {},
    scheduleNextSync: () => {},
    setSyncServiceRunning: (running) => {
      runningState = running;
    },
    clearSyncTimer: () => {
      clearTimerCount += 1;
    },
  });

  assert.ok(service, "service should be registered");
  await service.stop();

  assert.equal(runningState, false);
  assert.equal(clearTimerCount, 1);
  assert.equal(stopTrackedCount, 1);
  assert.equal(stopWatchdogCount, 1);
});
