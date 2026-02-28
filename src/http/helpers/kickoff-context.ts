import type { OrgXClient } from "../../api.js";
import type {
  KickoffContext,
  KickoffContextRequest,
  KickoffContextResponse,
} from "../../types.js";

function normalizeKickoffContextResponse(value: unknown): KickoffContext | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.context_hash === "string" && record.context_hash.trim().length > 0) {
    return record as unknown as KickoffContext;
  }

  if (record.ok === true && record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (typeof data.context_hash === "string" && data.context_hash.trim().length > 0) {
      return data as unknown as KickoffContext;
    }
  }

  return null;
}

export async function fetchKickoffContextSafe(
  client: OrgXClient,
  payload: KickoffContextRequest
): Promise<KickoffContext | null> {
  try {
    const anyClient = client as unknown as {
      getKickoffContext?: (p: KickoffContextRequest) => Promise<KickoffContextResponse>;
      rawRequest?: (...args: any[]) => Promise<unknown>;
    };
    if (typeof anyClient.getKickoffContext === "function") {
      const resp = await anyClient.getKickoffContext(payload);
      return normalizeKickoffContextResponse(resp);
    }

    if (typeof anyClient.rawRequest === "function") {
      const resp = await anyClient.rawRequest(
        "POST",
        "/api/client/kickoff-context",
        payload ?? {}
      );
      return normalizeKickoffContextResponse(resp);
    }
  } catch {
    // best effort: fall back to local kickoff message
  }
  return null;
}

function normalizeKickoffLines(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter((line) => line.length > 0);
}

export function renderKickoffMessage(input: {
  baseMessage: string;
  kickoff: KickoffContext | null;
  domain: string | null;
  requiredSkills: string[];
}): { message: string; contextHash: string | null } {
  const base = input.baseMessage.trim();
  const kickoff = input.kickoff;
  if (!kickoff) return { message: base, contextHash: null };

  const title = (
    kickoff.task?.title ??
    kickoff.workstream?.title ??
    kickoff.initiative?.title ??
    ""
  ).trim();
  const overview = (kickoff.overview ?? "").trim();
  const acceptance = normalizeKickoffLines(kickoff.acceptance_criteria ?? null);
  const constraints = normalizeKickoffLines(kickoff.constraints ?? null);
  const risks = normalizeKickoffLines(kickoff.risks ?? null);
  const reporting = normalizeKickoffLines(kickoff.reporting_expectations ?? null);

  const decisions = Array.isArray(kickoff.decisions) ? kickoff.decisions : [];
  const artifacts = Array.isArray(kickoff.artifacts) ? kickoff.artifacts : [];

  const allow = normalizeKickoffLines(kickoff.tool_scope?.allow ?? null);
  const deny = normalizeKickoffLines(kickoff.tool_scope?.deny ?? null);
  const toolNotes = (kickoff.tool_scope?.notes ?? "").trim();
  const personaVoice = (kickoff.persona?.voice ?? "").trim();
  const collaborationStyle = (kickoff.persona?.collaboration_style ?? "").trim();
  const personaDefaults = normalizeKickoffLines(kickoff.persona?.defaults ?? null);
  const runtimeSettings =
    kickoff.runtime_settings && typeof kickoff.runtime_settings === "object"
      ? kickoff.runtime_settings
      : null;
  const customRunInstructions =
    runtimeSettings && typeof runtimeSettings.custom_run_instructions === "string"
      ? runtimeSettings.custom_run_instructions.trim()
      : "";
  const runtimeFlagLines = [
    runtimeSettings && typeof runtimeSettings.decision_v2_enabled === "boolean"
      ? `- Decision V2: ${runtimeSettings.decision_v2_enabled ? "enabled" : "disabled"}`
      : null,
    runtimeSettings && typeof runtimeSettings.decision_dedupe_enabled === "boolean"
      ? `- Decision dedupe: ${runtimeSettings.decision_dedupe_enabled ? "enabled" : "disabled"}`
      : null,
    runtimeSettings &&
    typeof runtimeSettings.decision_evidence_required_for_blocking === "boolean"
      ? `- Blocking evidence required: ${runtimeSettings.decision_evidence_required_for_blocking ? "enabled" : "disabled"}`
      : null,
    runtimeSettings &&
    typeof runtimeSettings.decision_auto_resolve_guarded_enabled === "boolean"
      ? `- Guarded auto-resolve: ${runtimeSettings.decision_auto_resolve_guarded_enabled ? "enabled" : "disabled"}`
      : null,
    runtimeSettings &&
    typeof runtimeSettings.question_auto_answer_enabled === "boolean"
      ? `- Question auto-answer: ${runtimeSettings.question_auto_answer_enabled ? "enabled" : "disabled"}`
      : null,
    runtimeSettings &&
    typeof runtimeSettings.question_auto_answer_timeout_sec === "number"
      ? `- Question auto-answer timeout: ${Math.max(10, Math.min(3600, Math.floor(runtimeSettings.question_auto_answer_timeout_sec)))}s`
      : runtimeSettings &&
        typeof runtimeSettings.question_auto_answer_delay_seconds === "number"
      ? `- Question auto-answer delay: ${Math.max(1, Math.min(900, Math.floor(runtimeSettings.question_auto_answer_delay_seconds)))}s`
      : null,
    runtimeSettings &&
    typeof runtimeSettings.question_auto_answer_policy === "string"
      ? `- Question auto-answer policy: ${runtimeSettings.question_auto_answer_policy}`
      : null,
    runtimeSettings &&
    typeof runtimeSettings.question_blocking_behavior === "string"
      ? `- Blocking question behavior: ${runtimeSettings.question_blocking_behavior}`
      : null,
    runtimeSettings &&
    typeof runtimeSettings.question_auto_answer_action === "string"
      ? `- Question auto-answer action: ${
          runtimeSettings.question_auto_answer_action.trim().toLowerCase() === "reject"
            ? "reject"
            : "approve"
        }`
      : null,
    runtimeSettings &&
    runtimeSettings.workspace_question_defaults &&
    typeof runtimeSettings.workspace_question_defaults === "object"
      ? "- Workspace question defaults available"
      : null,
  ].filter((line): line is string => Boolean(line));

  const contextHash = kickoff.context_hash?.trim() || null;
  const schemaVersion = (kickoff.schema_version ?? "").trim();

  const lines: string[] = [];
  lines.push("# Kickoff");
  lines.push("");
  if (title) {
    lines.push(`## Target`);
    lines.push(`- ${title}`);
    lines.push("");
  }
  if (overview) {
    lines.push("## Overview");
    lines.push(overview);
    lines.push("");
  } else if (base) {
    lines.push("## Objective");
    lines.push(base);
    lines.push("");
  }

  if (acceptance.length > 0) {
    lines.push("## Acceptance Criteria");
    for (const item of acceptance) lines.push(`- ${item}`);
    lines.push("");
  }

  if (constraints.length > 0) {
    lines.push("## Constraints");
    for (const item of constraints) lines.push(`- ${item}`);
    lines.push("");
  }

  if (risks.length > 0) {
    lines.push("## Risks");
    for (const item of risks) lines.push(`- ${item}`);
    lines.push("");
  }

  if (decisions.length > 0 || artifacts.length > 0) {
    lines.push("## References");
    for (const item of decisions) {
      const decisionTitle =
        typeof (item as any)?.title === "string"
          ? String((item as any).title).trim()
          : "";
      const id = typeof (item as any)?.id === "string" ? String((item as any).id).trim() : "";
      const label = decisionTitle || id || "decision";
      lines.push(`- Decision: ${label}`);
    }
    for (const item of artifacts) {
      const artifactTitle =
        typeof (item as any)?.title === "string"
          ? String((item as any).title).trim()
          : "";
      const id = typeof (item as any)?.id === "string" ? String((item as any).id).trim() : "";
      const label = artifactTitle || id || "artifact";
      lines.push(`- Artifact: ${label}`);
    }
    lines.push("");
  }

  lines.push("## Operating Mode");
  if (input.domain) lines.push(`- Domain: ${input.domain}`);
  if (input.requiredSkills.length > 0) {
    lines.push(`- Skills: ${input.requiredSkills.join(", ")}`);
  }
  lines.push("- Communicate early when blocked. Provide options, tradeoffs, and a recommendation.");
  lines.push("- Verify before claiming done. Prefer proof (commands/tests) over confidence.");
  lines.push("");

  if (runtimeFlagLines.length > 0 || customRunInstructions) {
    lines.push("## Runtime Settings");
    for (const line of runtimeFlagLines) lines.push(line);
    if (customRunInstructions) {
      lines.push("- Custom run instructions:");
      lines.push(`  ${customRunInstructions}`);
    }
    lines.push("");
  }

  if (personaVoice || collaborationStyle || personaDefaults.length > 0) {
    lines.push("## Behavior");
    if (personaVoice) lines.push(`- Voice: ${personaVoice}`);
    if (collaborationStyle) lines.push(`- Collaboration style: ${collaborationStyle}`);
    for (const item of personaDefaults) lines.push(`- Default: ${item}`);
    lines.push("");
  }

  if (allow.length > 0 || deny.length > 0 || toolNotes) {
    lines.push("## Tool Scope");
    if (allow.length > 0) lines.push(`- Allow: ${allow.join(", ")}`);
    if (deny.length > 0) lines.push(`- Deny: ${deny.join(", ")}`);
    if (toolNotes) lines.push(`- Notes: ${toolNotes}`);
    lines.push("");
  }

  if (reporting.length > 0) {
    lines.push("## Reporting");
    for (const item of reporting) lines.push(`- ${item}`);
    lines.push("");
  }

  const teamContext = kickoff.team_context;
  if (teamContext) {
    const completions = Array.isArray(teamContext.recent_completions)
      ? teamContext.recent_completions.slice(0, 5)
      : [];
    const teamDecisions = Array.isArray(teamContext.recent_decisions)
      ? teamContext.recent_decisions.slice(0, 3)
      : [];

    if (completions.length > 0 || teamDecisions.length > 0) {
      lines.push("## Team Activity");
      lines.push("Recent work by other agents (for awareness, not direct action):");
      for (const c of completions) {
        const outputs =
          Array.isArray(c.key_outputs) && c.key_outputs.length > 0
            ? ` (${c.key_outputs.join(", ")})`
            : "";
        lines.push(`- [${c.domain}] ${c.task_title}: ${c.summary}${outputs}`);
      }
      if (teamDecisions.length > 0) {
        lines.push("");
        lines.push("Recent decisions:");
        for (const d of teamDecisions) {
          lines.push(`- ${d.title}: ${d.resolution}`);
        }
      }
      lines.push("");
      lines.push("Reference naturally when relevant. Do not summarize back.");
      lines.push("");
    }
  }

  if (contextHash || schemaVersion) {
    lines.push("## Provenance");
    if (schemaVersion) lines.push(`- kickoff_schema: ${schemaVersion}`);
    if (contextHash) lines.push(`- kickoff_context_hash: ${contextHash}`);
    lines.push("");
  }

  return {
    message: lines.join("\n").trimEnd(),
    contextHash,
  };
}
