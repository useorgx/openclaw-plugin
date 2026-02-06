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
  LiveActivityItem,
  SessionTreeResponse,
  HandoffSummary,
  CheckpointSummary,
  RestoreRequest,
  DelegationPreflightResult,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "OrgX-Clawdbot-Plugin/1.0";

export type DecisionAction = "approve" | "reject";
export type RunAction = "pause" | "resume" | "cancel" | "rollback";

export interface DecisionActionResult {
  id: string;
  ok: boolean;
  entity?: Entity;
  error?: string;
}

export class OrgXClient {
  private apiKey: string;
  private baseUrl: string;
  private userId: string;

  constructor(apiKey: string, baseUrl: string, userId?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.userId = userId || "";
  }

  // ===========================================================================
  // HTTP helpers
  // ===========================================================================

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${this.apiKey}`,
      };
      if (this.userId) {
        headers["X-Orgx-User-Id"] = this.userId;
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `OrgX API ${method} ${path}: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
        );
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return (await response.json()) as T;
      }

      return (await response.text()) as unknown as T;
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(
          `OrgX API ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`
        );
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
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

  // ===========================================================================
  // Org Snapshot
  // ===========================================================================

  async getOrgSnapshot(): Promise<OrgSnapshot> {
    // Use the sync endpoint with POST (empty body = pull only)
    const resp = await this.post<{ok: boolean; data: SyncResponse}>("/api/client/sync", {});
    const data = resp.data;
    
    // Transform SyncResponse to OrgSnapshot format
    return {
      initiatives: data.initiatives.map(i => ({
        id: i.id,
        title: i.title,
        status: i.status,
      })),
      agents: [], // Not returned by sync endpoint
      activeTasks: data.activeTasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        domain: t.domain,
        modelTier: t.modelTier,
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
    taskId?: string
  ): Promise<SpawnGuardResult> {
    return this.post<SpawnGuardResult>("/api/client/spawn", {
      domain,
      taskId,
    });
  }

  // ===========================================================================
  // Quality Scores
  // ===========================================================================

  async recordQuality(score: QualityScore): Promise<{ success: boolean }> {
    return this.post<{ success: boolean }>("/api/client/quality", score);
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
    const resp = await this.patch<{ type: string; data: Entity }>("/api/entities", {
      type,
      id,
      ...updates,
    });
    return resp.data ?? resp as unknown as Entity;
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
    if (filters?.limit) params.set("limit", String(filters.limit));
    return this.get(`/api/entities?${params.toString()}`);
  }

  // ===========================================================================
  // Live Sessions + Activity + Handoffs
  // ===========================================================================

  async getLiveSessions(params?: { limit?: number; initiative?: string | null }): Promise<SessionTreeResponse> {
    const query = this.buildQuery({
      limit: params?.limit,
      initiative: params?.initiative ?? null,
    });
    return this.get(`/api/client/live/sessions${query}`);
  }

  async getLiveActivity(params?: { limit?: number; run?: string | null; since?: string | null }): Promise<{ activities: LiveActivityItem[]; total: number }> {
    const query = this.buildQuery({
      limit: params?.limit,
      run: params?.run ?? null,
      since: params?.since ?? null,
    });
    return this.get(`/api/client/live/activity${query}`);
  }

  async getLiveAgents(params?: { initiative?: string | null; includeIdle?: boolean }): Promise<{ agents: unknown[]; summary: Record<string, number> }> {
    const query = this.buildQuery({
      initiative: params?.initiative ?? null,
      include_idle: params?.includeIdle ?? undefined,
    });
    return this.get(`/api/client/live/agents${query}`);
  }

  async getLiveInitiatives(params?: { id?: string | null; limit?: number }): Promise<{ initiatives: unknown[]; total: number }> {
    const query = this.buildQuery({
      id: params?.id ?? null,
      limit: params?.limit ?? null,
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

  async getLiveDecisions(params?: { status?: string; limit?: number }): Promise<{ decisions: Entity[]; total: number }> {
    const response = await this.listEntities("decision", {
      status: params?.status,
      limit: params?.limit,
    });
    const decisions = Array.isArray(response.data) ? response.data : [];
    return {
      decisions,
      total: response.pagination?.total ?? decisions.length,
    };
  }

  async decideDecision(id: string, action: DecisionAction, note?: string): Promise<Entity> {
    const resolvedStatus = action === "approve" ? "approved" : "rejected";
    const resolvedAt = new Date().toISOString();

    try {
      return await this.updateEntity("decision", id, {
        status: resolvedStatus,
        resolution: resolvedStatus,
        resolved_at: resolvedAt,
        decided_at: resolvedAt,
        decided_by: this.userId || undefined,
        note: note ?? undefined,
      });
    } catch {
      // Fallback for backends that only support generic "resolved" status.
      return this.updateEntity("decision", id, {
        status: "resolved",
        decision_status: resolvedStatus,
        resolution: resolvedStatus,
        resolved_at: resolvedAt,
        decided_at: resolvedAt,
        note: note ?? undefined,
      });
    }
  }

  async bulkDecideDecisions(
    ids: string[],
    action: DecisionAction,
    note?: string
  ): Promise<DecisionActionResult[]> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    const results: DecisionActionResult[] = [];

    for (const id of uniqueIds) {
      try {
        const entity = await this.decideDecision(id, action, note);
        results.push({ id, ok: true, entity });
      } catch (err: unknown) {
        results.push({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }
}
