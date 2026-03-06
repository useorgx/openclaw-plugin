import type { OnboardingState } from "./shared-types.js";

export function mergeOnboardingState(
  previous: OnboardingState,
  next: OnboardingState
): OnboardingState {
  const preserveVerifiedContext = previous.hasApiKey && previous.connectionVerified;
  const merged: OnboardingState = {
    ...previous,
    ...next,
  };

  if (
    preserveVerifiedContext &&
    (next.status === "pairing" || next.status === "awaiting_browser_auth")
  ) {
    merged.hasApiKey = true;
    merged.connectionVerified = true;
    merged.workspaceName = previous.workspaceName ?? next.workspaceName ?? null;
  } else if (!next.workspaceName && previous.workspaceName) {
    merged.workspaceName = previous.workspaceName;
  }

  if ((!next.installationId || next.installationId.trim().length === 0) && previous.installationId) {
    merged.installationId = previous.installationId;
  }

  if ((next.keySource === "none" || !next.keySource) && previous.keySource && previous.keySource !== "none") {
    merged.keySource = previous.keySource;
  }

  return merged;
}
