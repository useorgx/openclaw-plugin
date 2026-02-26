import type { LiveActivityItem } from "./contracts/shared-types.js";

type RecordLike = Record<string, unknown>;

function toRecord(value: unknown): RecordLike | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as RecordLike;
}

function pickString(input: RecordLike | null, ...keys: string[]): string | null {
  if (!input) return null;
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function pickBool(input: RecordLike | null, ...keys: string[]): boolean {
  if (!input) return false;
  for (const key of keys) {
    if (input[key] === true) return true;
  }
  return false;
}

function containsMockMarker(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;

  // Match whole marker tokens and avoid substring false positives (e.g. "latest").
  return /(^|[^a-z0-9])(mock|fixture|synthetic|test)([^a-z0-9]|$)/i.test(normalized);
}

export function isUuid(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    trimmed
  );
}

export function isSyntheticIdentifier(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isUuid(trimmed)) return false;
  return /^(init|initiative|task|workstream|ws|milestone|ms|decision|artifact|demo|mock|test|sample|queue|tmp|local)-/i.test(
    trimmed
  );
}

function isMockTaggedMetadata(metadata: RecordLike | null): boolean {
  if (!metadata) return false;
  if (pickBool(metadata, "mock", "is_mock", "isMock")) return true;
  if (
    containsMockMarker(pickString(metadata, "source")) ||
    containsMockMarker(pickString(metadata, "worker_kind", "workerKind")) ||
    containsMockMarker(pickString(metadata, "environment"))
  ) {
    return true;
  }
  return false;
}

type OutboxEventLike = {
  type?: unknown;
  payload?: unknown;
  activityItem?: unknown;
};

export function classifyOutboxReplaySkip(event: OutboxEventLike): string | null {
  const eventType = typeof event.type === "string" ? event.type.trim().toLowerCase() : "";
  const payload = toRecord(event.payload);
  const activity = toRecord(event.activityItem);
  const payloadMetadata = toRecord(payload?.metadata);
  const activityMetadata = toRecord(activity?.metadata);
  const skipMockOutboxReplay =
    String(process.env.ORGX_SKIP_MOCK_OUTBOX_REPLAY ?? "false")
      .trim()
      .toLowerCase() === "true";

  if (
    skipMockOutboxReplay &&
    (isMockTaggedMetadata(payloadMetadata) ||
      isMockTaggedMetadata(activityMetadata) ||
      pickBool(payload, "mock", "is_mock", "isMock"))
  ) {
    return "mock_event";
  }

  if (eventType === "artifact") {
    const initiativeId = pickString(payload, "initiative_id", "initiativeId");
    const entityId = pickString(payload, "entity_id", "entityId");
    const sourceClient = pickString(payload, "source_client", "sourceClient");
    const payloadEvent = pickString(payloadMetadata, "event");
    const activityEvent = pickString(activityMetadata, "event");
    const allowSyntheticArtifact =
      sourceClient === "openclaw" ||
      payloadEvent === "autopilot_slice_artifact_buffered" ||
      activityEvent === "autopilot_slice_artifact_buffered";

    if (!allowSyntheticArtifact && isSyntheticIdentifier(initiativeId)) {
      return "synthetic_initiative_id";
    }
    if (!allowSyntheticArtifact && !entityId) {
      return "missing_artifact_entity_id";
    }
    if (!allowSyntheticArtifact && isSyntheticIdentifier(entityId)) {
      return "synthetic_artifact_entity_id";
    }
  }

  return null;
}

export function shouldHideActivityItem(item: LiveActivityItem): boolean {
  const metadata = toRecord(item.metadata);
  const hideMockActivity =
    String(process.env.ORGX_HIDE_MOCK_ACTIVITY ?? "false")
      .trim()
      .toLowerCase() === "true";
  if (hideMockActivity && isMockTaggedMetadata(metadata)) return true;

  return false;
}
