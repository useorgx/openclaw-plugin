import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAgentSuite } from '@/hooks/useAgentSuite';
import type { AgentRuntimeSettings, AgentSuiteDomain } from '@/types';
import { cn } from '@/lib/utils';
import { humanizeWarning } from '@/lib/humanize';

const DOMAIN_LABEL: Record<AgentSuiteDomain, string> = {
  engineering: 'Engineering',
  product: 'Product',
  design: 'Design',
  marketing: 'Marketing',
  sales: 'Sales',
  operations: 'Operations',
  orchestration: 'Orchestration',
};

const DEFAULT_RUNTIME_SETTINGS: AgentRuntimeSettings = {
  decisionV2Enabled: true,
  decisionDedupeEnabled: true,
  decisionEvidenceRequiredForBlocking: false,
  decisionAutoResolveGuardedEnabled: true,
  questionAutoAnswerEnabled: true,
  questionAutoAnswerTimeoutSec: 60,
  questionAutoAnswerPolicy: 'contextual',
  questionBlockingBehavior: 'require_human',
  questionPolicyVersion: 1,
  questionAutoAnswerDelaySeconds: 60,
  questionAutoAnswerAction: 'approve',
  customRunInstructions: '',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  return UUID_RE.test(value.trim());
}

function inferDomainFromRuntimeAgent(input: {
  name?: string | null;
  id?: string | null;
}): AgentSuiteDomain | null {
  const haystack = `${input.name ?? ''} ${input.id ?? ''}`.toLowerCase();
  if (haystack.includes('orchestrat')) return 'orchestration';
  if (haystack.includes('engineer') || haystack.includes('dev delivery')) return 'engineering';
  if (haystack.includes('product')) return 'product';
  if (haystack.includes('design')) return 'design';
  if (haystack.includes('market')) return 'marketing';
  if (haystack.includes('sales')) return 'sales';
  if (haystack.includes('operations') || haystack.includes('ops ')) return 'operations';
  return null;
}

function settingsEqual(a: AgentRuntimeSettings, b: AgentRuntimeSettings): boolean {
  return (
    a.decisionV2Enabled === b.decisionV2Enabled &&
    a.decisionDedupeEnabled === b.decisionDedupeEnabled &&
    a.decisionEvidenceRequiredForBlocking === b.decisionEvidenceRequiredForBlocking &&
    a.decisionAutoResolveGuardedEnabled === b.decisionAutoResolveGuardedEnabled &&
    a.questionAutoAnswerEnabled === b.questionAutoAnswerEnabled &&
    a.questionAutoAnswerTimeoutSec === b.questionAutoAnswerTimeoutSec &&
    a.questionAutoAnswerPolicy === b.questionAutoAnswerPolicy &&
    a.questionBlockingBehavior === b.questionBlockingBehavior &&
    a.questionPolicyVersion === b.questionPolicyVersion &&
    a.questionAutoAnswerDelaySeconds === b.questionAutoAnswerDelaySeconds &&
    a.questionAutoAnswerAction === b.questionAutoAnswerAction &&
    a.customRunInstructions.trim() === b.customRunInstructions.trim()
  );
}

function HealthPill({ status }: { status: 'healthy' | 'needs_apply' | 'conflict' | null }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-micro uppercase tracking-[0.08em]',
        status === 'healthy'
          ? 'border-teal/25 bg-teal/[0.10] text-teal'
          : status === 'conflict'
          ? 'border-rose-300/30 bg-rose-500/[0.12] text-rose-100'
          : 'border-white/[0.14] bg-white/[0.04] text-secondary'
      )}
    >
      {status === 'healthy'
        ? 'Healthy'
        : status === 'conflict'
        ? 'Conflict'
        : 'Needs apply'}
    </span>
  );
}

function RuntimeToggleRow({
  label,
  description,
  enabled,
  onToggle,
}: {
  label: string;
  description: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="flex min-h-[54px] items-start justify-between gap-3 rounded-xl border border-white/[0.08] bg-black/20 px-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-body font-semibold text-primary">{label}</p>
        <p className="mt-1 text-caption leading-relaxed text-secondary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onToggle(!enabled)}
        className={cn(
          'relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border transition-colors',
          enabled ? 'border-lime/35 bg-lime/[0.20]' : 'border-white/[0.12] bg-white/[0.06]'
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full transition-all',
            enabled ? 'left-[20px] bg-lime' : 'left-0.5 bg-white/70'
          )}
        />
      </button>
    </div>
  );
}

function BehaviorSubspace({
  step,
  title,
  description,
  children,
}: {
  step: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 border-t border-white/[0.06] pt-5 first:border-t-0 first:pt-0">
      <div>
        <p className="text-micro uppercase tracking-[0.16em] text-[#D8FFA1]/72">{step}</p>
        <h4 className="mt-2 text-[18px] font-semibold leading-tight text-white">{title}</h4>
        <p className="mt-1.5 text-body leading-relaxed text-secondary">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function AgentBehaviorPanel({
  authToken = null,
  embedMode = false,
  enabled = true,
  initialDomain = null,
  onOpenSuiteOps,
}: {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
  initialDomain?: AgentSuiteDomain | null;
  onOpenSuiteOps?: () => void;
}) {
  const suite = useAgentSuite({ authToken, embedMode, enabled });
  const suiteAgents = suite.status?.ok ? suite.status.data.agents : [];
  const runtimeAgents = suite.runtimeSettings.agents;

  const runtimeSettingsByAgentId = useMemo(() => {
    const map = new Map<string, AgentRuntimeSettings>();
    for (const agent of suite.runtimeSettings.agents) {
      map.set(agent.id, agent.runtimeSettings);
    }
    return map;
  }, [suite.runtimeSettings.agents]);

  const agents = useMemo(() => {
    const runtimeByDomain = new Map<
      AgentSuiteDomain,
      {
        id: string;
        model: string | null;
        runtimeSettings: AgentRuntimeSettings;
      }
    >();
    for (const runtime of runtimeAgents) {
      const inferredDomain = inferDomainFromRuntimeAgent({
        name: runtime.name,
        id: runtime.id,
      });
      if (!inferredDomain || runtimeByDomain.has(inferredDomain)) continue;
      runtimeByDomain.set(inferredDomain, {
        id: runtime.id,
        model: runtime.model,
        runtimeSettings: runtime.runtimeSettings,
      });
    }

    if (suiteAgents.length > 0) {
      return suiteAgents.map((agent) => ({
        id: runtimeByDomain.get(agent.domain)?.id ?? agent.id,
        name: agent.name,
        domain: agent.domain,
        model: runtimeByDomain.get(agent.domain)?.model ?? null,
        configStatus: (agent.configHealth?.status ?? null) as 'healthy' | 'needs_apply' | 'conflict' | null,
        runtimeSettings:
          runtimeByDomain.get(agent.domain)?.runtimeSettings ??
          runtimeSettingsByAgentId.get(agent.id) ??
          DEFAULT_RUNTIME_SETTINGS,
      }));
    }
    return runtimeAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      domain: inferDomainFromRuntimeAgent({ name: agent.name, id: agent.id }),
      model: agent.model,
      configStatus: null,
      runtimeSettings: agent.runtimeSettings,
    }));
  }, [runtimeAgents, suiteAgents, runtimeSettingsByAgentId]);

  const savedByAgent = useMemo(() => {
    const record: Record<string, AgentRuntimeSettings> = {};
    for (const agent of agents) {
      record[agent.id] = agent.runtimeSettings;
    }
    return record;
  }, [agents]);

  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [draftByAgent, setDraftByAgent] = useState<Record<string, AgentRuntimeSettings>>({});
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (agents.length === 0) {
      setActiveAgentId(null);
      return;
    }
    if (!activeAgentId || !agents.some((agent) => agent.id === activeAgentId)) {
      setActiveAgentId(agents[0].id);
    }
    setDraftByAgent((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const agent of agents) {
        if (!next[agent.id]) {
          next[agent.id] = savedByAgent[agent.id] ?? DEFAULT_RUNTIME_SETTINGS;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeAgentId, agents, savedByAgent]);

  useEffect(() => {
    if (!initialDomain || agents.length === 0) return;
    const match = agents.find((agent) => agent.domain === initialDomain);
    if (match && match.id !== activeAgentId) {
      setActiveAgentId(match.id);
    }
  }, [activeAgentId, agents, initialDomain]);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [activeAgentId, agents]
  );

  const readDraft = (agentId: string): AgentRuntimeSettings =>
    draftByAgent[agentId] ?? savedByAgent[agentId] ?? DEFAULT_RUNTIME_SETTINGS;

  const activeDraft = activeAgent ? readDraft(activeAgent.id) : null;
  const dirtyAgentIds = useMemo(
    () =>
      agents
        .filter((agent) => !settingsEqual(readDraft(agent.id), savedByAgent[agent.id]))
        .map((agent) => agent.id),
    [agents, draftByAgent, savedByAgent]
  );
  const dirtySet = useMemo(() => new Set(dirtyAgentIds), [dirtyAgentIds]);

  const updateActiveDraft = (patch: Partial<AgentRuntimeSettings>) => {
    if (!activeAgent) return;
    setDraftByAgent((prev) => {
      const baseline = prev[activeAgent.id] ?? savedByAgent[activeAgent.id] ?? DEFAULT_RUNTIME_SETTINGS;
      return {
        ...prev,
        [activeAgent.id]: {
          ...baseline,
          ...patch,
        },
      };
    });
  };

  const resetActiveToSaved = () => {
    if (!activeAgent) return;
    setDraftByAgent((prev) => ({
      ...prev,
      [activeAgent.id]: savedByAgent[activeAgent.id] ?? DEFAULT_RUNTIME_SETTINGS,
    }));
  };

  const applyActiveToAll = () => {
    if (!activeDraft || agents.length === 0) return;
    const template = {
      ...activeDraft,
      customRunInstructions: activeDraft.customRunInstructions.trim().slice(0, 4000),
    };
    setDraftByAgent((prev) => {
      const next = { ...prev };
      for (const agent of agents) {
        next[agent.id] = { ...template };
      }
      return next;
    });
    setSaveNotice('Applied active agent settings to all agents.');
    setSaveError(null);
  };

  const discardAllDrafts = () => {
    const next: Record<string, AgentRuntimeSettings> = {};
    for (const agent of agents) {
      next[agent.id] = savedByAgent[agent.id] ?? DEFAULT_RUNTIME_SETTINGS;
    }
    setDraftByAgent(next);
    setSaveNotice(null);
    setSaveError(null);
  };

  const saveAllDrafts = async () => {
    if (dirtyAgentIds.length === 0 || suite.isSavingRuntimeSettings) return;
    setSaveNotice(null);
    setSaveError(null);
    try {
      for (const agentId of dirtyAgentIds) {
        if (!isUuid(agentId)) {
          const agentLabel =
            agents.find((agent) => agent.id === agentId)?.name ?? agentId;
          throw new Error(
            `Cannot save "${agentLabel}" because it is not linked to a valid OrgX agent UUID yet. Re-sync Agent Suite and try again.`
          );
        }
        const draft = readDraft(agentId);
        await suite.saveRuntimeSettingsAsync({
          projectId: suite.runtimeSettings.projectId,
          agentId,
          runtimeSettings: {
            ...draft,
            customRunInstructions: draft.customRunInstructions.trim().slice(0, 4000),
          },
        });
      }
      setSaveNotice(
        `Saved runtime settings for ${dirtyAgentIds.length} ${
          dirtyAgentIds.length === 1 ? 'agent' : 'agents'
        }.`
      );
      setSaveError(null);
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Failed to save agent settings.';
      setSaveError(humanizeWarning(raw));
    }
  };

  const runtimeSettingsError = suite.runtimeSettingsError?.trim() ?? null;
  const friendlyRuntimeSettingsError = runtimeSettingsError ? humanizeWarning(runtimeSettingsError) : null;
  const runtimeSettingsHasError = Boolean(runtimeSettingsError);
  const runtimeSettingsEndpointUnavailable = Boolean(
    runtimeSettingsError &&
      (runtimeSettingsError.toLowerCase().includes('endpoint is not available') ||
        runtimeSettingsError.includes('(404)'))
  );
  const runtimeSettingsUnavailable = runtimeSettingsHasError;

  if (suite.isLoading) {
    return (
      <section className="rounded-xl border border-subtle bg-white/[0.02] p-4">
        <p className="text-body text-secondary">Loading agent settings...</p>
      </section>
    );
  }

  if (suite.error && !suite.status) {
    return (
      <section className="rounded-xl border border-rose-300/25 bg-rose-400/10 p-4">
        <h3 className="text-body font-semibold text-rose-100">
          Unable to load agent settings
        </h3>
        <p className="mt-1 text-caption leading-relaxed text-rose-100/85">
          {humanizeWarning(suite.error)}
        </p>
      </section>
    );
  }

  if (agents.length === 0 || !activeAgent || !activeDraft) {
    return (
      <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
        <div className="max-w-2xl">
          <p className="text-micro uppercase tracking-[0.16em] text-[#D8FFA1]/72">Runtime policy</p>
          <h3 className="mt-2 text-[22px] font-semibold leading-tight text-white">No agent suite is installed yet.</h3>
          <p className="mt-2 text-body leading-relaxed text-secondary">
            Per-agent controls only become useful after the local suite is installed and linked to OrgX agent IDs. Set
            up the suite first, then come back here to tune decision policy and run behavior.
          </p>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
            <p className="text-micro uppercase tracking-[0.14em] text-muted">1</p>
            <p className="mt-2 text-body font-semibold text-primary">Install the suite</p>
            <p className="mt-1 text-caption leading-relaxed text-secondary">
              Scaffold domain agents and managed workspace files.
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
            <p className="text-micro uppercase tracking-[0.14em] text-muted">2</p>
            <p className="mt-2 text-body font-semibold text-primary">Link live identities</p>
            <p className="mt-1 text-caption leading-relaxed text-secondary">
              Confirm each runtime maps cleanly to its OrgX agent record.
            </p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
            <p className="text-micro uppercase tracking-[0.14em] text-muted">3</p>
            <p className="mt-2 text-body font-semibold text-primary">Tune policy</p>
            <p className="mt-1 text-caption leading-relaxed text-secondary">
              Apply guardrails, question policy, and custom run instructions per agent.
            </p>
          </div>
        </div>

        {onOpenSuiteOps ? (
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onOpenSuiteOps}
              className="inline-flex min-h-[44px] items-center rounded-full bg-[#BFFF00] px-4 py-2 text-body font-semibold text-black transition-colors hover:bg-[#d3ff42]"
            >
              Open suite setup
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const dirtyCount = dirtyAgentIds.length;
  const activeDirty = dirtySet.has(activeAgent.id);
  const domainLabel = activeAgent.domain ? DOMAIN_LABEL[activeAgent.domain] : 'Agent';

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-subtle bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-heading font-semibold text-white">Agent runtime settings</h3>
            <p className="mt-1 text-body leading-relaxed text-secondary">
              {runtimeSettingsUnavailable
                ? runtimeSettingsEndpointUnavailable
                  ? 'Viewing agent suite roster. Runtime configuration requires a plugin rebuild.'
                  : 'Viewing agent suite roster. Runtime configuration is temporarily unavailable.'
                : 'Configure decision guardrails and persistent run instructions per agent.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-white/[0.10] bg-white/[0.03] px-3 py-1 text-caption text-primary">
              {agents.length} agents
            </span>
            {!runtimeSettingsUnavailable && (
              <span
                className={cn(
                  'rounded-full border px-3 py-1 text-caption',
                  dirtyCount > 0
                    ? 'border-lime/25 bg-lime/[0.12] text-lime'
                    : 'border-white/[0.10] bg-white/[0.03] text-secondary'
                )}
              >
                {dirtyCount} unsaved
              </span>
            )}
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
            <p className="text-micro uppercase tracking-[0.14em] text-muted">Roster</p>
            <p className="mt-2 text-body font-semibold text-primary">Choose the agent you’re shaping.</p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
            <p className="text-micro uppercase tracking-[0.14em] text-muted">Guardrails</p>
            <p className="mt-2 text-body font-semibold text-primary">Tune approvals, evidence, and questions.</p>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
            <p className="text-micro uppercase tracking-[0.14em] text-muted">Commit</p>
            <p className="mt-2 text-body font-semibold text-primary">Save every draft change in one pass.</p>
          </div>
        </div>
      </header>

      {runtimeSettingsUnavailable && (
        <div className="rounded-xl border border-amber-300/20 bg-[#12100A]/95 px-4 py-3">
          {runtimeSettingsEndpointUnavailable ? (
            <>
              <p className="text-caption font-medium text-amber-100">
                Runtime settings endpoint is not available in the running plugin build.
              </p>
              <p className="mt-1 text-caption text-amber-100/70">
                Rebuild the plugin server to enable per-agent configuration. Agent roster is shown below.
              </p>
            </>
          ) : (
            <>
              <p className="text-caption font-medium text-amber-100">
                Runtime settings could not be loaded from the OrgX API.
              </p>
              <p className="mt-1 text-caption text-amber-100/70">
                {friendlyRuntimeSettingsError}
              </p>
            </>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <BehaviorSubspace
          step="Roster"
          title="Agent roster"
          description="Select the runtime identity to edit. Draft state is scoped per agent."
        >
          <aside className="rounded-xl border border-subtle bg-white/[0.02] p-2">
            <div className="max-h-[520px] space-y-1 overflow-y-auto pr-1">
              {agents.map((agent) => {
                const selected = agent.id === activeAgent.id;
                const isDirty = dirtySet.has(agent.id);
                const linked = isUuid(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => setActiveAgentId(agent.id)}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                      selected
                        ? 'border-lime/25 bg-lime/[0.12]'
                        : 'border-white/[0.08] bg-black/20 hover:bg-white/[0.04]'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-body font-semibold text-primary">{agent.name}</p>
                      <div className="flex items-center gap-1.5">
                        {!linked ? (
                          <span className="rounded-full border border-amber-300/25 bg-amber-400/[0.16] px-1.5 py-0.5 text-micro uppercase tracking-[0.08em] text-amber-100">
                            Not linked
                          </span>
                        ) : null}
                        {agent.configStatus ? <HealthPill status={agent.configStatus} /> : null}
                      </div>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <p className="truncate text-caption text-secondary">
                        {agent.domain ? DOMAIN_LABEL[agent.domain] : agent.model ?? 'Agent'}
                      </p>
                      {isDirty ? (
                        <span className="rounded-full border border-lime/25 bg-lime/[0.10] px-1.5 py-0.5 text-micro uppercase tracking-[0.08em] text-lime">
                          Draft
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>
        </BehaviorSubspace>

        <BehaviorSubspace
          step="Policy"
          title="Policy surfaces"
          description="Tune decision pipeline and persistent instructions for the selected agent."
        >
          <article className="rounded-xl border border-subtle bg-white/[0.02] p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-caption uppercase tracking-[0.08em] text-secondary">{domainLabel}</p>
                <h4 className="mt-1 text-heading font-semibold text-white">{activeAgent.name}</h4>
                {!isUuid(activeAgent.id) ? (
                  <p className="mt-1 text-caption text-amber-100/85">
                    This agent is not linked to a runtime UUID yet. Apply Agent Suite sync before saving.
                  </p>
                ) : null}
              </div>
              {!runtimeSettingsUnavailable && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={applyActiveToAll}
                    className="min-h-[44px] rounded-full border border-white/[0.14] bg-white/[0.03] px-3 py-2 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.06]"
                  >
                    Apply to all
                  </button>
                  <button
                    type="button"
                    onClick={resetActiveToSaved}
                    disabled={!activeDirty}
                    className="min-h-[44px] rounded-full border border-white/[0.14] bg-white/[0.03] px-3 py-2 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Reset active
                  </button>
                </div>
              )}
            </div>
          </article>

          <div className={runtimeSettingsUnavailable ? 'pointer-events-none opacity-40' : ''}>
            <article className="rounded-xl border border-subtle bg-white/[0.02] p-4">
              <h4 className="text-body font-semibold text-primary">Decision pipeline</h4>
              <p className="mt-1 text-caption leading-relaxed text-secondary">
                These controls are injected into dispatch and decision flows for this agent.
              </p>
              <div className="mt-3 space-y-3">
                <div className="space-y-2 rounded-xl border border-white/[0.08] bg-black/20 p-3">
                  <p className="text-caption font-semibold uppercase tracking-[0.08em] text-secondary">
                    Decision envelope
                  </p>
                  <RuntimeToggleRow
                    label="Decision envelope v2"
                    description="Emit richer context fields for diagnosis and replay."
                    enabled={activeDraft.decisionV2Enabled}
                    onToggle={(next) => updateActiveDraft({ decisionV2Enabled: next })}
                  />
                  <RuntimeToggleRow
                    label="Decision dedupe"
                    description="Collapse repeated blockers into the same pending decision."
                    enabled={activeDraft.decisionDedupeEnabled}
                    onToggle={(next) => updateActiveDraft({ decisionDedupeEnabled: next })}
                  />
                  <RuntimeToggleRow
                    label="Require evidence for blocking decisions"
                    description="Attach evidence before a blocking decision can be emitted."
                    enabled={activeDraft.decisionEvidenceRequiredForBlocking}
                    onToggle={(next) =>
                      updateActiveDraft({ decisionEvidenceRequiredForBlocking: next })
                    }
                  />
                  <RuntimeToggleRow
                    label="Guarded auto-resolve"
                    description="Attempt deterministic remediation before escalating to humans."
                    enabled={activeDraft.decisionAutoResolveGuardedEnabled}
                    onToggle={(next) =>
                      updateActiveDraft({ decisionAutoResolveGuardedEnabled: next })
                    }
                  />
                </div>

                <div className="space-y-2 rounded-xl border border-white/[0.08] bg-black/20 p-3">
                  <p className="text-caption font-semibold uppercase tracking-[0.08em] text-secondary">
                    Question automation
                  </p>
                  <RuntimeToggleRow
                    label="Auto-answer unanswered questions"
                    description="If no human response arrives in time, auto-resolve questions sequentially."
                    enabled={activeDraft.questionAutoAnswerEnabled}
                    onToggle={(next) =>
                      updateActiveDraft({ questionAutoAnswerEnabled: next })
                    }
                  />
                <div className="grid gap-2 rounded-xl border border-white/[0.08] bg-black/20 px-3 py-3 md:grid-cols-2">
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-caption font-semibold text-primary">
                      Auto-answer timeout (seconds)
                    </span>
                    <input
                      type="number"
                      min={10}
                      max={3600}
                      step={1}
                      value={activeDraft.questionAutoAnswerTimeoutSec}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        const normalized = Number.isFinite(parsed)
                          ? Math.max(10, Math.min(3600, parsed))
                          : 60;
                        updateActiveDraft({
                          questionAutoAnswerTimeoutSec: normalized,
                          questionAutoAnswerDelaySeconds: normalized,
                        });
                      }}
                      className="min-h-[40px] rounded-lg border border-white/[0.12] bg-black/25 px-3 text-body text-primary outline-none transition-colors focus:border-lime/35"
                    />
                  </label>
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-caption font-semibold text-primary">
                      Auto-answer policy
                    </span>
                    <select
                      value={activeDraft.questionAutoAnswerPolicy}
                      onChange={(event) =>
                        updateActiveDraft({
                          questionAutoAnswerPolicy:
                            event.target.value === 'approve_non_blocking' ||
                            event.target.value === 'defer_non_blocking'
                              ? event.target.value
                              : 'contextual',
                          // Keep legacy action field coherent for older servers.
                          questionAutoAnswerAction:
                            event.target.value === 'defer_non_blocking'
                              ? 'reject'
                              : 'approve',
                        })
                      }
                      className="min-h-[40px] rounded-lg border border-white/[0.12] bg-black/25 px-3 text-body text-primary outline-none transition-colors focus:border-lime/35"
                    >
                      <option value="contextual">Contextual (recommended)</option>
                      <option value="approve_non_blocking">Approve non-blocking</option>
                      <option value="defer_non_blocking">Defer non-blocking</option>
                    </select>
                  </label>
                  <label className="flex min-w-0 flex-col gap-1 md:col-span-2">
                    <span className="text-caption font-semibold text-primary">
                      Blocking question behavior
                    </span>
                    <select
                      value={activeDraft.questionBlockingBehavior}
                      onChange={(event) =>
                        updateActiveDraft({
                          questionBlockingBehavior:
                            event.target.value === 'guarded_auto_resolve_then_human'
                              ? 'guarded_auto_resolve_then_human'
                              : 'require_human',
                        })
                      }
                      className="min-h-[40px] rounded-lg border border-white/[0.12] bg-black/25 px-3 text-body text-primary outline-none transition-colors focus:border-lime/35"
                    >
                      <option value="require_human">Require human decision</option>
                      <option value="guarded_auto_resolve_then_human">
                        Guarded auto-resolve, then human
                      </option>
                    </select>
                  </label>
                </div>
                </div>
              </div>
            </article>

            <article className="mt-3 rounded-xl border border-subtle bg-white/[0.02] p-4">
              <h4 className="text-body font-semibold text-primary">Persistent run instructions</h4>
              <p className="mt-1 text-caption leading-relaxed text-secondary">
                Injected into every run for this agent as runtime guidance.
              </p>
              <textarea
                value={activeDraft.customRunInstructions}
                onChange={(event) =>
                  updateActiveDraft({
                    customRunInstructions: event.target.value.slice(0, 4000),
                  })
                }
                rows={7}
                placeholder="Add concise constraints, workflow defaults, and handoff requirements."
                className="mt-3 w-full rounded-xl border border-white/[0.12] bg-black/25 px-3 py-2 text-body text-primary outline-none transition-colors placeholder:text-muted focus:border-lime/35"
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-caption text-secondary">
                  Keep instructions explicit and operational, not aspirational.
                </p>
                <p className="text-micro uppercase tracking-[0.08em] text-secondary">
                  {activeDraft.customRunInstructions.trim().length}/4000
                </p>
              </div>
            </article>
          </div>
        </BehaviorSubspace>
      </div>

      <div className={cn('sticky bottom-0 z-10 rounded-xl border border-subtle bg-[#08090d]/90 p-3 backdrop-blur', runtimeSettingsUnavailable && 'hidden')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-h-[20px]">
            {saveError ? (
              <p className="text-caption text-rose-100">{humanizeWarning(saveError)}</p>
            ) : saveNotice ? (
              <p className="text-caption text-lime">{saveNotice}</p>
            ) : (
              <p className="text-caption text-secondary">
                {dirtyCount > 0
                  ? `${dirtyCount} ${dirtyCount === 1 ? 'agent has' : 'agents have'} unsaved changes.`
                  : 'All agent runtime settings are saved.'}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={discardAllDrafts}
              disabled={dirtyCount === 0 || suite.isSavingRuntimeSettings}
              className="min-h-[44px] rounded-lg border border-white/[0.14] px-3 py-2 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Discard all
            </button>
            <button
              type="button"
              onClick={() => {
                void saveAllDrafts();
              }}
              disabled={dirtyCount === 0 || suite.isSavingRuntimeSettings}
              className="min-h-[44px] rounded-lg border border-lime/30 bg-lime/[0.14] px-3 py-2 text-caption font-semibold text-lime transition-colors hover:bg-lime/[0.2] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {suite.isSavingRuntimeSettings ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
