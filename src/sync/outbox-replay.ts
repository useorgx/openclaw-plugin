import type { OrgXClient } from "../api.js";
import { registerArtifact } from "../artifacts/register-artifact.js";
import type { OutboxEvent } from "../outbox.js";
import { readOutbox, readOutboxSummary, replaceOutbox } from "../outbox.js";
import { extractProgressOutboxMessage } from "../reporting/outbox-replay.js";
import { RETRO_ARTIFACT_SCHEMA_VERSION } from "../contracts/retro-schema.js";
import type {
  ChangesetOperation,
  ReportingPhase,
  ReportingSourceClient,
} from "../types.js";

export type ReplayStatus = "idle" | "running" | "success" | "error";

export type OutboxReplayState = {
  status: ReplayStatus;
  lastReplayAttemptAt: string | null;
  lastReplaySuccessAt: string | null;
  lastReplayFailureAt: string | null;
  lastReplayError: string | null;
};

interface ReportingContextInput {
  initiative_id?: unknown;
  run_id?: unknown;
  correlation_id?: unknown;
  source_client?: unknown;
  initiativeId?: unknown;
  runId?: unknown;
  correlationId?: unknown;
  sourceClient?: unknown;
}

type ReplayContext = {
  initiativeId: string;
  runId?: string;
  correlationId?: string;
  sourceClient?: ReportingSourceClient;
};

export interface CreateOutboxReplayerDeps {
  client: OrgXClient;
  logger: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  toErrorMessage: (err: unknown) => string;
  stableHash: (value: string) => string;
  resolveReportingContext: (input: ReportingContextInput) =>
    | { ok: true; value: ReplayContext }
    | { ok: false; error: string };
  pickStringField: (input: Record<string, unknown>, ...keys: string[]) => string | null;
  pickStringArrayField: (input: Record<string, unknown>, ...keys: string[]) => string[] | undefined;
  toReportingPhase: (phase: string, progressPct?: number) => ReportingPhase;
  parseRetroEntityType: (
    value: string | null
  ) => "initiative" | "task" | "milestone" | "workstream" | null | undefined;
  isUuid: (value: string | undefined) => value is string;
  readOutboxReplayState: () => OutboxReplayState;
  writeOutboxReplayState: (next: OutboxReplayState) => void;
}

export function createOutboxReplayer(deps: CreateOutboxReplayerDeps): {
  replayOutboxEvent: (event: OutboxEvent) => Promise<void>;
  flushOutboxQueues: () => Promise<void>;
} {
  const {
    client,
    logger,
    toErrorMessage,
    stableHash,
    resolveReportingContext,
    pickStringField,
    pickStringArrayField,
    toReportingPhase,
    parseRetroEntityType,
    isUuid,
  } = deps;

  async function replayOutboxEvent(event: OutboxEvent): Promise<void> {
    const payload = event.payload ?? {};

    function normalizeRunFields(context: { runId?: string | null; correlationId?: string | null }): {
      run_id: string | undefined;
      correlation_id: string | undefined;
    } {
      // We prefer correlation IDs for replay because many local adapters use UUID-like
      // session IDs that do *not* exist as server-side run IDs.
      if (context.correlationId) {
        return { run_id: undefined, correlation_id: context.correlationId };
      }
      if (context.runId) {
        return {
          run_id: undefined,
          correlation_id: `openclaw_run_${stableHash(context.runId).slice(0, 24)}`,
        };
      }
      return { run_id: undefined, correlation_id: undefined };
    }

    function normalizeRetro(payload: Record<string, unknown>): {
      schema_version: typeof RETRO_ARTIFACT_SCHEMA_VERSION;
      summary: string;
      what_went_well?: string[];
      what_went_wrong?: string[];
      decisions?: string[];
      follow_ups?: Array<{ title: string; priority?: "p0" | "p1" | "p2"; reason?: string }>;
      signals?: Record<string, unknown>;
    } | null {
      const retro =
        payload.retro && typeof payload.retro === "object" && !Array.isArray(payload.retro)
          ? (payload.retro as Record<string, unknown>)
          : null;
      const summary =
        retro && typeof retro.summary === "string" ? retro.summary.trim() : "";
      if (!retro || !summary) {
        return null;
      }

      const normalizeStringList = (value: unknown): string[] | undefined => {
        if (!Array.isArray(value)) return undefined;
        const normalized = value
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
          .slice(0, 25);
        return normalized.length > 0 ? normalized : undefined;
      };

      const followUpsRaw = Array.isArray(retro.follow_ups)
        ? retro.follow_ups
        : Array.isArray((retro as any).followUps)
          ? ((retro as any).followUps as unknown[])
          : [];
      const followUps: Array<{
        title: string;
        priority?: "p0" | "p1" | "p2";
        reason?: string;
      }> = [];
      for (const candidate of followUpsRaw) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
          continue;
        }
        const title =
          typeof (candidate as { title?: unknown }).title === "string"
            ? (candidate as { title: string }).title.trim()
            : "";
        if (!title) {
          continue;
        }
        const priorityRaw =
          typeof (candidate as { priority?: unknown }).priority === "string"
            ? (candidate as { priority: string }).priority.trim().toLowerCase()
            : "";
        const priority =
          priorityRaw === "p0" || priorityRaw === "p1" || priorityRaw === "p2"
            ? (priorityRaw as "p0" | "p1" | "p2")
            : undefined;
        const reason =
          typeof (candidate as { reason?: unknown }).reason === "string"
            ? (candidate as { reason: string }).reason.trim()
            : "";
        followUps.push({
          title,
          priority,
          reason: reason || undefined,
        });
        if (followUps.length >= 25) {
          break;
        }
      }

      const signals =
        retro.signals && typeof retro.signals === "object" && !Array.isArray(retro.signals)
          ? (retro.signals as Record<string, unknown>)
          : undefined;

      return {
        schema_version: RETRO_ARTIFACT_SCHEMA_VERSION,
        summary,
        what_went_well: normalizeStringList(retro.what_went_well),
        what_went_wrong: normalizeStringList(retro.what_went_wrong),
        decisions: normalizeStringList(retro.decisions),
        follow_ups: followUps.length > 0 ? followUps : undefined,
        signals,
      };
    }

    if (event.type === "progress") {
      const message = extractProgressOutboxMessage(payload);
      if (!message) {
        logger.warn?.("[orgx] Dropping invalid progress outbox event", {
          eventId: event.id,
        });
        return;
      }
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const rawPhase = pickStringField(payload, "phase") ?? "implementing";
      const progressPct =
        typeof payload.progress_pct === "number"
          ? payload.progress_pct
          : typeof (payload as Record<string, unknown>).progressPct === "number"
            ? ((payload as Record<string, unknown>).progressPct as number)
            : undefined;
      const phase =
        rawPhase === "intent" ||
        rawPhase === "execution" ||
        rawPhase === "blocked" ||
        rawPhase === "review" ||
        rawPhase === "handoff" ||
        rawPhase === "completed"
          ? (rawPhase as ReportingPhase)
          : toReportingPhase(rawPhase, progressPct);

      const metaRaw = payload.metadata;
      const meta =
        metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
          ? (metaRaw as Record<string, unknown>)
          : {};

      const baseMetadata: Record<string, unknown> = {
        ...meta,
        source: "orgx_openclaw_outbox_replay",
        outbox_event_id: event.id,
      };

      let emitPayload = {
        initiative_id: context.value.initiativeId,
        run_id: context.value.runId,
        correlation_id: context.value.correlationId,
        source_client: context.value.sourceClient,
        message,
        phase,
        progress_pct: progressPct,
        level: pickStringField(payload, "level") as "info" | "warn" | "error" | undefined,
        next_step:
          pickStringField(payload, "next_step") ??
          pickStringField(payload, "nextStep") ??
          undefined,
        metadata: baseMetadata,
      } satisfies Parameters<typeof client.emitActivity>[0];

      try {
        await client.emitActivity(emitPayload);
      } catch (err: unknown) {
        // Some locally-buffered events carry a UUID that *looks* like an OrgX run_id
        // but was only ever used as a local correlation/grouping key. If OrgX
        // doesn't recognize it, retry by treating it as correlation_id so OrgX can
        // create/attach a run deterministically.
        const msg = toErrorMessage(err);
        if (
          emitPayload.run_id &&
          /^404\b/.test(msg) &&
          /\brun\b/i.test(msg) &&
          /not found/i.test(msg)
        ) {
          const replayCorrelationId = `openclaw_run_${stableHash(emitPayload.run_id).slice(0, 24)}`;
          await client.emitActivity({
            ...emitPayload,
            run_id: undefined,
            correlation_id: replayCorrelationId,
            metadata: {
              ...(emitPayload.metadata ?? {}),
              replay_run_id_as_correlation: true,
            },
          });
        } else {
          throw err;
        }
      }
      return;
    }

    if (event.type === "decision") {
      const question = pickStringField(payload, "question");
      if (!question) {
        logger.warn?.("[orgx] Dropping invalid decision outbox event", {
          eventId: event.id,
        });
        return;
      }
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const runFields = normalizeRunFields({
        runId: context.value.runId,
        correlationId: context.value.correlationId,
      });

      // Payloads should include a stable idempotency_key when enqueued, but older
      // events may not. Derive a deterministic fallback so outbox replay won't
      // double-create the same remote decision.
      const fallbackKey = stableHash(
        JSON.stringify({
          t: "decision",
          initiative_id: context.value.initiativeId,
          run_id: context.value.runId ?? null,
          correlation_id: context.value.correlationId ?? null,
          question,
        })
      ).slice(0, 24);

      const resolvedIdempotencyKey =
        pickStringField(payload, "idempotency_key") ??
        pickStringField(payload, "idempotencyKey") ??
        `openclaw:decision:${fallbackKey}`;

      await client.applyChangeset({
        initiative_id: context.value.initiativeId,
        run_id: runFields.run_id,
        correlation_id: runFields.correlation_id,
        source_client: context.value.sourceClient,
        idempotency_key: resolvedIdempotencyKey,
        operations: [
          {
            op: "decision.create",
            title: question,
            summary: pickStringField(payload, "context") ?? undefined,
            urgency:
              (pickStringField(payload, "urgency") as
                | "low"
                | "medium"
                | "high"
                | "urgent"
                | undefined) ?? "medium",
            options: pickStringArrayField(payload, "options"),
            blocking:
              typeof payload.blocking === "boolean" ? payload.blocking : true,
          },
        ],
      });
      return;
    }

    if (event.type === "changeset") {
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const runFields = normalizeRunFields({
        runId: context.value.runId,
        correlationId: context.value.correlationId,
      });
      const operations = Array.isArray(payload.operations)
        ? (payload.operations as ChangesetOperation[])
        : [];
      if (operations.length === 0) {
        logger.warn?.("[orgx] Dropping invalid changeset outbox event", {
          eventId: event.id,
        });
        return;
      }

      // Status updates are the most common offline replay payload, and `updateEntity`
      // is the most widely supported primitive across OrgX deployments. Prefer it
      // when the changeset contains only simple status mutations.
      const statusOps = operations
        .map((op) => {
          if (!op || typeof op !== "object") return null;
          const record = op as Record<string, unknown>;
          const kind = typeof record.op === "string" ? record.op.trim() : "";
          if (kind === "task.update") {
            const taskId = typeof record.task_id === "string" ? record.task_id.trim() : "";
            const statusRaw = typeof record.status === "string" ? record.status.trim() : "";
            const normalized = statusRaw.toLowerCase().replace(/\s+/g, "_");
            const status =
              normalized === "completed" || normalized === "complete" || normalized === "finished"
                ? "done"
                : normalized === "inprogress"
                  ? "in_progress"
                  : normalized;
            if (!taskId || !status) return null;
            return { type: "task" as const, id: taskId, status };
          }
          if (kind === "milestone.update") {
            const milestoneId =
              typeof record.milestone_id === "string" ? record.milestone_id.trim() : "";
            const statusRaw = typeof record.status === "string" ? record.status.trim() : "";
            const normalized = statusRaw.toLowerCase().replace(/\s+/g, "_");
            const status =
              normalized === "done" || normalized === "complete" || normalized === "finished"
                ? "completed"
                : normalized === "inprogress"
                  ? "in_progress"
                  : normalized === "todo" || normalized === "not_started" || normalized === "pending"
                    ? "planned"
                    : normalized === "blocked" || normalized === "stuck"
                      ? "at_risk"
                      : normalized;
            if (!milestoneId || !status) return null;
            return { type: "milestone" as const, id: milestoneId, status };
          }
          return null;
        })
        .filter((item): item is { type: "task" | "milestone"; id: string; status: string } =>
          Boolean(item)
        );

      if (statusOps.length === operations.length) {
        for (const op of statusOps) {
          await client.updateEntity(op.type, op.id, { status: op.status });
        }
        return;
      }

      // Payloads should include a stable idempotency_key when enqueued, but older
      // events may not. Derive a deterministic fallback so outbox replay won't
      // double-create the same remote change.
      const fallbackKey = stableHash(
        JSON.stringify({
          t: "changeset",
          initiative_id: context.value.initiativeId,
          run_id: context.value.runId ?? null,
          correlation_id: context.value.correlationId ?? null,
          operations,
        })
      ).slice(0, 24);

      const resolvedIdempotencyKey =
        pickStringField(payload, "idempotency_key") ??
        pickStringField(payload, "idempotencyKey") ??
        `openclaw:changeset:${fallbackKey}`;

      await client.applyChangeset({
        initiative_id: context.value.initiativeId,
        run_id: runFields.run_id,
        correlation_id: runFields.correlation_id,
        source_client: context.value.sourceClient,
        idempotency_key: resolvedIdempotencyKey,
        operations,
      });
      return;
    }

    if (event.type === "outcome") {
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const runFields = normalizeRunFields({
        runId: context.value.runId,
        correlationId: context.value.correlationId,
      });

      const executionId =
        pickStringField(payload, "execution_id") ??
        pickStringField(payload, "executionId");
      const executionType =
        pickStringField(payload, "execution_type") ??
        pickStringField(payload, "executionType");
      const agentId =
        pickStringField(payload, "agent_id") ??
        pickStringField(payload, "agentId");
      const success =
        typeof (payload as Record<string, unknown>).success === "boolean"
          ? ((payload as Record<string, unknown>).success as boolean)
          : null;

      if (!executionId || !executionType || !agentId || success === null) {
        logger.warn?.("[orgx] Dropping invalid outcome outbox event", {
          eventId: event.id,
        });
        return;
      }

      const metaRaw = payload.metadata;
      const meta =
        metaRaw && typeof metaRaw === "object" && !Array.isArray(metaRaw)
          ? (metaRaw as Record<string, unknown>)
          : {};

      await client.recordRunOutcome({
        initiative_id: context.value.initiativeId,
        run_id: runFields.run_id,
        correlation_id: runFields.correlation_id,
        source_client: context.value.sourceClient,
        execution_id: executionId,
        execution_type: executionType,
        agent_id: agentId,
        task_type:
          pickStringField(payload, "task_type") ??
          pickStringField(payload, "taskType") ??
          undefined,
        domain: pickStringField(payload, "domain") ?? undefined,
        started_at:
          pickStringField(payload, "started_at") ??
          pickStringField(payload, "startedAt") ??
          undefined,
        completed_at:
          pickStringField(payload, "completed_at") ??
          pickStringField(payload, "completedAt") ??
          undefined,
        inputs:
          payload.inputs && typeof payload.inputs === "object"
            ? (payload.inputs as Record<string, unknown>)
            : undefined,
        outputs:
          payload.outputs && typeof payload.outputs === "object"
            ? (payload.outputs as Record<string, unknown>)
            : undefined,
        steps: Array.isArray(payload.steps)
          ? (payload.steps as Array<Record<string, unknown>>)
          : undefined,
        success,
        quality_score:
          typeof payload.quality_score === "number"
            ? payload.quality_score
            : typeof (payload as any).qualityScore === "number"
              ? (payload as any).qualityScore
              : undefined,
        duration_vs_estimate:
          typeof payload.duration_vs_estimate === "number"
            ? payload.duration_vs_estimate
            : typeof (payload as any).durationVsEstimate === "number"
              ? (payload as any).durationVsEstimate
              : undefined,
        cost_vs_budget:
          typeof payload.cost_vs_budget === "number"
            ? payload.cost_vs_budget
            : typeof (payload as any).costVsBudget === "number"
              ? (payload as any).costVsBudget
              : undefined,
        human_interventions:
          typeof payload.human_interventions === "number"
            ? payload.human_interventions
            : typeof (payload as any).humanInterventions === "number"
              ? (payload as any).humanInterventions
              : undefined,
        user_satisfaction:
          typeof payload.user_satisfaction === "number"
            ? payload.user_satisfaction
            : typeof (payload as any).userSatisfaction === "number"
              ? (payload as any).userSatisfaction
              : undefined,
        errors: Array.isArray(payload.errors)
          ? (payload.errors as unknown[]).filter((e): e is string => typeof e === "string")
          : undefined,
        metadata: {
          ...meta,
          source: "orgx_openclaw_outbox_replay",
          outbox_event_id: event.id,
        },
      });
      return;
    }

    if (event.type === "retro") {
      const context = resolveReportingContext(payload as ReportingContextInput);
      if (!context.ok) {
        throw new Error(context.error);
      }
      const runFields = normalizeRunFields({
        runId: context.value.runId,
        correlationId: context.value.correlationId,
      });

      const normalizedRetro = normalizeRetro(payload);
      if (!normalizedRetro) {
        logger.warn?.("[orgx] Dropping invalid retro outbox event", {
          eventId: event.id,
        });
        return;
      }

      const entityTypeRaw =
        pickStringField(payload, "entity_type") ??
        pickStringField(payload, "entityType");
      const parsedEntityType = parseRetroEntityType(entityTypeRaw) ?? null;
      // Server-side enum parity can lag behind local clients. Only attach to the
      // entity types that are guaranteed to exist today.
      const entityType =
        parsedEntityType === "initiative" || parsedEntityType === "task"
          ? parsedEntityType
          : null;

      const entityIdRaw =
        pickStringField(payload, "entity_id") ??
        pickStringField(payload, "entityId") ??
        null;
      const entityId = isUuid(entityIdRaw ?? undefined) ? entityIdRaw : null;

      await client.recordRunRetro({
        initiative_id: context.value.initiativeId,
        run_id: runFields.run_id,
        correlation_id: runFields.correlation_id,
        source_client: context.value.sourceClient,
        entity_type: entityType && entityId ? entityType : undefined,
        entity_id: entityType && entityId ? entityId : undefined,
        title: pickStringField(payload, "title") ?? undefined,
        idempotency_key:
          pickStringField(payload, "idempotency_key") ??
          pickStringField(payload, "idempotencyKey") ??
          undefined,
        retro: normalizedRetro as any,
        markdown: pickStringField(payload, "markdown") ?? undefined,
      });
      return;
    }

    if (event.type === "artifact") {
      // Artifacts are first-class UX loop closure (activity stream + entity modals).
      // Try to persist upstream; if this fails, keep the event queued for retry.
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};

      const name = pickStringField(payload, "name") ?? pickStringField(payload, "title") ?? "";
      const artifactType = pickStringField(payload, "artifact_type") ?? "other";
      const entityType = pickStringField(payload, "entity_type") ?? "";
      const entityId = pickStringField(payload, "entity_id") ?? "";
      const artifactId = pickStringField(payload, "artifact_id") ?? null;
      const description = pickStringField(payload, "description") ?? undefined;
      const externalUrl = pickStringField(payload, "url") ?? pickStringField(payload, "artifact_url") ?? null;
      const content = pickStringField(payload, "content") ?? pickStringField(payload, "preview_markdown") ?? null;
      const confidenceRaw = payload.confidence_score;
      const confidenceScore =
        typeof confidenceRaw === "number" &&
        Number.isFinite(confidenceRaw) &&
        confidenceRaw >= 0 &&
        confidenceRaw <= 1
          ? confidenceRaw
          : null;

      const allowedEntityType =
        entityType === "initiative" ||
        entityType === "milestone" ||
        entityType === "task" ||
        entityType === "decision" ||
        entityType === "project"
          ? (entityType as any)
          : null;

      if (!allowedEntityType || !entityId.trim() || !name.trim()) {
        logger.warn?.("[orgx] Dropping invalid artifact outbox event", {
          eventId: event.id,
          entityType,
          entityId,
        });
        return;
      }

      const result = await registerArtifact(client as any, client.getBaseUrl(), {
        artifact_id: artifactId,
        entity_type: allowedEntityType,
        entity_id: entityId,
        name: name.trim(),
        artifact_type: artifactType.trim() || "other",
        confidence_score: confidenceScore,
        description,
        external_url: externalUrl,
        preview_markdown: content,
        status: "draft",
        metadata: {
          source: "outbox_replay",
          outbox_event_id: event.id,
          confidence_score: confidenceScore,
          ...(payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : {}),
        },
        validate_persistence: process.env.ORGX_VALIDATE_ARTIFACT_PERSISTENCE === "1",
      });

      if (!result.ok) {
        throw new Error(result.persistence.last_error ?? "artifact registration failed");
      }

      return;
    }
  }

  async function flushOutboxQueues(): Promise<void> {
    const attemptAt = new Date().toISOString();
    deps.writeOutboxReplayState({
      ...deps.readOutboxReplayState(),
      status: "running",
      lastReplayAttemptAt: attemptAt,
      lastReplayError: null,
    });

    let hadReplayFailure = false;
    let lastReplayError: string | null = null;

    // Outbox files are keyed by *session id* (e.g. initiative/run correlation),
    // not by event type.
    const outboxSummary = await readOutboxSummary();
    const queues = Object.entries(outboxSummary.pendingByQueue)
      .filter(([, count]) => typeof count === "number" && count > 0)
      .map(([queueId]) => queueId)
      .sort();

    for (const queue of queues) {
      const pending = await readOutbox(queue);
      if (pending.length === 0) {
        continue;
      }

      const remaining: OutboxEvent[] = [];
      for (const event of pending) {
        try {
          await replayOutboxEvent(event);
        } catch (err: unknown) {
          hadReplayFailure = true;
          lastReplayError = toErrorMessage(err);
          remaining.push(event);
          logger.warn?.("[orgx] Outbox replay failed", {
            queue,
            eventId: event.id,
            error: lastReplayError,
          });
        }
      }

      await replaceOutbox(queue, remaining);

      const replayedCount = pending.length - remaining.length;
      if (replayedCount > 0) {
        logger.info?.("[orgx] Replayed buffered outbox events", {
          queue,
          replayed: replayedCount,
          remaining: remaining.length,
        });
      }
    }

    if (hadReplayFailure) {
      deps.writeOutboxReplayState({
        ...deps.readOutboxReplayState(),
        status: "error",
        lastReplayFailureAt: new Date().toISOString(),
        lastReplayError,
      });
    } else {
      deps.writeOutboxReplayState({
        ...deps.readOutboxReplayState(),
        status: "success",
        lastReplaySuccessAt: new Date().toISOString(),
        lastReplayError: null,
      });
    }
  }

  return {
    replayOutboxEvent,
    flushOutboxQueues,
  };
}
