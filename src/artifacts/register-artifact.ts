import { randomUUID } from "node:crypto";

import type { OrgXClient } from "../contracts/client.js";
import { stableHash } from "../hash-utils.js";
import {
  validateArtifactMetadata,
  normalizeArtifactType,
} from "./artifact-domain-schemas.js";
import type { QueueRef, RunRef } from "./artifact-domain-schemas.js";

export type ArtifactEntityType =
  | "initiative"
  | "workstream"
  | "milestone"
  | "task"
  | "decision"
  | "project";

const ALLOWED_ENTITY_TYPES: ReadonlySet<ArtifactEntityType> = new Set([
  "initiative",
  "workstream",
  "milestone",
  "task",
  "decision",
  "project",
]);

export interface RegisterArtifactInput {
  /** Optional deterministic artifact id (UUID). Enables idempotent retries/outbox replay. */
  artifact_id?: string | null;
  entity_type: ArtifactEntityType;
  entity_id: string;
  name: string;
  artifact_type: string;
  confidence_score?: number | null;
  /**
   * Required by OrgX work_artifacts schema.
   * If omitted, defaults to "human" (safe default for user-scoped oxk_ keys).
   */
  created_by_type?: "human" | "agent" | null;
  /**
   * Optional explicit creator id. OrgX can typically infer this from auth context,
   * but allow callers to supply it when they have a stable UUID.
   */
  created_by_id?: string | null;
  description?: string | null;
  external_url?: string | null;
  preview_markdown?: string | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
  /**
   * When true, do a read-after-write check against:
   * - GET /api/client/artifacts/:id
   * - GET /api/client/artifacts/by-entity
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

function normalizeConfidenceScore(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function resolveCreatedById(client: OrgXClient, input: RegisterArtifactInput): string | null {
  const explicit = normalizeText(input.created_by_id);
  if (explicit && isUuid(explicit)) return explicit;

  const fromClient =
    typeof (client as any)?.getUserId === "function"
      ? normalizeText((client as any).getUserId())
      : "";
  if (fromClient && isUuid(fromClient)) return fromClient;

  const fromEnv = normalizeText(process.env.ORGX_CREATED_BY_ID);
  if (fromEnv && isUuid(fromEnv)) return fromEnv;

  return null;
}

export function validateRegisterArtifactInput(input: RegisterArtifactInput): string[] {
  const errors: string[] = [];

  if (!input || typeof input !== "object") {
    return ["input must be an object"];
  }

  const entityType = normalizeText(input.entity_type);
  if (!entityType) errors.push("entity_type is required");
  else if (!ALLOWED_ENTITY_TYPES.has(entityType as ArtifactEntityType)) {
    errors.push("entity_type must be one of: initiative, workstream, milestone, task, decision, project");
  }

  const entityId = normalizeText(input.entity_id);
  if (!entityId) errors.push("entity_id is required");
  // In production OrgX uses UUIDs, but tests/mocks sometimes use short ids like "init-1".
  // Keep this as a soft constraint (persistence validation will catch mismatches upstream).

  const name = normalizeText(input.name);
  if (!name) errors.push("name is required");

  const artifactType = normalizeText(input.artifact_type);
  if (!artifactType) errors.push("artifact_type is required");
  if (
    typeof input.confidence_score !== "undefined" &&
    normalizeConfidenceScore(input.confidence_score) == null
  ) {
    errors.push("confidence_score must be a number between 0 and 1 when provided");
  }

  const createdByType = normalizeText(input.created_by_type);
  if (createdByType && createdByType !== "human" && createdByType !== "agent") {
    errors.push("created_by_type must be 'human' or 'agent' when provided");
  }

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractArtifactFromCreateResponse(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;

  if (isRecord(payload.artifact)) return payload.artifact;
  if (isRecord(payload.data) && isRecord((payload.data as Record<string, unknown>).artifact)) {
    return (payload.data as Record<string, unknown>).artifact as Record<string, unknown>;
  }
  if (isRecord(payload.data)) return payload.data as Record<string, unknown>;
  return null;
}

function extractArtifactFromDetailResponse(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.artifact)) return payload.artifact;
  if (isRecord(payload.data) && isRecord((payload.data as Record<string, unknown>).artifact)) {
    return (payload.data as Record<string, unknown>).artifact as Record<string, unknown>;
  }
  if (isRecord(payload.data)) return payload.data as Record<string, unknown>;
  return null;
}

function extractArtifactsFromListResponse(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  const direct = payload.artifacts;
  if (Array.isArray(direct)) return direct.filter(isRecord);
  if (isRecord(payload.data) && Array.isArray((payload.data as Record<string, unknown>).artifacts)) {
    return ((payload.data as Record<string, unknown>).artifacts as unknown[]).filter(isRecord);
  }
  return [];
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
    `/api/client/artifacts/${encodeURIComponent(input.artifactId)}`
  );
  const detailArtifact = extractArtifactFromDetailResponse(detail);
  const detailOk = Boolean(
    detailArtifact && typeof detailArtifact.id === "string" && detailArtifact.id === input.artifactId
  );

  const list = await client.rawRequest<any>(
    "GET",
    `/api/client/artifacts/by-entity?entity_type=${encodeURIComponent(
      input.entity_type
    )}&entity_id=${encodeURIComponent(input.entity_id)}&limit=25`
  );
  const artifacts = extractArtifactsFromListResponse(list);
  const linkedArtifact = artifacts.find((artifact) => {
    return (
      typeof artifact.id === "string" &&
      artifact.id === input.artifactId &&
      typeof artifact.entity_type === "string" &&
      artifact.entity_type === input.entity_type &&
      typeof artifact.entity_id === "string" &&
      artifact.entity_id === input.entity_id
    );
  });

  return { artifact_detail_ok: detailOk, linked_ok: Boolean(linkedArtifact) };
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
  const createdByType = normalizeText(input.created_by_type) || "human";
  const createdById = resolveCreatedById(client, input);
  const createdBy: Record<string, unknown> =
    createdById ? { created_by_type: createdByType, created_by_id: createdById } : { created_by_type: createdByType };

  const metadata: Record<string, unknown> = {
    ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata
      : {}),
  };
  const confidenceScore = normalizeConfidenceScore(input.confidence_score);
  if (confidenceScore != null) metadata.confidence_score = confidenceScore;
  if (input.external_url) metadata.external_url = String(input.external_url);
  if (input.preview_markdown) {
    const preview = String(input.preview_markdown);
    metadata.preview_markdown =
      preview.length > MAX_PREVIEW_MARKDOWN
        ? preview.slice(0, MAX_PREVIEW_MARKDOWN)
        : preview;
    if (preview.length > MAX_PREVIEW_MARKDOWN) metadata.preview_truncated = true;
  }

  // --- Proof Ladder: atomic unit normalization + schema validation ---
  const explicitAtomicType = typeof metadata.atomic_unit_type === "string"
    ? metadata.atomic_unit_type.trim()
    : null;
  const inferredAtomicType = normalizeArtifactType(input.artifact_type);
  const atomicUnitType = explicitAtomicType || inferredAtomicType;
  if (atomicUnitType) {
    metadata.atomic_unit_type = atomicUnitType;
    const validation = validateArtifactMetadata(atomicUnitType, metadata);
    metadata.schema_validated = validation.valid;
    if (!validation.valid) {
      warnings.push(...validation.warnings);
    }
  }

  // --- Proof Ladder: artifact content hash ---
  const hashSource = input.preview_markdown || input.external_url || input.name;
  if (hashSource && !metadata.artifact_hash) {
    metadata.artifact_hash = stableHash(String(hashSource));
  }

  // --- Proof Ladder: queue_ref from environment / caller ---
  if (!metadata.queue_ref) {
    const queueRef: QueueRef = {};
    const envInitId = normalizeText(process.env.ORGX_INITIATIVE_ID);
    const envWsId = normalizeText(process.env.ORGX_WORKSTREAM_ID);
    const envTaskId = normalizeText(process.env.ORGX_TASK_ID);
    if (envInitId) queueRef.initiative_id = envInitId;
    if (envWsId) queueRef.workstream_id = envWsId;
    if (envTaskId) queueRef.task_id = envTaskId;
    if (Object.keys(queueRef).length > 0) {
      metadata.queue_ref = queueRef;
    }
  }

  // --- Proof Ladder: run_ref from environment / caller ---
  if (!metadata.run_ref) {
    const runRef: RunRef = {};
    const envRunId = normalizeText(process.env.ORGX_RUN_ID);
    const envCorrId = normalizeText(process.env.ORGX_CORRELATION_ID);
    const envSessionId = normalizeText(process.env.ORGX_SESSION_ID);
    if (envRunId) runRef.run_id = envRunId;
    if (envCorrId) runRef.correlation_id = envCorrId;
    if (envSessionId) runRef.session_id = envSessionId;
    if (Object.keys(runRef).length > 0) {
      metadata.run_ref = runRef;
    }
  }

  const metadataInitiativeId =
    typeof metadata.initiative_id === "string" && metadata.initiative_id.trim().length > 0
      ? metadata.initiative_id.trim()
      : null;
  const initiativeIdHint = input.entity_type === "initiative" ? input.entity_id : metadataInitiativeId;

  let entity: any = null;
  let created = false;
  let usedLegacyCreate = false;

  // Primary path: canonical client artifact contract.
  try {
    const response = await client.rawRequest<any>("POST", "/api/client/artifacts", {
      artifact_id: desiredId,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      name: input.name,
      artifact_type: input.artifact_type,
      description: input.description ?? undefined,
      artifact_url: artifactUrl,
      external_url: input.external_url ?? undefined,
      preview_markdown: input.preview_markdown ?? undefined,
      status,
      metadata,
      ...(initiativeIdHint ? { initiative_id: initiativeIdHint } : {}),
      ...createdBy,
    });

    entity = extractArtifactFromCreateResponse(response);
    if (!entity) {
      warnings.push("client artifact create returned an unexpected payload shape");
    } else {
      created = true;
    }
  } catch (err: unknown) {
    warnings.push(`client artifact create failed; falling back to legacy entities route: ${safeErrorMessage(err)}`);
  }

  // Compatibility path for older OrgX servers.
  if (!entity) {
    usedLegacyCreate = true;
    try {
      entity = await client.createEntity("artifact", {
        id: desiredId,
        name: input.name,
        description: input.description ?? undefined,
        artifact_type: input.artifact_type,
        confidence_score: confidenceScore ?? undefined,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        ...(initiativeIdHint ? { initiative_id: initiativeIdHint } : {}),
        artifact_url: artifactUrl,
        status,
        metadata,
        ...createdBy,
      });
      created = true;
    } catch (err: unknown) {
      if (!isArtifactTypeConstraintError(err)) {
        throw err;
      }
      warnings.push(`artifact_type rejected on legacy route; retrying with shared.project_handbook`);
      metadata.requested_artifact_type = input.artifact_type;
      entity = await client.createEntity("artifact", {
        id: desiredId,
        name: input.name,
        description: input.description ?? undefined,
        artifact_type: "shared.project_handbook",
        confidence_score: confidenceScore ?? undefined,
        entity_type: input.entity_type,
        entity_id: input.entity_id,
        ...(initiativeIdHint ? { initiative_id: initiativeIdHint } : {}),
        artifact_url: artifactUrl,
        status,
        metadata,
        ...createdBy,
      });
      created = true;
    }
  }

  const artifactId =
    entity && typeof entity === "object" && typeof (entity as any).id === "string"
      ? String((entity as any).id)
      : null;

  let finalArtifactUrl: string | null =
    entity && typeof entity === "object" && typeof (entity as any).artifact_url === "string"
      ? String((entity as any).artifact_url)
      : artifactId
      ? `${normalizeBaseUrl(baseUrl)}/artifacts/${artifactId}`
      : null;

  if (artifactId && usedLegacyCreate) {
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
