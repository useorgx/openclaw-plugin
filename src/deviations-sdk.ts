import { createHash } from "node:crypto";

/**
 * Daily Brief — deviation ingestion SDK.
 *
 * Call when a skill fires locally (pre-PR, pre-commit, pre-chat) against
 * a file edit, commit, PR, chat turn, or task output. The server enforces
 * dedupe via UNIQUE (workspace_id, dedupe_key); plugin-side computation
 * here matches the server's expectation:
 *
 *   dedupe_key = sha1(skill_id | evidence_kind | evidence_ref | floor(epoch/600))
 *
 * 10-minute bucketing handles save-happy editors without losing legitimate
 * re-fires beyond that window.
 *
 * Endpoint contract: see orgx/docs/api-contracts/daily-brief-schema.md §04.
 */

export type EvidenceKind =
  | "pr"
  | "commit"
  | "file_edit"
  | "chat_turn"
  | "task_output";

export type ApplicationSource =
  | "agent_run"
  | "plugin_cursor"
  | "plugin_claude"
  | "plugin_codex"
  | "plugin_openclaw"
  | "manual";

export type DeviationOutcome =
  | "pending"
  | "confirmed"
  | "rejected"
  | "ignored";

export interface PostDeviationInput {
  skillId: string;
  evidenceKind: EvidenceKind;
  /** e.g. "finance-dashboard#142" or "/path/to/file.py:42" */
  evidenceRef: string;
  summary: string;
  applicationSource: ApplicationSource;
  /** 0..1 — plugin-measured match confidence */
  confidence: number;
  outcome?: DeviationOutcome;
  triggerContext?: Record<string, unknown>;
  capturedAt?: Date;
  taskId?: string;
  runId?: string;
}

export interface PostDeviationOptions {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  abortAfterMs?: number;
}

export interface PostDeviationResult {
  ok: boolean;
  id: string | null;
  deduplicated: boolean;
  status: number;
  error?: string;
}

export function computeDedupeKey(input: {
  skillId: string;
  evidenceKind: EvidenceKind;
  evidenceRef: string;
  capturedAt?: Date;
}): string {
  const now = input.capturedAt ?? new Date();
  const bucket = Math.floor(now.getTime() / 1000 / 600);
  const material = [
    input.skillId,
    input.evidenceKind,
    input.evidenceRef,
    String(bucket),
  ].join("|");
  return createHash("sha1").update(material).digest("hex");
}

/**
 * Post a deviation to OrgX. Returns the result shape from the server.
 *
 * On HTTP 409 / duplicate-key the server treats it as deduplicated — callers
 * usually don't need to distinguish (the outcome is the same).
 */
export async function postDeviation(
  input: PostDeviationInput,
  options: PostDeviationOptions,
): Promise<PostDeviationResult> {
  const capturedAt = input.capturedAt ?? new Date();
  const dedupeKey = computeDedupeKey({
    skillId: input.skillId,
    evidenceKind: input.evidenceKind,
    evidenceRef: input.evidenceRef,
    capturedAt,
  });

  const url = buildUrl(options.apiBaseUrl, input.skillId);
  const body = JSON.stringify({
    evidence_kind: input.evidenceKind,
    evidence_ref: input.evidenceRef,
    summary: input.summary,
    application_source: input.applicationSource,
    confidence: input.confidence,
    outcome: input.outcome ?? "pending",
    trigger_context: input.triggerContext ?? {},
    dedupe_key: dedupeKey,
    captured_at: capturedAt.toISOString(),
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.runId ? { run_id: input.runId } : {}),
  });

  const controller = new AbortController();
  const timeoutId = options.abortAfterMs
    ? setTimeout(() => controller.abort(), options.abortAfterMs)
    : null;

  try {
    const fetchFn = options.fetchImpl ?? fetch;
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });

    const payload = await response
      .json()
      .catch(() => null) as {
        id?: string | null;
        deduplicated?: boolean;
        error?: string;
      } | null;

    if (!response.ok) {
      return {
        ok: false,
        id: payload?.id ?? null,
        deduplicated: false,
        status: response.status,
        error: payload?.error ?? `HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      id: payload?.id ?? null,
      deduplicated: Boolean(payload?.deduplicated),
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      id: null,
      deduplicated: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function buildUrl(apiBaseUrl: string, skillId: string): string {
  const base = apiBaseUrl.replace(/\/+$/, "");
  return `${base}/api/v1/skills/${encodeURIComponent(skillId)}/deviations`;
}

/**
 * Convenience: post multiple deviations in parallel with a shared auth.
 * Returns per-input results so callers can log which fired + which deduped.
 */
export async function postDeviationBatch(
  inputs: PostDeviationInput[],
  options: PostDeviationOptions,
): Promise<PostDeviationResult[]> {
  return Promise.all(inputs.map((input) => postDeviation(input, options)));
}
