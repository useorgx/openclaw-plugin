import { normalizeKeyword } from "./util.mjs";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "vs",
  "versus",
]);

function tokenize(kw) {
  const normalized = normalizeKeyword(kw);
  const tokens = normalized.split(" ").filter(Boolean);
  return tokens.filter((t) => !STOPWORDS.has(t));
}

function signature(tokens) {
  // Stable-ish signature: first 3 meaningful tokens
  return tokens.slice(0, 3).join(" ");
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function clusterKeywords(keywords, { minSimilarity = 0.5 } = {}) {
  const list = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k ?? "").trim())
    .filter(Boolean);

  const items = list.map((kw) => {
    const tokens = tokenize(kw);
    return {
      keyword: kw,
      norm: normalizeKeyword(kw),
      tokens,
      tokenSet: new Set(tokens),
      sig: signature(tokens),
    };
  });

  const clusters = [];
  const bySig = new Map();
  for (const item of items) {
    const key = item.sig || item.norm;
    if (!bySig.has(key)) bySig.set(key, []);
    bySig.get(key).push(item);
  }

  // Seed clusters by signature, then merge near clusters by Jaccard.
  for (const group of bySig.values()) {
    clusters.push({
      id: `c_${clusters.length + 1}`,
      keywords: group.map((g) => g.keyword),
      centroidTokens: group[0]?.tokenSet ?? new Set(),
    });
  }

  const merged = [];
  for (const c of clusters) {
    let placed = false;
    for (const m of merged) {
      const sim = jaccard(c.centroidTokens, m.centroidTokens);
      if (sim >= minSimilarity) {
        m.keywords.push(...c.keywords);
        // Expand centroid (union)
        for (const t of c.centroidTokens) m.centroidTokens.add(t);
        placed = true;
        break;
      }
    }
    if (!placed) {
      merged.push({
        ...c,
        centroidTokens: new Set(c.centroidTokens),
      });
    }
  }

  return merged
    .map((c) => ({
      id: c.id,
      label: Array.from(c.centroidTokens).slice(0, 6).join(" "),
      keywords: Array.from(new Set(c.keywords)),
    }))
    .sort((a, b) => b.keywords.length - a.keywords.length);
}

export function inferIntent(keyword) {
  const k = normalizeKeyword(keyword);
  if (/\bvs\b|\bversus\b/.test(k)) return "comparison";
  if (/\bpricing\b|\bcost\b|\bprice\b/.test(k)) return "pricing";
  if (/\btemplate\b|\bexamples?\b/.test(k)) return "template";
  if (/\bintegration\b|\bplugin\b|\bconnect\b/.test(k)) return "integration";
  if (/\bhow to\b|\bguide\b|\btutorial\b/.test(k)) return "guide";
  if (/\bbest\b|\btop\b|\breview\b|\balternatives?\b/.test(k)) return "commercial";
  if (/\bwhat is\b|\bdefinition\b/.test(k)) return "informational";
  return "landing";
}

