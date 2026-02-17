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
      const [openclawAgents, localSnapshot] = await Promise.all([
        deps.listAgents(),
        deps.loadLocalSnapshot(),
      ]);

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
      if (localSnapshot) {
        for (const agent of localSnapshot.agents) {
          localById.set(agent.id, {
            status: agent.status,
            currentTask: agent.currentTask,
            runId: agent.runId,
            startedAt: agent.startedAt,
            blockers: agent.blockers,
          });
        }
      }

      const contexts = deps.readAgentContexts().agents;
      const runs = deps.readAgentRuns().runs;
      const latestRunByAgent = new Map<string, (typeof runs)[string]>();

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

      const agents = openclawAgents.map((entry) => {
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        const name =
          typeof entry.name === "string" && entry.name.trim().length > 0
            ? entry.name.trim()
            : id || "unknown";
        const local = id ? localById.get(id) ?? null : null;
        const context = id ? contexts[id] ?? null : null;
        const runFromSession = id && local?.runId ? runs[local.runId] ?? null : null;
        const run = runFromSession ?? (id ? latestRunByAgent.get(id) ?? null : null);
        return {
          id,
          name,
          workspace: typeof entry.workspace === "string" ? entry.workspace : null,
          model: typeof entry.model === "string" ? entry.model : null,
          isDefault: Boolean(entry.isDefault),
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
