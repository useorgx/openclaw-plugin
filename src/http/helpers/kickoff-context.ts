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
