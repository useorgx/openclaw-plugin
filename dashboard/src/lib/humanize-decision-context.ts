/**
 * Frontend translation layer for decision context strings.
 *
 * When the backend creates decisions with minimal context (raw error text,
 * developer-facing diagnostics), this module re-humanizes them at render time
 * so operators see actionable explanations and auto-generated options.
 */

import type { LiveDecision, LiveDecisionOption } from '../../../src/contracts/shared-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HumanizedDecisionContext {
  /** One-line human headline, e.g. "Agent work stopped unexpectedly" */
  headline: string;
  /** Multi-sentence explanation for operators */
  explanation: string;
  /** Parsed structured data from the raw string */
  structuredDetails: Record<string, string | undefined>;
  /** Generated options when decision has none */
  suggestedOptions: SuggestedOption[];
  /** Severity for UI theming */
  severity: 'critical' | 'warning' | 'info';
}

export interface SuggestedOption {
  label: string;
  description: string;
  impliedStatus: 'approved' | 'declined';
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

interface PatternDef {
  test: RegExp;
  headline: string;
  explain: (raw: string, m: RegExpMatchArray) => string;
  severity: 'critical' | 'warning' | 'info';
  options: SuggestedOption[];
  extractDetails?: (raw: string, m: RegExpMatchArray) => Record<string, string | undefined>;
}

const RETRY_OPTION: SuggestedOption = {
  label: 'Retry this workstream',
  description: 'Re-run with the same configuration. Recommended if this was a transient issue.',
  impliedStatus: 'approved',
};
const SKIP_OPTION: SuggestedOption = {
  label: 'Skip and continue',
  description: 'Mark as accepted and move to the next workstream.',
  impliedStatus: 'approved',
};

const PATTERNS: PatternDef[] = [
  {
    test: /Worker exited without structured output.*?code=(\S+?),\s*signal=(\S+?)\)/i,
    headline: 'Agent work stopped unexpectedly',
    explain: (_raw, m) => {
      const code = m[1] === 'null' ? 'none' : m[1];
      const signal = m[2] === 'null' ? 'none' : m[2];
      return `The agent process exited before producing results. Exit code: ${code}. Signal: ${signal}. This usually means the worker was terminated externally or ran out of resources.`;
    },
    severity: 'critical',
    options: [
      RETRY_OPTION,
      {
        label: 'Retry with more resources',
        description: 'Increase token budget before re-running.',
        impliedStatus: 'approved',
      },
      SKIP_OPTION,
    ],
    extractDetails: (_raw, m) => ({
      exitCode: m[1] === 'null' ? undefined : m[1],
      signal: m[2] === 'null' ? undefined : m[2],
    }),
  },
  {
    test: /MCP handshake failed(?:\s+for\s+(\S+))?/i,
    headline: "Agent couldn't connect to tools",
    explain: (_raw, m) => {
      const server = m[1] ? ` (${m[1]})` : '';
      return `The agent failed to connect to its tool server${server}. This typically means the MCP server is unreachable or took too long to respond.`;
    },
    severity: 'critical',
    options: [
      RETRY_OPTION,
      {
        label: 'Check MCP server',
        description: 'Investigate the tool server connection before retrying.',
        impliedStatus: 'approved',
      },
      SKIP_OPTION,
    ],
    extractDetails: (_raw, m) => ({
      server: m[1] || undefined,
    }),
  },
  {
    test: /(?:Slice|Autopilot slice) timed out after (\d+)/i,
    headline: 'Agent ran out of time',
    explain: (_raw, m) => {
      const mins = Math.round(parseInt(m[1], 10) / 60_000);
      return `The agent exceeded its ${mins > 0 ? `${mins}-minute` : `${m[1]}ms`} time limit. Consider breaking the work into smaller steps or increasing the time budget.`;
    },
    severity: 'warning',
    options: [
      {
        label: 'Retry with more time',
        description: 'Increase the timeout before re-running.',
        impliedStatus: 'approved',
      },
      {
        label: 'Break into smaller tasks',
        description: 'Split the workstream into smaller pieces that fit the time budget.',
        impliedStatus: 'approved',
      },
      SKIP_OPTION,
    ],
    extractDetails: (_raw, m) => ({
      elapsedMs: m[1],
    }),
  },
  {
    test: /(?:Slice|Autopilot slice) stalled/i,
    headline: 'Agent stopped making progress',
    explain: () =>
      'The agent stopped producing output. It may be stuck in a loop, waiting on an unresponsive resource, or unable to proceed with the current approach.',
    severity: 'warning',
    options: [
      RETRY_OPTION,
      {
        label: 'Review logs',
        description: 'Check the session logs to understand why the agent stalled.',
        impliedStatus: 'approved',
      },
      SKIP_OPTION,
    ],
  },
  {
    test: /blocked.*?(?:needs|requires?) intervention/i,
    headline: 'Agent needs your help to continue',
    explain: () =>
      'The agent reached a point where it cannot proceed without human guidance. This may be a question about requirements, a permission needed, or an ambiguity.',
    severity: 'warning',
    options: [
      {
        label: 'Review blocker',
        description: 'Look at what the agent needs and provide guidance.',
        impliedStatus: 'approved',
      },
      {
        label: 'Provide guidance',
        description: 'Add a note with instructions for the agent.',
        impliedStatus: 'approved',
      },
      SKIP_OPTION,
    ],
  },
  {
    test: /completed.*?(?:without|no) (?:verifiable )?(?:outcomes?|artifacts?)/i,
    headline: 'Agent finished but produced no outputs',
    explain: () =>
      'The agent reported completion but produced no artifacts or status updates. The work may have been done informally, or the agent could not find actionable work.',
    severity: 'info',
    options: [
      {
        label: 'Accept as-is',
        description: 'The work was done informally or no output was needed.',
        impliedStatus: 'approved',
      },
      {
        label: 'Retry with stronger output requirements',
        description: 'Re-run and require the agent to produce structured artifacts.',
        impliedStatus: 'approved',
      },
      SKIP_OPTION,
    ],
  },
  {
    test: /Spawn guard denied/i,
    headline: 'Agent dispatch was blocked by safety check',
    explain: () =>
      "The system's safety checks prevented this agent from starting. This is typically due to capacity limits or quality gate requirements.",
    severity: 'warning',
    options: [
      {
        label: 'Approve exception',
        description: 'Override the safety check and allow dispatch.',
        impliedStatus: 'approved',
      },
      {
        label: 'Investigate quality gate',
        description: 'Review what safety check failed before proceeding.',
        impliedStatus: 'approved',
      },
      SKIP_OPTION,
    ],
  },
  {
    test: /code=(\d+)/i,
    headline: 'Agent encountered an error',
    explain: (_raw, m) =>
      `The agent process exited with error code ${m[1]}. Reviewing the session logs will show what operation failed.`,
    severity: 'critical',
    options: [
      RETRY_OPTION,
      {
        label: 'Review error logs',
        description: 'Check session logs to understand the error before retrying.',
        impliedStatus: 'approved',
      },
      SKIP_OPTION,
    ],
    extractDetails: (_raw, m) => ({
      exitCode: m[1],
    }),
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Translate raw decision context into human-readable form.
 * Returns generated headline, explanation, structured details,
 * suggested options (for optionless decisions), and severity.
 */
export function humanizeDecisionContext(
  decision: Pick<LiveDecision, 'context' | 'title' | 'decisionType'>
): HumanizedDecisionContext {
  const raw = decision.context || decision.title || '';

  for (const pattern of PATTERNS) {
    const match = raw.match(pattern.test);
    if (match) {
      return {
        headline: pattern.headline,
        explanation: pattern.explain(raw, match),
        structuredDetails: pattern.extractDetails?.(raw, match) ?? {},
        suggestedOptions: pattern.options,
        severity: pattern.severity,
      };
    }
  }

  // Fallback: use decision type to provide some context
  if (decision.decisionType === 'autopilot_failure') {
    return {
      headline: 'Agent work needs attention',
      explanation: raw || 'An issue occurred during autopilot execution that requires review.',
      structuredDetails: {},
      suggestedOptions: [RETRY_OPTION, SKIP_OPTION],
      severity: 'warning',
    };
  }

  return {
    headline: decision.title || 'Decision needed',
    explanation: raw || 'Review the details and choose an action.',
    structuredDetails: {},
    suggestedOptions: [],
    severity: 'info',
  };
}

/**
 * Convert suggested options into LiveDecisionOption format suitable for
 * rendering in the existing option card infrastructure.
 */
export function suggestedOptionsToLiveOptions(
  suggested: SuggestedOption[]
): LiveDecisionOption[] {
  return suggested.map((s, i) => ({
    id: `suggested-${i}`,
    label: s.label,
    description: s.description,
    impliedStatus: s.impliedStatus,
    actionType: null,
    requiresNote: false,
  }));
}
