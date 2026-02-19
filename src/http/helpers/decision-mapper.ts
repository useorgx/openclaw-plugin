import type { Entity } from "../../types.js";
import { pickNumber, pickString, toIsoString } from "./value-utils.js";

type LiveDecisionOptionStatus = "approved" | "declined" | "cancelled";

type LiveDecisionOption = {
  id: string;
  label: string;
  description: string | null;
  impliedStatus: LiveDecisionOptionStatus | null;
  actionType: string | null;
  requiresNote: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeOptionStatus(value: unknown): LiveDecisionOptionStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "rejected") return "declined";
  if (normalized === "approved" || normalized === "declined" || normalized === "cancelled") {
    return normalized;
  }
  return null;
}

function parseDecisionOptions(record: Record<string, unknown>): LiveDecisionOption[] {
  const containers: Record<string, unknown>[] = [record];
  const metadata = asRecord(record.metadata);
  if (metadata) containers.push(metadata);

  const rawItems: unknown[] = [];
  for (const container of containers) {
    for (const key of ["decision_options", "options", "actions"]) {
      const value = container[key];
      if (Array.isArray(value)) rawItems.push(...value);
    }
  }

  const options: LiveDecisionOption[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < rawItems.length; index += 1) {
    const item = rawItems[index];
    if (typeof item === "string") {
      const label = item.trim();
      if (!label) continue;
      const id = `option-${index + 1}`;
      if (seen.has(id)) continue;
      seen.add(id);
      options.push({
        id,
        label,
        description: null,
        impliedStatus: null,
        actionType: null,
        requiresNote: false,
      });
      continue;
    }

    const candidate = asRecord(item);
    if (!candidate) continue;
    const id =
      (typeof candidate.id === "string" && candidate.id.trim()) ||
      (typeof candidate.option_id === "string" && candidate.option_id.trim()) ||
      (typeof candidate.action_id === "string" && candidate.action_id.trim()) ||
      `option-${index + 1}`;
    if (seen.has(id)) continue;

    const label =
      (typeof candidate.label === "string" && candidate.label.trim()) ||
      (typeof candidate.title === "string" && candidate.title.trim()) ||
      (typeof candidate.name === "string" && candidate.name.trim()) ||
      (typeof candidate.action === "string" && candidate.action.trim()) ||
      null;
    if (!label) continue;

    seen.add(id);
    options.push({
      id,
      label,
      description:
        typeof candidate.description === "string" ? candidate.description : null,
      impliedStatus:
        normalizeOptionStatus(candidate.implied_status) ??
        normalizeOptionStatus(candidate.status) ??
        normalizeOptionStatus(candidate.disposition),
      actionType:
        (typeof candidate.action_type === "string" && candidate.action_type) ||
        (typeof candidate.type === "string" && candidate.type) ||
        (typeof candidate.verb === "string" && candidate.verb) ||
        null,
      requiresNote:
        candidate.requires_note === true ||
        candidate.requiresNote === true ||
        candidate.note_required === true,
    });
  }

  return options.slice(0, 12);
}

function parseSelectedOptionId(record: Record<string, unknown>): string | null {
  const metadata = asRecord(record.metadata);
  if (!metadata) return null;
  const resolution = asRecord(metadata.resolution);
  if (!resolution) return null;
  const selected =
    (typeof resolution.selected_option_id === "string" && resolution.selected_option_id.trim()) ||
    (typeof resolution.option_id === "string" && resolution.option_id.trim()) ||
    null;
  return selected;
}

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
  const options = parseDecisionOptions(record);

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
    options,
    selectedOptionId: parseSelectedOptionId(record),
  };
}
