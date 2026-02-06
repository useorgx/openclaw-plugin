/**
 * HTTP Handler — Serves the React dashboard SPA and API proxy endpoints.
 *
 * Registered at the `/orgx` prefix. Handles:
 *   /orgx/live           → dashboard SPA (index.html)
 *   /orgx/live/assets/*  → static assets (JS, CSS, images)
 *   /orgx/api/status     → org status summary
 *   /orgx/api/agents     → agent states
 *   /orgx/api/activity   → activity feed
 *   /orgx/api/initiatives → initiative data
 *   /orgx/api/onboarding → onboarding / config state
 *   /orgx/api/delegation/preflight → delegation preflight
 *   /orgx/api/runs/:id/checkpoints → list/create checkpoints
 *   /orgx/api/runs/:id/checkpoints/:checkpointId/restore → restore checkpoint
 *   /orgx/api/runs/:id/actions/:action → run control action
 */

import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { OrgXClient } from "./api.js";
import type { OrgXConfig, OrgSnapshot, Entity } from "./types.js";
import {
  formatStatus,
  formatAgents,
  formatActivity,
  formatInitiatives,
  getOnboardingState,
} from "./dashboard-api.js";

// =============================================================================
// Types — mirrors the Node http.IncomingMessage / http.ServerResponse pattern
// that Clawdbot provides to plugin HTTP handlers.
// =============================================================================

interface PluginRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface PluginResponse {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string | Buffer): void;
  write?(chunk: string | Buffer): void;
}

// =============================================================================
// Content-Type mapping
// =============================================================================

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function contentType(filePath: string): string {
  return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// =============================================================================
// CORS headers (for local dev)
// =============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// =============================================================================
// Resolve the dashboard/dist/ directory relative to this file
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
// src/http-handler.ts → up to plugin root → dashboard/dist
const DIST_DIR = join(__filename, "..", "..", "dashboard", "dist");

// =============================================================================
// Helpers
// =============================================================================

function sendJson(
  res: PluginResponse,
  status: number,
  data: unknown
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  });
  res.end(body);
}

function sendFile(
  res: PluginResponse,
  filePath: string,
  cacheControl: string
): void {
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": cacheControl,
      ...CORS_HEADERS,
    });
    res.end(content);
  } catch {
    send404(res);
  }
}

function send404(res: PluginResponse): void {
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
    ...CORS_HEADERS,
  });
  res.end("Not Found");
}

function sendIndexHtml(res: PluginResponse): void {
  const indexPath = join(DIST_DIR, "index.html");
  if (existsSync(indexPath)) {
    sendFile(res, indexPath, "no-cache, no-store, must-revalidate");
  } else {
    res.writeHead(503, {
      "Content-Type": "text/html; charset=utf-8",
      ...CORS_HEADERS,
    });
    res.end(
      "<html><body><h1>Dashboard not built</h1>" +
        "<p>Run <code>cd dashboard &amp;&amp; npm run build</code> to build the SPA.</p>" +
        "</body></html>"
    );
  }
}

function parseJsonBody(body: unknown): Record<string, unknown> {
  if (!body) return {};
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (Buffer.isBuffer(body)) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof body === "object") {
    return body as Record<string, unknown>;
  }
  return {};
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

function toIsoString(value: string | null): string | null {
  if (!value) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch).toISOString();
}

function mapDecisionEntity(entity: Entity) {
  const record = entity as Record<string, unknown>;
  const requestedAt = toIsoString(
    pickString(record, [
      "requestedAt",
      "requested_at",
      "createdAt",
      "created_at",
      "updatedAt",
      "updated_at",
    ])
  );
  const updatedAt = toIsoString(
    pickString(record, ["updatedAt", "updated_at", "createdAt", "created_at"])
  );

  const waitingMinutesFromEntity = pickNumber(record, [
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

  return {
    id: String(record.id ?? ""),
    title: pickString(record, ["title", "name"]) ?? "Decision",
    context: pickString(record, ["context", "summary", "description", "details"]),
    status: pickString(record, ["status", "decision_status"]) ?? "pending",
    agentName: pickString(record, [
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
    requestedAt,
    updatedAt,
    waitingMinutes,
    metadata: record,
  };
}

// =============================================================================
// Factory
// =============================================================================

export function createHttpHandler(
  config: OrgXConfig,
  client: OrgXClient,
  getSnapshot: () => OrgSnapshot | null
) {
  const dashboardEnabled =
    (config as OrgXConfig & { dashboardEnabled?: boolean }).dashboardEnabled ??
    true;

  return async function handler(
    req: PluginRequest,
    res: PluginResponse
  ): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const rawUrl = req.url ?? "/";
    const [path, queryString] = rawUrl.split("?", 2);
    const url = path;
    const searchParams = new URLSearchParams(queryString ?? "");

    // Only handle /orgx paths — return false for everything else
    if (!url.startsWith("/orgx")) {
      return false;
    }

    // Handle CORS preflight
    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }

    // ── API endpoints ──────────────────────────────────────────────────────
    if (url.startsWith("/orgx/api/")) {
      const route = url.replace("/orgx/api/", "").replace(/\/+$/, "");
      const decisionApproveMatch = route.match(
        /^live\/decisions\/([^/]+)\/approve$/
      );
      const runActionMatch = route.match(/^runs\/([^/]+)\/actions\/([^/]+)$/);
      const runCheckpointsMatch = route.match(/^runs\/([^/]+)\/checkpoints$/);
      const runCheckpointRestoreMatch = route.match(
        /^runs\/([^/]+)\/checkpoints\/([^/]+)\/restore$/
      );
      const isDelegationPreflight = route === "delegation/preflight";

      if (
        method === "POST" &&
        (route === "live/decisions/approve" || decisionApproveMatch)
      ) {
        try {
          const payload = parseJsonBody(req.body);
          const action = payload.action === "reject" ? "reject" : "approve";
          const note =
            typeof payload.note === "string" && payload.note.trim().length > 0
              ? payload.note.trim()
              : undefined;

          const ids = decisionApproveMatch
            ? [decodeURIComponent(decisionApproveMatch[1])]
            : Array.isArray(payload.ids)
              ? payload.ids
                  .filter((id): id is string => typeof id === "string")
                  .map((id) => id.trim())
                  .filter(Boolean)
              : [];

          if (ids.length === 0) {
            sendJson(res, 400, {
              error: "Decision IDs are required.",
              expected: {
                route: "/orgx/api/live/decisions/approve",
                body: { ids: ["decision-id"], action: "approve|reject" },
              },
            });
            return true;
          }

          const results = await client.bulkDecideDecisions(ids, action, note);
          const updated = results.filter((result) => result.ok).length;
          const failed = results.length - updated;

          sendJson(res, failed > 0 ? 207 : 200, {
            action,
            requested: ids.length,
            updated,
            failed,
            results,
          });
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      if (method === "POST" && isDelegationPreflight) {
        try {
          const payload = parseJsonBody(req.body);
          const intent = pickString(payload, ["intent"]);
          if (!intent) {
            sendJson(res, 400, { error: "intent is required" });
            return true;
          }

          const toStringArray = (value: unknown): string[] | undefined =>
            Array.isArray(value)
              ? value.filter((entry): entry is string => typeof entry === "string")
              : undefined;

          const data = await client.delegationPreflight({
            intent,
            acceptanceCriteria: toStringArray(payload.acceptanceCriteria),
            constraints: toStringArray(payload.constraints),
            domains: toStringArray(payload.domains),
          });

          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      if (runCheckpointsMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runCheckpointsMatch[1]);
          const payload = parseJsonBody(req.body);
          const reason = pickString(payload, ["reason"]) ?? undefined;
          const rawPayload = payload.payload;
          const checkpointPayload =
            rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
              ? (rawPayload as Record<string, unknown>)
              : undefined;

          const data = await client.createRunCheckpoint(runId, {
            reason,
            payload: checkpointPayload,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      if (runCheckpointRestoreMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runCheckpointRestoreMatch[1]);
          const checkpointId = decodeURIComponent(runCheckpointRestoreMatch[2]);
          const payload = parseJsonBody(req.body);
          const reason = pickString(payload, ["reason"]) ?? undefined;
          const data = await client.restoreRunCheckpoint(runId, {
            checkpointId,
            reason,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      if (runActionMatch && method === "POST") {
        try {
          const runId = decodeURIComponent(runActionMatch[1]);
          const action = decodeURIComponent(runActionMatch[2]) as
            | "pause"
            | "resume"
            | "cancel"
            | "rollback";
          const payload = parseJsonBody(req.body);
          const checkpointId = pickString(payload, ["checkpointId", "checkpoint_id"]);
          const reason = pickString(payload, ["reason"]);

          const data = await client.runAction(runId, action, {
            checkpointId: checkpointId ?? undefined,
            reason: reason ?? undefined,
          });
          sendJson(res, 200, data);
        } catch (err: unknown) {
          sendJson(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      if (
        method !== "GET" &&
        !(runCheckpointsMatch && method === "POST") &&
        !(runCheckpointRestoreMatch && method === "POST") &&
        !(runActionMatch && method === "POST") &&
        !(isDelegationPreflight && method === "POST")
      ) {
        res.writeHead(405, {
          "Content-Type": "text/plain",
          ...CORS_HEADERS,
        });
        res.end("Method Not Allowed");
        return true;
      }

      switch (route) {
        case "status": {
          // Proxy-style: try live fetch, fall back to cache
          let snapshot = getSnapshot();
          if (!snapshot) {
            try {
              snapshot = await client.getOrgSnapshot();
            } catch {
              // use null snapshot
            }
          }
          sendJson(res, 200, formatStatus(snapshot));
          return true;
        }

        case "agents":
          sendJson(res, 200, formatAgents(getSnapshot()));
          return true;

        case "activity":
          sendJson(res, 200, formatActivity(getSnapshot()));
          return true;

        case "initiatives":
          sendJson(res, 200, formatInitiatives(getSnapshot()));
          return true;

        case "onboarding":
          sendJson(
            res,
            200,
            getOnboardingState(config, dashboardEnabled)
          );
          return true;

        case "live/sessions": {
          try {
            const initiative = searchParams.get("initiative");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const data = await client.getLiveSessions({
              initiative,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        case "live/activity": {
          try {
            const run = searchParams.get("run");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const since = searchParams.get("since");
            const data = await client.getLiveActivity({
              run,
              since,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        case "live/agents": {
          try {
            const initiative = searchParams.get("initiative");
            const includeIdleRaw = searchParams.get("include_idle");
            const includeIdle =
              includeIdleRaw === null ? undefined : includeIdleRaw !== "false";
            const data = await client.getLiveAgents({
              initiative,
              includeIdle,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        case "live/initiatives": {
          try {
            const id = searchParams.get("id");
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : undefined;
            const data = await client.getLiveInitiatives({
              id,
              limit: Number.isFinite(limit) ? limit : undefined,
            });
            sendJson(res, 200, data);
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        case "live/decisions": {
          try {
            const status = searchParams.get("status") ?? "pending";
            const limit = searchParams.get("limit")
              ? Number(searchParams.get("limit"))
              : 100;
            const data = await client.getLiveDecisions({
              status,
              limit: Number.isFinite(limit) ? limit : 100,
            });
            const decisions = data.decisions
              .map(mapDecisionEntity)
              .sort((a, b) => b.waitingMinutes - a.waitingMinutes);

            sendJson(res, 200, {
              decisions,
              total: data.total,
            });
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        case "handoffs": {
          try {
            const data = await client.getHandoffs();
            sendJson(res, 200, data);
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        case "live/stream": {
          const write = res.write?.bind(res);
          if (!write) {
            sendJson(res, 501, { error: "Streaming not supported" });
            return true;
          }
          const target = `${config.baseUrl.replace(/\/+$/, "")}/api/client/live/stream${queryString ? `?${queryString}` : ""}`;
          try {
            const upstream = await fetch(target, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${config.apiKey}`,
                Accept: "text/event-stream",
                ...(config.userId
                  ? { "X-Orgx-User-Id": config.userId }
                  : {}),
              },
            });

            const contentType =
              upstream.headers.get("content-type")?.toLowerCase() ?? "";
            if (!upstream.ok || !contentType.includes("text/event-stream")) {
              const bodyPreview = (await upstream.text().catch(() => ""))
                .replace(/\s+/g, " ")
                .slice(0, 300);
              sendJson(res, upstream.ok ? 502 : upstream.status, {
                error: "Live stream endpoint unavailable",
                status: upstream.status,
                contentType,
                preview: bodyPreview || null,
              });
              return true;
            }

            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
              ...CORS_HEADERS,
            });

            if (!upstream.body) {
              res.end();
              return true;
            }

            const reader = upstream.body.getReader();
            const pump = async () => {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) write(Buffer.from(value));
              }
              res.end();
            };

            void pump();
          } catch (err: unknown) {
            sendJson(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return true;
        }

        case "delegation/preflight": {
          sendJson(res, 405, { error: "Use POST /orgx/api/delegation/preflight" });
          return true;
        }

        default: {
          if (runCheckpointsMatch) {
            try {
              const runId = decodeURIComponent(runCheckpointsMatch[1]);
              const data = await client.listRunCheckpoints(runId);
              sendJson(res, 200, data);
            } catch (err: unknown) {
              sendJson(res, 500, {
                error: err instanceof Error ? err.message : String(err),
              });
            }
            return true;
          }

          if (runActionMatch || runCheckpointRestoreMatch) {
            sendJson(res, 405, { error: "Use POST for this endpoint" });
            return true;
          }

          sendJson(res, 404, { error: "Unknown API endpoint" });
          return true;
        }
      }
    }

    // ── Dashboard SPA + static assets ──────────────────────────────────────
    if (!dashboardEnabled) {
      res.writeHead(404, {
        "Content-Type": "text/plain",
        ...CORS_HEADERS,
      });
      res.end("Dashboard is disabled");
      return true;
    }

    // Requests under /orgx/live
    if (url === "/orgx/live" || url.startsWith("/orgx/live/")) {
      const subPath = url.replace(/^\/orgx\/live\/?/, "");

      // Static assets: /orgx/live/assets/* → dashboard/dist/assets/*
      // Hashed filenames get long-lived cache
      if (subPath.startsWith("assets/")) {
        const assetPath = join(DIST_DIR, subPath);
        if (existsSync(assetPath)) {
          sendFile(
            res,
            assetPath,
            "public, max-age=31536000, immutable"
          );
        } else {
          send404(res);
        }
        return true;
      }

      // Check for an exact file match (e.g. favicon, manifest)
      if (subPath && !subPath.includes("..")) {
        const filePath = join(DIST_DIR, subPath);
        if (existsSync(filePath)) {
          sendFile(res, filePath, "no-cache");
          return true;
        }
      }

      // SPA fallback: serve index.html for all other routes under /orgx/live
      sendIndexHtml(res);
      return true;
    }

    // Catch-all for /orgx but not /orgx/live or /orgx/api
    if (url === "/orgx" || url === "/orgx/") {
      // Redirect to dashboard
      res.writeHead(302, {
        Location: "/orgx/live",
        ...CORS_HEADERS,
      });
      res.end();
      return true;
    }

    send404(res);
    return true;
  };
}
