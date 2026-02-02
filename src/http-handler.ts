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
 */

import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

import type { OrgXClient } from "./api.js";
import type { OrgXConfig, OrgSnapshot } from "./types.js";
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
    // Strip query string for routing
    const url = rawUrl.split("?")[0];

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
      if (method !== "GET") {
        res.writeHead(405, {
          "Content-Type": "text/plain",
          ...CORS_HEADERS,
        });
        res.end("Method Not Allowed");
        return true;
      }

      const route = url.replace("/orgx/api/", "").replace(/\/+$/, "");

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

        default:
          sendJson(res, 404, { error: "Unknown API endpoint" });
          return true;
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
