/**
 * Translates raw auto-continue engine error strings into human-readable
 * decision context suitable for operator display.
 *
 * Used at decision creation time to enrich the `summary` field and
 * generate structured options when the engine produces terse diagnostics.
 */

export interface HumanizedSliceFailure {
  /** One-line human headline, e.g. "Agent work stopped unexpectedly" */
  headline: string;
  /** Multi-sentence explanation for operators */
  explanation: string;
  /** Parsed structured data extracted from the raw string */
  structuredDetails: {
    exitCode?: string;
    signal?: string;
    elapsedMs?: string;
    idleMs?: string;
    server?: string;
    reason?: string;
  };
  /** Severity for UI theming */
  severity: "critical" | "warning" | "info";
}

interface PatternEntry {
  test: RegExp;
  headline: string;
  explain: (raw: string, match: RegExpMatchArray) => string;
  severity: "critical" | "warning" | "info";
  extractDetails?: (raw: string, match: RegExpMatchArray) => HumanizedSliceFailure["structuredDetails"];
}

const PATTERNS: PatternEntry[] = [
  {
    test: /Worker exited without structured output.*?code=(\S+?),\s*signal=(\S+?)\)/i,
    headline: "Agent work stopped unexpectedly",
    explain: (_raw, m) => {
      const code = m[1] === "null" ? "none" : m[1];
      const signal = m[2] === "null" ? "none" : m[2];
      const parts = [
        "The agent process exited before producing results.",
      ];
      if (signal !== "none" && signal !== "null") {
        parts.push(
          `It was terminated by signal ${signal}, which usually means the worker was stopped externally or ran out of resources.`
        );
      } else {
        parts.push(
          "This usually means the worker crashed or was terminated before completing."
        );
      }
      parts.push(`Exit code: ${code}. Signal: ${signal}.`);
      return parts.join(" ");
    },
    severity: "critical",
    extractDetails: (_raw, m) => ({
      exitCode: m[1] === "null" ? undefined : m[1],
      signal: m[2] === "null" ? undefined : m[2],
    }),
  },
  {
    test: /MCP handshake failed(?:\s+for\s+(\S+))?/i,
    headline: "Agent couldn't connect to tools",
    explain: (_raw, m) => {
      const server = m[1] ? ` (${m[1]})` : "";
      return `The agent failed to establish a connection with its tool server${server}. This typically means the MCP server is unreachable, misconfigured, or took too long to respond. Retrying often resolves transient connection issues.`;
    },
    severity: "critical",
    extractDetails: (_raw, m) => ({
      server: m[1] || undefined,
    }),
  },
  {
    test: /(?:Slice|Autopilot slice) timed out after (\d+)/i,
    headline: "Agent ran out of time",
    explain: (_raw, m) => {
      const ms = parseInt(m[1], 10);
      const mins = Math.round(ms / 60_000);
      return `The agent exceeded its ${mins > 0 ? `${mins}-minute` : `${ms}ms`} time limit without completing. This can happen when the task is too large for a single work slice or when the agent is waiting on a slow external resource. Consider breaking the work into smaller steps or increasing the time budget.`;
    },
    severity: "warning",
    extractDetails: (_raw, m) => ({
      elapsedMs: m[1],
    }),
  },
  {
    test: /(?:Slice|Autopilot slice) stalled.*?(?:no progress for (\d+))?/i,
    headline: "Agent stopped making progress",
    explain: (_raw, m) => {
      const mins = m[1] ? Math.round(parseInt(m[1], 10) / 60_000) : null;
      const duration = mins ? ` for ${mins} minute${mins !== 1 ? "s" : ""}` : "";
      return `The agent stopped producing output${duration}. This can indicate it's stuck in a loop, waiting on an unresponsive resource, or unable to proceed with the current approach. Reviewing the session logs may reveal the specific bottleneck.`;
    },
    severity: "warning",
    extractDetails: (_raw, m) => ({
      idleMs: m[1] || undefined,
    }),
  },
  {
    test: /blocked.*?(?:needs|requires?) intervention/i,
    headline: "Agent needs your help to continue",
    explain: () =>
      "The agent reached a point where it cannot proceed without human guidance. This may be a question about requirements, a permission needed, or an ambiguity that needs resolution.",
    severity: "warning",
  },
  {
    test: /blocked.*?without.*?(?:blocking )?decision payload/i,
    headline: "Agent paused without clear reason",
    explain: () =>
      "The agent reported it was blocked but did not specify what decision is needed. Review the session logs for context about what the agent was working on when it paused.",
    severity: "warning",
  },
  {
    test: /code=(\d+)/i,
    headline: "Agent encountered an error",
    explain: (_raw, m) =>
      `The agent process exited with error code ${m[1]}. This indicates the agent hit an unexpected condition during execution. Reviewing the session logs will show what operation failed.`,
    severity: "critical",
    extractDetails: (_raw, m) => ({
      exitCode: m[1],
    }),
  },
  {
    test: /completed.*?(?:without|no) (?:verifiable )?(?:outcomes?|artifacts?|status updates?)/i,
    headline: "Agent finished but produced nothing",
    explain: () =>
      "The agent reported completion but did not produce any artifacts, status updates, or measurable outcomes. This may mean the work was done informally (e.g., analysis without a written output) or the agent couldn't find actionable work.",
    severity: "info",
  },
  {
    test: /Spawn guard denied/i,
    headline: "Agent dispatch was blocked by safety check",
    explain: (_raw) =>
      "The system's safety checks prevented this agent from starting. This is typically due to capacity limits, domain restrictions, or quality gate requirements that haven't been met.",
    severity: "warning",
  },
];

/**
 * Translate a raw auto-continue error/context string into a human-friendly
 * decision description. Falls back gracefully for unrecognised patterns.
 */
export function humanizeSliceFailure(raw: string): HumanizedSliceFailure {
  for (const pattern of PATTERNS) {
    const match = raw.match(pattern.test);
    if (match) {
      return {
        headline: pattern.headline,
        explanation: pattern.explain(raw, match),
        structuredDetails: pattern.extractDetails?.(raw, match) ?? {},
        severity: pattern.severity,
      };
    }
  }

  // Fallback for unrecognised patterns
  return {
    headline: "Agent work needs attention",
    explanation: raw,
    structuredDetails: {},
    severity: "warning",
  };
}

/**
 * Generate a human-friendly summary string from a raw error, suitable for
 * the `summary` field when creating decisions. Combines the headline and
 * explanation into a concise paragraph.
 */
export function humanizeSliceFailureSummary(raw: string): string {
  const h = humanizeSliceFailure(raw);
  return `${h.headline}. ${h.explanation}`;
}
