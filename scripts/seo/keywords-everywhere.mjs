import { normalizeKeyword, uniqStrings } from "./util.mjs";

const KE_BASE = "https://api.keywordseverywhere.com/v1";

function requireKeKey() {
  const key =
    process.env.KEYWORDS_EVERYWHERE_API_KEY?.trim() ||
    process.env.KEYWORDS_EVERYWHERE_KEY?.trim() ||
    "";
  if (!key) {
    throw new Error(
      "Missing KEYWORDS_EVERYWHERE_API_KEY (or KEYWORDS_EVERYWHERE_KEY) in env/.env"
    );
  }
  return key;
}

async function kePostForm(path, form) {
  const key = requireKeKey();
  const response = await fetch(`${KE_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new Error(
      `Keywords Everywhere HTTP ${response.status}: ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`
    );
  }

  return parsed;
}

async function kePostJson(path, payload) {
  const key = requireKeKey();
  const response = await fetch(`${KE_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new Error(
      `Keywords Everywhere HTTP ${response.status}: ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`
    );
  }

  return parsed;
}

export async function getRelatedKeywords({ keyword, limit = 200 }) {
  const raw = await kePostForm("/get_related_keywords", {
    keyword: String(keyword ?? ""),
    num: String(Math.max(1, Math.min(1000, Number(limit) || 200))),
  });
  const list = Array.isArray(raw) ? raw : [];
  return uniqStrings(list.map((k) => normalizeKeyword(k)));
}

export async function getPasfKeywords({ keyword, limit = 200 }) {
  const raw = await kePostForm("/get_pasf_keywords", {
    keyword: String(keyword ?? ""),
    num: String(Math.max(1, Math.min(1000, Number(limit) || 200))),
  });
  const list = Array.isArray(raw) ? raw : [];
  return uniqStrings(list.map((k) => normalizeKeyword(k)));
}

export async function getCreditBalance() {
  const raw = await kePostForm("/get_credit_balance", {});
  return raw;
}

/**
 * Optional: KE keyword metrics (volume/cpc/competition). Prefer DataForSEO Labs for
 * canonical metrics when available, but this can be useful for cross-checking.
 */
export async function getKeywordData({
  keywords,
  country = "us",
  currency = "usd",
  dataSource = "gkp",
}) {
  const list = Array.isArray(keywords) ? keywords : [];
  const payload = {
    "kw[]": list.map((k) => String(k ?? "")),
    country,
    currency,
    dataSource,
  };
  return await kePostJson("/get_keyword_data", payload);
}

