import { appendToOutbox } from "../../outbox.js";
import {
  computeMilestoneRollup,
  computeWorkstreamRollup,
} from "../../reporting/rollups.js";
import { readSkillPackState } from "../../skill-pack-state.js";
import type { OrgXClient } from "../../api.js";
import type { DecisionActionType } from "../../contracts/shared-types.js";
import { normalizeDecisionActionType } from "../../contracts/shared-types.js";
import type { LiveActivityItem } from "../../types.js";
import {
  buildMissionControlGraph,
  deriveExecutionPolicy,
  inferExecutionDomainFromText,
  normalizeExecutionDomain,
  ORGX_SKILL_BY_DOMAIN,
  spawnGuardIsRateLimited,
  summarizeSpawnGuardBlockReason,
} from "./mission-control.js";

type ActivityBucket = "message" | "artifact" | "decision";

type DispatchLifecycleDeps = {
  client: OrgXClient;
  pluginVersion: string | undefined;
  randomUUID: () => string;
  safeErrorMessage: (err: unknown) => string;
  stableHash: (value: string) => string;
  idempotencyKey: (parts: Array<string | null | undefined>) => string;
  pickString: (record: Record<string, unknown>, keys: string[]) => string | null;
  deriveStructuredActivityBucket: (input: {
    phase: "intent" | "execution" | "blocked" | "review" | "handoff" | "completed";
    metadata?: Record<string, unknown>;
    explicitBucket?: ActivityBucket | null;
  }) => ActivityBucket;
};

export function createDispatchLifecycle(deps: DispatchLifecycleDeps) {
  const decisionV2Enabled =
    String(process.env.DECISION_V2_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const decisionDedupeEnabled =
    String(process.env.DECISION_DEDUPE_ENABLED ?? "true").trim().toLowerCase() !== "false";
  const decisionEvidenceRequiredForBlocking =
    String(process.env.DECISION_EVIDENCE_REQUIRED_FOR_BLOCKING ?? "false")
      .trim()
      .toLowerCase() === "true";

  type DecisionRequestResult = {
    queued: boolean;
    decisionIds: string[];
  };

  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  };

  const extractDecisionIdsFromChangesetResults = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    const seen = new Set<string>();

    const pushId = (candidate: unknown) => {
      if (typeof candidate !== "string") return;
      const id = candidate.trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };

    for (const entry of value) {
      const record = asRecord(entry);
      if (!record) continue;

      pushId(record.decision_id);
      pushId(record.decisionId);

      const directDecision = asRecord(record.decision);
      if (directDecision) {
        pushId(directDecision.id);
        pushId(directDecision.decision_id);
        pushId(directDecision.decisionId);
      }

      const entityType =
        (typeof record.entity_type === "string" ? record.entity_type : null) ??
        (typeof record.entityType === "string" ? record.entityType : null);
      if (entityType && entityType.trim().toLowerCase() === "decision") {
        pushId(record.entity_id);
        pushId(record.entityId);
        pushId(record.id);
      }

      const created = asRecord(record.created);
      if (created) {
        const createdType =
          (typeof created.entity_type === "string" ? created.entity_type : null) ??
          (typeof created.entityType === "string" ? created.entityType : null);
        if (createdType && createdType.trim().toLowerCase() === "decision") {
          pushId(created.entity_id);
          pushId(created.entityId);
          pushId(created.id);
        }
      }
    }

    return ids;
  };

  function withProvenanceMetadata(metadata?: Record<string, unknown>): Record<string, unknown> | undefined {
    const input = metadata ?? {};
    const out: Record<string, unknown> = { ...input };

    if (out.orgx_plugin_version === undefined) {
      out.orgx_plugin_version = (deps.pluginVersion ?? "").trim() || null;
    }

    try {
      const state = readSkillPackState();
      const overrides = state.overrides;

      if (out.skill_pack_name === undefined) {
        out.skill_pack_name = overrides?.name ?? state.pack?.name ?? null;
      }
      if (out.skill_pack_version === undefined) {
        out.skill_pack_version = overrides?.version ?? state.pack?.version ?? null;
      }
      if (out.skill_pack_checksum === undefined) {
        out.skill_pack_checksum = overrides?.checksum ?? state.pack?.checksum ?? null;
      }
      if (out.skill_pack_source === undefined) {
        out.skill_pack_source = overrides?.source ?? null;
      }
      if (out.skill_pack_etag === undefined) {
        out.skill_pack_etag = state.etag ?? null;
      }
      if (out.skill_pack_policy_frozen === undefined) {
        out.skill_pack_policy_frozen = Boolean(state.policy?.frozen);
      }
      if (out.skill_pack_policy_pinned_checksum === undefined) {
        out.skill_pack_policy_pinned_checksum = state.policy?.pinnedChecksum ?? null;
      }
    } catch {
      // best effort
    }

    if (out.orgx_provenance === undefined) {
      out.orgx_provenance = {
        plugin_version: out.orgx_plugin_version ?? null,
        skill_pack: {
          name: out.skill_pack_name ?? null,
          version: out.skill_pack_version ?? null,
          checksum: out.skill_pack_checksum ?? null,
          source: out.skill_pack_source ?? null,
          etag: out.skill_pack_etag ?? null,
        },
        policy: {
          frozen: out.skill_pack_policy_frozen ?? null,
          pinned_checksum: out.skill_pack_policy_pinned_checksum ?? null,
        },
      };
    }

    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function emitActivitySafe(input: {
    initiativeId: string | null;
    runId?: string | null;
    correlationId?: string | null;
    phase: "intent" | "execution" | "blocked" | "review" | "handoff" | "completed";
    message: string;
    level?: "info" | "warn" | "error";
    progressPct?: number;
    nextStep?: string;
    activityBucket?: ActivityBucket | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const initiativeId = input.initiativeId?.trim() ?? "";
    if (!initiativeId) return;
    const message = input.message.trim();
    if (!message) return;
    const normalizedRunId = input.runId?.trim() || null;
    const normalizedCorrelationId =
      normalizedRunId ? null : (input.correlationId?.trim() || `openclaw-${Date.now()}`);
    const canonicalMetadata: Record<string, unknown> = {
      initiative_id: initiativeId,
      run_id: normalizedRunId,
      slice_run_id: normalizedRunId,
      correlation_id: normalizedCorrelationId,
    };

    const metadataWithProvenance = withProvenanceMetadata(input.metadata);
    const activityBucket = deps.deriveStructuredActivityBucket({
      phase: input.phase,
      metadata: metadataWithProvenance,
      explicitBucket: input.activityBucket ?? null,
    });
    const enrichedMetadata: Record<string, unknown> = {
      ...(metadataWithProvenance ?? {}),
      ...canonicalMetadata,
      activity_bucket: activityBucket,
    };

    try {
      await deps.client.emitActivity({
        initiative_id: initiativeId,
        run_id: normalizedRunId ?? undefined,
        correlation_id: normalizedCorrelationId ?? undefined,
        source_client: "openclaw",
        message,
        phase: input.phase,
        progress_pct:
          typeof input.progressPct === "number" && Number.isFinite(input.progressPct)
            ? Math.max(0, Math.min(100, Math.round(input.progressPct)))
            : undefined,
        level: input.level,
        next_step: input.nextStep,
        metadata: enrichedMetadata,
      });
    } catch (err: unknown) {
      const msg = deps.safeErrorMessage(err);
      const runId = normalizedRunId ?? "";

      // If OrgX rejects an unknown run_id, retry by treating the local run_id as a
      // correlation key (non-UUID) so OrgX can create/attach a run deterministically.
      if (runId && /^404\b/.test(msg) && /\brun\b/i.test(msg) && /not found/i.test(msg)) {
        const retryCorrelationId = `openclaw_run_${deps.stableHash(runId).slice(0, 24)}`;
        try {
          await deps.client.emitActivity({
            initiative_id: initiativeId,
            run_id: undefined,
            correlation_id: retryCorrelationId,
            source_client: "openclaw",
            message,
            phase: input.phase,
            progress_pct:
              typeof input.progressPct === "number" && Number.isFinite(input.progressPct)
                ? Math.max(0, Math.min(100, Math.round(input.progressPct)))
                : undefined,
            level: input.level,
            next_step: input.nextStep,
            metadata: {
              ...(enrichedMetadata ?? {}),
              replay_run_id_as_correlation: true,
            },
          });
          return;
        } catch {
          // Fall through to local outbox.
        }
      }

      // Fall back to local outbox so activity is still visible in Mission Control/Activity.
      try {
        const timestamp = new Date().toISOString();
        const runId = normalizedRunId || normalizedCorrelationId || null;
        const activityItem: LiveActivityItem = {
          id: deps.randomUUID(),
          type:
            input.phase === "completed"
              ? "run_completed"
              : input.phase === "blocked"
                ? "run_failed"
                : "run_started",
          title: message,
          description: input.nextStep ?? null,
          agentId:
            (typeof metadataWithProvenance?.agent_id === "string"
              ? metadataWithProvenance.agent_id
              : null) ?? null,
          agentName:
            (typeof metadataWithProvenance?.agent_name === "string"
              ? metadataWithProvenance.agent_name
              : null) ?? null,
          requesterAgentId: null,
          requesterAgentName: null,
          executorAgentId:
            (typeof metadataWithProvenance?.agent_id === "string"
              ? metadataWithProvenance.agent_id
              : null) ?? null,
          executorAgentName:
            (typeof metadataWithProvenance?.agent_name === "string"
              ? metadataWithProvenance.agent_name
              : null) ?? null,
          runId,
          initiativeId,
          timestamp,
          phase: input.phase,
          summary: message,
          kind: activityBucket,
          metadata: {
            ...(enrichedMetadata ?? {}),
            source: "openclaw_local_fallback",
          },
        };
        await appendToOutbox(initiativeId, {
          id: deps.randomUUID(),
          type: "progress",
          timestamp,
          payload: {
            initiative_id: initiativeId,
            run_id: normalizedRunId ?? undefined,
            correlation_id: normalizedCorrelationId ?? undefined,
            source_client: "openclaw",
            message,
            phase: input.phase,
            progress_pct:
              typeof input.progressPct === "number" && Number.isFinite(input.progressPct)
                ? Math.max(0, Math.min(100, Math.round(input.progressPct)))
                : undefined,
            level: input.level ?? "info",
            next_step: input.nextStep ?? undefined,
            metadata: enrichedMetadata,
          },
          activityItem,
        });
      } catch {
        // best effort
      }
    }
  }

  async function requestDecisionSafe(input: {
    initiativeId: string | null;
    correlationId?: string | null;
    title: string;
    summary?: string | null;
    urgency?: "low" | "medium" | "high" | "urgent";
    options?: Array<string | Record<string, unknown>>;
    blocking?: boolean;
    decisionType?: string | null;
    workstreamId?: string | null;
    agentId?: string | null;
    dueAt?: string | null;
    sourceSystem?: string | null;
    conflictSource?: string | null;
    dedupeKey?: string | null;
    recommendedAction?: string | null;
    sourceRunId?: string | null;
    sourceSessionId?: string | null;
    sourceStreamId?: string | null;
    sourceRef?: Record<string, unknown> | null;
    evidenceRefs?: Array<Record<string, unknown>> | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<DecisionRequestResult> {
    const initiativeId = input.initiativeId?.trim() ?? "";
    const title = input.title.trim();
    if (!initiativeId || !title) {
      return { queued: false, decisionIds: [] };
    }

    type DecisionOptionPayload = {
      id?: string;
      label: string;
      description?: string;
      implied_status?: "approved" | "declined" | "cancelled" | "rejected";
      action_type?: DecisionActionType;
      requires_note?: boolean;
    };
    const normalizedOptions: Array<string | DecisionOptionPayload> = [];
    for (const entry of Array.isArray(input.options) ? input.options : []) {
      if (typeof entry === "string") {
        const label = entry.trim();
        if (label.length > 0) normalizedOptions.push(label);
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const label = typeof record.label === "string" ? record.label.trim() : "";
      if (!label) continue;
      const optionPayload: DecisionOptionPayload = {
        label,
      };
      if (typeof record.id === "string" && record.id.trim()) {
        optionPayload.id = record.id.trim();
      }
      if (typeof record.description === "string" && record.description.trim()) {
        optionPayload.description = record.description.trim();
      }
      if (typeof record.implied_status === "string" && record.implied_status.trim()) {
        const implied = record.implied_status.trim().toLowerCase();
        if (
          implied === "approved" ||
          implied === "declined" ||
          implied === "cancelled" ||
          implied === "rejected"
        ) {
          optionPayload.implied_status = implied;
        }
      }
      const normalizedActionType = normalizeDecisionActionType(
        record.action_type ?? record.type ?? record.verb ?? record.action
      );
      if (normalizedActionType) {
        optionPayload.action_type = normalizedActionType;
      }
      if (record.requires_note === true) {
        optionPayload.requires_note = true;
      }
      normalizedOptions.push(optionPayload);
    }

    const normalizedEvidenceRefs = (Array.isArray(input.evidenceRefs) ? input.evidenceRefs : [])
      .map((entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const asUuid = (value: string | null | undefined): string | undefined => {
      const normalized = value?.trim() ?? "";
      return uuidPattern.test(normalized) ? normalized : undefined;
    };
    const asIsoDateTime = (value: string | null | undefined): string | undefined => {
      const normalized = value?.trim() ?? "";
      if (!normalized) return undefined;
      const epoch = Date.parse(normalized);
      if (!Number.isFinite(epoch)) return undefined;
      return new Date(epoch).toISOString();
    };

    const sourceRef =
      input.sourceRef && typeof input.sourceRef === "object" && !Array.isArray(input.sourceRef)
        ? input.sourceRef
        : null;
    const metadata =
      input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
        ? input.metadata
        : null;

    const dedupeKey =
      input.dedupeKey?.trim() ||
      `decision:${deps.stableHash(
        [
          initiativeId,
          input.workstreamId?.trim() || "none",
          input.conflictSource?.trim() || "general",
          title.toLowerCase(),
        ].join("|")
      ).slice(0, 24)}`;

    const blocking = input.blocking ?? true;
    const fallbackEvidenceRefs =
      blocking && decisionEvidenceRequiredForBlocking && normalizedEvidenceRefs.length === 0
        ? [
            {
              evidence_type: "decision_context",
              title: "Decision context",
              summary:
                input.summary?.trim() ||
                "Blocking decision emitted without explicit evidence payload.",
              payload: {
                source_ref: sourceRef ?? null,
                generated_by: "plugin_guardrail",
              },
            },
          ]
        : [];
    const effectiveEvidenceRefs = [...normalizedEvidenceRefs, ...fallbackEvidenceRefs];
    const operation = {
      op: "decision.create" as const,
      title,
      summary: input.summary ?? undefined,
      urgency: input.urgency ?? "high",
      options: normalizedOptions,
      blocking,
      ...(decisionV2Enabled
        ? {
            decision_type: input.decisionType?.trim() || undefined,
            workstream_id: asUuid(input.workstreamId),
            agent_id: asUuid(input.agentId),
            due_at: asIsoDateTime(input.dueAt),
            source_system: input.sourceSystem?.trim() || "openclaw",
            conflict_source: input.conflictSource?.trim() || undefined,
            dedupe_key: decisionDedupeEnabled ? dedupeKey : undefined,
            recommended_action: input.recommendedAction?.trim() || undefined,
            source_run_id: asUuid(input.sourceRunId),
            source_session_id: input.sourceSessionId?.trim() || undefined,
            source_stream_id: asUuid(input.sourceStreamId),
            source_ref: sourceRef ?? undefined,
            evidence_refs:
              effectiveEvidenceRefs.length > 0 ? effectiveEvidenceRefs : undefined,
            metadata: metadata ?? undefined,
          }
        : {}),
    };

    try {
      const response = await deps.client.applyChangeset({
        initiative_id: initiativeId,
        correlation_id: input.correlationId?.trim() || undefined,
        source_client: "openclaw",
        idempotency_key: deps.idempotencyKey([
          "openclaw",
          "decision",
          initiativeId,
          dedupeKey,
          title,
          input.correlationId ?? null,
        ]),
        operations: [operation],
      });
      return {
        queued: true,
        decisionIds: extractDecisionIdsFromChangesetResults(response?.results),
      };
    } catch (err: unknown) {
      const timestamp = new Date().toISOString();
      const correlationId = input.correlationId?.trim() || undefined;
      const operations = [operation];

      const activityItem: LiveActivityItem = {
        id: deps.randomUUID(),
        type: "decision_requested",
        title,
        description: input.summary ?? null,
        agentId: null,
        agentName: null,
        requesterAgentId: null,
        requesterAgentName: null,
        executorAgentId: null,
        executorAgentName: null,
        runId: correlationId ?? null,
        initiativeId,
        timestamp,
        phase: "review",
        summary: input.summary ?? null,
        metadata: {
          source: "openclaw_local_fallback",
          event: "decision_buffered",
          urgency: input.urgency ?? "high",
          blocking: input.blocking ?? true,
          options: normalizedOptions,
          dedupe_key: decisionDedupeEnabled ? dedupeKey : null,
          decision_type: decisionV2Enabled
            ? input.decisionType?.trim() || null
            : null,
          conflict_source: decisionV2Enabled
            ? input.conflictSource?.trim() || null
            : null,
          source_system: decisionV2Enabled
            ? input.sourceSystem?.trim() || "openclaw"
            : "openclaw",
          error: deps.safeErrorMessage(err),
        },
      };

      try {
        await appendToOutbox(initiativeId, {
          id: deps.randomUUID(),
          type: "changeset",
          timestamp,
          payload: {
            initiative_id: initiativeId,
            correlation_id: correlationId,
            source_client: "openclaw",
            idempotency_key: deps.idempotencyKey([
              "openclaw",
              "decision",
              initiativeId,
              dedupeKey,
              title,
              input.correlationId ?? null,
              "outbox",
            ]),
            operations,
          },
          activityItem,
        });
        return { queued: true, decisionIds: [] };
      } catch {
        return { queued: false, decisionIds: [] };
      }
    }
  }

  async function checkSpawnGuardSafe(input: {
    domain: string;
    taskId?: string | null;
    initiativeId: string | null;
    correlationId: string;
    runId?: string | null;
    targetLabel?: string | null;
  }): Promise<unknown | null> {
    const bypassRaw = (process.env.ORGX_SPAWN_GUARD_BYPASS ?? "").trim().toLowerCase();
    const modeRaw = (process.env.ORGX_SPAWN_GUARD_MODE ?? "").trim().toLowerCase();
    const bypass =
      (bypassRaw && bypassRaw !== "0" && bypassRaw !== "false" && bypassRaw !== "no") ||
      modeRaw === "off" ||
      modeRaw === "bypass";
    if (bypass) return null;

    const scopedClient = deps.client as OrgXClient & {
      checkSpawnGuard?: (domain: string, taskId?: string) => Promise<unknown>;
    };
    if (typeof scopedClient.checkSpawnGuard !== "function") {
      return null;
    }

    const taskId = input.taskId?.trim() ?? "";
    const targetLabel =
      input.targetLabel?.trim() ||
      (taskId ? `task ${taskId}` : "dispatch target");

    try {
      return await scopedClient.checkSpawnGuard(
        input.domain,
        taskId || undefined
      );
    } catch (err: unknown) {
      await emitActivitySafe({
        initiativeId: input.initiativeId,
        runId: input.runId ?? null,
        correlationId: input.correlationId,
        phase: "blocked",
        level: "warn",
        message: `Spawn guard check degraded for ${targetLabel}; continuing with local policy.`,
        metadata: {
          event: "spawn_guard_degraded",
          task_id: taskId || null,
          domain: input.domain,
          error: deps.safeErrorMessage(err),
        },
      });
      return null;
    }
  }

  function extractSpawnGuardModelTier(result: unknown): string | null {
    if (!result || typeof result !== "object") return null;
    return (
      deps.pickString(result as Record<string, unknown>, ["modelTier", "model_tier"]) ??
      null
    );
  }

  function formatRequiredSkills(requiredSkills: string[]): string {
    const normalized = requiredSkills
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => (entry.startsWith("$") ? entry : `$${entry}`));
    return normalized.length > 0
      ? normalized.join(", ")
      : "$orgx-engineering-agent";
  }

  function buildPolicyEnforcedMessage(input: {
    baseMessage: string;
    executionPolicy: { domain: string; requiredSkills: string[] };
    spawnGuardResult?: unknown | null;
  }): string {
    const modelTier = extractSpawnGuardModelTier(input.spawnGuardResult ?? null);
    return [
      `Execution policy: ${input.executionPolicy.domain}`,
      `Required skills: ${formatRequiredSkills(input.executionPolicy.requiredSkills)}`,
      modelTier ? `Spawn guard model tier: ${modelTier}` : null,
      "",
      input.baseMessage,
    ]
      .filter((entry): entry is string => Boolean(entry))
      .join("\n");
  }

  async function resolveDispatchExecutionPolicy(input: {
    initiativeId: string | null;
    initiativeTitle?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
    message?: string | null;
  }): Promise<{
    executionPolicy: { domain: string; requiredSkills: string[] };
    taskTitle: string | null;
    workstreamTitle: string | null;
  }> {
    const initiativeId = input.initiativeId?.trim() ?? "";
    const taskId = input.taskId?.trim() ?? "";
    const workstreamId = input.workstreamId?.trim() ?? "";
    let resolvedTaskTitle = input.taskTitle?.trim() || null;
    let resolvedWorkstreamTitle = input.workstreamTitle?.trim() || null;

    if (initiativeId && (taskId || workstreamId)) {
      try {
        const graph = await buildMissionControlGraph(deps.client, initiativeId);
        const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
        const taskNode = taskId ? nodeById.get(taskId) ?? null : null;
        const workstreamNode = workstreamId ? nodeById.get(workstreamId) ?? null : null;

        if (taskNode && taskNode.type === "task") {
          resolvedTaskTitle = resolvedTaskTitle ?? taskNode.title;
          const relatedWorkstream =
            (taskNode.workstreamId ? nodeById.get(taskNode.workstreamId) ?? null : null) ??
            workstreamNode;
          const normalizedWorkstream =
            relatedWorkstream && relatedWorkstream.type === "workstream"
              ? relatedWorkstream
              : null;
          resolvedWorkstreamTitle =
            resolvedWorkstreamTitle ?? normalizedWorkstream?.title ?? null;
          return {
            executionPolicy: deriveExecutionPolicy(taskNode, normalizedWorkstream),
            taskTitle: resolvedTaskTitle,
            workstreamTitle: resolvedWorkstreamTitle,
          };
        }

        if (workstreamNode && workstreamNode.type === "workstream") {
          resolvedWorkstreamTitle = resolvedWorkstreamTitle ?? workstreamNode.title;
          const assignedDomain = workstreamNode.assignedAgents
            .map((agent) => normalizeExecutionDomain(agent.domain))
            .find((entry): entry is string => Boolean(entry));
          const domain =
            assignedDomain ??
            inferExecutionDomainFromText(
              workstreamNode.title,
              input.initiativeTitle,
              input.message
            );
          const normalizedDomain = normalizeExecutionDomain(domain) ?? "engineering";
          return {
            executionPolicy: {
              domain: normalizedDomain,
              requiredSkills: [
                ORGX_SKILL_BY_DOMAIN[normalizedDomain] ??
                  ORGX_SKILL_BY_DOMAIN.engineering,
              ],
            },
            taskTitle: resolvedTaskTitle,
            workstreamTitle: resolvedWorkstreamTitle,
          };
        }
      } catch {
        // best effort
      }
    }

    const inferredDomain =
      normalizeExecutionDomain(
        inferExecutionDomainFromText(
          resolvedTaskTitle,
          resolvedWorkstreamTitle,
          input.initiativeTitle,
          input.message
        )
      ) ?? "engineering";
    return {
      executionPolicy: {
        domain: inferredDomain,
        requiredSkills: [
          ORGX_SKILL_BY_DOMAIN[inferredDomain] ?? ORGX_SKILL_BY_DOMAIN.engineering,
        ],
      },
      taskTitle: resolvedTaskTitle,
      workstreamTitle: resolvedWorkstreamTitle,
    };
  }

  async function syncParentRollupsForTask(input: {
    initiativeId: string | null;
    taskId: string | null;
    workstreamId?: string | null;
    milestoneId?: string | null;
    correlationId?: string | null;
  }): Promise<void> {
    const initiativeId = input.initiativeId?.trim() ?? "";
    const taskId = input.taskId?.trim() ?? "";
    if (!initiativeId || !taskId) return;

    let tasks: Array<Record<string, unknown>> = [];
    try {
      const response = await deps.client.listEntities("task", {
        initiative_id: initiativeId,
        limit: 4000,
      });
      tasks = Array.isArray((response as any)?.data)
        ? ((response as any).data as Array<Record<string, unknown>>)
        : [];
    } catch {
      return;
    }

    const task = tasks.find((row) => String(row.id ?? "").trim() === taskId) ?? null;
    const resolvedMilestoneId =
      (input.milestoneId?.trim() || "") ||
      (task ? deps.pickString(task, ["milestone_id", "milestoneId"]) ?? "" : "");
    const resolvedWorkstreamId =
      (input.workstreamId?.trim() || "") ||
      (task ? deps.pickString(task, ["workstream_id", "workstreamId"]) ?? "" : "");

    if (resolvedMilestoneId) {
      const milestoneTaskStatuses = tasks
        .filter(
          (row) =>
            deps.pickString(row, ["milestone_id", "milestoneId"]) === resolvedMilestoneId
        )
        .map((row) => deps.pickString(row, ["status"]) ?? "todo");
      const rollup = computeMilestoneRollup(milestoneTaskStatuses);

      try {
        await deps.client.applyChangeset({
          initiative_id: initiativeId,
          correlation_id: input.correlationId?.trim() || undefined,
          source_client: "openclaw",
          idempotency_key: deps.idempotencyKey([
            "openclaw",
            "rollup",
            "milestone",
            resolvedMilestoneId,
            rollup.status,
            String(rollup.progressPct),
            String(rollup.done),
            String(rollup.total),
          ]),
          operations: [
            {
              op: "milestone.update",
              milestone_id: resolvedMilestoneId,
              status: rollup.status,
            },
          ],
        });
      } catch {
        // best effort
      }
    }

    if (resolvedWorkstreamId) {
      const workstreamTaskStatuses = tasks
        .filter(
          (row) =>
            deps.pickString(row, ["workstream_id", "workstreamId"]) === resolvedWorkstreamId
        )
        .map((row) => deps.pickString(row, ["status"]) ?? "todo");
      const rollup = computeWorkstreamRollup(workstreamTaskStatuses);

      try {
        await deps.client.updateEntity("workstream", resolvedWorkstreamId, {
          status: rollup.status,
        });
      } catch {
        // best effort
      }
    }
  }

  async function enforceSpawnGuardForDispatch(input: {
    sourceEventPrefix: string;
    initiativeId: string | null;
    correlationId: string;
    runId?: string | null;
    executionPolicy: { domain: string; requiredSkills: string[] };
    agentId?: string | null;
    taskId?: string | null;
    taskTitle?: string | null;
    workstreamId?: string | null;
    workstreamTitle?: string | null;
    milestoneId?: string | null;
  }): Promise<{
    allowed: boolean;
    retryable: boolean;
    blockedReason: string | null;
    spawnGuardResult: unknown | null;
  }> {
    const taskId = input.taskId?.trim() ?? "";
    const workstreamId = input.workstreamId?.trim() ?? "";
    const taskTitle = input.taskTitle?.trim() || null;
    const workstreamTitle = input.workstreamTitle?.trim() || null;
    const targetLabel = taskId
      ? `task ${taskTitle ?? taskId}`
      : workstreamId
        ? `workstream ${workstreamTitle ?? workstreamId}`
        : "dispatch target";

    const spawnGuardResult = await checkSpawnGuardSafe({
      domain: input.executionPolicy.domain,
      // Spawn guard is task-scoped. Passing a workstream ID causes noisy 404s
      // ("Task ... not found") and makes the UI feel perpetually degraded.
      taskId: taskId || null,
      initiativeId: input.initiativeId,
      correlationId: input.correlationId,
      runId: input.runId ?? null,
      targetLabel,
    });

    if (!spawnGuardResult || typeof spawnGuardResult !== "object") {
      return {
        allowed: true,
        retryable: false,
        blockedReason: null,
        spawnGuardResult,
      };
    }

    const allowed = (spawnGuardResult as Record<string, unknown>).allowed;
    if (allowed !== false) {
      return {
        allowed: true,
        retryable: false,
        blockedReason: null,
        spawnGuardResult,
      };
    }

    const blockedReason = summarizeSpawnGuardBlockReason(spawnGuardResult);
    const retryable = spawnGuardIsRateLimited(spawnGuardResult);
    const blockedEvent = retryable
      ? `${input.sourceEventPrefix}_spawn_guard_rate_limited`
      : `${input.sourceEventPrefix}_spawn_guard_blocked`;

    await emitActivitySafe({
      initiativeId: input.initiativeId,
      runId: input.runId ?? null,
      correlationId: input.correlationId,
      phase: "blocked",
      level: retryable ? "warn" : "error",
      message: retryable
        ? `Spawn guard rate-limited ${targetLabel}; deferring launch.`
        : `Spawn guard blocked ${targetLabel}.`,
      metadata: {
        event: blockedEvent,
        agent_id: input.agentId ?? null,
        task_id: taskId || null,
        task_title: taskTitle,
        workstream_id: workstreamId || null,
        workstream_title: workstreamTitle,
        domain: input.executionPolicy.domain,
        required_skills: input.executionPolicy.requiredSkills,
        blocked_reason: blockedReason,
        spawn_guard: spawnGuardResult,
      },
      nextStep: retryable
        ? "Retry dispatch when spawn rate limits recover."
        : "Review decision and unblock guard checks before retry.",
    });

    if (!retryable && input.initiativeId && taskId) {
      try {
        await deps.client.updateEntity("task", taskId, { status: "blocked" });
      } catch {
        // best effort
      }
      await syncParentRollupsForTask({
        initiativeId: input.initiativeId,
        taskId,
        workstreamId: workstreamId || null,
        milestoneId: input.milestoneId ?? null,
        correlationId: input.correlationId,
      });
    }

    if (!retryable) {
      await requestDecisionSafe({
        initiativeId: input.initiativeId,
        correlationId: input.correlationId,
        title: `Unblock ${targetLabel}`,
        summary: [
          `${targetLabel} failed spawn guard checks.`,
          `Reason: ${blockedReason}`,
          `Domain: ${input.executionPolicy.domain}`,
          `Required skills: ${input.executionPolicy.requiredSkills.join(", ")}`,
        ].join(" "),
        urgency: "high",
        options: [
          "Approve exception and continue",
          "Reassign task/domain",
          "Pause and investigate quality gate",
        ],
        blocking: true,
        decisionType: "spawn_guard_blocked",
        workstreamId: workstreamId || null,
        agentId: input.agentId ?? null,
        sourceSystem: "openclaw",
        conflictSource: "spawn_guard_blocked",
        dedupeKey: [
          "dispatch",
          input.initiativeId ?? "none",
          workstreamId || "none",
          taskId || "none",
          "spawn_guard_blocked",
        ].join(":"),
        recommendedAction:
          "Choose exception, reassignment, or pause before retrying dispatch.",
        sourceRunId: input.runId ?? null,
        sourceRef: {
          run_id: input.runId ?? null,
          correlation_id: input.correlationId,
          task_id: taskId || null,
          workstream_id: workstreamId || null,
          domain: input.executionPolicy.domain,
        },
        evidenceRefs: [
          {
            evidence_type: "spawn_guard_result",
            title: `Spawn guard blocked ${targetLabel}`,
            summary: blockedReason,
            payload: {
              spawn_guard: spawnGuardResult,
              required_skills: input.executionPolicy.requiredSkills,
            },
          },
        ],
      });
    }

    return {
      allowed: false,
      retryable,
      blockedReason,
      spawnGuardResult,
    };
  }

  return {
    withProvenanceMetadata,
    emitActivitySafe,
    requestDecisionSafe,
    checkSpawnGuardSafe,
    extractSpawnGuardModelTier,
    buildPolicyEnforcedMessage,
    resolveDispatchExecutionPolicy,
    enforceSpawnGuardForDispatch,
    syncParentRollupsForTask,
  };
}
