import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadDotEnv } from "./env.mjs";
import {
  asyncPool,
  nowRunId,
  normalizeKeyword,
  pickTopByScore,
  toHostname,
  uniqStrings,
  writeCsv,
  writeJson,
  writeText,
} from "./util.mjs";
import { getPasfKeywords, getRelatedKeywords } from "./keywords-everywhere.mjs";
import {
  backlinksDomainIntersection,
  keywordOverviewLive,
  onPageInstantPages,
  serpGoogleOrganicLiveAdvanced,
} from "./dataforseo.mjs";
import { clusterKeywords, inferIntent } from "./cluster.mjs";
import { generateLandingPages } from "./pages.mjs";

function readJson(pathname) {
  return JSON.parse(readFileSync(pathname, "utf8"));
}

function scoreKeyword(row) {
  const volume = Number(row.search_volume ?? 0) || 0;
  const kd = Number(row.keyword_difficulty ?? 0) || 0;
  const cpc = Number(row.cpc ?? 0) || 0;
  // Simple scoring: prefer higher volume, lower KD, and some commercial signal via CPC.
  return Math.max(0, volume) * (1 + Math.min(2, cpc / 2)) / (1 + kd);
}

function buildCalendarRows({ clusters, metricsByKeyword, target }) {
  const rows = [];
  for (const cluster of clusters) {
    const entries = cluster.keywords.map((kw) => {
      const m = metricsByKeyword.get(normalizeKeyword(kw)) ?? null;
      return {
        keyword: kw,
        search_volume: m?.search_volume ?? 0,
        keyword_difficulty: m?.keyword_difficulty ?? null,
        cpc: m?.cpc ?? null,
        competition: m?.competition ?? null,
        score: m ? scoreKeyword(m) : 0,
      };
    });
    entries.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const primary = entries[0]?.keyword ?? cluster.keywords[0] ?? null;
    if (!primary) continue;

    const intent = inferIntent(primary);
    const slug = primary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    const title = `${primary} | ${target.brandName}`;

    rows.push({
      cluster_id: cluster.id,
      cluster_label: cluster.label,
      primary_keyword: primary,
      intent,
      slug,
      title,
      meta_description: `${target.brandName} for ${primary}. ${target.productOneLiner}`,
      top_keywords: entries
        .slice(0, 12)
        .map((e) => e.keyword)
        .join(" | "),
      total_keywords: cluster.keywords.length,
      cluster_score: Math.round(entries.slice(0, 20).reduce((s, e) => s + (e.score ?? 0), 0) * 100) / 100,
      max_volume: Math.max(...entries.map((e) => Number(e.search_volume ?? 0) || 0), 0),
      min_kd: entries.reduce((min, e) => {
        const kd = e.keyword_difficulty;
        if (kd === null || kd === undefined) return min;
        return min === null ? kd : Math.min(min, kd);
      }, null),
    });
  }

  rows.sort((a, b) => (b.cluster_score ?? 0) - (a.cluster_score ?? 0));
  return rows;
}

function parseKeywordOverviewResponse(payload) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const out = [];
  for (const task of tasks) {
    const results = Array.isArray(task?.result) ? task.result : [];
    for (const r of results) {
      const kw = String(r?.keyword ?? "").trim();
      if (!kw) continue;
      const info = r?.keyword_info ?? {};
      const props = r?.keyword_properties ?? {};
      out.push({
        keyword: kw,
        search_volume: info.search_volume ?? null,
        cpc: info.cpc ?? null,
        competition: info.competition ?? null,
        competition_level: info.competition_level ?? null,
        keyword_difficulty: props.keyword_difficulty ?? null,
        core_keyword: props.core_keyword ?? null,
      });
    }
  }
  return out;
}

function parseSerpTop(payload, { depth = 10 } = {}) {
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  const items = [];
  for (const task of tasks) {
    const results = Array.isArray(task?.result) ? task.result : [];
    for (const r of results) {
      const keyword = String(r?.keyword ?? "").trim();
      const i = Array.isArray(r?.items) ? r.items : [];
      for (const item of i) {
        if (!item || typeof item !== "object") continue;
        const type = String(item.type ?? "");
        if (type !== "organic") continue;
        const rank = Number(item.rank_absolute ?? item.rank_group ?? 0) || null;
        const url = String(item.url ?? "");
        const domain = String(item.domain ?? "");
        items.push({
          keyword,
          rank,
          domain: toHostname(domain || url),
          url,
          title: String(item.title ?? ""),
          description: String(item.description ?? ""),
        });
      }
    }
  }

  // Keep top N per keyword
  const byKw = new Map();
  for (const item of items) {
    if (!byKw.has(item.keyword)) byKw.set(item.keyword, []);
    byKw.get(item.keyword).push(item);
  }
  const out = [];
  for (const [kw, list] of byKw.entries()) {
    list.sort((a, b) => (a.rank ?? 9e9) - (b.rank ?? 9e9));
    out.push(...list.slice(0, depth));
  }
  return out;
}

export async function runSeoPipeline({
  configPath,
  mode = "all",
  outBase = "artifacts/seo",
  dryRun = false,
}) {
  loadDotEnv(".env");

  const cfg = readJson(configPath);
  const runId = nowRunId();
  const outDir = resolve(outBase, runId);

  const target = {
    domain: toHostname(cfg?.target?.domain ?? ""),
    brandName: String(cfg?.target?.brandName ?? "Brand"),
    productOneLiner: String(cfg?.target?.productOneLiner ?? ""),
  };

  if (!target.domain) {
    throw new Error(`Invalid config: target.domain is required (${configPath})`);
  }

  const seedKeywords = uniqStrings(cfg?.seedKeywords ?? []);
  const competitors = Array.isArray(cfg?.competitors) ? cfg.competitors : [];

  const keRelatedLimit = Number(cfg?.keywordsEverywhere?.relatedLimit ?? 200) || 200;
  const kePasfLimit = Number(cfg?.keywordsEverywhere?.pasfLimit ?? 200) || 200;

  const locationCode = Number(cfg?.dataforseo?.locationCode ?? 2840) || 2840;
  const languageCode = String(cfg?.dataforseo?.languageCode ?? "en");
  const serpDepth = Number(cfg?.dataforseo?.serpDepth ?? 10) || 10;

  const maxUniverseKeywords = Number(cfg?.pipeline?.maxUniverseKeywords ?? 5000) || 5000;
  const maxSerpKeywords = Number(cfg?.pipeline?.maxSerpKeywords ?? 300) || 300;
  const minSearchVolume = Number(cfg?.pipeline?.minSearchVolume ?? 10) || 10;

  writeJson(join(outDir, "config.json"), { ...cfg, target });

  const outputs = {
    outDir,
    runId,
    universe: null,
    metrics: null,
    calendar: null,
    serp: null,
    linkgap: null,
    audit: null,
    pages: null,
  };

  const wants = (name) => mode === "all" || mode === name;

  // ---------------------------------------------------------------------------
  // Keyword universe
  // ---------------------------------------------------------------------------
  let universe = [];
  if (wants("universe") || wants("all") || wants("calendar") || wants("metrics") || wants("serp") || wants("pages")) {
    if (dryRun) {
      universe = uniqStrings([
        ...seedKeywords,
        ...seedKeywords.map((k) => `${k} software`),
        ...seedKeywords.map((k) => `${k} tools`),
        ...seedKeywords.map((k) => `${k} for saas`),
      ]).slice(0, 50);
    } else {
      const expanded = [];
      const related = await asyncPool(4, seedKeywords, async (kw) => {
        const list = await getRelatedKeywords({ keyword: kw, limit: keRelatedLimit });
        return list;
      });
      const pasf = await asyncPool(4, seedKeywords, async (kw) => {
        const list = await getPasfKeywords({ keyword: kw, limit: kePasfLimit });
        return list;
      });
      for (const list of related) expanded.push(...(list ?? []));
      for (const list of pasf) expanded.push(...(list ?? []));

      universe = uniqStrings([...seedKeywords, ...expanded]).slice(0, maxUniverseKeywords);
    }

    writeJson(join(outDir, "universe.keywords.json"), universe);
    writeText(join(outDir, "universe.keywords.txt"), universe.join("\n") + "\n");
    outputs.universe = { count: universe.length };
  }

  // ---------------------------------------------------------------------------
  // Metrics (DataForSEO Labs keyword overview)
  // ---------------------------------------------------------------------------
  const metricsRows = [];
  const metricsByKeyword = new Map();
  if (wants("metrics") || wants("all") || wants("calendar") || wants("serp") || wants("pages")) {
    if (dryRun) {
      for (const kw of universe) {
        const v = Math.floor(Math.random() * 2000);
        const kd = Math.round(Math.random() * 80);
        const row = {
          keyword: kw,
          search_volume: v,
          cpc: Math.round(Math.random() * 500) / 100,
          competition: Math.round(Math.random() * 100) / 100,
          competition_level: "LOW",
          keyword_difficulty: kd,
          core_keyword: null,
        };
        metricsRows.push(row);
        metricsByKeyword.set(normalizeKeyword(kw), row);
      }
    } else {
      // Batch by 700 (DataForSEO Labs limit varies; keep conservative)
      const batchSize = 600;
      for (let i = 0; i < universe.length; i += batchSize) {
        const batch = universe.slice(i, i + batchSize);
        const payload = await keywordOverviewLive({
          keywords: batch,
          locationCode,
          languageCode,
        });
        const rows = parseKeywordOverviewResponse(payload);
        for (const r of rows) {
          metricsRows.push(r);
          metricsByKeyword.set(normalizeKeyword(r.keyword), r);
        }
      }
    }

    const scored = metricsRows
      .map((r) => ({ ...r, score: scoreKeyword(r) }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    writeJson(join(outDir, "metrics.keyword_overview.json"), scored);
    writeCsv(join(outDir, "metrics.keyword_overview.csv"), scored);
    outputs.metrics = { count: scored.length };
  }

  // ---------------------------------------------------------------------------
  // Calendar + clustering
  // ---------------------------------------------------------------------------
  let calendarRows = [];
  if (wants("calendar") || wants("all") || wants("pages")) {
    const filteredUniverse =
      metricsRows.length > 0
        ? metricsRows
            .filter((r) => (Number(r.search_volume ?? 0) || 0) >= minSearchVolume)
            .map((r) => r.keyword)
        : universe;

    const clusters = clusterKeywords(filteredUniverse, { minSimilarity: 0.5 });
    const rows = buildCalendarRows({ clusters, metricsByKeyword, target });
    calendarRows = rows;

    writeJson(join(outDir, "calendar.clusters.json"), clusters);
    writeCsv(join(outDir, "calendar.rows.csv"), rows);
    outputs.calendar = { clusters: clusters.length, rows: rows.length };
  }

  // ---------------------------------------------------------------------------
  // Programmatic pages (drafts)
  // ---------------------------------------------------------------------------
  if (wants("pages") || wants("all")) {
    const verticals = Array.isArray(cfg?.verticals) ? cfg.verticals : [];
    const baseRows = calendarRows.slice(0, 200);
    const expandedRows = [];

    for (const row of baseRows) {
      expandedRows.push(row);
      for (const v of verticals) {
        const name = String(v?.name ?? "").trim();
        const slug = String(v?.slug ?? "").trim();
        if (!name || !slug) continue;
        expandedRows.push({
          ...row,
          slug: `${row.slug}-${slug}`,
          primary_keyword: `${row.primary_keyword} for ${name}`,
          title: `${row.primary_keyword} for ${name} | ${target.brandName}`,
          meta_description: `${target.brandName} for ${row.primary_keyword} in ${name}. ${target.productOneLiner}`,
        });
      }
    }

    const templatePath = resolve("templates/seo/programmatic-landing-page.md");
    const outPagesDir = join(outDir, "pages");
    const written = generateLandingPages({
      outDir: outPagesDir,
      templatePath,
      target,
      calendarRows: expandedRows,
    });
    writeJson(join(outDir, "pages.manifest.json"), written);
    outputs.pages = { written: written.length, dir: outPagesDir };
  }

  // ---------------------------------------------------------------------------
  // SERP gap analysis
  // ---------------------------------------------------------------------------
  if (wants("serp") || wants("all")) {
    const candidates = metricsRows.length > 0 ? metricsRows : universe.map((k) => ({ keyword: k, search_volume: 0, keyword_difficulty: null, cpc: null }));

    const eligible = candidates
      .filter((r) => (Number(r.search_volume ?? 0) || 0) >= minSearchVolume)
      .map((r) => ({ ...r, score: scoreKeyword(r) }));

    const top = pickTopByScore(eligible, (r) => r.score, maxSerpKeywords);
    const topKeywords = top.map((r) => r.keyword);

    let serpTop = [];
    if (dryRun) {
      serpTop = topKeywords.flatMap((kw) => [
        { keyword: kw, rank: 1, domain: "wikipedia.org", url: `https://en.wikipedia.org/wiki/${encodeURIComponent(kw)}`, title: kw, description: "" },
        { keyword: kw, rank: 2, domain: competitors[0]?.domain ? toHostname(competitors[0].domain) : "competitor-a.com", url: `https://${competitors[0]?.domain ?? "competitor-a.com"}/`, title: "Competitor", description: "" },
      ]);
    } else {
      const payloads = await asyncPool(3, topKeywords, async (kw) => {
        return await serpGoogleOrganicLiveAdvanced({
          keyword: kw,
          locationCode,
          languageCode,
          depth: serpDepth,
        });
      });
      for (const p of payloads) {
        serpTop.push(...parseSerpTop(p, { depth: serpDepth }));
      }
    }

    const targetDomain = toHostname(target.domain);
    const competitorDomains = competitors.map((c) => toHostname(c.domain));

    const gaps = [];
    const byKw = new Map();
    for (const item of serpTop) {
      if (!byKw.has(item.keyword)) byKw.set(item.keyword, []);
      byKw.get(item.keyword).push(item);
    }

    for (const [kw, list] of byKw.entries()) {
      list.sort((a, b) => (a.rank ?? 9e9) - (b.rank ?? 9e9));
      const targetHit = list.find((r) => r.domain === targetDomain) ?? null;
      const topDomains = uniqStrings(list.map((r) => r.domain)).slice(0, 6);
      const competitorHits = competitorDomains.filter((d) => list.some((r) => r.domain === d));

      gaps.push({
        keyword: kw,
        intent: inferIntent(kw),
        target_rank: targetHit?.rank ?? null,
        target_url: targetHit?.url ?? null,
        competitor_domains_present: competitorHits.join(" | "),
        top_domains: topDomains.join(" | "),
      });
    }

    writeJson(join(outDir, "serp.top.json"), serpTop);
    writeCsv(join(outDir, "serp.gaps.csv"), gaps);
    outputs.serp = { keywords: byKw.size, items: serpTop.length };
  }

  // ---------------------------------------------------------------------------
  // Link gap (domain intersection)
  // ---------------------------------------------------------------------------
  if (wants("linkgap") || wants("all")) {
    let payload = null;
    if (dryRun) {
      payload = { ok: true, tasks: [] };
    } else {
      payload = await backlinksDomainIntersection({
        competitors,
        excludeTarget: target.domain,
        limit: 1000,
      });
    }
    writeJson(join(outDir, "linkgap.domain_intersection.raw.json"), payload);
    outputs.linkgap = { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Technical audit (instant pages starter)
  // ---------------------------------------------------------------------------
  if (wants("audit") || wants("all")) {
    const urls = [
      `https://${target.domain}/`,
      `https://${target.domain}/pricing`,
      `https://${target.domain}/blog`,
    ];
    let payload = null;
    if (dryRun) {
      payload = { ok: true, note: "dry-run" };
    } else {
      payload = await onPageInstantPages({ urls });
    }
    writeJson(join(outDir, "audit.onpage.instant_pages.raw.json"), payload);
    outputs.audit = { ok: true, urls: urls.length };
  }

  writeJson(join(outDir, "run.summary.json"), outputs);
  return outputs;
}

