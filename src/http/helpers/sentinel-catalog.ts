export type SentinelDomain = "engineering" | "sales" | "product" | "operations";

export type BuiltInSentinel = {
  id: string;
  domain: SentinelDomain;
  name: string;
  summary: string;
  signal: "error_log" | "ci_failure" | "dependency_scan";
  severity: "high" | "medium";
  schedule: {
    cadence: "realtime" | "hourly";
    windowMinutes: number;
  };
  trigger: {
    operator: "gt" | "eq";
    threshold: number;
    unit: "events" | "failures" | "findings";
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
