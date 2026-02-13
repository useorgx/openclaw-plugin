import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function nowRunId() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10);
  const hms = d.toISOString().slice(11, 19).replace(/:/g, "");
  return `${ymd}-${hms}Z`;
}

export function ensureDir(pathname) {
  mkdirSync(pathname, { recursive: true });
}

export function writeJson(pathname, value) {
  ensureDir(dirname(pathname));
  writeFileSync(pathname, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeText(pathname, text) {
  ensureDir(dirname(pathname));
  writeFileSync(pathname, String(text ?? ""), "utf8");
}

function escapeCsvCell(value) {
  const raw = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function writeCsv(pathname, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    writeText(pathname, "");
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvCell(row?.[h])).join(","));
  }
  writeText(pathname, lines.join("\n") + "\n");
}

export async function asyncPool(limit, items, worker) {
  const size = Math.max(1, Math.floor(Number(limit) || 1));
  const results = new Array(items.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

export function toHostname(input) {
  try {
    const u = input.startsWith("http") ? new URL(input) : new URL(`https://${input}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return String(input ?? "").trim().replace(/^www\./, "").toLowerCase();
  }
}

export function normalizeKeyword(input) {
  return String(input ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

export function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function pickTopByScore(items, scoreFn, limit) {
  const scored = items
    .map((item) => ({ item, score: Number(scoreFn(item) ?? 0) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, Number(limit) || 0)).map((row) => row.item);
}

