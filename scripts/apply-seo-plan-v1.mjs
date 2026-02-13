#!/usr/bin/env node

/**
 * Apply an OrgX initiative plan for SEO automation (idempotent-ish).
 *
 * This script is designed to be run by a human with OrgX credentials:
 * - ORGX_API_KEY (preferred)
 * - ORGX_BASE_URL (optional; defaults https://www.useorgx.com)
 *
 * It will create (or reuse) one initiative, then ensure workstreams + tasks exist.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PLAN_VERSION = "seo-plan-v1-2026-02-10";
const DEFAULT_INITIATIVE_TITLE = "SEO Automation Pipeline (Keywords Everywhere + DataForSEO)";

function normalize(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

class OrgxApi {
  constructor(baseUrl, headers = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = headers;
  }

  async request(method, path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": PLAN_VERSION,
        ...this.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}: ${
          typeof parsed === "string" ? parsed : JSON.stringify(parsed)
        }`
      );
    }

    return parsed;
  }

  async listEntities(type, filters = {}) {
    const q = new URLSearchParams({ type, limit: "1000", ...filters });
    const result = await this.request("GET", `/api/entities?${q.toString()}`);
    return Array.isArray(result?.data) ? result.data : [];
  }

  async createEntity(type, payload) {
    const result = await this.request("POST", "/api/entities", { type, ...payload });
    return result?.entity || result?.data || result;
  }

  async updateEntity(type, id, updates) {
    const payload = { type, id, ...updates };
    const result = await this.request("PATCH", "/api/entities", payload);
    return result?.entity || result?.data || result;
  }
}

function loadOrgxCredentials() {
  const envApiKey = process.env.ORGX_API_KEY?.trim();
  const envUserId = process.env.ORGX_USER_ID?.trim();
  const envBase = process.env.ORGX_BASE_URL?.trim();
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      userId: envUserId || "",
      baseUrl: envBase || "https://www.useorgx.com",
      source: "env",
    };
  }

  const openclawConfigPath = join(homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(openclawConfigPath)) {
    throw new Error(`ORGX_API_KEY not set and ${openclawConfigPath} not found.`);
  }

  const raw = readFileSync(openclawConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const cfg = parsed?.plugins?.entries?.orgx?.config ?? {};
  const apiKey = typeof cfg.apiKey === "string" ? cfg.apiKey.trim() : "";
  const userId = typeof cfg.userId === "string" ? cfg.userId.trim() : "";
  const baseUrl =
    typeof cfg.baseUrl === "string" && cfg.baseUrl.trim().length > 0
      ? cfg.baseUrl.trim()
      : "https://www.useorgx.com";

  if (!apiKey) {
    throw new Error("OrgX API key missing in ~/.openclaw/openclaw.json");
  }

  return { apiKey, userId, baseUrl, source: "openclaw_config" };
}

function buildSummary({ owner, due, exitCriteria }) {
  return [
    "[SEO Plan v1]",
    `Plan: ${PLAN_VERSION}`,
    `Owner: ${owner}`,
    `Due: ${due}`,
    "",
    `Exit criteria: ${exitCriteria}`,
  ].join("\n");
}

const WORKSTREAMS = [
  {
    name: "Keyword Universe",
    owner: "marketing-owner",
    due: "2026-02-11T23:59:00-06:00",
    exitCriteria: "Keyword universe generated from KE related + PASF and persisted as artifacts.",
    tasks: [
      {
        title: "Implement KE keyword expansion (related + PASF)",
        due: "2026-02-11T18:00:00-06:00",
      },
      {
        title: "Generate keyword universe artifacts (json/txt)",
        due: "2026-02-11T23:00:00-06:00",
      },
    ],
  },
  {
    name: "Metrics + Prioritization",
    owner: "marketing-owner",
    due: "2026-02-12T23:59:00-06:00",
    exitCriteria: "Keyword metrics and priority scores generated; top candidates selected.",
    tasks: [
      { title: "Fetch keyword overview metrics from DataForSEO Labs", due: "2026-02-12T18:00:00-06:00" },
      { title: "Produce prioritized keyword list + top clusters", due: "2026-02-12T23:00:00-06:00" },
    ],
  },
  {
    name: "SERP Gap Analysis",
    owner: "marketing-owner",
    due: "2026-02-12T23:59:00-06:00",
    exitCriteria: "For top keywords, SERP results pulled; gaps and competitor dominance summarized.",
    tasks: [
      { title: "Query DataForSEO SERP API for top keywords", due: "2026-02-12T20:00:00-06:00" },
      { title: "Generate SERP gap report (csv + json)", due: "2026-02-12T23:30:00-06:00" },
    ],
  },
  {
    name: "Content Calendar + Clustering",
    owner: "marketing-owner",
    due: "2026-02-13T23:59:00-06:00",
    exitCriteria: "Clustered content calendar produced with page type + slugs and priorities.",
    tasks: [
      { title: "Cluster keywords into topics", due: "2026-02-13T15:00:00-06:00" },
      { title: "Generate content calendar rows (csv)", due: "2026-02-13T18:00:00-06:00" },
    ],
  },
  {
    name: "Programmatic Landing Pages",
    owner: "engineering-owner",
    due: "2026-02-14T12:00:00-06:00",
    exitCriteria: "Programmatic landing page drafts generated with schema stubs and semantic coverage.",
    tasks: [
      { title: "Create landing page template w/ schema placeholders", due: "2026-02-13T20:00:00-06:00" },
      { title: "Generate draft pages from calendar + verticals", due: "2026-02-14T10:00:00-06:00" },
    ],
  },
  {
    name: "Link Gap + Outreach Prep",
    owner: "marketing-owner",
    due: "2026-02-14T18:00:00-06:00",
    exitCriteria: "Competitor link gap domains identified and outreach queue prepared (no automated email).",
    tasks: [
      { title: "Run DataForSEO domain intersection for competitors", due: "2026-02-14T12:00:00-06:00" },
      { title: "Draft outreach templates referencing linking pages (manual send)", due: "2026-02-14T18:00:00-06:00" },
    ],
  },
  {
    name: "Internal Linking Map",
    owner: "engineering-owner",
    due: "2026-02-14T20:00:00-06:00",
    exitCriteria: "Internal linking suggestions exported for hubs/spokes and adjacent clusters.",
    tasks: [
      { title: "Generate internal linking map from clusters", due: "2026-02-14T20:00:00-06:00" },
    ],
  },
  {
    name: "Technical Audit + Fix Plan",
    owner: "engineering-owner",
    due: "2026-02-15T20:00:00-06:00",
    exitCriteria: "DataForSEO On-Page audit run; prioritized fix plan generated.",
    tasks: [
      { title: "Run DataForSEO On-Page instant pages for priority URLs", due: "2026-02-15T12:00:00-06:00" },
      { title: "Generate prioritized tech SEO fix plan", due: "2026-02-15T20:00:00-06:00" },
    ],
  },
];

async function main() {
  const creds = loadOrgxCredentials();
  const api = new OrgxApi(creds.baseUrl, {
    Authorization: `Bearer ${creds.apiKey}`,
    ...(creds.userId ? { "X-Orgx-User-Id": creds.userId } : {}),
  });

  const desiredTitle = process.env.SEO_INITIATIVE_TITLE?.trim() || DEFAULT_INITIATIVE_TITLE;
  const forcedId = process.env.ORGX_INITIATIVE_ID?.trim() || "";

  let initiative = null;
  if (forcedId) {
    // Best-effort: find by id in list.
    const list = await api.listEntities("initiative", { limit: "500" });
    initiative = list.find((i) => String(i.id ?? "") === forcedId) ?? null;
    if (!initiative) {
      console.error(`[seo-plan] WARNING: ORGX_INITIATIVE_ID=${forcedId} not found by list; proceeding anyway.`);
      initiative = { id: forcedId, title: desiredTitle };
    }
  } else {
    const list = await api.listEntities("initiative", { limit: "500" });
    initiative =
      list.find((i) => normalize(i.title ?? i.name) === normalize(desiredTitle)) ?? null;
    if (!initiative) {
      initiative = await api.createEntity("initiative", {
        title: desiredTitle,
        status: "active",
        summary: `[SEO Plan v1]\nPlan: ${PLAN_VERSION}\nAuto-created initiative.`,
      });
    }
  }

  const initiativeId = String(initiative.id ?? "").trim();
  if (!initiativeId) {
    throw new Error("Failed to resolve initiative id");
  }

  const existingWorkstreams = await api.listEntities("workstream", {
    initiative_id: initiativeId,
    limit: "1000",
  });
  const existingTasks = await api.listEntities("task", {
    initiative_id: initiativeId,
    limit: "4000",
  });

  const wsByName = new Map(existingWorkstreams.map((ws) => [normalize(ws.name ?? ws.title), ws]));

  for (const wsPlan of WORKSTREAMS) {
    let ws = wsByName.get(normalize(wsPlan.name)) ?? null;
    if (!ws) {
      ws = await api.createEntity("workstream", {
        title: wsPlan.name,
        initiative_id: initiativeId,
        status: "not_started",
        summary: buildSummary(wsPlan),
      });
      wsByName.set(normalize(wsPlan.name), ws);
    } else {
      // keep status, refresh summary with plan marker
      await api.updateEntity("workstream", ws.id, {
        summary: buildSummary(wsPlan),
      });
    }

    const wsId = String(ws.id ?? "");

    for (const t of wsPlan.tasks) {
      const existing =
        existingTasks.find(
          (row) =>
            String(row.workstream_id ?? row.workstreamId ?? "") === wsId &&
            normalize(row.title ?? row.name) === normalize(t.title)
        ) ?? null;

      if (existing) {
        await api.updateEntity("task", existing.id, {
          due_date: t.due,
          description: `[SEO Plan v1]\nDue: ${t.due}\nTask: ${t.title}`,
        });
      } else {
        await api.createEntity("task", {
          title: t.title,
          status: "todo",
          priority: "high",
          due_date: t.due,
          description: `[SEO Plan v1]\nDue: ${t.due}\nTask: ${t.title}`,
          workstream_id: wsId,
          initiative_id: initiativeId,
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        planVersion: PLAN_VERSION,
        initiativeId,
        initiativeTitle: desiredTitle,
        workstreamsPlanned: WORKSTREAMS.length,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      null,
      2
    )
  );
  process.exit(1);
});

