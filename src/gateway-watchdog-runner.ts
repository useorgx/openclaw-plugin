import { runGatewayWatchdogDaemon } from "./gateway-watchdog.js";

void runGatewayWatchdogDaemon().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[orgx] gateway-watchdog crashed: ${message}`);
  process.exit(1);
});
