import type { LiveActivityItem } from "../types.js";
import type { OutboxSummary } from "../outbox.js";
import { readAllOutboxItems, readOutboxSummary } from "../outbox.js";

export type OutboxAdapter = {
  readAllItems: () => Promise<LiveActivityItem[]>;
  readSummary: () => Promise<OutboxSummary>;
};

export const defaultOutboxAdapter: OutboxAdapter = {
  readAllItems: readAllOutboxItems,
  readSummary: readOutboxSummary,
};
