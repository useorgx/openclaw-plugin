import type { OutboxAdapter } from "../adapters/outbox.js";
import type { OrgXClient } from "../api.js";
import type { OrgXConfig, OrgSnapshot } from "../types.js";

/**
 * SharedState is the dependency bag used by extracted HTTP route modules.
 * Start intentionally small and widen as route groups are migrated.
 */
export interface SharedState {
  client: OrgXClient;
  config: OrgXConfig;
  outbox: OutboxAdapter;
  getCachedSnapshot: () => OrgSnapshot | null;
  doSync: () => Promise<void>;
  tickAllAutoContinue: () => Promise<void>;
  [key: string]: unknown;
}
