type RetroFollowUp = {
  title: string;
  priority?: "p0" | "p1" | "p2";
  reason?: string;
};

export type OrgxAgentRetroDomain =
  | "engineering"
  | "product"
  | "design"
  | "marketing"
  | "sales"
  | "operations"
  | "orchestration"
  | "general";

type DomainTemplate = {
  summaryPrefix: string;
  successWell: string[];
  successDecisions: string[];
  successFollowUps: RetroFollowUp[];
  failureDecision: string;
  failureFollowUpTitle: string;
  failureFollowUpReason: string;
};

const DOMAIN_TEMPLATES: Record<OrgxAgentRetroDomain, DomainTemplate> = {
  engineering: {
    summaryPrefix: "Engineering execution",
    successWell: [
      "Delivered implementation changes with focused validation evidence.",
      "Kept execution scoped to the active slice and avoided unrelated churn.",
    ],
    successDecisions: ["No immediate intervention required; keep current engineering execution pattern."],
    successFollowUps: [
      {
        title: "Capture engineering implementation notes for future retros",
        priority: "p2",
      },
    ],
    failureDecision: "Escalate blocker triage and assign root-cause owner before the next engineering run.",
    failureFollowUpTitle: "Reproduce failure with a targeted engineering check and patch root cause",
    failureFollowUpReason:
      "Engineering runs should converge quickly on reproducible failures and ship a corrective change.",
  },
  product: {
    summaryPrefix: "Product execution",
    successWell: [
      "Clarified scope and acceptance criteria for the requested slice.",
      "Converted ambiguous asks into concrete execution steps.",
    ],
    successDecisions: ["Proceed with the current product plan and track any open assumptions."],
    successFollowUps: [{ title: "Log product assumptions and open questions", priority: "p2" }],
    failureDecision: "Resolve product scope/acceptance ambiguity with a direct owner decision before retry.",
    failureFollowUpTitle: "Resolve product requirement ambiguity before next run",
    failureFollowUpReason:
      "Product loops fail when acceptance criteria and constraints remain underspecified.",
  },
  design: {
    summaryPrefix: "Design execution",
    successWell: [
      "Produced design output aligned with existing system constraints.",
      "Prioritized usability clarity over decorative changes.",
    ],
    successDecisions: ["Continue with the approved design direction and preserve current constraints."],
    successFollowUps: [{ title: "Attach visual QA checklist for handoff", priority: "p2" }],
    failureDecision: "Run a blocking UX triage decision and align acceptance checkpoints before rerun.",
    failureFollowUpTitle: "Run design QA pass and fix blocking UX mismatches",
    failureFollowUpReason:
      "Design regressions should be validated with explicit viewport and interaction checks.",
  },
  marketing: {
    summaryPrefix: "Marketing execution",
    successWell: [
      "Delivered channel-ready messaging with clear audience targeting.",
      "Maintained consistent narrative and measurable intent.",
    ],
    successDecisions: ["Keep the current campaign direction and monitor defined success signals."],
    successFollowUps: [{ title: "Record campaign hypotheses and success metrics", priority: "p2" }],
    failureDecision: "Decide on updated positioning hypothesis before the next marketing execution cycle.",
    failureFollowUpTitle: "Diagnose marketing execution gap and tighten message-to-metric mapping",
    failureFollowUpReason:
      "Marketing outcomes need explicit hypotheses, channel constraints, and measurable goals.",
  },
  sales: {
    summaryPrefix: "Sales execution",
    successWell: [
      "Created actionable next steps tied to buyer-stage progression.",
      "Preserved signal quality for follow-up actions and objections.",
    ],
    successDecisions: ["Continue with the current sales motion while maintaining pipeline signal quality."],
    successFollowUps: [{ title: "Document discovery-to-close handoff notes", priority: "p2" }],
    failureDecision: "Trigger a sales unblock decision on objection handling and next-step ownership.",
    failureFollowUpTitle: "Rework sales motion to unblock stalled buyer progression",
    failureFollowUpReason:
      "Sales stalls usually reflect missing objection handling or unclear next actions.",
  },
  operations: {
    summaryPrefix: "Operations execution",
    successWell: [
      "Stabilized process flow with explicit ownership and runbook alignment.",
      "Reduced operational risk through controlled scope and sequencing.",
    ],
    successDecisions: ["Keep current ops controls and apply runbook deltas from this run."],
    successFollowUps: [{ title: "Add ops runbook delta from this run", priority: "p2" }],
    failureDecision: "Escalate operational owner decision to remove the bottleneck before retrying.",
    failureFollowUpTitle: "Patch operational bottleneck and update runbook controls",
    failureFollowUpReason:
      "Operations failures should result in tighter runbooks and clearer owner accountability.",
  },
  orchestration: {
    summaryPrefix: "Orchestration execution",
    successWell: [
      "Coordinated dependencies and sequencing across agents effectively.",
      "Maintained clear control flow for decisions and handoffs.",
    ],
    successDecisions: ["Preserve current orchestration sequencing and monitor handoff latency."],
    successFollowUps: [{ title: "Capture orchestration handoff timing insights", priority: "p2" }],
    failureDecision: "Request an orchestration sequencing decision to unblock dependency handoffs.",
    failureFollowUpTitle: "Unblock orchestration handoff failure and re-sequence dependent work",
    failureFollowUpReason:
      "Orchestration errors should tighten dependency ordering and handoff contracts.",
  },
  general: {
    summaryPrefix: "Execution",
    successWell: ["Completed the requested run without runtime error."],
    successDecisions: ["No immediate action required; continue with the current execution flow."],
    successFollowUps: [],
    failureDecision: "Request a human unblock decision before the next retry.",
    failureFollowUpTitle: "Investigate OpenClaw session failure and unblock task",
    failureFollowUpReason: "Session ended with error.",
  },
};

function inferDomainFromAgentId(agentId: string | null | undefined): OrgxAgentRetroDomain {
  const normalized = String(agentId ?? "").trim().toLowerCase();
  if (!normalized) return "general";

  const compact = normalized.replace(/[^a-z0-9]/g, "");
  const tokenSet = new Set(normalized.split(/[^a-z0-9]+/g).filter(Boolean));
  const hasToken = (...tokens: string[]): boolean => tokens.some((token) => tokenSet.has(token));
  const hasTokenPrefix = (...prefixes: string[]): boolean =>
    Array.from(tokenSet).some((token) => prefixes.some((prefix) => token.startsWith(prefix)));

  if (
    normalized.includes("sentinel") ||
    hasToken("sentinel", "watchdog") ||
    hasTokenPrefix("sentinel", "watch")
  ) {
    return "orchestration";
  }

  if (
    normalized.includes("engineering") ||
    normalized.includes("developer") ||
    hasToken("eng", "dev", "frontend", "backend", "fullstack", "engineer") ||
    compact.includes("engineering") ||
    compact.includes("developer")
  ) {
    return "engineering";
  }
  if (
    normalized.includes("product") ||
    hasToken("pm", "prod") ||
    hasTokenPrefix("product", "pm") ||
    compact.includes("productmanager")
  ) {
    return "product";
  }
  if (normalized.includes("design") || tokenSet.has("ux") || tokenSet.has("ui")) return "design";
  if (
    normalized.includes("marketing") ||
    hasToken("mktg", "growth") ||
    hasTokenPrefix("mkt", "market")
  ) {
    return "marketing";
  }
  if (normalized.includes("sales") || hasToken("sdr", "ae") || hasTokenPrefix("sales")) return "sales";
  if (
    normalized.includes("operations") ||
    normalized.includes("platform") ||
    hasToken("ops", "sre", "infra") ||
    hasTokenPrefix("operat", "platform", "infra")
  ) {
    return "operations";
  }
  if (
    normalized.includes("orchestrat") ||
    hasToken("coord", "router") ||
    hasTokenPrefix("coordinat", "orchestrat", "route")
  ) {
    return "orchestration";
  }
  return "general";
}

function isSentinelAgentId(agentId: string | null | undefined): boolean {
  const normalized = String(agentId ?? "").trim().toLowerCase();
  if (!normalized) return false;
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  if (normalized.includes("sentinel") || compact.includes("sentinel")) {
    return true;
  }
  const tokenSet = new Set(normalized.split(/[^a-z0-9]+/g).filter(Boolean));
  return tokenSet.has("watchdog") || Array.from(tokenSet).some((token) => token.startsWith("watch"));
}

export function buildRetroTemplateForAgent(input: {
  agentId: string | null | undefined;
  success: boolean;
  taskId: string | null | undefined;
  runId: string;
  errorMessage: string | null | undefined;
}): {
  domain: OrgxAgentRetroDomain;
  summary: string;
  whatWentWell: string[];
  whatWentWrong: string[];
  decisions: string[];
  followUps: RetroFollowUp[];
} {
  const domain = inferDomainFromAgentId(input.agentId);
  const isSentinel = isSentinelAgentId(input.agentId);
  const template = DOMAIN_TEMPLATES[domain];
  const errorMessage = input.errorMessage?.trim() || "Session ended with error.";
  const summary = input.taskId
    ? `${template.summaryPrefix} ${input.success ? "completed" : "blocked"} task ${input.taskId}.`
    : `${template.summaryPrefix} run ${input.success ? "completed" : "blocked"} (session ${input.runId}).`;

  if (input.success) {
    return {
      domain,
      summary,
      whatWentWell: template.successWell,
      whatWentWrong: [],
      decisions: template.successDecisions,
      followUps: template.successFollowUps,
    };
  }

  return {
    domain,
    summary,
    whatWentWell: [],
    whatWentWrong: [errorMessage],
    decisions: [
      isSentinel
        ? "Sentinel: resolve decision to unblock dependency handoffs before retrying this run."
        : template.failureDecision,
    ],
    followUps: [
      {
        title: template.failureFollowUpTitle,
        priority: "p0",
        reason:
          domain === "general"
            ? errorMessage
            : `${template.failureFollowUpReason} Error: ${errorMessage}`,
      },
    ],
  };
}
