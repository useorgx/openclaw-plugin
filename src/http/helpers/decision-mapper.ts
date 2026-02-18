import type { Entity } from "../../types.js";
import { pickNumber, pickString, toIsoString } from "./value-utils.js";

export function mapDecisionEntity(entity: Entity) {
  const record = entity as Record<string, unknown>;
  const requestedAt = toIsoString(
    pickString(record, [
      "requestedAt",
      "requested_at",
      "createdAt",
      "created_at",
      "updatedAt",
      "updated_at",
    ])
  );
  const updatedAt = toIsoString(
    pickString(record, ["updatedAt", "updated_at", "createdAt", "created_at"])
  );

  const waitingMinutesFromEntity = pickNumber(record, [
    "waitingMinutes",
    "waiting_minutes",
    "ageMinutes",
    "age_minutes",
  ]);
  const waitingMinutes =
    waitingMinutesFromEntity ??
    (requestedAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(requestedAt)) / 60_000))
      : 0);

  return {
    id: String(record.id ?? ""),
    title: pickString(record, ["title", "name"]) ?? "Decision",
    context: pickString(record, ["context", "summary", "description", "details"]),
    status: pickString(record, ["status", "decision_status"]) ?? "pending",
    agentName: pickString(record, [
      "agentName",
      "agent_name",
      "requestedBy",
      "requested_by",
      "ownerName",
      "owner_name",
      "assignee",
      "createdBy",
      "created_by",
    ]),
    requestedAt,
    updatedAt,
    waitingMinutes,
    metadata: record,
  };
}

