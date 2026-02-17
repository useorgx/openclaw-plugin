import type { LiveActivityItem } from "../../types.js";

type ListActivityPageResult = {
  activities: LiveActivityItem[];
  nextCursor: string | null;
};

type BuildArtifactFallbackDeps = {
  listActivityPage: (input: {
    limit: number;
    cursor: string | null;
  }) => ListActivityPageResult;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function flattenActivityMetadata(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const nested = asRecord(record.metadata);
  if (!nested) return record;
  return { ...record, ...nested };
}

function metadataString(
  metadata: Record<string, unknown> | null,
  keys: string[]
): string | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function metadataNumber(
  metadata: Record<string, unknown> | null,
  keys: string[]
): number | null {
  if (!metadata) return null;
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function resolveArtifactIdFromActivityItem(item: LiveActivityItem): string | null {
  const metadata = flattenActivityMetadata(item.metadata);
  if (!metadata) return null;
  const rawId = metadataString(metadata, ["artifact_id", "artifactId", "work_artifact_id"]);
  return rawId && rawId.length > 0 ? rawId : null;
}

function resolveArtifactHref(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `/orgx/api/live/filesystem/open?path=${encodeURIComponent(trimmed)}`;
}

export function createLocalArtifactDetailFallbackBuilder(
  deps: BuildArtifactFallbackDeps
): (artifactId: string, warning: string) => Record<string, unknown> | null {
  return (artifactId: string, warning: string) => {
    let cursor: string | null = null;
    const maxPages = 8;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const page = deps.listActivityPage({ limit: 500, cursor });
      const activities = Array.isArray(page.activities) ? page.activities : [];
      for (const item of activities) {
        const matchId = resolveArtifactIdFromActivityItem(item);
        if (!matchId || matchId !== artifactId) continue;

        const metadata = flattenActivityMetadata(item.metadata) ?? {};
        const rawPath =
          metadataString(metadata, [
            "url",
            "path",
            "file_path",
            "filepath",
            "artifact_path",
            "output_path",
            "external_url",
            "artifact_url",
          ]) ?? null;
        const artifactHref = resolveArtifactHref(rawPath);
        const artifactType =
          metadataString(metadata, ["artifact_type", "artifactType", "type"]) ?? "report";
        const artifactName =
          metadataString(metadata, ["artifact_name", "artifactName", "name", "title"]) ??
          item.title?.trim() ??
          `Artifact ${artifactId.slice(0, 8)}`;
        const status =
          metadataString(metadata, ["artifact_status", "status", "state"]) ??
          (typeof metadata.event === "string" && metadata.event.includes("buffered")
            ? "buffered"
            : "draft");
        const entityType =
          metadataString(metadata, ["entity_type", "entityType"]) ??
          (metadataString(metadata, ["initiative_id", "initiativeId"])
            ? "initiative"
            : "task");
        const entityId =
          metadataString(metadata, [
            "entity_id",
            "entityId",
            "task_id",
            "taskId",
            "workstream_id",
            "workstreamId",
            "initiative_id",
            "initiativeId",
            "run_id",
            "runId",
          ]) ?? "local";
        const description =
          metadataString(metadata, ["description", "summary", "message"]) ??
          item.summary ??
          item.description ??
          null;
        const version = Math.max(
          1,
          Math.round(metadataNumber(metadata, ["version", "artifact_version"]) ?? 1)
        );
        const createdAt = item.timestamp ?? new Date().toISOString();
        const updatedAt = item.timestamp ?? createdAt;

        return {
          artifact: {
            id: artifactId,
            name: artifactName,
            description,
            artifact_url: artifactHref ?? "",
            artifact_type: artifactType,
            status,
            version,
            entity_type: entityType,
            entity_id: entityId,
            metadata: {
              ...metadata,
              local_fallback: true,
              local_warning: warning,
              local_activity_event_id: item.id,
              local_activity_type: item.type,
              local_activity_timestamp: item.timestamp,
              local_source_path: rawPath,
            },
            created_at: createdAt,
            updated_at: updatedAt,
            catalog: null,
            cached_metadata: null,
          },
          relationships: [],
          localFallback: true,
          warning,
        };
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return null;
  };
}
