import { toHostname } from "./util.mjs";

const DFS_BASE = "https://api.dataforseo.com/v3";

function requireDfsCreds() {
  const login =
    process.env.DATAFORSEO_LOGIN?.trim() ||
    process.env.DATAFORSEO_API_LOGIN?.trim() ||
    "";
  const password =
    process.env.DATAFORSEO_PASSWORD?.trim() ||
    process.env.DATAFORSEO_API_PASSWORD?.trim() ||
    "";

  if (!login || !password) {
    throw new Error(
      "Missing DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD (or DATAFORSEO_API_LOGIN + DATAFORSEO_API_PASSWORD) in env/.env"
    );
  }
  return { login, password };
}

function basicAuthHeader(login, password) {
  const token = Buffer.from(`${login}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

export async function dfsPost(path, payload) {
  const { login, password } = requireDfsCreds();
  const response = await fetch(`${DFS_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(login, password),
      "Content-Type": "application/json",
      Accept: "application/json",
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
      `DataForSEO HTTP ${response.status}: ${
        typeof parsed === "string" ? parsed : JSON.stringify(parsed)
      }`
    );
  }

  return parsed;
}

export async function keywordOverviewLive({
  keywords,
  locationCode = 2840,
  languageCode = "en",
}) {
  const tasks = (Array.isArray(keywords) ? keywords : [])
    .map((k) => String(k ?? "").trim())
    .filter(Boolean)
    .map((keyword) => ({
      keyword,
      location_code: Number(locationCode),
      language_code: String(languageCode),
    }));

  if (tasks.length === 0) return { tasks: [] };

  return await dfsPost("/dataforseo_labs/google/keyword_overview/live", tasks);
}

export async function serpGoogleOrganicLiveAdvanced({
  keyword,
  locationCode = 2840,
  languageCode = "en",
  depth = 10,
  device = "desktop",
  os = "windows",
}) {
  const tasks = [
    {
      keyword: String(keyword ?? ""),
      location_code: Number(locationCode),
      language_code: String(languageCode),
      depth: Math.max(1, Math.min(100, Number(depth) || 10)),
      device: String(device),
      os: String(os),
    },
  ];
  return await dfsPost("/serp/google/organic/live/advanced", tasks);
}

export async function backlinksDomainIntersection({
  competitors,
  excludeTarget,
  limit = 1000,
  includeSubdomains = false,
}) {
  const targets = {};
  const list = Array.isArray(competitors) ? competitors : [];
  let idx = 1;
  for (const c of list) {
    const domain = toHostname(c?.domain ?? c);
    if (!domain) continue;
    targets[String(idx)] = domain;
    idx += 1;
  }
  if (Object.keys(targets).length < 2) {
    throw new Error("domain_intersection requires at least 2 competitor domains");
  }

  const exclude = toHostname(excludeTarget ?? "");
  const payload = [
    {
      targets,
      exclude_targets: exclude ? [exclude] : [],
      include_subdomains: Boolean(includeSubdomains),
      exclude_internal_backlinks: true,
      limit: Math.max(1, Math.min(10000, Number(limit) || 1000)),
      order_by: ["1.backlinks,desc"],
    },
  ];

  return await dfsPost("/backlinks/domain_intersection/live", payload);
}

export async function onPageInstantPages({
  urls,
  customUserAgent = null,
  loadResources = false,
  enableJavascript = false,
}) {
  const list = (Array.isArray(urls) ? urls : [])
    .map((u) => String(u ?? "").trim())
    .filter(Boolean);
  const payload = [
    {
      url: list,
      ...(customUserAgent ? { custom_user_agent: String(customUserAgent) } : {}),
      load_resources: Boolean(loadResources),
      enable_javascript: Boolean(enableJavascript),
    },
  ];
  return await dfsPost("/on_page/instant_pages", payload);
}

