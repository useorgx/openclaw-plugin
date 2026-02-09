import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { InitiativeDetails, InitiativeTask, InitiativeWorkstream } from '@/types';
import { Modal } from '@/components/shared/Modal';
import { colors } from '@/lib/tokens';
import { cn } from '@/lib/utils';
import { useEntityInitiatives } from '@/hooks/useEntityInitiatives';
import { useInitiativeDetails } from '@/hooks/useInitiativeDetails';

type AgentContext = {
  agentId: string;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
  updatedAt: string;
};

type AgentRunRecord = {
  runId: string;
  agentId: string;
  pid: number | null;
  message: string | null;
  provider: string | null;
  model: string | null;
  initiativeId: string | null;
  initiativeTitle: string | null;
  workstreamId: string | null;
  taskId: string | null;
  startedAt: string;
  stoppedAt: string | null;
  status: 'running' | 'stopped';
};

type OpenClawCatalogAgent = {
  id: string;
  name: string;
  workspace: string | null;
  model: string | null;
  isDefault: boolean;
  status: string | null;
  currentTask: string | null;
  runId: string | null;
  startedAt: string | null;
  blockers: string[];
  context: AgentContext | null;
  run?: AgentRunRecord | null;
};

type AgentCatalogResponse = {
  generatedAt: string;
  agents: OpenClawCatalogAgent[];
};

function toStatusBadge(status: string | null) {
  const normalized = (status ?? '').toLowerCase();
  if (normalized === 'active') return { label: 'Active', color: colors.lime, bg: 'rgba(191,255,0,0.12)' };
  if (normalized === 'blocked') return { label: 'Blocked', color: '#fb7185', bg: 'rgba(244, 63, 94, 0.12)' };
  if (normalized === 'idle') return { label: 'Idle', color: 'rgba(255,255,255,0.55)', bg: 'rgba(255,255,255,0.06)' };
  return { label: status ? status : 'Unknown', color: colors.iris, bg: 'rgba(124,124,255,0.10)' };
}

function sortWorkstreams(details: InitiativeDetails): InitiativeWorkstream[] {
  return [...details.workstreams].sort((a, b) => a.name.localeCompare(b.name));
}

function sortTasks(details: InitiativeDetails, workstreamId: string | null): InitiativeTask[] {
  const items = workstreamId
    ? details.tasks.filter((task) => task.workstreamId === workstreamId)
    : details.tasks;
  return [...items].sort((a, b) => a.title.localeCompare(b.title));
}

export function AgentLaunchModal({
  open,
  onClose,
  onLaunched,
}: {
  open: boolean;
  onClose: () => void;
  onLaunched?: () => void;
}) {
  const catalogQuery = useQuery<AgentCatalogResponse>({
    queryKey: ['openclaw-agent-catalog'],
    queryFn: async () => {
      const res = await fetch('/orgx/api/agents/catalog');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Agent catalog failed (${res.status})`);
      }
      return (await res.json()) as AgentCatalogResponse;
    },
    enabled: open,
    staleTime: 2_000,
    refetchInterval: open ? 3_000 : false,
  });

  const { data: initiatives } = useEntityInitiatives(open);

  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [selectedInitiativeId, setSelectedInitiativeId] = useState<string>('');
  const [selectedWorkstreamId, setSelectedWorkstreamId] = useState<string>('');
  const [selectedTaskId, setSelectedTaskId] = useState<string>('');
  const [selectedProvider, setSelectedProvider] = useState<string>('auto');
  const [message, setMessage] = useState<string>('');
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);

  const selectedInitiative = useMemo(() => {
    const id = selectedInitiativeId.trim();
    if (!id) return null;
    return initiatives?.find((init) => init.id === id) ?? null;
  }, [initiatives, selectedInitiativeId]);

  const { details } = useInitiativeDetails({
    initiativeId: selectedInitiative ? selectedInitiative.id : null,
    enabled: open && Boolean(selectedInitiative),
  });

  const workstreams = useMemo(() => sortWorkstreams(details), [details]);
  const tasks = useMemo(
    () => sortTasks(details, selectedWorkstreamId ? selectedWorkstreamId : null),
    [details, selectedWorkstreamId]
  );

  const catalogAgents = catalogQuery.data?.agents ?? [];
  const selectedAgent = useMemo(() => {
    const id = selectedAgentId.trim();
    if (!id) return null;
    return catalogAgents.find((agent) => agent.id === id) ?? null;
  }, [catalogAgents, selectedAgentId]);

  useEffect(() => {
    if (!open) return;

    // Default to the current default agent, otherwise first in list.
    const nextAgent =
      catalogAgents.find((agent) => agent.isDefault)?.id ??
      catalogAgents[0]?.id ??
      '';
    if (!selectedAgentId && nextAgent) {
      setSelectedAgentId(nextAgent);
    }
  }, [catalogAgents, open, selectedAgentId]);

  useEffect(() => {
    if (!open) return;
    const model = selectedAgent?.model ?? '';
    const inferred =
      model.includes('openrouter')
        ? 'openrouter'
        : model.includes('anthropic')
          ? 'anthropic'
          : model.includes('openai')
            ? 'openai'
            : 'auto';
    setSelectedProvider(inferred);
  }, [open, selectedAgent?.model, selectedAgentId]);

  useEffect(() => {
    if (!open) return;
    setLaunchError(null);
  }, [open]);

  useEffect(() => {
    // Reset downstream selections if the initiative changes.
    setSelectedWorkstreamId('');
    setSelectedTaskId('');
  }, [selectedInitiativeId]);

  useEffect(() => {
    setSelectedTaskId('');
  }, [selectedWorkstreamId]);

  useEffect(() => {
    if (!open) return;
    if (message.trim().length > 0) return;
    if (!selectedInitiative) return;
    setMessage(`Kick off: ${selectedInitiative.name}`);
  }, [message, open, selectedInitiative]);

  const canLaunch = Boolean(selectedAgentId.trim()) && Boolean(selectedInitiativeId.trim());

  const launch = async () => {
    if (!canLaunch || isLaunching) return;
    setLaunchError(null);
    setIsLaunching(true);
    try {
      const payload = {
        agentId: selectedAgentId.trim(),
        message: message.trim() ? message.trim() : undefined,
        initiativeId: selectedInitiativeId.trim(),
        initiativeTitle: selectedInitiative?.name ?? null,
        workstreamId: selectedWorkstreamId.trim() ? selectedWorkstreamId.trim() : null,
        taskId: selectedTaskId.trim() ? selectedTaskId.trim() : null,
        provider: selectedProvider !== 'auto' ? selectedProvider : null,
      };
      const query = new URLSearchParams();
      query.set('agentId', payload.agentId);
      query.set('initiativeId', payload.initiativeId);
      if (payload.initiativeTitle) query.set('initiativeTitle', payload.initiativeTitle);
      if (payload.workstreamId) query.set('workstreamId', payload.workstreamId);
      if (payload.taskId) query.set('taskId', payload.taskId);
      if (payload.message) query.set('message', payload.message);
      if (payload.provider) query.set('provider', payload.provider);

      // Some OpenClaw gateway builds do not expose request bodies to plugin HTTP handlers.
      // We send launch parameters via query string (and keep the request as POST).
      const res = await fetch(`/orgx/api/agents/launch?${query.toString()}`, {
        method: 'POST',
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error ?? `Launch failed (${res.status})`);
      }
      onClose();
      onLaunched?.();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Launch failed');
    } finally {
      setIsLaunching(false);
    }
  };

  const canControlRun = Boolean(selectedAgent?.run?.runId) && Boolean(selectedAgent?.run?.pid);

  const stopRun = async () => {
    if (!selectedAgent?.run?.runId || !canControlRun || isLaunching) return;
    setLaunchError(null);
    setIsLaunching(true);
    try {
      const res = await fetch(`/orgx/api/agents/stop?runId=${encodeURIComponent(selectedAgent.run.runId)}`, {
        method: 'POST',
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error ?? `Stop failed (${res.status})`);
      }
      await catalogQuery.refetch();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Stop failed');
    } finally {
      setIsLaunching(false);
    }
  };

  const restartRun = async () => {
    if (!selectedAgent?.run?.runId || isLaunching) return;
    setLaunchError(null);
    setIsLaunching(true);
    try {
      const query = new URLSearchParams();
      query.set('runId', selectedAgent.run.runId);
      if (message.trim()) query.set('message', message.trim());
      if (selectedProvider && selectedProvider !== 'auto') query.set('provider', selectedProvider);

      const res = await fetch(`/orgx/api/agents/restart?${query.toString()}`, { method: 'POST' });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error ?? `Restart failed (${res.status})`);
      }
      onClose();
      onLaunched?.();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Restart failed');
    } finally {
      setIsLaunching(false);
    }
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-[14px] font-semibold text-white">Launch OpenClaw Agent</h3>
              <p className="mt-1 text-[12px] text-white/55">
                Starts a background agent turn and scopes the resulting sessions/activity to the selected OrgX initiative.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[12px] text-white/60 hover:bg-white/[0.08] hover:text-white"
            >
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {catalogQuery.isLoading && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-[12px] text-white/55">
              Loading agent catalog…
            </div>
          )}

          {catalogQuery.error && (
            <div className="rounded-xl border border-rose-300/20 bg-rose-400/10 p-4 text-[12px] text-rose-100">
              {(catalogQuery.error as Error).message}
            </div>
          )}

          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="text-[11px] uppercase tracking-[0.1em] text-white/35">Agent</label>
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-[12px] text-white/80 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
              >
                {catalogAgents.map((agent) => {
                  const badge = toStatusBadge(agent.status);
                  return (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.id}) · {badge.label}
                    </option>
                  );
                })}
              </select>
              {selectedAgent && (
                <div className="mt-2 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-white/60">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-white/80">{selectedAgent.name}</span>
                    <span
                      className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]"
                      style={{
                        borderColor: `${toStatusBadge(selectedAgent.status).color}55`,
                        color: toStatusBadge(selectedAgent.status).color,
                        backgroundColor: toStatusBadge(selectedAgent.status).bg,
                      }}
                    >
                      {toStatusBadge(selectedAgent.status).label}
                    </span>
                  </div>
                  <div className="mt-2 space-y-2">
                    <p className="truncate">
                      <span className="text-white/40">Model:</span> {selectedAgent.model ?? 'unknown'}
                    </p>
                    <p className="truncate">
                      <span className="text-white/40">Workspace:</span> {selectedAgent.workspace ?? 'unknown'}
                    </p>
                    {selectedAgent.context?.initiativeId && (
                      <p className="truncate">
                        <span className="text-white/40">Scoped:</span>{' '}
                        {selectedAgent.context.initiativeTitle ?? selectedAgent.context.initiativeId}
                      </p>
                    )}

                    <div>
                      <label className="text-[10px] uppercase tracking-[0.12em] text-white/30">Provider</label>
                      <select
                        value={selectedProvider}
                        onChange={(e) => setSelectedProvider(e.target.value)}
                        className="mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-[12px] text-white/80 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
                      >
                        <option value="auto">Auto (keep agent model)</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="openai">OpenAI</option>
                      </select>
                      <p className="mt-1 text-[10px] text-white/35">
                        Selecting a provider updates the agent&apos;s default model before launch.
                      </p>
                    </div>

                    {selectedAgent.run && (
                      <p className="truncate">
                        <span className="text-white/40">Tracked run:</span>{' '}
                        {selectedAgent.run.runId.slice(0, 8)}…{' '}
                        <span className="text-white/35">({selectedAgent.run.status})</span>
                      </p>
                    )}

                    {selectedAgent.run && (
                      <div className="grid grid-cols-2 gap-2 pt-1">
                        <button
                          type="button"
                          onClick={stopRun}
                          disabled={!canControlRun || isLaunching}
                          className="rounded-lg border border-rose-300/25 bg-rose-400/10 px-3 py-2 text-[11px] font-semibold text-rose-100 transition-colors hover:bg-rose-400/20 disabled:opacity-45"
                        >
                          Stop Run
                        </button>
                        <button
                          type="button"
                          onClick={restartRun}
                          disabled={isLaunching}
                          className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-2 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
                        >
                          Restart
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div>
              <label className="text-[11px] uppercase tracking-[0.1em] text-white/35">Initiative Scope</label>
              <select
                value={selectedInitiativeId}
                onChange={(e) => setSelectedInitiativeId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-[12px] text-white/80 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
              >
                <option value="">Select an initiative…</option>
                {(initiatives ?? []).map((initiative) => (
                  <option key={initiative.id} value={initiative.id}>
                    {initiative.name}
                  </option>
                ))}
              </select>

              <div className="mt-3 grid grid-cols-1 gap-3">
                <div>
                  <label className="text-[10px] uppercase tracking-[0.12em] text-white/30">Workstream (optional)</label>
                  <select
                    value={selectedWorkstreamId}
                    onChange={(e) => setSelectedWorkstreamId(e.target.value)}
                    disabled={!selectedInitiative}
                    className={cn(
                      'mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-[12px] text-white/80 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30',
                      !selectedInitiative && 'opacity-50'
                    )}
                  >
                    <option value="">Any workstream</option>
                    {workstreams.map((ws) => (
                      <option key={ws.id} value={ws.id}>
                        {ws.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-[10px] uppercase tracking-[0.12em] text-white/30">Task (optional)</label>
                  <select
                    value={selectedTaskId}
                    onChange={(e) => setSelectedTaskId(e.target.value)}
                    disabled={!selectedInitiative}
                    className={cn(
                      'mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-[12px] text-white/80 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30',
                      !selectedInitiative && 'opacity-50'
                    )}
                  >
                    <option value="">Any task</option>
                    {tasks.slice(0, 80).map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                  </select>
                  {tasks.length > 80 && (
                    <p className="mt-1 text-[10px] text-white/35">
                      Showing first 80 tasks to keep the menu usable.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label className="text-[11px] uppercase tracking-[0.1em] text-white/35">Kickoff Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="mt-1 w-full resize-none rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-[12px] text-white/80 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
              placeholder="Optional. If left blank, a default kickoff message is used."
            />
          </div>

          {launchError && (
            <div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-[12px] text-rose-100">
              {launchError}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-5 py-3.5 sm:px-6">
          <div className="text-[11px] text-white/45">
            {canLaunch ? 'Launch will update sessions/activity under the selected initiative.' : 'Select an agent and initiative to launch.'}
          </div>
          <button
            type="button"
            onClick={launch}
            disabled={!canLaunch || isLaunching}
            className={cn(
              'rounded-xl px-4 py-2 text-[12px] font-semibold transition-colors',
              canLaunch && !isLaunching
                ? 'text-black'
                : 'cursor-not-allowed border border-white/[0.12] bg-white/[0.05] text-white/40'
            )}
            style={canLaunch && !isLaunching ? { backgroundColor: colors.lime } : undefined}
          >
            {isLaunching ? 'Launching…' : 'Launch'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
