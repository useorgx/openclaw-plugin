import { callLlmJson } from "../http/helpers/llm-client.js";
import type { OrgxAgentDomain } from "../contracts/types.js";

export type RetroQualityRubricInput = {
  success: boolean;
  hadError: boolean;
  errorMessage?: string | null;
  tokens?: number | null;
  costUsd?: number | null;
  decisionsCount?: number;
  followUpsCount?: number;
  whatWentWrongCount?: number;
  /** Agent domain for domain-specific scoring modifiers */
  domain?: OrgxAgentDomain | null;
  /** Artifact metadata from the registered atomic unit */
  artifactMetadata?: Record<string, unknown> | null;
};

export type RetroQualityRubricResult = {
  score: number;
  reasons: string[];
};

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toNonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * Compute domain-specific quality modifier based on artifact metadata.
 * Returns delta (positive = bonus, negative = penalty) and reasons.
 */
export function computeDomainQualityModifier(
  domain: OrgxAgentDomain | null | undefined,
  artifactMetadata: Record<string, unknown> | null | undefined
): { delta: number; reasons: string[] } {
  if (!domain || !artifactMetadata) return { delta: 0, reasons: [] };

  let delta = 0;
  const reasons: string[] = [];
  const meta = artifactMetadata;

  // Helper to check nested dotted paths or flat keys
  const has = (key: string): boolean => {
    if (key in meta && meta[key] != null) {
      const v = meta[key];
      if (typeof v === "string") return v.trim().length > 0;
      if (Array.isArray(v)) return v.length > 0;
      return true;
    }
    const parts = key.split(".");
    let cur: unknown = meta;
    for (const p of parts) {
      if (cur == null || typeof cur !== "object") return false;
      cur = (cur as Record<string, unknown>)[p];
    }
    if (cur == null) return false;
    if (typeof cur === "string") return cur.trim().length > 0;
    if (Array.isArray(cur)) return cur.length > 0;
    return true;
  };

  switch (domain) {
    case "engineering":
      if (has("verification.tests_passed") || has("verification")) {
        delta += 1;
        reasons.push("Engineering artifact includes test verification.");
      }
      if (!has("commit_sha")) {
        delta -= 1;
        reasons.push("Engineering artifact missing commit_sha.");
      }
      break;
    case "product":
      if (has("acceptance_criteria")) {
        delta += 1;
        reasons.push("Product artifact includes acceptance criteria.");
      }
      if (!has("success_metric")) {
        delta -= 1;
        reasons.push("Product artifact missing success metric.");
      }
      break;
    case "design":
      if (has("evidence_url")) {
        delta += 1;
        reasons.push("Design artifact includes evidence URL.");
      }
      if (!has("tokens_referenced")) {
        delta -= 1;
        reasons.push("Design artifact missing token references.");
      }
      break;
    case "marketing":
      if (has("measurement_hook")) {
        delta += 1;
        reasons.push("Marketing artifact includes measurement hook.");
      }
      if (!has("audience")) {
        delta -= 1;
        reasons.push("Marketing artifact missing target audience.");
      }
      break;
    case "sales":
      if (has("next_action")) {
        delta += 1;
        reasons.push("Sales artifact includes next action.");
      }
      if (!has("buyer_stage")) {
        delta -= 1;
        reasons.push("Sales artifact missing buyer stage.");
      }
      break;
    case "operations":
      if (has("rollback_path")) {
        delta += 1;
        reasons.push("Operations artifact includes rollback path.");
      }
      if (!has("affected_systems")) {
        delta -= 1;
        reasons.push("Operations artifact missing affected systems.");
      }
      break;
    case "orchestration":
      if (has("unblocked_work")) {
        delta += 1;
        reasons.push("Orchestration artifact includes unblocked work.");
      }
      if (!has("rationale")) {
        delta -= 1;
        reasons.push("Orchestration artifact missing rationale.");
      }
      break;
  }

  return { delta, reasons };
}

export function computeRetroQualityRubricScore(input: RetroQualityRubricInput): RetroQualityRubricResult {
  let score = input.success ? 5 : 2;
  const reasons: string[] = [];

  if (input.hadError || (input.errorMessage?.trim() ?? "").length > 0) {
    score -= 1;
    reasons.push("Run ended with error signal.");
  }

  const followUpsCount = toNonNegativeCount(input.followUpsCount);
  if (!input.success && followUpsCount < 1) {
    score -= 1;
    reasons.push("Failure run missing actionable follow-up.");
  }

  const decisionsCount = toNonNegativeCount(input.decisionsCount);
  if (!input.success && decisionsCount < 1) {
    score -= 1;
    reasons.push("Failure run missing decision signal.");
  }

  const wrongCount = toNonNegativeCount(input.whatWentWrongCount);
  if (input.success && wrongCount > 0) {
    score -= 1;
    reasons.push("Success run still reported retrospective issues.");
  }

  const tokens = toFiniteNumber(input.tokens);
  if (tokens === null || tokens <= 0) {
    score -= 1;
    reasons.push("Missing or invalid token telemetry.");
  }

  const costUsd = toFiniteNumber(input.costUsd);
  if (costUsd !== null && costUsd > 10) {
    score -= 1;
    reasons.push("Run cost exceeded preferred threshold ($10).");
  }

  // Domain-specific modifiers (stacks with generic signals)
  const domainMod = computeDomainQualityModifier(input.domain, input.artifactMetadata);
  score += domainMod.delta;
  reasons.push(...domainMod.reasons);

  const normalized = Math.max(1, Math.min(5, Math.round(score)));
  if (reasons.length === 0) {
    reasons.push("Outcome met baseline quality rubric expectations.");
  }
  return { score: normalized, reasons };
}

export async function computeRetroQualityWithLlm(
  input: RetroQualityRubricInput & { executionContext?: string | null },
): Promise<RetroQualityRubricResult & { source: "llm" | "heuristic" }> {
  const lines: string[] = [
    `Outcome: ${input.success ? "success" : "failure"}`,
    `Error present: ${input.hadError || (input.errorMessage?.trim() ?? "").length > 0 ? "yes" : "no"}`,
  ];
  if (input.errorMessage?.trim()) {
    lines.push(`Error message: ${input.errorMessage.trim()}`);
  }
  const tokens = toFiniteNumber(input.tokens);
  if (tokens !== null) lines.push(`Tokens used: ${tokens}`);
  const costUsd = toFiniteNumber(input.costUsd);
  if (costUsd !== null) lines.push(`Cost (USD): ${costUsd.toFixed(4)}`);
  const decisionsCount = toNonNegativeCount(input.decisionsCount);
  lines.push(`Decisions recorded: ${decisionsCount}`);
  const followUpsCount = toNonNegativeCount(input.followUpsCount);
  lines.push(`Follow-ups recorded: ${followUpsCount}`);
  const issuesCount = toNonNegativeCount(input.whatWentWrongCount);
  lines.push(`Issues reported: ${issuesCount}`);
  if (input.executionContext?.trim()) {
    lines.push(`Execution context: ${input.executionContext.trim()}`);
  }

  const userPrompt = lines.join("\n");

  const systemPrompt =
    "Score this autonomous agent run on a 1-5 quality scale. Consider: task completion, error handling, resource efficiency, follow-up quality, and decision signals. Return JSON: {\"score\": <1-5>, \"reasons\": [\"...\", ...]}. Each reason should be specific and actionable, not generic.";

  const { result, source } = await callLlmJson<RetroQualityRubricResult>(
    {
      taskId: "quality_rubric",
      systemPrompt,
      userPrompt,
      model: "openai/gpt-4.1-nano",
      maxTokens: 256,
      cacheTtlMs: 12 * 60 * 60_000,
    },
    (raw: string): RetroQualityRubricResult | null => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const score = parsed.score;
        if (typeof score !== "number" || !Number.isInteger(score) || score < 1 || score > 5) {
          return null;
        }
        const reasons = parsed.reasons;
        if (
          !Array.isArray(reasons) ||
          reasons.length === 0 ||
          !reasons.every((r): r is string => typeof r === "string" && r.length > 0)
        ) {
          return null;
        }
        return { score, reasons };
      } catch {
        return null;
      }
    },
    () => computeRetroQualityRubricScore(input),
  );

  return { ...result, source };
}
