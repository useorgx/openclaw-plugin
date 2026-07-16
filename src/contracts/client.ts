/**
 * OrgX API Client
 *
 * Communicates with the OrgX server for org snapshots, memory sync,
 * quality gates, model routing, and entity CRUD.
 *
 * Uses native fetch — no external dependencies.
 */

import type {
  OrgSnapshot,
  SyncPayload,
  SyncResponse,
  SpawnGuardResult,
  QualityScore,
  Entity,
  EntityListFilters,
  EmitActivityRequest,
  EmitActivityResponse,
  EmitExecutionGraphRequest,
  EmitExecutionGraphResponse,
  ApplyChangesetRequest,
  ApplyChangesetResponse,
  RecordRunOutcomeRequest,
  RecordRunOutcomeResponse,
  RecordRunRetroRequest,
  RecordRunRetroResponse,
  LiveActivityItem,
  SessionTreeResponse,
  HandoffSummary,
  EntityUpdateResult,
  CheckpointSummary,
  RestoreRequest,
  DelegationPreflightResult,
  BillingStatus,
  BillingCheckoutRequest,
  BillingUrlResult,
  UsageControlPlaneSummary,
  KickoffContextRequest,
  KickoffContextResponse,
  SkillPack,
  SkillPackResponse,
  ClientRuntimeSettingsResponse,
  ClientRuntimeSettingsUpdateRequest,
  ModelTier,
} from "./types.js";
import type { CapacityRuntimeRecommendation } from "../runtime-capacity-routing.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const DEFAULT_LIVE_TIMEOUT_MS = 30_000;
const DEFAULT_SYNC_TIMEOUT_MS = 45_000;
const USER_AGENT = "OrgX-Clawdbot-Plugin/1.0";
const DECISION_MUTATION_CONCURRENCY = 6;
const DEFAULT_CLIENT_BASE_URL = "https://www.useorgx.com";
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

function normalizeAgentStatus(value: unknown): "active" | "idle" | "throttled" {
  if (value === "active" || value === "idle" || value === "throttled") {
    return value;
  }
  return "idle";
}

function isUserScopedApiKey(apiKey: string): boolean {
  return apiKey.trim().toLowerCase().startsWith("oxk_");
}

function parseTimeoutMsEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  // Keep it sane: timeouts below 1s tend to create pathological "offline" loops.
  return Math.max(1_000, Math.floor(parsed));
}

function resolveRequestTimeoutMs(path: string): number {
  const configured =
    parseTimeoutMsEnv("ORGX_HTTP_TIMEOUT_MS") ??
    parseTimeoutMsEnv("ORGX_API_TIMEOUT_MS");
  const base = configured ?? DEFAULT_REQUEST_TIMEOUT_MS;

  // Live endpoints frequently return larger payloads (sessions, activity, agents).
  if (path.startsWith("/api/client/live/")) {
    return Math.max(base, DEFAULT_LIVE_TIMEOUT_MS);
  }

  // Sync can include a full org snapshot and may take longer than typical CRUD.
  if (path === "/api/client/sync") {
    return Math.max(base, DEFAULT_SYNC_TIMEOUT_MS);
  }

  // Handoffs can require server-side aggregation.
  if (path === "/api/client/handoffs") {
    return Math.max(base, DEFAULT_LIVE_TIMEOUT_MS);
  }

  return base;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function normalizeClientBaseUrl(raw: string, fallback: string): string {
  const candidate = raw.trim();
  if (!candidate) return fallback;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return fallback;
    }
    if (parsed.username || parsed.password) {
      return fallback;
    }
    if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
      return fallback;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return fallback;
  }
}

function normalizeQualityScorePayload(
  score: QualityScore
): Omit<QualityScore, "domain" | "agentDomain"> & { agentDomain: string } {
  const legacyDomain =
    typeof score.domain === "string" ? score.domain.trim() : "";
  const explicitAgentDomain =
    typeof score.agentDomain === "string" ? score.agentDomain.trim() : "";
  const agentDomain = explicitAgentDomain || legacyDomain;

  if (!agentDomain) {
    throw new Error("Quality score requires domain or agentDomain");
  }

  const { domain: _domain, agentDomain: _agentDomain, ...rest } = score;
  return { ...rest, agentDomain };
}

type ClientToolExecutionResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
  tool_id?: string;
  execution_time_ms?: number;
};

export type DecisionAction = "approve" | "reject";
export type RunAction = "pause" | "resume" | "cancel" | "rollback";

export interface DecisionActionResult {
  id: string;
  ok: boolean;
  entity?: Entity;
  error?: string;
}

export interface DecisionMutationInput {
  note?: string;
  optionId?: string;
}

export type AttentionKind = "question" | "permission" | "approval" | "recovery";
export type AttentionContinuationState =
  | "answer_received"
  | "resuming"
  | "resumed"
  | "resume_failed"
  | "cancelled";

export interface AttentionRequestInput {
  initiative_id: string;
  attention_kind: AttentionKind;
  idempotency_key: string;
  question: string;
  source_tool: string;
  context?: string;
  impact_if_delayed?: string;
  options?: Array<string | { id?: string; label: string; description?: string }>;
  response_mode?: "single_select" | "multi_select" | "free_text" | "confirmation";
  recommended_option_id?: string;
  recommended_action?: string;
  blocking?: boolean;
  urgency?: "low" | "medium" | "high" | "urgent";
  workstream_id?: string;
  run_id?: string;
  correlation_id?: string;
  source_client?: string;
  source_session_id?: string;
  source_event_id?: string;
  continuation?: {
    strategy?: "reply_in_place" | "resume_session" | "followup_from_checkpoint" | "poll" | "none";
    session_handle?: string;
    thread_id?: string;
    turn_id?: string;
    tool_call_id?: string;
    checkpoint_id?: string;
    peer_id?: string;
    capability_version?: string;
  };
  source_ref?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface AttentionReceiptInput {
  state: AttentionContinuationState;
  idempotency_key: string;
  session_handle?: string;
  client_event_id?: string;
  detail?: string;
  occurred_at?: string;
  metadata?: Record<string, unknown>;
}

export class OrgXClient {
  private apiKey: string;
  private baseUrl: string;
  private fallbackBaseUrl: string | null;
  private userId: string;

  constructor(
    apiKey: string,
    baseUrl: string,
    userId?: string,
    fallbackBaseUrl?: string
  ) {
    this.apiKey = apiKey;
    this.baseUrl = normalizeClientBaseUrl(baseUrl, DEFAULT_CLIENT_BASE_URL);
    this.fallbackBaseUrl =
      typeof fallbackBaseUrl === "string" && fallbackBaseUrl.trim().length > 0
        ? normalizeClientBaseUrl(fallbackBaseUrl, "")
        : null;
    // Keep userId available even for oxk_ keys (it can be used as created_by_id for certain writes),
    // but only send it as a header for non-user-scoped keys.
    this.userId = userId || "";
  }

  setCredentials(input: {
    apiKey?: string;
    userId?: string;
    baseUrl?: string;
    apiFallbackUrl?: string;
    fallbackBaseUrl?: string;
  }) {
    if (typeof input.apiKey === "string") {
      this.apiKey = input.apiKey;
    }
    if (typeof input.userId === "string") {
      this.userId = input.userId;
    }
    if (typeof input.baseUrl === "string" && input.baseUrl.trim().length > 0) {
      this.baseUrl = normalizeClientBaseUrl(input.baseUrl, this.baseUrl);
    }
    const fallbackBaseUrl = input.apiFallbackUrl ?? input.fallbackBaseUrl;
    if (typeof fallbackBaseUrl === "string") {
      this.fallbackBaseUrl =
        fallbackBaseUrl.trim().length > 0
          ? normalizeClientBaseUrl(fallbackBaseUrl, "")
          : null;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getUserId(): string {
    return this.userId;
  }

  getFallbackBaseUrl(): string | null {
    return this.fallbackBaseUrl;
  }

  // ===========================================================================
  // HTTP helpers
  // ===========================================================================

  /**
   * Low-level authenticated request helper.
   *
   * This is intentionally part of the public surface so other codebases can
   * layer additional adapters/endpoints without re-implementing auth header
   * logic (and drifting from the canonical client contract).
   */
  async rawRequest<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    return this.request<T>(method, path, body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const timeoutMs = resolveRequestTimeoutMs(path);
    const baseUrls = [this.baseUrl, this.fallbackBaseUrl].filter(
      (value, index, values): value is string =>
        typeof value === "string" &&
        value.trim().length > 0 &&
        values.indexOf(value) === index
    );
    let lastRetryableError: Error | null = null;

    for (let index = 0; index < baseUrls.length; index += 1) {
      const baseUrl = baseUrls[index];
      const isLastAttempt = index === baseUrls.length - 1;
      const url = `${baseUrl}${path}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${this.apiKey}`,
      };
      if (this.userId && !isUserScopedApiKey(this.apiKey)) {
        headers["X-Orgx-User-Id"] = this.userId;
      }

      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          let detail = "";
          if (text) {
            try {
              const parsed = JSON.parse(text) as Record<string, unknown>;
              const msg = parsed.message ?? parsed.error;
              detail = typeof msg === "string" ? msg : text.slice(0, 200);
            } catch {
              detail = text.slice(0, 200);
            }
          }
          const message = `${response.status} ${response.statusText}${
            detail ? `: ${detail}` : ""
          }`;
          if (
            !isLastAttempt &&
            RETRYABLE_UPSTREAM_STATUSES.has(response.status)
          ) {
            lastRetryableError = new Error(message);
            continue;
          }
          throw new Error(message);
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          return (await response.json()) as T;
        }

        return (await response.text()) as unknown as T;
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          lastRetryableError = new Error(
            `OrgX API ${method} ${path} timed out after ${timeoutMs}ms`
          );
        } else if (err instanceof TypeError) {
          lastRetryableError = err;
        } else {
          throw err;
        }
        if (isLastAttempt) {
          throw lastRetryableError;
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastRetryableError ?? new Error(`OrgX API ${method} ${path} failed`);
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  private buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
    const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null);
    if (entries.length === 0) return "";
    const search = new URLSearchParams();
    for (const [key, value] of entries) {
      search.set(key, String(value));
    }
    return `?${search.toString()}`;
  }

  private unwrapSyncResponse(
    response: { ok?: boolean; data?: SyncResponse } | SyncResponse
  ): SyncResponse {
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return response.data;
    }
    return response as SyncResponse;
  }

  private async executeClientTool<T>(
    toolId: string,
    args: Record<string, unknown>
  ): Promise<T> {
    const response = await this.post<ClientToolExecutionResponse<T>>(
      "/api/client/tools/execute",
      {
        tool_id: toolId,
        args,
      }
    );

    if (!response.ok) {
      throw new Error(response.error || `Tool ${toolId} execution failed`);
    }

    return (response.data ?? {}) as T;
  }

  // ===========================================================================
  // Org Snapshot
  // ===========================================================================

  async getOrgSnapshot(): Promise<OrgSnapshot> {
    // Use the sync endpoint with POST (empty body = pull only)
    const resp = await this.post<{ ok?: boolean; data?: SyncResponse } | SyncResponse>(
      "/api/client/sync",
      {}
    );
    const data = this.unwrapSyncResponse(resp);
    
    // Transform SyncResponse to OrgSnapshot format
    const syncAgents = Array.isArray(data.agents) ? data.agents : [];
    return {
      workspaceId:
        typeof data.workspaceId === "string" && data.workspaceId.trim()
          ? data.workspaceId
          : null,
      workspaceName:
        typeof data.workspaceName === "string" && data.workspaceName.trim()
          ? data.workspaceName
          : null,
      initiatives: data.initiatives.map(i => ({
        id: i.id,
        title: i.title,
        status: i.status,
      })),
      agents: syncAgents.map((agent) => ({
        id: String(agent.id ?? ""),
        name: String(agent.name ?? ""),
        domain: String(agent.domain ?? ""),
        status: normalizeAgentStatus(agent.status),
        currentTask:
          typeof agent.currentTask === "string" && agent.currentTask.trim().length > 0
            ? agent.currentTask
            : undefined,
        lastActive:
          typeof agent.lastActive === "string" && agent.lastActive.trim().length > 0
            ? agent.lastActive
            : undefined,
      })),
      activeTasks: data.activeTasks.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        domain: t.domain,
        modelTier: t.modelTier,
        priority: t.priority,
        dueDate: t.dueDate,
        initiativeId: t.initiativeId,
        workstreamId: t.workstreamId,
        milestoneId: t.milestoneId,
        goalIds: t.goalIds,
        canonicalGoalId: t.canonicalGoalId,
        assignedAgentIds: t.assignedAgentIds,
        assignedAgentNames: t.assignedAgentNames,
        canonicalAssignedAgentId: t.canonicalAssignedAgentId,
        canonicalNextTask: t.canonicalNextTask,
        dispatchReady: t.dispatchReady,
        acceptanceCriteria: t.acceptanceCriteria,
        executionContext: t.executionContext,
        updatedAt: t.updatedAt,
      })),
      pendingDecisions: data.pendingDecisions.map(d => ({
        id: d.id,
        title: d.title,
        urgency: d.urgency,
      })),
      syncedAt: data.syncedAt,
    };
  }

  // ===========================================================================
  // Memory Sync
  // ===========================================================================

  async syncMemory(payload: SyncPayload): Promise<SyncResponse> {
    const response = await this.post<{ ok?: boolean; data?: SyncResponse } | SyncResponse>(
      "/api/client/sync",
      payload
    );
    return this.unwrapSyncResponse(response);
  }

  async sendGatewayHeartbeat(payload: {
    workspace_id: string;
    plugin_id: "orgx-codex-plugin" | "orgx-claude-code-plugin";
    installation_id: string;
    host_platform: string;
    drivers_installed: Array<"codex" | "claude_code">;
    gateway_version: string;
    plan_tier?: string | null;
    subscription_type?: string | null;
    subscription_active: boolean;
    capacity_windows?: Array<{
      kind: string;
      used_pct: number;
      resets_at?: string | null;
    }>;
    metadata?: Record<string, unknown>;
  }): Promise<{
    ok: boolean;
    peer_id: string;
    status: string;
    last_heartbeat_at: string;
    routing_policy?: {
      recommended_runtime?: CapacityRuntimeRecommendation | null;
      fallback_runtime?: CapacityRuntimeRecommendation | null;
    };
  }> {
    return this.post("/api/v1/gateway/heartbeat", payload);
  }

  // ===========================================================================
  // Kickoff Context
  // ===========================================================================

  async getKickoffContext(payload: KickoffContextRequest): Promise<KickoffContextResponse> {
    return await this.post<KickoffContextResponse>("/api/client/kickoff-context", payload ?? {});
  }

  // ===========================================================================
  // Skill Packs (ETag-aware)
  // ===========================================================================

  async getSkillPack(input?: {
    name?: string;
    ifNoneMatch?: string | null;
  }): Promise<
    | { ok: true; notModified: true; etag: string | null; pack: null }
    | { ok: true; notModified: false; etag: string | null; pack: SkillPack }
    | { ok: false; status: number; error: string }
  > {
    const name = (input?.name ?? "").trim() || "orgx-agent-suite";
    const url = `${this.baseUrl}/api/client/skill-pack?name=${encodeURIComponent(name)}`;

    const controller = new AbortController();
    const timeoutMs = resolveRequestTimeoutMs("/api/client/skill-pack");
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${this.apiKey}`,
      };
      if (this.userId && !isUserScopedApiKey(this.apiKey)) {
        headers["X-Orgx-User-Id"] = this.userId;
      }
      const ifNoneMatch = (input?.ifNoneMatch ?? "").trim();
      if (ifNoneMatch) {
        headers["If-None-Match"] = ifNoneMatch;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      const etag = response.headers.get("etag");
      if (response.status === 304) {
        return { ok: true, notModified: true, etag, pack: null };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("application/json")
        ? ((await response.json().catch(() => null)) as SkillPackResponse | null)
        : null;

      if (!response.ok) {
        const detail =
          payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
            ? payload.error
            : `${response.status} ${response.statusText}`;
        return { ok: false, status: response.status, error: detail };
      }

      if (payload && typeof payload === "object" && (payload as any).ok === true && (payload as any).data) {
        return { ok: true, notModified: false, etag, pack: (payload as any).data as SkillPack };
      }

      return { ok: false, status: 502, error: "SkillPack response was invalid" };
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return {
          ok: false,
          status: 504,
          error: `OrgX API GET /api/client/skill-pack timed out after ${timeoutMs}ms`,
        };
      }
      return { ok: false, status: 502, error: err instanceof Error ? err.message : "SkillPack request failed" };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ===========================================================================
  // Client Agent Runtime Settings
  // ===========================================================================

  async getClientAgentRuntimeSettings(input?: {
    workspaceId?: string | null;
    /** Legacy alias retained for backward compatibility */
    projectId?: string | null;
  }): Promise<ClientRuntimeSettingsResponse> {
    const workspaceScope = input?.workspaceId ?? input?.projectId ?? null;
    const query = this.buildQuery({
      workspace_id: workspaceScope,
      command_center_id: workspaceScope,
    });
    return this.get<ClientRuntimeSettingsResponse>(
      `/api/client/agents/runtime-settings${query}`
    );
  }

  async updateClientAgentRuntimeSettings(
    payload: ClientRuntimeSettingsUpdateRequest
  ): Promise<ClientRuntimeSettingsResponse> {
    return this.patch<ClientRuntimeSettingsResponse>(
      "/api/client/agents/runtime-settings",
      payload
    );
  }

  async delegationPreflight(payload: {
    intent: string;
    acceptanceCriteria?: string[];
    constraints?: string[];
    domains?: string[];
  }): Promise<{ ok: boolean; data: DelegationPreflightResult }> {
    return this.post<{ ok: boolean; data: DelegationPreflightResult }>(
      "/api/client/delegation/preflight",
      payload
    );
  }

  // ===========================================================================
  // Spawn Guard (Quality Gate + Model Routing)
  // ===========================================================================

  async checkSpawnGuard(
    domain: string,
    taskId?: string,
    modelTier?: ModelTier
  ): Promise<SpawnGuardResult> {
    const response = await this.post<
      SpawnGuardResult | { ok?: boolean; data?: SpawnGuardResult }
    >("/api/client/spawn", {
      domain,
      taskId,
      model_tier: modelTier,
    });

    // Newer servers wrap responses in { ok, data } while older clients expect the
    // SpawnGuardResult fields at top-level.
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return response.data as SpawnGuardResult;
    }

    return response as SpawnGuardResult;
  }

  // ===========================================================================
  // Quality Scores
  // ===========================================================================

  async recordQuality(score: QualityScore): Promise<{ success: boolean }> {
    const normalizedScore = normalizeQualityScorePayload(score);
    const response = await this.post<
      { success: boolean } | { ok?: boolean; data?: unknown }
    >("/api/client/quality", normalizedScore);

    // Backwards-compatible: accept either { success: true } or { ok: true, data: ... }.
    if (
      response &&
      typeof response === "object" &&
      "success" in response &&
      typeof (response as { success: unknown }).success === "boolean"
    ) {
      return response as { success: boolean };
    }

    if (response && typeof response === "object" && "ok" in response) {
      return { success: Boolean((response as { ok?: unknown }).ok) };
    }

    return { success: true };
  }

  async getMorningBrief(params: {
    workspace_id: string;
    session_id?: string;
  }): Promise<Record<string, unknown>> {
    const query = this.buildQuery({
      workspace_id: params.workspace_id,
      session_id: params.session_id,
    });
    return this.get<Record<string, unknown>>(`/api/flywheel/briefs${query}`);
  }

  async queryOrgMemory(params: {
    query: string;
    scope?: "all" | "artifacts" | "decisions" | "initiatives";
    limit?: number;
  }): Promise<Record<string, unknown>> {
    return this.executeClientTool<Record<string, unknown>>(
      "query_org_memory",
      params
    );
  }

  async recommendNextAction(params: {
    entity_type?: "workspace" | "initiative" | "workstream" | "milestone";
    entity_id?: string;
    workspace_id?: string;
    command_center_id?: string;
    agent_id?: string;
    domain?: string;
    canonical_only?: boolean;
    limit?: number;
    cascade?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.executeClientTool<Record<string, unknown>>(
      "recommend_next_action",
      params
    );
  }

  // ===========================================================================
  // Entity CRUD
  // Uses /api/entities with type in body (NOT per-type REST paths)
  // ===========================================================================

  /**
   * Create an OrgX entity.
   * POST /api/entities { type, title, summary, status, initiative_id, ... }
   */
  async createEntity(
    type: string,
    data: Record<string, unknown>
  ): Promise<Entity> {
    const resp = await this.post<{ type: string; data: Entity }>("/api/entities", {
      type,
      ...data,
    });
    return resp.data ?? resp as unknown as Entity;
  }

  /**
   * Update an OrgX entity.
   * PATCH /api/entities { type, id, ...updates }
   */
  async updateEntity(
    type: string,
    id: string,
    updates: Record<string, unknown>
  ): Promise<Entity> {
    const result = await this.updateEntityDetailed(type, id, updates);
    return result.entity;
  }

  /**
   * Update an OrgX entity and preserve reassignment metadata when present.
   * PATCH /api/entities { type, id, ...updates }
   */
  async updateEntityDetailed(
    type: string,
    id: string,
    updates: Record<string, unknown>
  ): Promise<EntityUpdateResult> {
    const resp = await this.patch<
      | { type?: string; data?: Entity; entity?: Entity; reassignment?: unknown; initiative_reassignment?: unknown }
      | Entity
    >("/api/entities", {
      type,
      id,
      ...updates,
    });

    if (resp && typeof resp === "object") {
      const envelope = resp as {
        data?: Entity;
        entity?: Entity;
        reassignment?: unknown;
        initiative_reassignment?: unknown;
      };
      const entity = envelope.entity ?? envelope.data ?? (resp as Entity);
      return {
        entity,
        reassignment:
          envelope.reassignment && typeof envelope.reassignment === "object"
            ? (envelope.reassignment as EntityUpdateResult["reassignment"])
            : null,
        initiative_reassignment:
          envelope.initiative_reassignment &&
          typeof envelope.initiative_reassignment === "object"
            ? (envelope.initiative_reassignment as EntityUpdateResult["initiative_reassignment"])
            : null,
      };
    }

    return { entity: resp as Entity };
  }

  /**
   * List OrgX entities.
   * GET /api/entities?type={type}&status={status}&limit={n}
   */
  async listEntities(
    type: string,
    filters?: EntityListFilters
  ): Promise<{ data: Entity[]; pagination: { total: number; has_more: boolean } }> {
    const params = new URLSearchParams({ type });
    if (filters?.status) params.set("status", filters.status);
    if (typeof filters?.offset === "number" && Number.isFinite(filters.offset)) {
      params.set("offset", String(Math.max(0, Math.floor(filters.offset))));
    }
    if (filters?.search) params.set("search", String(filters.search));
    if (filters?.id) params.set("id", String(filters.id));
    if (filters?.ids) {
      const values = Array.isArray(filters.ids)
        ? filters.ids
        : String(filters.ids)
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
      if (values.length > 0) {
        params.set("ids", values.join(","));
      }
    }
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.initiative_id) params.set("initiative_id", String(filters.initiative_id));
    const legacyProjectIdRaw =
      filters?.project_id != null ? String(filters.project_id) : null;
    const workspaceIdRaw =
      filters?.workspace_id != null ? String(filters.workspace_id) : null;
    const commandCenterIdRaw =
      filters?.command_center_id != null
        ? String(filters.command_center_id)
        : null;
    if (
      workspaceIdRaw &&
      commandCenterIdRaw &&
      workspaceIdRaw.trim() !== commandCenterIdRaw.trim()
    ) {
      throw new Error(
        "workspace_id and command_center_id must match when both are provided"
      );
    }
    if (
      legacyProjectIdRaw &&
      workspaceIdRaw &&
      legacyProjectIdRaw.trim() !== workspaceIdRaw.trim()
    ) {
      throw new Error(
        "project_id cannot differ from workspace_id; use workspace_id as canonical scope"
      );
    }

    const workspaceId = workspaceIdRaw ?? commandCenterIdRaw ?? legacyProjectIdRaw;
    if (workspaceId) {
      // Canonical scope param. Keep legacy alias for backward compatibility.
      params.set("workspace_id", workspaceId);
      params.set("command_center_id", workspaceId);
    }
    return this.get(`/api/entities?${params.toString()}`);
  }

  // ===========================================================================
  // Billing (API-key clients)
  // ===========================================================================

  async getBillingStatus(): Promise<BillingStatus> {
    const response = await this.get<{ ok?: boolean; data?: BillingStatus } | BillingStatus>(
      "/api/client/billing/status"
    );
    if (response && typeof response === "object" && "data" in response && response.data) {
      return response.data as BillingStatus;
    }
    return response as BillingStatus;
  }

  async createBillingCheckout(payload: BillingCheckoutRequest): Promise<BillingUrlResult> {
    const response = await this.post<
      BillingUrlResult | { ok?: boolean; data?: BillingUrlResult }
    >("/api/client/billing/checkout", payload);
    if (response && typeof response === "object" && "data" in response && response.data) {
      return response.data as BillingUrlResult;
    }
    return response as BillingUrlResult;
  }

  async createBillingPortal(): Promise<BillingUrlResult> {
    const response = await this.post<
      BillingUrlResult | { ok?: boolean; data?: BillingUrlResult }
    >("/api/client/billing/portal", {});
    if (response && typeof response === "object" && "data" in response && response.data) {
      return response.data as BillingUrlResult;
    }
    return response as BillingUrlResult;
  }

  // ===========================================================================
  // Usage (Control Plane + Forecast)
  // ===========================================================================

  async getUsageControlPlaneSummary(): Promise<UsageControlPlaneSummary> {
    return this.get<UsageControlPlaneSummary>("/api/usage/control-plane/summary");
  }

  async getUsageUnified(): Promise<UsageControlPlaneSummary> {
    return this.get<UsageControlPlaneSummary>("/api/usage/unified");
  }

  async getUsageForecast(): Promise<
    Pick<
      UsageControlPlaneSummary,
      "generatedAt" | "period" | "predicted" | "risk" | "headroom" | "utilization"
    >
  > {
    return this.get<
      Pick<
        UsageControlPlaneSummary,
        "generatedAt" | "period" | "predicted" | "risk" | "headroom" | "utilization"
      >
    >("/api/usage/forecast");
  }

  // ===========================================================================
  // Reporting Control Plane
  // ===========================================================================

  async emitActivity(payload: EmitActivityRequest): Promise<EmitActivityResponse> {
    const response = await this.post<EmitActivityResponse | { ok: boolean; data?: EmitActivityResponse }>(
      "/api/client/live/activity",
      payload
    );
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return response.data;
    }
    return response as EmitActivityResponse;
  }

  // Emit the deterministic execution graph + trust ledger for the active run
  // (nodes + depends_on edges + trust events). The backend derives
  // false-completion / hallucinated-receipt / dependency-violation signals and
  // surfaces them on /live. Structured sibling of emitActivity.
  async emitExecutionGraph(
    payload: EmitExecutionGraphRequest
  ): Promise<EmitExecutionGraphResponse> {
    const response = await this.post<
      EmitExecutionGraphResponse | { ok: boolean; data?: EmitExecutionGraphResponse }
    >("/api/client/live/execution-graph", payload);
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return response.data;
    }
    return response as EmitExecutionGraphResponse;
  }

  async applyChangeset(
    payload: ApplyChangesetRequest
  ): Promise<ApplyChangesetResponse> {
    const response = await this.post<
      ApplyChangesetResponse | { ok: boolean; data?: ApplyChangesetResponse }
    >("/api/client/live/changesets/apply", payload);
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return response.data;
    }
    return response as ApplyChangesetResponse;
  }

  async recordRunOutcome(
    payload: RecordRunOutcomeRequest
  ): Promise<RecordRunOutcomeResponse> {
    const response = await this.post<
      RecordRunOutcomeResponse | { ok: boolean; data?: RecordRunOutcomeResponse }
    >("/api/client/live/runs/outcomes/record", payload);
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return response.data;
    }
    return response as RecordRunOutcomeResponse;
  }

  async recordRunRetro(
    payload: RecordRunRetroRequest
  ): Promise<RecordRunRetroResponse> {
    const response = await this.post<
      RecordRunRetroResponse | { ok: boolean; data?: RecordRunRetroResponse }
    >("/api/client/live/runs/retro", payload);
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return response.data;
    }
    return response as RecordRunRetroResponse;
  }

  // ===========================================================================
  // Agent Jobs (Plugin Dispatch Bridge)
  // ===========================================================================

  async createAgentJob(payload: {
    initiative_id: string;
    workstream_id: string;
    task_id?: string | null;
    run_id: string;
    agent_type: string;
    execution_target: string;
    worker_name: string;
    machine_id: string;
    slice_scope?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<{ ok: boolean; job_id: string }> {
    const response = await this.post<
      { ok: boolean; job_id: string } | { ok: boolean; data?: { job_id: string } }
    >("/api/client/jobs", payload);
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return { ok: true, job_id: (response.data as { job_id: string }).job_id };
    }
    return response as { ok: boolean; job_id: string };
  }

  async updateAgentJob(payload: {
    job_id: string;
    status: "completed" | "failed" | "cancelled";
    error?: string | null;
    output?: Record<string, unknown> | null;
  }): Promise<{ ok: boolean }> {
    const response = await this.patch<
      { ok: boolean } | { ok: boolean; data?: unknown }
    >("/api/client/jobs", payload);
    if (response && typeof response === "object" && "ok" in response) {
      return { ok: Boolean((response as { ok?: unknown }).ok) };
    }
    return { ok: true };
  }

  async queryDispatchPreflight(payload: {
    initiative_id: string;
    workstream_id: string;
    task_id?: string | null;
    domain?: string | null;
    launch_mode: "autopilot" | "manual";
  }): Promise<{
    dispatch_status: string;
    block_reasons: Array<{ code: string; message: string; severity: string; overrideable: boolean }>;
    recommended_execution_target: string;
    eligible_workers: Array<{ workerId: string; workerName: string }>;
    routing_policy_state?: "live" | "partial" | "unconfigured";
    recommended_runtime?: {
      channelId: string;
      workerKind: "codex" | "claude-code" | "server";
      provider: "openai" | "anthropic";
      score: number;
      reason: string;
    } | null;
    fallback_runtime?: {
      channelId: string;
      workerKind: "codex" | "claude-code" | "server";
      provider: "openai" | "anthropic";
      score: number;
      reason: string;
    } | null;
    next_goal?: {
      id: string;
      title: string;
      priority: "critical" | "high" | "normal" | "low";
      monthlyBudgetCents: number | null;
    } | null;
    routing_blocked_reason?: string | null;
  }> {
    const response = await this.post<
      | {
          dispatch_status: string;
          block_reasons: Array<{ code: string; message: string; severity: string; overrideable: boolean }>;
          recommended_execution_target: string;
          eligible_workers: Array<{ workerId: string; workerName: string }>;
          routing_policy_state?: "live" | "partial" | "unconfigured";
          recommended_runtime?: {
            channelId: string;
            workerKind: "codex" | "claude-code" | "server";
            provider: "openai" | "anthropic";
            score: number;
            reason: string;
          } | null;
          fallback_runtime?: {
            channelId: string;
            workerKind: "codex" | "claude-code" | "server";
            provider: "openai" | "anthropic";
            score: number;
            reason: string;
          } | null;
          next_goal?: {
            id: string;
            title: string;
            priority: "critical" | "high" | "normal" | "low";
            monthlyBudgetCents: number | null;
          } | null;
          routing_blocked_reason?: string | null;
        }
      | { ok: boolean; data?: unknown }
    >("/api/client/dispatch/preflight", payload);
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      response.data
    ) {
      return response.data as any;
    }
    return response as any;
  }

  // ===========================================================================
  // Live Sessions + Activity + Handoffs
  // ===========================================================================

  async getLiveSessions(params?: {
    limit?: number;
    initiative?: string | null;
    workspaceId?: string | null;
    /** @deprecated Use workspaceId */
    projectId?: string | null;
  }): Promise<SessionTreeResponse> {
    const workspaceScope = params?.workspaceId ?? params?.projectId ?? null;
    const query = this.buildQuery({
      limit: params?.limit,
      initiative: params?.initiative ?? null,
      workspace_id: workspaceScope,
      command_center_id: workspaceScope,
    });
    return this.get(`/api/client/live/sessions${query}`);
  }

  async getLiveActivity(params?: {
    limit?: number;
    run?: string | null;
    since?: string | null;
    workspaceId?: string | null;
    /** @deprecated Use workspaceId */
    projectId?: string | null;
  }): Promise<{ activities: LiveActivityItem[]; total: number }> {
    const workspaceScope = params?.workspaceId ?? params?.projectId ?? null;
    const query = this.buildQuery({
      limit: params?.limit,
      run: params?.run ?? null,
      since: params?.since ?? null,
      workspace_id: workspaceScope,
      command_center_id: workspaceScope,
    });
    return this.get(`/api/client/live/activity${query}`);
  }

  async getLiveAgents(params?: {
    initiative?: string | null;
    includeIdle?: boolean;
    workspaceId?: string | null;
    /** @deprecated Use workspaceId */
    projectId?: string | null;
  }): Promise<{ agents: unknown[]; summary: Record<string, number> }> {
    const workspaceScope = params?.workspaceId ?? params?.projectId ?? null;
    const query = this.buildQuery({
      initiative: params?.initiative ?? null,
      include_idle: params?.includeIdle ?? undefined,
      workspace_id: workspaceScope,
      command_center_id: workspaceScope,
    });
    return this.get(`/api/client/live/agents${query}`);
  }

  async getLiveInitiatives(params?: {
    id?: string | null;
    limit?: number;
    offset?: number;
    workspaceId?: string | null;
    /** @deprecated Use workspaceId */
    projectId?: string | null;
  }): Promise<{
    initiatives: unknown[];
    total: number;
    pagination?: { limit?: number; offset?: number; has_more?: boolean };
  }> {
    const workspaceScope = params?.workspaceId ?? params?.projectId ?? null;
    const query = this.buildQuery({
      id: params?.id ?? null,
      limit: params?.limit ?? null,
      offset: params?.offset ?? null,
      workspace_id: workspaceScope,
      command_center_id: workspaceScope,
    });
    return this.get(`/api/client/live/initiatives${query}`);
  }

  async getHandoffs(): Promise<{ handoffs: HandoffSummary[] }> {
    return this.get(`/api/client/handoffs`);
  }

  async runAction(
    runId: string,
    action: RunAction,
    payload?: { checkpointId?: string; reason?: string }
  ): Promise<{
    ok: boolean;
    data: {
      runId: string;
      action: RunAction;
      status: string;
      checkpointId?: string;
    };
  }> {
    const encodedRunId = encodeURIComponent(runId);
    const encodedAction = encodeURIComponent(action);
    return this.post(
      `/api/client/runs/${encodedRunId}/actions/${encodedAction}`,
      payload ?? {}
    );
  }

  async listRunCheckpoints(
    runId: string
  ): Promise<{ ok: boolean; data: CheckpointSummary[] }> {
    const encodedRunId = encodeURIComponent(runId);
    return this.get(`/api/client/runs/${encodedRunId}/checkpoints`);
  }

  async createRunCheckpoint(
    runId: string,
    payload?: { reason?: string; payload?: Record<string, unknown> }
  ): Promise<{ ok: boolean; data: CheckpointSummary }> {
    const encodedRunId = encodeURIComponent(runId);
    return this.post(`/api/client/runs/${encodedRunId}/checkpoints`, payload ?? {});
  }

  async restoreRunCheckpoint(
    runId: string,
    request: RestoreRequest
  ): Promise<{
    ok: boolean;
    data: {
      runId: string;
      action: RunAction;
      status: string;
      checkpointId?: string;
    };
  }> {
    const encodedRunId = encodeURIComponent(runId);
    const encodedCheckpointId = encodeURIComponent(request.checkpointId);
    return this.post(
      `/api/client/runs/${encodedRunId}/checkpoints/${encodedCheckpointId}/restore`,
      { reason: request.reason }
    );
  }

  async getLiveDecisions(params?: {
    status?: string;
    limit?: number;
    workspaceId?: string | null;
    /** @deprecated Use workspaceId */
    projectId?: string | null;
  }): Promise<{ decisions: Entity[]; total: number }> {
    const workspaceScope = params?.workspaceId ?? params?.projectId ?? undefined;
    const response = await this.listEntities("decision", {
      status: params?.status,
      limit: params?.limit,
      workspace_id: workspaceScope,
      command_center_id: workspaceScope,
    });
    const decisions = Array.isArray(response.data) ? response.data : [];
    return {
      decisions,
      total: response.pagination?.total ?? decisions.length,
    };
  }

  async requestAttention(
    input: AttentionRequestInput
  ): Promise<Record<string, unknown>> {
    return this.post("/api/client/live/attention", input);
  }

  async pollAttention(attentionId: string): Promise<Record<string, unknown>> {
    return this.get(
      `/api/client/live/attention/${encodeURIComponent(attentionId)}`
    );
  }

  async acknowledgeAttention(
    attentionId: string,
    input: AttentionReceiptInput
  ): Promise<Record<string, unknown>> {
    return this.post(
      `/api/client/live/attention/${encodeURIComponent(attentionId)}`,
      input
    );
  }

  async decideDecision(
    id: string,
    action: DecisionAction,
    input?: DecisionMutationInput
  ): Promise<Entity> {
    const note = input?.note?.trim() || null;
    const optionId = input?.optionId?.trim() || null;
    const resolvedStatus = action === "approve" ? "approved" : "declined";
    const primaryPatch: Record<string, unknown> = {
      status: resolvedStatus,
      ...(note ? { resolution_summary: note } : {}),
      ...(optionId ? { option_id: optionId } : {}),
    };

    try {
      return await this.updateEntity("decision", id, primaryPatch);
    } catch {
      // Keep fallback payload schema-safe for strict entity routes.
      return this.updateEntity("decision", id, {
        status: resolvedStatus,
        ...(note
          ? {
              metadata: {
                resolution: {
                  summary: note,
                  note,
                },
              },
            }
          : {}),
        ...(optionId ? { option_id: optionId } : {}),
      });
    }
  }

  async bulkDecideDecisions(
    ids: string[],
    action: DecisionAction,
    input?: DecisionMutationInput
  ): Promise<DecisionActionResult[]> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    const results: DecisionActionResult[] = new Array(uniqueIds.length);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= uniqueIds.length) {
          return;
        }

        const id = uniqueIds[index];
        try {
          const entity = await this.decideDecision(id, action, input);
          results[index] = { id, ok: true, entity };
        } catch (err: unknown) {
          results[index] = {
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    };

    const concurrency = Math.min(
      DECISION_MUTATION_CONCURRENCY,
      Math.max(1, uniqueIds.length)
    );
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  }
}
