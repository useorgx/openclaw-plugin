import type { Router } from "../router.js";

type OpenClawAgentEntry = {
  id?: string;
  name?: string;
  workspace?: string;
  model?: string;
  isDefault?: boolean;
};

type LocalAgentSnapshot = {
  id: string;
  status: string;
  currentTask: string | null;
  runId: string | null;
  startedAt: string | null;
  blockers: string[];
};

type LocalSnapshot = {
  agents: LocalAgentSnapshot[];
};

type AgentRun = {
  agentId: string;
  startedAt: string | null;
  status: string;
};

type AgentRunStoreSnapshot = {
  runs: Record<string, AgentRun & Record<string, unknown>>;
};

type AgentContextStoreSnapshot = {
  agents: Record<string, unknown>;
};

type AgentsCatalogDeps<TRes> = {
  listAgents: () => Promise<OpenClawAgentEntry[]>;
  loadLocalSnapshot: () => Promise<LocalSnapshot | null>;
  readAgentContexts: () => AgentContextStoreSnapshot;
  readAgentRuns: () => AgentRunStoreSnapshot;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
};

export function registerAgentsCatalogRoutes<TReq, TRes>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: AgentsCatalogDeps<TRes>
): void {
  async function handle(res: TRes): Promise<void> {
    try {
      let openclawAgents: OpenClawAgentEntry[] = [];
      let openclawAgentsError: string | null = null;
      try {
        const fetched = await deps.listAgents();
        openclawAgents = Array.isArray(fetched) ? fetched : [];
      } catch (err: unknown) {
        openclawAgentsError = deps.safeErrorMessage(err);
      }
      const localSnapshot = await deps.loadLocalSnapshot().catch(() => null);
      const localAgents = Array.isArray(localSnapshot?.agents)
        ? localSnapshot.agents
        : [];
      const warnings: string[] = [];
      if (openclawAgentsError) {
        warnings.push(`openclaw agent discovery unavailable: ${openclawAgentsError}`);
      }

      const localById = new Map<
        string,
        {
          status: string;
          currentTask: string | null;
          runId: string | null;
          startedAt: string | null;
          blockers: string[];
        }
      >();
      if (localAgents.length > 0) {
        for (const agent of localAgents) {
          localById.set(agent.id, {
            status: agent.status,
            currentTask: agent.currentTask,
            runId: agent.runId,
            startedAt: agent.startedAt,
            blockers: agent.blockers,
          });
        }
      }

      let contexts: Record<string, unknown> = {};
      try {
        contexts = deps.readAgentContexts().agents ?? {};
      } catch (err: unknown) {
        warnings.push(`agent context snapshot unavailable: ${deps.safeErrorMessage(err)}`);
      }

      let runs: Record<string, AgentRun & Record<string, unknown>> = {};
      try {
        runs = deps.readAgentRuns().runs ?? {};
      } catch (err: unknown) {
        warnings.push(`agent run snapshot unavailable: ${deps.safeErrorMessage(err)}`);
      }

      const latestRunByAgent = new Map<string, (typeof runs)[string]>();
      const openclawById = new Map<string, OpenClawAgentEntry>();

      for (const run of Object.values(runs)) {
        if (!run || typeof run !== "object") continue;
        const agentId = typeof run.agentId === "string" ? run.agentId.trim() : "";
        if (!agentId) continue;
        const existing = latestRunByAgent.get(agentId);
        const nextTs = Date.parse(run.startedAt ?? "");
        const existingTs = existing ? Date.parse(existing.startedAt ?? "") : 0;

        if (!existing) {
          latestRunByAgent.set(agentId, run);
          continue;
        }

        const existingRunning = existing.status === "running";
        const nextRunning = run.status === "running";
        if (nextRunning && !existingRunning) {
          latestRunByAgent.set(agentId, run);
          continue;
        }
        if (nextRunning === existingRunning && nextTs > existingTs) {
          latestRunByAgent.set(agentId, run);
        }
      }

      for (const entry of openclawAgents) {
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        if (!id) continue;
        openclawById.set(id, entry);
      }

      const candidateAgentIds = new Set<string>();
      for (const id of openclawById.keys()) candidateAgentIds.add(id);
      for (const id of localById.keys()) candidateAgentIds.add(id);
      for (const id of Object.keys(contexts ?? {})) {
        const normalized = id.trim();
        if (normalized) candidateAgentIds.add(normalized);
      }
      for (const id of latestRunByAgent.keys()) candidateAgentIds.add(id);

      const agents = [...candidateAgentIds].sort((a, b) => a.localeCompare(b)).map((agentId) => {
        const entry = openclawById.get(agentId) ?? null;
        const name =
          typeof entry?.name === "string" && entry.name.trim().length > 0
            ? entry.name.trim()
            : agentId || "unknown";
        const local = localById.get(agentId) ?? null;
        const context = contexts[agentId] ?? null;
        const runFromSession = local?.runId ? runs[local.runId] ?? null : null;
        const run = runFromSession ?? (latestRunByAgent.get(agentId) ?? null);
        return {
          id: agentId,
          name,
          workspace: typeof entry?.workspace === "string" ? entry.workspace : null,
          model: typeof entry?.model === "string" ? entry.model : null,
          isDefault: Boolean(entry?.isDefault),
          status: local?.status ?? null,
          currentTask: local?.currentTask ?? null,
          runId: local?.runId ?? null,
          startedAt: local?.startedAt ?? null,
          blockers: local?.blockers ?? [],
          context,
          run,
        };
      });

      deps.sendJson(res, 200, {
        generatedAt: new Date().toISOString(),
        agents,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (err: unknown) {
      deps.sendJson(res, 500, {
        error: deps.safeErrorMessage(err),
      });
    }
  }

  router.add("GET", "agents/catalog", async ({ res }) => handle(res), "Agent catalog");
  router.add(
    "HEAD",
    "agents/catalog",
    async ({ res }) => handle(res),
    "Agent catalog (HEAD)"
  );
}
