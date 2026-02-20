import test from "node:test";
import assert from "node:assert/strict";

import { renderKickoffMessage } from "../../dist/http/helpers/kickoff-context.js";

test("renderKickoffMessage includes Team Activity section when team_context has completions", () => {
  const kickoff = {
    context_hash: "ctx_team1",
    team_context: {
      recent_completions: [
        {
          domain: "engineering",
          task_title: "Ship auth API",
          summary: "OAuth2 + MFA endpoints live",
          key_outputs: ["auth-api", "mfa-module"],
          completed_at: "2026-02-20T00:00:00Z",
        },
      ],
      recent_decisions: [
        {
          title: "Use JWT tokens",
          resolution: "Approved JWT over session cookies",
          resolved_at: "2026-02-19T00:00:00Z",
        },
      ],
    },
  };

  const result = renderKickoffMessage({
    baseMessage: "Test",
    kickoff,
    domain: "marketing",
    requiredSkills: [],
  });

  assert.ok(
    result.message.includes("## Team Activity"),
    "Expected message to include '## Team Activity' section header"
  );
  assert.ok(
    result.message.includes(
      "[engineering] Ship auth API: OAuth2 + MFA endpoints live (auth-api, mfa-module)"
    ),
    "Expected message to include formatted completion line with domain, title, summary, and key outputs"
  );
  assert.ok(
    result.message.includes("Recent decisions:"),
    "Expected message to include 'Recent decisions:' sub-header"
  );
  assert.ok(
    result.message.includes("Use JWT tokens: Approved JWT over session cookies"),
    "Expected message to include decision with title and resolution"
  );
  assert.ok(
    result.message.includes("Reference naturally when relevant. Do not summarize back."),
    "Expected message to include team activity usage guidance"
  );
});

test("renderKickoffMessage omits Team Activity section when team_context is empty", () => {
  const kickoff = {
    context_hash: "ctx_team2",
    team_context: {
      recent_completions: [],
      recent_decisions: [],
    },
  };

  const result = renderKickoffMessage({
    baseMessage: "Test",
    kickoff,
    domain: null,
    requiredSkills: [],
  });

  assert.ok(
    !result.message.includes("## Team Activity"),
    "Expected message to NOT include '## Team Activity' when completions and decisions are empty"
  );
});

test("renderKickoffMessage omits Team Activity when team_context is null", () => {
  const kickoff = {
    context_hash: "ctx_team3",
    team_context: null,
  };

  const result = renderKickoffMessage({
    baseMessage: "Test",
    kickoff,
    domain: null,
    requiredSkills: [],
  });

  assert.ok(
    !result.message.includes("## Team Activity"),
    "Expected message to NOT include '## Team Activity' when team_context is null"
  );
});

test("renderKickoffMessage caps completions at 5 and decisions at 3", () => {
  const completions = [];
  for (let i = 1; i <= 8; i++) {
    completions.push({
      domain: `domain-${i}`,
      task_title: `Task ${i}`,
      summary: `Summary for task ${i}`,
      key_outputs: [`output-${i}`],
      completed_at: `2026-02-${String(i).padStart(2, "0")}T00:00:00Z`,
    });
  }

  const decisions = [];
  for (let i = 1; i <= 5; i++) {
    decisions.push({
      title: `Decision ${i}`,
      resolution: `Resolution for decision ${i}`,
      resolved_at: `2026-02-${String(i).padStart(2, "0")}T00:00:00Z`,
    });
  }

  const kickoff = {
    context_hash: "ctx_team4",
    team_context: {
      recent_completions: completions,
      recent_decisions: decisions,
    },
  };

  const result = renderKickoffMessage({
    baseMessage: "Test",
    kickoff,
    domain: null,
    requiredSkills: [],
  });

  // Should include completions 1-5 but not 6-8
  assert.ok(
    result.message.includes("[domain-5]"),
    "Expected message to include the 5th completion (domain-5)"
  );
  assert.ok(
    !result.message.includes("[domain-6]"),
    "Expected message to NOT include the 6th completion (domain-6) — capped at 5"
  );
  assert.ok(
    !result.message.includes("[domain-7]"),
    "Expected message to NOT include the 7th completion (domain-7)"
  );
  assert.ok(
    !result.message.includes("[domain-8]"),
    "Expected message to NOT include the 8th completion (domain-8)"
  );

  // Should include decisions 1-3 but not 4-5
  assert.ok(
    result.message.includes("Decision 3: Resolution for decision 3"),
    "Expected message to include the 3rd decision"
  );
  assert.ok(
    !result.message.includes("Decision 4:"),
    "Expected message to NOT include the 4th decision — capped at 3"
  );
  assert.ok(
    !result.message.includes("Decision 5:"),
    "Expected message to NOT include the 5th decision"
  );
});
