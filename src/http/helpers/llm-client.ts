/**
 * Shared LLM client for classification, summarization, and generation tasks.
 *
 * Generalizes the pattern from activity-headline.ts into a reusable client
 * with in-memory caching, timeout, and heuristic fallback.
 */

import { createHash } from "node:crypto";
import { pickString } from "./value-utils.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "openai/gpt-4.1-nano";
const DEFAULT_GENERATION_MODEL = "openai/gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_CACHE_TTL_MS = 12 * 60 * 60_000; // 12 hours
const CACHE_MAX_ENTRIES = 2_000;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmSource = "llm" | "heuristic";

export interface LlmRequest {
  /** Namespace for cache keys (e.g. "retro", "turn_summary", "classify_status") */
  taskId: string;
  systemPrompt: string;
  userPrompt: string;
  /** Override default model. Use DEFAULT_GENERATION_MODEL for longer outputs. */
  model?: string;
  /** Default 0.1 */
  temperature?: number;
  /** Default 128 */
  maxTokens?: number;
  /** Default 4000ms */
  timeoutMs?: number;
  /** Default 12h. Set 0 to disable caching. */
  cacheTtlMs?: number;
}

export interface LlmResponse<T> {
  result: T;
  source: LlmSource;
  model: string | null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: string;
  source: LlmSource;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(taskId: string, content: string): string {
  return `${taskId}:${createHash("sha256").update(content).digest("hex")}`;
}

function trimCache(): void {
  while (cache.size > CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    cache.delete(firstKey);
  }
}

function getCached(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry;
  if (entry) cache.delete(key);
  return null;
}

function setCached(key: string, value: string, source: LlmSource, ttlMs: number): void {
  if (ttlMs <= 0) return;
  cache.set(key, { value, source, expiresAt: Date.now() + ttlMs });
  trimCache();
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

let resolvedApiKey: string | null | undefined;

export function resolveApiKey(): string | null {
  if (resolvedApiKey !== undefined) return resolvedApiKey;

  const candidates = [
    process.env.ORGX_LLM_API_KEY ?? "",
    process.env.ORGX_ACTIVITY_SUMMARY_API_KEY ?? "",
    process.env.OPENROUTER_API_KEY ?? "",
  ];

  const key = candidates.find((c) => c.trim().length > 0)?.trim() ?? "";
  resolvedApiKey = key || null;
  return resolvedApiKey;
}

/** Reset cached key (for testing or key rotation). */
export function resetApiKeyCache(): void {
  resolvedApiKey = undefined;
}

// ---------------------------------------------------------------------------
// OpenRouter completion
// ---------------------------------------------------------------------------

function extractCompletionText(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;

  const firstRecord = first as Record<string, unknown>;
  const message = firstRecord.message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const textParts = content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          const record = part as Record<string, unknown>;
          return typeof record.text === "string" ? record.text : "";
        })
        .filter((part) => part.length > 0);
      if (textParts.length > 0) return textParts.join(" ");
    }
  }

  return pickString(firstRecord, ["text", "content"]);
}

// ---------------------------------------------------------------------------
// Public API: text completion
// ---------------------------------------------------------------------------

/**
 * Call LLM for a text completion with automatic caching and heuristic fallback.
 *
 * @param request - The LLM request configuration
 * @param fallback - Heuristic fallback that produces a result when LLM is unavailable
 * @param parse - Optional transform on the raw LLM text (default: identity)
 */
export async function callLlm(
  request: LlmRequest,
  fallback: () => string,
  parse?: (raw: string) => string | null,
): Promise<LlmResponse<string>> {
  const ttl = request.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const key = cacheKey(request.taskId, `${request.systemPrompt}\n${request.userPrompt}`);

  const cached = getCached(key);
  if (cached) {
    return { result: cached.value, source: cached.source, model: null };
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    const heuristic = fallback();
    setCached(key, heuristic, "heuristic", ttl);
    return { result: heuristic, source: "heuristic", model: null };
  }

  const model = process.env.ORGX_LLM_MODEL?.trim() || request.model || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: request.temperature ?? 0.1,
        max_tokens: request.maxTokens ?? 128,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const raw = extractCompletionText(payload) ?? "";
    const parsed = parse ? parse(raw) : raw.trim();

    if (parsed && parsed.length > 0) {
      setCached(key, parsed, "llm", ttl);
      return { result: parsed, source: "llm", model };
    }

    const heuristic = fallback();
    setCached(key, heuristic, "heuristic", ttl);
    return { result: heuristic, source: "heuristic", model };
  } catch {
    const heuristic = fallback();
    setCached(key, heuristic, "heuristic", ttl);
    return { result: heuristic, source: "heuristic", model: null };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API: JSON-structured completion
// ---------------------------------------------------------------------------

/**
 * Call LLM expecting a JSON response. Parses and validates via the provided parser.
 *
 * @param request - The LLM request (systemPrompt should instruct JSON output)
 * @param parse - Parse raw JSON string into typed result, return null on failure
 * @param fallback - Heuristic fallback
 */
export async function callLlmJson<T>(
  request: LlmRequest,
  parse: (raw: string) => T | null,
  fallback: () => T,
): Promise<LlmResponse<T>> {
  const ttl = request.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const key = cacheKey(request.taskId, `${request.systemPrompt}\n${request.userPrompt}`);

  const cached = getCached(key);
  if (cached) {
    const parsed = parse(cached.value);
    if (parsed !== null) {
      return { result: parsed, source: cached.source, model: null };
    }
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    const heuristic = fallback();
    return { result: heuristic, source: "heuristic", model: null };
  }

  const model =
    process.env.ORGX_LLM_MODEL?.trim() || request.model || DEFAULT_GENERATION_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: request.temperature ?? 0.1,
        max_tokens: request.maxTokens ?? 512,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LLM request failed (${response.status})`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const raw = extractCompletionText(payload) ?? "";

    // Try to extract JSON from markdown fences or raw text
    const jsonStr = extractJsonFromText(raw);
    const parsed = parse(jsonStr);

    if (parsed !== null) {
      setCached(key, jsonStr, "llm", ttl);
      return { result: parsed, source: "llm", model };
    }

    return { result: fallback(), source: "heuristic", model };
  } catch {
    return { result: fallback(), source: "heuristic", model: null };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJsonFromText(text: string): string {
  const trimmed = text.trim();

  // Try markdown JSON fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  // Try raw JSON (starts with { or [)
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;

  // Try to find JSON embedded in text
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart >= 0) {
    const candidate = trimmed.slice(jsonStart);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // fall through
    }
  }

  return trimmed;
}
