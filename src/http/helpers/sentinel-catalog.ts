export type SentinelDomain =
  | "engineering"
  | "sales"
  | "product"
  | "operations"
  | "marketing";

export type BuiltInSentinel = {
  id: string;
  domain: SentinelDomain;
  name: string;
  summary: string;
  signal:
    | "error_log"
    | "ci_failure"
    | "dependency_scan"
    | "accessibility_audit"
    | "deal_stagnation"
    | "lead_response"
    | "cost_anomaly"
    | "sla_breach"
    | "content_performance"
    | "budget_monitor";
  severity: "high" | "medium";
  schedule: {
    cadence: "realtime" | "hourly";
    windowMinutes: number;
  };
  trigger: {
    operator: "gt" | "eq";
    threshold: number;
    unit: "events" | "failures" | "findings" | "hours" | "minutes" | "percent";
  };
  defaultAction: string;
};

const BUILT_IN_SENTINELS: BuiltInSentinel[] = [
  {
    id: "eng.error-log-spike",
    domain: "engineering",
    name: "Error Log Spike",
    summary: "Detects sudden increases in production error volume.",
    signal: "error_log",
    severity: "high",
    schedule: {
      cadence: "realtime",
      windowMinutes: 15,
    },
    trigger: {
      operator: "gt",
      threshold: 25,
      unit: "events",
    },
    defaultAction: "Open incident triage task and notify on-call.",
  },
  {
    id: "eng.ci-failure-streak",
    domain: "engineering",
    name: "CI Failure Streak",
    summary: "Flags repeated failures on default-branch CI pipelines.",
    signal: "ci_failure",
    severity: "high",
    schedule: {
      cadence: "hourly",
      windowMinutes: 60,
    },
    trigger: {
      operator: "gt",
      threshold: 2,
      unit: "failures",
    },
    defaultAction: "Create blocker task and assign build owner.",
  },
  {
    id: "eng.dependency-vuln-findings",
    domain: "engineering",
    name: "Dependency Vulnerability Scan",
    summary: "Tracks critical dependency findings from security scans.",
    signal: "dependency_scan",
    severity: "medium",
    schedule: {
      cadence: "hourly",
      windowMinutes: 60,
    },
    trigger: {
      operator: "gt",
      threshold: 0,
      unit: "findings",
    },
    defaultAction: "Open remediation task with package and CVE details.",
  },
  {
    id: "product.accessibility-audit",
    domain: "product",
    name: "Accessibility Regression Audit",
    summary: "Detects new accessibility violations introduced in active UI surfaces.",
    signal: "accessibility_audit",
    severity: "medium",
    schedule: {
      cadence: "hourly",
      windowMinutes: 60,
    },
    trigger: {
      operator: "gt",
      threshold: 0,
      unit: "findings",
    },
    defaultAction:
      "Open remediation task with failing WCAG checks, impacted routes, and owner assignment.",
  },
  {
    id: "sales.deal-stagnation",
    domain: "sales",
    name: "Deal Stagnation",
    summary: "Detects deals that have stalled without stage progression.",
    signal: "deal_stagnation",
    severity: "high",
    schedule: {
      cadence: "hourly",
      windowMinutes: 60,
    },
    trigger: {
      operator: "gt",
      threshold: 72,
      unit: "hours",
    },
    defaultAction: "Spawn MEDDIC gap review task and assign account owner.",
  },
  {
    id: "sales.lead-response-lag",
    domain: "sales",
    name: "Lead Response SLA",
    summary: "Flags inbound leads waiting past first-response SLA.",
    signal: "lead_response",
    severity: "medium",
    schedule: {
      cadence: "realtime",
      windowMinutes: 15,
    },
    trigger: {
      operator: "gt",
      threshold: 30,
      unit: "minutes",
    },
    defaultAction: "Create follow-up task for SDR and alert sales manager.",
  },
  {
    id: "operations.cost-anomaly",
    domain: "operations",
    name: "Cost Anomaly",
    summary: "Detects spend spikes above planned baseline across active services.",
    signal: "cost_anomaly",
    severity: "high",
    schedule: {
      cadence: "hourly",
      windowMinutes: 60,
    },
    trigger: {
      operator: "gt",
      threshold: 15,
      unit: "percent",
    },
    defaultAction: "Open budget variance investigation and assign service owner.",
  },
  {
    id: "operations.sla-breach-risk",
    domain: "operations",
    name: "SLA Breach Risk",
    summary: "Flags open incidents approaching or exceeding contractual SLA thresholds.",
    signal: "sla_breach",
    severity: "high",
    schedule: {
      cadence: "realtime",
      windowMinutes: 15,
    },
    trigger: {
      operator: "gt",
      threshold: 10,
      unit: "minutes",
    },
    defaultAction: "Escalate incident to on-call lead and trigger exec escalation path.",
  },
  {
    id: "marketing.content-performance-drop",
    domain: "marketing",
    name: "Content Performance Drop",
    summary: "Flags campaign content with sustained engagement below target baseline.",
    signal: "content_performance",
    severity: "medium",
    schedule: {
      cadence: "hourly",
      windowMinutes: 60,
    },
    trigger: {
      operator: "gt",
      threshold: 20,
      unit: "percent",
    },
    defaultAction:
      "Create optimization task with low-performing assets, channel mix, and CTA update recommendations.",
  },
  {
    id: "marketing.budget-monitor",
    domain: "marketing",
    name: "Budget Monitor",
    summary: "Detects paid channel spend pacing above planned daily budget thresholds.",
    signal: "budget_monitor",
    severity: "high",
    schedule: {
      cadence: "hourly",
      windowMinutes: 60,
    },
    trigger: {
      operator: "gt",
      threshold: 15,
      unit: "percent",
    },
    defaultAction:
      "Open budget pacing review task for campaign owner with spend breakout and reallocation options.",
  },
];

export function listBuiltInSentinels(input?: {
  domain?: string | null;
  signal?: string | null;
}): BuiltInSentinel[] {
  const domainFilter = (input?.domain ?? "").trim().toLowerCase();
  const signalFilter = (input?.signal ?? "").trim().toLowerCase();

  return BUILT_IN_SENTINELS.filter((entry) => {
    if (domainFilter && entry.domain !== domainFilter) return false;
    if (signalFilter && entry.signal !== signalFilter) return false;
    return true;
  });
}
