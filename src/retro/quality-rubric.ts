export type RetroQualityRubricInput = {
  success: boolean;
  hadError: boolean;
  errorMessage?: string | null;
  tokens?: number | null;
  costUsd?: number | null;
  decisionsCount?: number;
  followUpsCount?: number;
  whatWentWrongCount?: number;
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

  const normalized = Math.max(1, Math.min(5, Math.round(score)));
  if (reasons.length === 0) {
    reasons.push("Outcome met baseline quality rubric expectations.");
  }
  return { score: normalized, reasons };
}
