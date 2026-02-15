import { randomUUID } from "node:crypto";

import type { OrgXClient } from "../contracts/client.js";

export type ArtifactEntityType = "initiative" | "milestone" | "task" | "decision" | "project";

export interface RegisterArtifactInput {
  /** Optional deterministic artifact id (UUID). Enables idempotent retries/outbox replay. */
  artifact_id?: string | null;
  entity_type: ArtifactEntityType;
  entity_id: string;
  name: string;
  artifact_type: string;
  description?: string | null;
  external_url?: string | null;
  preview_markdown?: string | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
  /**
   * When true, do a read-after-write check against:
   * - GET /api/artifacts/:id
   * - GET /api/work-artifacts/by-entity
   */
  validate_persistence?: boolean;
}

export interface RegisterArtifactResult {
  ok: boolean;
  artifact_id: string | null;
  artifact_url: string | null;
  created: boolean;
  persistence: {
    checked: boolean;
    artifact_detail_ok: boolean;
    linked_ok: boolean;
    attempts: number;
    last_error: string | null;
  };
  warnings: string[];
}

const MAX_PREVIEW_MARKDOWN = 25_000;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

export function validateRegisterArtifactInput(input: RegisterArtifactInput): string[] {
  const errors: string[] = [];

  if (!input || typeof input !== "object") {
    return ["input must be an object"];
  }

  const entityType = normalizeText(input.entity_type);
  if (!entityType) errors.push("entity_type is required");

  const entityId = normalizeText(input.entity_id);
  if (!entityId) errors.push("entity_id is required");
  // In production OrgX uses UUIDs, but tests/mocks sometimes use short ids like "init-1".
  // Keep this as a soft constraint (persistence validation will catch mismatches upstream).

  const name = normalizeText(input.name);
  if (!name) errors.push("name is required");

  const artifactType = normalizeText(input.artifact_type);
  if (!artifactType) errors.push("artifact_type is required");

  const externalUrl = normalizeText(input.external_url);
  const preview = normalizeText(input.preview_markdown);
  if (!externalUrl && !preview) {
    errors.push("at least one of external_url or preview_markdown is required");
  }

  return errors;
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isArtifactTypeConstraintError(err: unknown): boolean {
  const msg = safeErrorMessage(err).toLowerCase();
  return (
    msg.includes("artifact_type") &&
    (msg.includes("constraint") || msg.includes("foreign") || msg.includes("violat"))
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function validateArtifactPersistence(client: OrgXClient, input: {
  artifactId: string;
  entity_type: string;
  entity_id: string;
}): Promise<{ artifact_detail_ok: boolean; linked_ok: boolean }> {
  const detail = await client.rawRequest<any>(
    "GET",
    `/api/artifacts/${encodeURIComponent(input.artifactId)}`
  );
  const artifact = detail && typeof detail === "object" ? (detail as any).artifact : null;
  const artifactOk =
    artifact &&
    typeof artifact === "object" &&
    typeof artifact.id === "string" &&
    artifact.id === input.artifactId;

  const byEntity = await client.rawRequest<any>(
    "GET",
    `/api/work-artifacts/by-entity?entity_type=${encodeURIComponent(
      input.entity_type
    )}&entity_id=${encodeURIComponent(input.entity_id)}&limit=50`
  );
  const artifacts = byEntity && typeof byEntity === "object" ? (byEntity as any).artifacts : null;
  const linkedOk =
    Array.isArray(artifacts) &&
    artifacts.some((a) => a && typeof a === "object" && a.id === input.artifactId);

  return { artifact_detail_ok: Boolean(artifactOk), linked_ok: Boolean(linkedOk) };
}

export async function registerArtifact(
  client: OrgXClient,
  baseUrl: string,
  input: RegisterArtifactInput
): Promise<RegisterArtifactResult> {
  const warnings: string[] = [];
  const errors = validateRegisterArtifactInput(input);
  if (errors.length > 0) {
    return {
      ok: false,
      artifact_id: null,
      artifact_url: null,
      created: false,
      persistence: {
        checked: false,
        artifact_detail_ok: false,
        linked_ok: false,
        attempts: 0,
        last_error: errors.join("; "),
      },
      warnings: [],
    };
  }

  const requestedId = normalizeText(input.artifact_id);
  const desiredId = requestedId && isUuid(requestedId) ? requestedId : randomUUID();
  const artifactUrl = `${normalizeBaseUrl(baseUrl)}/artifacts/${desiredId}`;
  const status = normalizeText(input.status) || "draft";

  const metadata: Record<string, unknown> = {
    ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {}),
  };
  if (input.external_url) metadata.external_url = String(input.external_url);
  if (input.preview_markdown) {
    const preview = String(input.preview_markdown);
    metadata.preview_markdown =
      preview.length > MAX_PREVIEW_MARKDOWN
        ? preview.slice(0, MAX_PREVIEW_MARKDOWN)
        : preview;
    if (preview.length > MAX_PREVIEW_MARKDOWN) metadata.preview_truncated = true;
  }

  let entity: any = null;
  let created = false;

  // Attempt idempotent create using a client-provided UUID id (preferred).
  try {
    try {
      entity = await client.createEntity("artifact", {
        id: desiredId,
        name: input.name,
        description: input.description ?? undefined,
        artifact_type: input.artifact_type,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        artifact_url: artifactUrl,
        status,
        metadata,
      });
      created = true;
    } catch (err: unknown) {
      if (!isArtifactTypeConstraintError(err)) {
        throw err;
      }
      warnings.push(`artifact_type rejected; retrying with shared.project_handbook`);
      metadata.requested_artifact_type = input.artifact_type;
      entity = await client.createEntity("artifact", {
        id: desiredId,
        name: input.name,
        description: input.description ?? undefined,
        artifact_type: "shared.project_handbook",
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        artifact_url: artifactUrl,
        status,
        metadata,
      });
      created = true;
    }
  } catch (err: unknown) {
    warnings.push(`artifact create with explicit id failed: ${safeErrorMessage(err)}`);
    // Fallback: create without id, then patch artifact_url once we know the server id.
    try {
      entity = await client.createEntity("artifact", {
        name: input.name,
        description: input.description ?? undefined,
        artifact_type: input.artifact_type,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        artifact_url: input.external_url ?? `${normalizeBaseUrl(baseUrl)}/artifacts/pending`,
        status,
        metadata,
      });
      created = true;
    } catch (inner: unknown) {
      if (!isArtifactTypeConstraintError(inner)) {
        throw inner;
      }
      warnings.push(`artifact_type rejected; retrying with shared.project_handbook`);
      metadata.requested_artifact_type = input.artifact_type;
      entity = await client.createEntity("artifact", {
        name: input.name,
        description: input.description ?? undefined,
        artifact_type: "shared.project_handbook",
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        artifact_url: input.external_url ?? `${normalizeBaseUrl(baseUrl)}/artifacts/pending`,
        status,
        metadata,
      });
      created = true;
    }
  }

  const artifactId =
    entity && typeof entity === "object" && typeof (entity as any).id === "string"
      ? String((entity as any).id)
      : null;

  let finalArtifactUrl: string | null = artifactId
    ? `${normalizeBaseUrl(baseUrl)}/artifacts/${artifactId}`
    : null;

  if (artifactId) {
    try {
      await client.updateEntity("artifact", artifactId, {
        artifact_url: finalArtifactUrl,
      });
    } catch (err: unknown) {
      warnings.push(`artifact_url patch failed: ${safeErrorMessage(err)}`);
      // Keep whatever we sent originally.
      finalArtifactUrl = typeof (entity as any)?.artifact_url === "string" ? (entity as any).artifact_url : finalArtifactUrl;
    }
  }

  const shouldValidate = input.validate_persistence === true;
  const persistence = {
    checked: false,
    artifact_detail_ok: false,
    linked_ok: false,
    attempts: 0,
    last_error: null as string | null,
  };

  if (shouldValidate && artifactId) {
    persistence.checked = true;
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      persistence.attempts = attempt;
      try {
        const result = await validateArtifactPersistence(client, {
          artifactId,
          entity_type: input.entity_type,
          entity_id: input.entity_id,
        });
        persistence.artifact_detail_ok = result.artifact_detail_ok;
        persistence.linked_ok = result.linked_ok;
        if (result.artifact_detail_ok && result.linked_ok) {
          break;
        }
      } catch (err: unknown) {
        persistence.last_error = safeErrorMessage(err);
      }
      // quick backoff for eventual consistency
      await sleep(250 * attempt);
    }
    if (!persistence.artifact_detail_ok || !persistence.linked_ok) {
      warnings.push(
        `artifact persistence check failed (detail_ok=${persistence.artifact_detail_ok}, linked_ok=${persistence.linked_ok})`
      );
    }
  }

  return {
    ok: Boolean(artifactId),
    artifact_id: artifactId,
    artifact_url: finalArtifactUrl,
    created,
    persistence,
    warnings,
  };
}
