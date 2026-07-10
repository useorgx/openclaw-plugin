export type CapacityRuntimeWorkerKind = "codex" | "claude-code" | "server";

export type CapacityRuntimeRecommendation = {
  channelId: string;
  workerKind: CapacityRuntimeWorkerKind;
  provider: "openai" | "anthropic";
  score: number;
  reason: string;
};

export type ResolvedCapacityRuntime = {
  workerKind: string;
  source: "explicit" | "orgx-policy" | "default";
  requiresServerDispatch: boolean;
  channelId: string | null;
  reason: string | null;
};

export function resolveCapacityRuntime(input: {
  configuredWorkerKind?: string | null;
  recommendation?: CapacityRuntimeRecommendation | null;
}): ResolvedCapacityRuntime {
  const configured = (input.configuredWorkerKind ?? "").trim().toLowerCase();
  if (configured) {
    return {
      workerKind: configured,
      source: "explicit",
      requiresServerDispatch: false,
      channelId: null,
      reason: "Local worker kind is explicitly pinned.",
    };
  }

  const recommendation = input.recommendation ?? null;
  if (recommendation?.workerKind === "server") {
    return {
      workerKind: "server",
      source: "orgx-policy",
      requiresServerDispatch: true,
      channelId: recommendation.channelId,
      reason: recommendation.reason,
    };
  }
  if (
    recommendation?.workerKind === "codex" ||
    recommendation?.workerKind === "claude-code"
  ) {
    return {
      workerKind: recommendation.workerKind,
      source: "orgx-policy",
      requiresServerDispatch: false,
      channelId: recommendation.channelId,
      reason: recommendation.reason,
    };
  }

  return {
    workerKind: "codex",
    source: "default",
    requiresServerDispatch: false,
    channelId: null,
    reason: "No capacity policy was available; retained the Codex default.",
  };
}
