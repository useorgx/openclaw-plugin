import type { Entity } from "../../types.js";
import { pickNumber, pickString, toIsoString } from "./value-utils.js";
import type { DecisionActionType } from "../../contracts/shared-types.js";
import { normalizeDecisionActionType } from "../../contracts/shared-types.js";

type LiveDecisionOptionStatus = "approved" | "declined" | "cancelled";

type LiveDecisionOption = {
  id: string;
  label: string;
  description: string | null;
  impliedStatus: LiveDecisionOptionStatus | null;
  actionType: DecisionActionType | null;
  requiresNote: boolean;
};

type LiveDecisionEvidenceRef = {
  evidenceType: string | null;
  title: string | null;
  summary: string | null;
  sourceUrl: string | null;
  sourcePointer: string | null;
  freshness: string | null;
  confidence: number | null;
  payload: Record<string, unknown> | null;
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

function pickStringFromRecords(
  records: Array<Record<string, unknown> | null>,
  keys: string[]
): string | null {
  for (const record of records) {
    if (!record) continue;
    const value = pickString(record, keys);
    if (value) return value;
  }
  return null;
}

function pickNumberFromRecords(
  records: Array<Record<string, unknown> | null>,
  keys: string[]
): number | null {
  for (const record of records) {
    if (!record) continue;
    const value = pickNumber(record, keys);
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function pickActionType(values: unknown[]): DecisionActionType | null {
  for (const value of values) {
    const normalized = normalizeDecisionActionType(value);
    if (normalized) return normalized;
  }
  return null;
}

function parseDecisionOptions(record: Record<string, unknown>): LiveDecisionOption[] {
  const metadata = asRecord(record.metadata);
  const envelope = metadata ? asRecord(metadata.envelope_v2) : null;
  const containers: Record<string, unknown>[] = [record];
  if (metadata) containers.push(metadata);
  if (envelope) containers.push(envelope);

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
        pickActionType([
          candidate.action_type,
          candidate.type,
          candidate.verb,
          candidate.action,
        ]) ?? null,
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

function parseEvidenceRefs(record: Record<string, unknown>): LiveDecisionEvidenceRef[] {
  const metadata = asRecord(record.metadata);
  const envelope = metadata ? asRecord(metadata.envelope_v2) : null;
  const rawGroups: unknown[] = [
    record.evidence_refs,
    metadata?.evidence_refs,
    metadata?.decision_evidence,
    envelope?.evidence_refs,
  ];
  const refs: LiveDecisionEvidenceRef[] = [];

  for (const group of rawGroups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const evidence = asRecord(item);
      if (!evidence) continue;
      const confidenceRaw = pickNumber(evidence, ["confidence"]);
      refs.push({
        evidenceType: pickString(evidence, ["evidence_type", "evidenceType", "type"]),
        title: pickString(evidence, ["title", "name"]),
        summary: pickString(evidence, ["summary", "description"]),
        sourceUrl: pickString(evidence, ["source_url", "sourceUrl", "url"]),
        sourcePointer: pickString(evidence, ["source_pointer", "sourcePointer", "pointer", "path"]),
        freshness: pickString(evidence, ["freshness"]),
        confidence:
          typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
            ? confidenceRaw
            : null,
        payload: asRecord(evidence.payload),
      });
    }
  }

  return refs.slice(0, 20);
}

export function mapDecisionEntity(entity: Entity) {
  const record = entity as Record<string, unknown>;
  const metadata = asRecord(record.metadata);
  const envelope = metadata ? asRecord(metadata.envelope_v2) : null;
  const containers: Array<Record<string, unknown> | null> = [record, metadata, envelope];

  const requestedAt = toIsoString(
    pickStringFromRecords(containers, [
      "requestedAt",
      "requested_at",
      "createdAt",
      "created_at",
      "updatedAt",
      "updated_at",
    ])
  );
  const updatedAt = toIsoString(
    pickStringFromRecords(containers, ["updatedAt", "updated_at", "createdAt", "created_at"])
  );
  const dueAt = toIsoString(pickStringFromRecords(containers, ["dueAt", "due_at"]));

  const waitingMinutesFromEntity = pickNumberFromRecords(containers, [
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
  const evidenceRefs = parseEvidenceRefs(record);

  return {
    id: String(record.id ?? ""),
    title: pickStringFromRecords(containers, ["title", "name"]) ?? "Decision",
    context: pickStringFromRecords(containers, [
      "context",
      "summary",
      "description",
      "details",
      "recommended_action",
      "recommendedAction",
    ]),
    status: pickStringFromRecords(containers, ["status", "decision_status"]) ?? "pending",
    priority: pickStringFromRecords(containers, ["priority"]),
    decisionType: pickStringFromRecords(containers, ["decision_type", "decisionType"]),
    agentName: pickStringFromRecords(containers, [
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
    agentId: pickStringFromRecords(containers, ["agent_id", "agentId"]),
    initiativeId: pickStringFromRecords(containers, ["initiative_id", "initiativeId"]),
    workstreamId: pickStringFromRecords(containers, ["workstream_id", "workstreamId"]),
    dueAt,
    requestedAt,
    updatedAt,
    sourceSystem: pickStringFromRecords(containers, ["source_system", "sourceSystem"]),
    conflictSource: pickStringFromRecords(containers, ["conflict_source", "conflictSource"]),
    dedupeKey: pickStringFromRecords(containers, ["dedupe_key", "dedupeKey"]),
    recommendedAction: pickStringFromRecords(containers, [
      "recommended_action",
      "recommendedAction",
    ]),
    occurrenceCount: pickNumberFromRecords(containers, ["occurrence_count", "occurrenceCount"]),
    firstSeenAt: toIsoString(pickStringFromRecords(containers, ["first_seen_at", "firstSeenAt"])),
    lastSeenAt: toIsoString(pickStringFromRecords(containers, ["last_seen_at", "lastSeenAt"])),
    sourceRunId: pickStringFromRecords(containers, ["source_run_id", "sourceRunId"]),
    sourceSessionId: pickStringFromRecords(containers, [
      "source_session_id",
      "sourceSessionId",
      "session_id",
      "sessionId",
    ]),
    sourceStreamId: pickStringFromRecords(containers, ["source_stream_id", "sourceStreamId"]),
    evidenceRefs,
    waitingMinutes,
    metadata: record,
    options,
    selectedOptionId: parseSelectedOptionId(record),
  };
}
