import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
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

type UpgradeActions = {
  checkout?: string;
  portal?: string;
  pricing?: string;
};

type LaunchErrorPayload = {
  ok?: boolean;
  error?: string;
  code?: string;
  requiredPlan?: string;
  currentPlan?: string;
  actions?: UpgradeActions;
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
  const [upgradeActions, setUpgradeActions] = useState<UpgradeActions | null>(null);
  const [requiredPlan, setRequiredPlan] = useState<string>('starter');
  const [isLaunching, setIsLaunching] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);

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
    if (selectedInitiativeId.trim()) return;
    const list = initiatives ?? [];
    const only = list.length === 1 ? list[0] : null;
    if (only) {
      setSelectedInitiativeId(only.id);
    }
  }, [initiatives, open, selectedInitiativeId]);

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
    setUpgradeActions(null);
    setRequiredPlan('starter');
    setStep(1);
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
  const canContinueStep =
    step === 1
      ? Boolean(selectedAgentId.trim())
      : step === 2
        ? Boolean(selectedInitiativeId.trim())
        : canLaunch;

  const openCheckout = async () => {
    const checkoutPath = upgradeActions?.checkout ?? '/orgx/api/billing/checkout';
    const planId = requiredPlan && requiredPlan.trim().length > 0 ? requiredPlan.trim() : 'starter';
    const res = await fetch(checkoutPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, billingCycle: 'monthly' }),
    });
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; data?: { url?: string | null }; url?: string | null; error?: string } | null;
    const url = payload?.data?.url ?? payload?.url ?? null;
    if (!url) {
      throw new Error(payload?.error ?? 'Checkout unavailable');
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const openBillingPortal = async () => {
    const portalPath = upgradeActions?.portal ?? '/orgx/api/billing/portal';
    const res = await fetch(portalPath, { method: 'POST' });
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; data?: { url?: string | null }; url?: string | null; error?: string } | null;
    const url = payload?.data?.url ?? payload?.url ?? null;
    if (!url) {
      throw new Error(payload?.error ?? 'Billing portal unavailable');
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const launch = async () => {
    if (!canLaunch || isLaunching) return;
    setLaunchError(null);
    setUpgradeActions(null);
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
      const json = (await res.json().catch(() => null)) as LaunchErrorPayload | null;
      if (!res.ok || !json?.ok) {
        if (json?.code === 'upgrade_required') {
          setUpgradeActions(json.actions ?? null);
          setRequiredPlan(json.requiredPlan ?? 'starter');
        }
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
        <div className="border-b border-subtle px-5 py-4 sm:px-6">
	          <div className="flex items-start justify-between gap-4">
	            <div>
	              <h3 className="text-heading font-semibold text-white">Launch OpenClaw Agent</h3>
	              <p className="mt-1 text-body text-secondary">
	                Starts a background agent turn and scopes the resulting sessions/activity to the selected OrgX initiative.
	              </p>
	              <div className="mt-3 inline-flex items-center gap-1 rounded-full border border-strong bg-white/[0.03] p-1 text-micro uppercase tracking-[0.12em] text-secondary">
	                {(
	                  [
	                    [1, 'Agent'],
	                    [2, 'Scope'],
	                    [3, 'Message'],
	                  ] as const
	                ).map(([value, label]) => (
	                  <button
	                    key={value}
	                    type="button"
	                    onClick={() => setStep(value)}
	                    className={cn(
	                      'rounded-full px-3 py-1 transition-colors',
	                      step === value ? 'bg-white/[0.12] text-white' : 'hover:bg-white/[0.06]'
	                    )}
	                  >
	                    {value}. {label}
	                  </button>
	                ))}
	              </div>
	            </div>
	            <button
	              type="button"
	              onClick={onClose}
              className="rounded-lg border border-strong bg-white/[0.03] px-3 py-1.5 text-body text-secondary hover:bg-white/[0.08] hover:text-white"
            >
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {catalogQuery.isLoading && (
            <div className="rounded-xl border border-subtle bg-white/[0.02] p-4 text-body text-secondary">
              Loading agent catalog…
            </div>
          )}

	          {catalogQuery.error && (
	            <div className="rounded-xl border border-rose-300/20 bg-rose-400/10 p-4 text-body text-rose-100">
	              {(catalogQuery.error as Error).message}
	            </div>
	          )}

	          <AnimatePresence mode="wait">
	            <motion.div
	              key={step}
	              initial={{ opacity: 0, y: 10 }}
	              animate={{ opacity: 1, y: 0 }}
	              exit={{ opacity: 0, y: -8 }}
	              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
	              className="mt-3 space-y-4"
	            >
	              {step === 1 && (
	                <div className="space-y-4">
	                  <div>
	                    <label className="text-caption uppercase tracking-[0.1em] text-muted">Agent</label>
	                    <select
	                      value={selectedAgentId}
	                      onChange={(e) => setSelectedAgentId(e.target.value)}
	                      className="mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-body text-primary focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
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
	                  </div>

	                  {selectedAgent && (
	                    <div className="rounded-xl border border-subtle bg-white/[0.02] p-3 text-body text-secondary">
	                      <div className="flex items-center justify-between gap-2">
	                        <span className="font-medium text-primary">{selectedAgent.name}</span>
	                        <span
	                          className="rounded-full border px-2 py-0.5 text-micro uppercase tracking-[0.12em]"
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
	                          <span className="text-muted">Model:</span> {selectedAgent.model ?? 'unknown'}
	                        </p>
	                        <p className="truncate">
	                          <span className="text-muted">Workspace:</span> {selectedAgent.workspace ?? 'unknown'}
	                        </p>
	                        {selectedAgent.context?.initiativeId && (
	                          <p className="truncate">
	                            <span className="text-muted">Scoped:</span>{' '}
	                            {selectedAgent.context.initiativeTitle ?? selectedAgent.context.initiativeId}
	                          </p>
	                        )}

	                        <div>
	                          <label className="text-micro uppercase tracking-[0.12em] text-muted">Provider</label>
	                          <select
	                            value={selectedProvider}
	                            onChange={(e) => setSelectedProvider(e.target.value)}
	                            className="mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-body text-primary focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
	                          >
	                            <option value="auto">Auto (keep agent model)</option>
	                            <option value="anthropic">Anthropic</option>
	                            <option value="openrouter">OpenRouter</option>
	                            <option value="openai">OpenAI</option>
	                          </select>
	                          <p className="mt-1 text-micro text-muted">
	                            Selecting a provider updates the agent&apos;s default model before launch.
	                          </p>
	                        </div>

	                        {selectedAgent.run && (
	                          <p className="truncate">
	                            <span className="text-muted">Tracked run:</span>{' '}
	                            {selectedAgent.run.runId.slice(0, 8)}…{' '}
	                            <span className="text-muted">({selectedAgent.run.status})</span>
	                          </p>
	                        )}

	                        {selectedAgent.run && (
	                          <div className="grid grid-cols-2 gap-2 pt-1">
	                            <button
	                              type="button"
	                              onClick={stopRun}
	                              disabled={!canControlRun || isLaunching}
	                              className="rounded-lg border border-rose-300/25 bg-rose-400/10 px-3 py-2 text-caption font-semibold text-rose-100 transition-colors hover:bg-rose-400/20 disabled:opacity-45"
	                            >
	                              Stop Run
	                            </button>
	                            <button
	                              type="button"
	                              onClick={restartRun}
	                              disabled={isLaunching}
	                              className="rounded-lg border border-strong bg-white/[0.03] px-3 py-2 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
	                            >
	                              Restart
	                            </button>
	                          </div>
	                        )}
	                      </div>
	                    </div>
	                  )}
	                </div>
	              )}

	              {step === 2 && (
	                <div className="space-y-4">
	                  <div>
	                    <label className="text-caption uppercase tracking-[0.1em] text-muted">Initiative Scope</label>
	                    <select
	                      value={selectedInitiativeId}
	                      onChange={(e) => setSelectedInitiativeId(e.target.value)}
	                      className="mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-body text-primary focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
	                    >
	                      <option value="">Select an initiative…</option>
	                      {(initiatives ?? []).map((initiative) => (
	                        <option key={initiative.id} value={initiative.id}>
	                          {initiative.name}
	                        </option>
	                      ))}
	                    </select>
	                  </div>

	                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
	                    <div>
	                      <label className="text-micro uppercase tracking-[0.12em] text-muted">Workstream (optional)</label>
	                      <select
	                        value={selectedWorkstreamId}
	                        onChange={(e) => setSelectedWorkstreamId(e.target.value)}
	                        disabled={!selectedInitiative}
	                        className={cn(
	                          'mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-body text-primary focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30',
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
	                      <label className="text-micro uppercase tracking-[0.12em] text-muted">Task (optional)</label>
	                      <select
	                        value={selectedTaskId}
	                        onChange={(e) => setSelectedTaskId(e.target.value)}
	                        disabled={!selectedInitiative}
	                        className={cn(
	                          'mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-body text-primary focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30',
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
	                        <p className="mt-1 text-micro text-muted">
	                          Showing first 80 tasks to keep the menu usable.
	                        </p>
	                      )}
	                    </div>
	                  </div>
	                </div>
	              )}

	              {step === 3 && (
	                <div className="space-y-4">
	                  <div>
	                    <label className="text-caption uppercase tracking-[0.1em] text-muted">Kickoff Message</label>
	                    <textarea
	                      value={message}
	                      onChange={(e) => setMessage(e.target.value)}
	                      rows={4}
	                      className="mt-1 w-full resize-none rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-body text-primary focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
	                      placeholder="Optional. If left blank, a default kickoff message is used."
	                    />
	                  </div>

	                  <div className="rounded-xl border border-subtle bg-white/[0.02] p-3 text-body text-secondary">
	                    <p className="text-micro uppercase tracking-[0.12em] text-muted">Review</p>
	                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
	                      <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
	                        <div className="text-micro uppercase tracking-[0.12em] text-muted">Agent</div>
	                        <div className="mt-0.5 truncate text-body text-primary">
	                          {(selectedAgent?.name ?? selectedAgentId.trim()) || '—'}
	                        </div>
	                      </div>
	                      <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
	                        <div className="text-micro uppercase tracking-[0.12em] text-muted">Initiative</div>
	                        <div className="mt-0.5 truncate text-body text-primary">
	                          {(selectedInitiative?.name ?? selectedInitiativeId.trim()) || '—'}
	                        </div>
	                      </div>
	                      <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
	                        <div className="text-micro uppercase tracking-[0.12em] text-muted">Workstream</div>
	                        <div className="mt-0.5 truncate text-body text-primary">
	                          {selectedWorkstreamId.trim()
	                            ? workstreams.find((w) => w.id === selectedWorkstreamId)?.name ?? selectedWorkstreamId
	                            : 'Any'}
	                        </div>
	                      </div>
	                      <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
	                        <div className="text-micro uppercase tracking-[0.12em] text-muted">Task</div>
	                        <div className="mt-0.5 truncate text-body text-primary">
	                          {selectedTaskId.trim()
	                            ? tasks.find((t) => t.id === selectedTaskId)?.title ?? selectedTaskId
	                            : 'Any'}
	                        </div>
	                      </div>
	                    </div>
	                  </div>
	                </div>
	              )}
	            </motion.div>
	          </AnimatePresence>

	          {launchError && (
	            <div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-body text-rose-100">
	              <div className="flex flex-col gap-2">
	                <div>{launchError}</div>
                {upgradeActions && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void openCheckout().catch((err) => setLaunchError(err instanceof Error ? err.message : 'Checkout failed'))}
                      className="rounded-full border border-amber-200/25 bg-amber-200/10 px-3 py-1.5 text-caption font-semibold text-amber-100 transition-colors hover:bg-amber-200/15"
                    >
                      Upgrade
                    </button>
                    <button
                      type="button"
                      onClick={() => void openBillingPortal().catch((err) => setLaunchError(err instanceof Error ? err.message : 'Portal failed'))}
                      className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08]"
                    >
                      Billing portal
                    </button>
                    {upgradeActions.pricing && (
                      <a
                        href={upgradeActions.pricing}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-caption text-secondary underline decoration-white/20 hover:text-primary"
                      >
                        View pricing
                      </a>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

	        <div className="flex items-center justify-between gap-3 border-t border-subtle px-5 py-3.5 sm:px-6">
	          <div className="text-caption text-secondary">
	            {step === 1
	              ? 'Pick an agent to configure.'
	              : step === 2
	                ? 'Select an initiative scope (required).'
	                : canLaunch
	                  ? 'Launch will update sessions/activity under the selected initiative.'
	                  : 'Select an agent and initiative to launch.'}
	          </div>
	          <div className="flex items-center gap-2">
	            {step > 1 && (
	              <button
	                type="button"
	                onClick={() => setStep((prev) => (prev > 1 ? ((prev - 1) as 1 | 2 | 3) : prev))}
	                disabled={isLaunching}
	                className="rounded-xl border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
	              >
	                Back
	              </button>
	            )}
	            {step < 3 ? (
	              <button
	                type="button"
	                onClick={() => setStep((prev) => (prev < 3 ? ((prev + 1) as 1 | 2 | 3) : prev))}
	                disabled={!canContinueStep || isLaunching}
	                className={cn(
	                  'rounded-xl px-4 py-2 text-body font-semibold transition-colors',
	                  canContinueStep && !isLaunching
	                    ? 'text-black'
	                    : 'cursor-not-allowed border border-strong bg-white/[0.05] text-muted'
	                )}
	                style={canContinueStep && !isLaunching ? { backgroundColor: colors.lime } : undefined}
	              >
	                Next
	              </button>
	            ) : (
	              <button
	                type="button"
	                onClick={launch}
	                disabled={!canLaunch || isLaunching}
	                className={cn(
	                  'rounded-xl px-4 py-2 text-body font-semibold transition-colors',
	                  canLaunch && !isLaunching
	                    ? 'text-black'
	                    : 'cursor-not-allowed border border-strong bg-white/[0.05] text-muted'
	                )}
	                style={canLaunch && !isLaunching ? { backgroundColor: colors.lime } : undefined}
	              >
	                {isLaunching ? 'Launching…' : 'Launch'}
	              </button>
	            )}
	          </div>
	        </div>
      </div>
    </Modal>
  );
}
