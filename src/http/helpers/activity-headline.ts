import { createHash } from "node:crypto";
import { pickString } from "./value-utils.js";

const ACTIVITY_HEADLINE_TIMEOUT_MS = 4_000;
const ACTIVITY_HEADLINE_CACHE_TTL_MS = 12 * 60 * 60_000;
const ACTIVITY_HEADLINE_CACHE_MAX = 1_000;
const ACTIVITY_HEADLINE_MAX_INPUT_CHARS = 8_000;
const DEFAULT_ACTIVITY_HEADLINE_MODEL = "openai/gpt-4.1-nano";

export type ActivityHeadlineSource = "llm" | "heuristic";

interface ActivityHeadlineCacheEntry {
  headline: string;
  source: ActivityHeadlineSource;
  expiresAt: number;
}

const activityHeadlineCache = new Map<string, ActivityHeadlineCacheEntry>();
let resolvedActivitySummaryApiKey: string | null | undefined;

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripMarkdownLite(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function cleanActivityHeadline(value: string): string {
  const lines = stripMarkdownLite(value)
    .split("\n")
    .map((line) => normalizeSpaces(line))
    .filter((line) => line.length > 0 && !/^\|?[:\-| ]+\|?$/.test(line));
  const headline = lines[0] ?? "";
  if (!headline) return "";
  if (headline.length <= 108) return headline;
  return `${headline.slice(0, 107).trimEnd()}…`;
}

function heuristicActivityHeadline(text: string, title?: string | null): string {
  const cleanedText = cleanActivityHeadline(text);
  if (cleanedText.length > 0) return cleanedText;
  const cleanedTitle = cleanActivityHeadline(title ?? "");
  if (cleanedTitle.length > 0) return cleanedTitle;
  return "Activity update";
}

function resolveActivitySummaryApiKey(): string | null {
  if (resolvedActivitySummaryApiKey !== undefined) {
    return resolvedActivitySummaryApiKey;
  }

  const candidates = [
    process.env.ORGX_ACTIVITY_SUMMARY_API_KEY ?? "",
    process.env.OPENROUTER_API_KEY ?? "",
  ];

  const key = candidates.find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
  resolvedActivitySummaryApiKey = key || null;
  return resolvedActivitySummaryApiKey;
}

function trimActivityHeadlineCache(): void {
  while (activityHeadlineCache.size > ACTIVITY_HEADLINE_CACHE_MAX) {
    const firstKey = activityHeadlineCache.keys().next().value;
    if (!firstKey) break;
    activityHeadlineCache.delete(firstKey);
  }
}

function extractCompletionText(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;

  const firstRecord = first as Record<string, unknown>;
  const message = firstRecord.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const textParts = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const record = part as Record<string, unknown>;
          return typeof record.text === "string" ? record.text : "";
        })
        .filter((part) => part.length > 0);
      if (textParts.length > 0) {
        return textParts.join(" ");
      }
    }
  }

  return pickString(firstRecord, ["text", "content"]);
}

export async function summarizeActivityHeadline(input: {
  text: string;
  title?: string | null;
  type?: string | null;
}): Promise<{ headline: string; source: ActivityHeadlineSource; model: string | null }> {
  const normalizedText = normalizeSpaces(input.text).slice(0, ACTIVITY_HEADLINE_MAX_INPUT_CHARS);
  const normalizedTitle = normalizeSpaces(input.title ?? "");
  const normalizedType = normalizeSpaces(input.type ?? "");
  const heuristic = heuristicActivityHeadline(normalizedText, normalizedTitle);

  const cacheKey = createHash("sha256")
    .update(`${normalizedType}\n${normalizedTitle}\n${normalizedText}`)
    .digest("hex");

  const cached = activityHeadlineCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { headline: cached.headline, source: cached.source, model: null };
  }

  const apiKey = resolveActivitySummaryApiKey();
  if (!apiKey) {
    activityHeadlineCache.set(cacheKey, {
      headline: heuristic,
      source: "heuristic",
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline: heuristic, source: "heuristic", model: null };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACTIVITY_HEADLINE_TIMEOUT_MS);

  const model =
    process.env.ORGX_ACTIVITY_SUMMARY_MODEL?.trim() || DEFAULT_ACTIVITY_HEADLINE_MODEL;
  const prompt = [
    "Create one short activity title for a dashboard header.",
    "Rules:",
    "- Max 96 characters.",
    "- Keep key numbers/status markers (for example: 15 tasks, 0 blocked).",
    "- No markdown, no quotes, no trailing period unless needed.",
    "- Prefer plain language over jargon.",
    "",
    `Type: ${normalizedType || "activity"}`,
    normalizedTitle ? `Current title: ${normalizedTitle}` : "",
    "Full detail:",
    normalizedText,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 48,
        messages: [
          {
            role: "system",
            content:
              "You write concise activity headers for operational dashboards. Return only the header text.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`headline model request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const generated = cleanActivityHeadline(extractCompletionText(payload) ?? "");
    const headline = generated || heuristic;
    const source: ActivityHeadlineSource = generated ? "llm" : "heuristic";
    activityHeadlineCache.set(cacheKey, {
      headline,
      source,
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline, source, model };
  } catch {
    activityHeadlineCache.set(cacheKey, {
      headline: heuristic,
      source: "heuristic",
      expiresAt: Date.now() + ACTIVITY_HEADLINE_CACHE_TTL_MS,
    });
    trimActivityHeadlineCache();
    return { headline: heuristic, source: "heuristic", model: null };
  } finally {
    clearTimeout(timeout);
  }
}
