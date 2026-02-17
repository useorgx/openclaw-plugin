export type AutoAssignedAgent = {
  id: string;
  name: string;
  domain: string | null;
};

type LiveAgent = AutoAssignedAgent & { status: string | null };

export async function autoAssignEntityForCreate(input: {
  client: {
    getLiveAgents: (payload: {
      initiative: string | null;
      includeIdle: boolean;
    }) => Promise<{ agents?: unknown[] }>;
    delegationPreflight: (payload: {
      intent: string;
    }) => Promise<{ data?: { recommended_split?: Array<{ owner_domain?: string | null }> } }>;
    updateEntity: (
      entityType: string,
      entityId: string,
      payload: Record<string, unknown>
    ) => Promise<unknown>;
  };
  toErrorMessage: (err: unknown) => string;
  entityType: string;
  entityId: string;
  initiativeId: string | null;
  title: string;
  summary: string | null;
}): Promise<{
  assignmentSource: "orchestrator" | "fallback" | "manual";
  assignedAgents: AutoAssignedAgent[];
  warnings: string[];
  updatedEntity: Record<string, unknown> | null;
}> {
  const warnings: string[] = [];
  const byKey = new Map<string, AutoAssignedAgent>();
  const addAgent = (agent: AutoAssignedAgent) => {
    const key = `${agent.id}:${agent.name}`.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, agent);
  };

  let liveAgents: LiveAgent[] = [];
  try {
    const agentResp = await input.client.getLiveAgents({
      initiative: input.initiativeId,
      includeIdle: true,
    });
    liveAgents = (Array.isArray(agentResp.agents) ? agentResp.agents : [])
      .map((raw): LiveAgent | null => {
        if (!raw || typeof raw !== "object") return null;
        const record = raw as Record<string, unknown>;
        const id =
          (typeof record.id === "string" && record.id.trim()) ||
          (typeof record.agentId === "string" && record.agentId.trim()) ||
          "";
        const name =
          (typeof record.name === "string" && record.name.trim()) ||
          (typeof record.agentName === "string" && record.agentName.trim()) ||
          id;
        if (!name) return null;
        return {
          id: id || `name:${name}`,
          name,
          domain:
            (typeof record.domain === "string" && record.domain.trim()) ||
            (typeof record.role === "string" && record.role.trim()) ||
            null,
          status:
            (typeof record.status === "string" && record.status.trim()) || null,
        };
      })
      .filter((agent): agent is LiveAgent => agent !== null);
  } catch (err: unknown) {
    warnings.push(`live agents unavailable (${input.toErrorMessage(err)})`);
  }

  const orchestrator = liveAgents.find(
    (agent) =>
      /holt|orchestrator/i.test(agent.name) ||
      /orchestrator/i.test(agent.domain ?? "")
  );
  if (orchestrator) addAgent(orchestrator);

  let assignmentSource: "orchestrator" | "fallback" | "manual" = "fallback";
  try {
    const preflight = await input.client.delegationPreflight({
      intent: `${input.title}${input.summary ? `: ${input.summary}` : ""}`,
    });
    const recommendations = preflight.data?.recommended_split ?? [];
    const recommendedDomains = [
      ...new Set(
        recommendations
          .map((entry) => String(entry.owner_domain ?? "").trim().toLowerCase())
          .filter(Boolean)
      ),
    ];
    for (const domain of recommendedDomains) {
      const match = liveAgents.find((agent) =>
        (agent.domain ?? "").toLowerCase().includes(domain)
      );
      if (match) addAgent(match);
    }
    if (recommendedDomains.length > 0) {
      assignmentSource = "orchestrator";
    }
  } catch (err: unknown) {
    warnings.push(`delegation preflight failed (${input.toErrorMessage(err)})`);
  }

  if (byKey.size === 0) {
    const haystack = `${input.title} ${input.summary ?? ""}`.toLowerCase();
    const domainHints: string[] = [];
    if (/market|campaign|thread|article|tweet|copy/.test(haystack)) {
      domainHints.push("marketing");
    } else if (/design|ux|ui|a11y/.test(haystack)) {
      domainHints.push("design");
    } else if (/ops|runbook|incident|reliability/.test(haystack)) {
      domainHints.push("operations");
    } else if (/sales|deal|pipeline/.test(haystack)) {
      domainHints.push("sales");
    } else {
      domainHints.push("engineering", "product");
    }

    for (const domain of domainHints) {
      const match = liveAgents.find((agent) =>
        (agent.domain ?? "").toLowerCase().includes(domain)
      );
      if (match) addAgent(match);
    }
  }

  if (byKey.size === 0 && liveAgents.length > 0) {
    addAgent(liveAgents[0]);
    warnings.push("fallback selected first available live agent");
  }

  const assignedAgents = Array.from(byKey.values());
  let updatedEntity: Record<string, unknown> | null = null;
  try {
    updatedEntity = (await input.client.updateEntity(input.entityType, input.entityId, {
      assigned_agent_ids: assignedAgents.map((agent) => agent.id),
      assigned_agent_names: assignedAgents.map((agent) => agent.name),
      assignment_source: assignmentSource,
    })) as Record<string, unknown>;
  } catch (err: unknown) {
    warnings.push(`assignment update failed (${input.toErrorMessage(err)})`);
  }

  return {
    assignmentSource,
    assignedAgents,
    warnings,
    updatedEntity,
  };
}
