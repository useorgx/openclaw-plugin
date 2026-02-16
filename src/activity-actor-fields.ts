import type { LiveActivityItem } from "./contracts/types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstString(record: Record<string, unknown> | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const candidate = nonEmptyString(record[key]);
    if (candidate) return candidate;
  }
  return null;
}

function normalizedMetadata(item: LiveActivityItem): Record<string, unknown> | null {
  const metadata = asRecord(item.metadata);
  if (!metadata) return null;
  const nested = asRecord(metadata.metadata);
  if (!nested) return metadata;
  return { ...metadata, ...nested };
}

function hasActorValue(id: string | null, name: string | null): boolean {
  return Boolean((id && id.trim().length > 0) || (name && name.trim().length > 0));
}

export function enrichActivityActorFields(item: LiveActivityItem): LiveActivityItem {
  const metadata = normalizedMetadata(item);

  let requesterAgentId =
    nonEmptyString(item.requesterAgentId) ??
    firstString(metadata, [
      "requested_by_agent_id",
      "requestedByAgentId",
      "requester_agent_id",
      "requesterAgentId",
      "requester_id",
      "requesterId",
      "runner_agent_id",
      "runnerAgentId",
      "handoff_from_agent_id",
      "handoffFromAgentId",
      "from_agent_id",
      "fromAgentId",
      "source_agent_id",
      "sourceAgentId",
    ]);

  let requesterAgentName =
    nonEmptyString(item.requesterAgentName) ??
    firstString(metadata, [
      "requested_by_agent_name",
      "requestedByAgentName",
      "requester_agent_name",
      "requesterAgentName",
      "requester_name",
      "requesterName",
      "runner_agent_name",
      "runnerAgentName",
      "handoff_from_agent_name",
      "handoffFromAgentName",
      "from_agent_name",
      "fromAgentName",
      "source_agent_name",
      "sourceAgentName",
    ]);

  const executorAgentId =
    nonEmptyString(item.executorAgentId) ??
    firstString(metadata, [
      "executed_by_agent_id",
      "executedByAgentId",
      "executor_agent_id",
      "executorAgentId",
      "executor_id",
      "executorId",
      "delegated_to_agent_id",
      "delegatedToAgentId",
      "handoff_to_agent_id",
      "handoffToAgentId",
      "target_agent_id",
      "targetAgentId",
      "agent_id",
      "agentId",
    ]) ??
    nonEmptyString(item.agentId);

  const executorAgentName =
    nonEmptyString(item.executorAgentName) ??
    firstString(metadata, [
      "executed_by_agent_name",
      "executedByAgentName",
      "executor_agent_name",
      "executorAgentName",
      "executor_name",
      "executorName",
      "delegated_to_agent_name",
      "delegatedToAgentName",
      "handoff_to_agent_name",
      "handoffToAgentName",
      "target_agent_name",
      "targetAgentName",
      "agent_name",
      "agentName",
    ]) ??
    nonEmptyString(item.agentName);

  if (!hasActorValue(requesterAgentId, requesterAgentName) && hasActorValue(executorAgentId, executorAgentName)) {
    requesterAgentId = executorAgentId;
    requesterAgentName = executorAgentName;
  }

  const unchanged =
    nonEmptyString(item.requesterAgentId) === requesterAgentId &&
    nonEmptyString(item.requesterAgentName) === requesterAgentName &&
    nonEmptyString(item.executorAgentId) === executorAgentId &&
    nonEmptyString(item.executorAgentName) === executorAgentName;
  if (unchanged) return item;

  return {
    ...item,
    requesterAgentId: requesterAgentId ?? null,
    requesterAgentName: requesterAgentName ?? null,
    executorAgentId: executorAgentId ?? null,
    executorAgentName: executorAgentName ?? null,
  } as LiveActivityItem;
}

export function enrichActivityActorFieldsList(items: LiveActivityItem[]): LiveActivityItem[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  return items.map((item) => enrichActivityActorFields(item));
}
