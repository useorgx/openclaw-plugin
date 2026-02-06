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
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "OrgX-Clawdbot-Plugin/1.0";

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
    return this.post<SyncResponse>("/api/client/sync", payload);
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
}
