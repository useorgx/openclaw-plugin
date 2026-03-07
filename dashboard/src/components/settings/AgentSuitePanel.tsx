import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useAgentSuite } from '@/hooks/useAgentSuite';
import { buildOrgxHeaders } from '@/lib/http';
import { humanizeWarning } from '@/lib/humanize';
import type { AgentSuitePlan } from '@/types';

function pluralize(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

type TagTone = 'good' | 'warn' | 'neutral';

function Tag({ tone, children }: { tone: TagTone; children: ReactNode }) {
  const className = useMemo(() => {
    if (tone === 'good') return 'border-lime/25 bg-lime/[0.10] text-lime';
    if (tone === 'warn') return 'border-amber-300/25 bg-amber-400/10 text-amber-100/90';
    return 'border-white/[0.10] bg-white/[0.02] text-primary';
  }, [tone]);

  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-caption font-semibold', className)}>
      {children}
    </span>
  );
}

function SuiteSection({
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
    <section className="grid gap-3">
      <div>
        <p className="text-micro uppercase tracking-[0.12em] text-lime/80">{step}</p>
        <h4 className="mt-1 text-heading font-semibold text-white">{title}</h4>
        <p className="mt-1 text-caption leading-relaxed text-secondary">{description}</p>
      </div>
      {children}
    </section>
  );
}

interface DryRunPreview {
  outcome: 'ready' | 'warning';
  executionTrace: string[];
  riskFlags: string[];
  expectedOutputs: string[];
  confidence: string;
}

type BehaviorPresetId = 'conservative' | 'balanced' | 'autonomous';

const BEHAVIOR_PRESET_LABELS: Record<BehaviorPresetId, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  autonomous: 'Autonomous',
};

const BEHAVIOR_PRESET_DESCRIPTIONS: Record<BehaviorPresetId, string> = {
  conservative: 'All approvals. Freeze and pin policy updates until manually reviewed.',
  balanced: 'Smart defaults. Keep policy live but pinned to current checksum.',
  autonomous: 'Max automation. Keep policy live and unpinned for newest updates.',
};

function resolveBehaviorPreset(policy: AgentSuitePlan['skillPackPolicy']): BehaviorPresetId | null {
  if (!policy) return null;
  if (policy.frozen && policy.pinnedChecksum) return 'conservative';
  if (!policy.frozen && policy.pinnedChecksum) return 'balanced';
  if (!policy.frozen && !policy.pinnedChecksum) return 'autonomous';
  return null;
}

function buildPresetPolicyUpdate(preset: BehaviorPresetId): Record<string, unknown> {
  if (preset === 'conservative') {
    return {
      frozen: true,
      pinToCurrent: true,
      reason: 'Applied Conservative preset from Agent Settings UI',
    };
  }
  if (preset === 'balanced') {
    return {
      frozen: false,
      pinToCurrent: true,
      reason: 'Applied Balanced preset from Agent Settings UI',
    };
  }
  return {
    frozen: false,
    clearPin: true,
    reason: 'Applied Autonomous preset from Agent Settings UI',
  };
}

function buildDryRunPreview({
  plan,
  agentId,
  sampleTaskId,
}: {
  plan: AgentSuitePlan;
  agentId: string;
  sampleTaskId: string;
}): DryRunPreview {
  const changedFileItems = plan.workspaceFiles.filter((f) => f.action !== 'noop');
  const conflicts = changedFileItems.filter((f) => f.action === 'conflict').length;
  const creates = changedFileItems.filter((f) => f.action === 'create').length;
  const updates = changedFileItems.filter((f) => f.action === 'update').length;

  const riskFlags: string[] = [];
  if (conflicts > 0) riskFlags.push(`${pluralize(conflicts, 'managed file')} needs review before apply.`);
  if (plan.skillPackUpdateAvailable) riskFlags.push('Remote skill update is available; behavior could drift after refresh.');
  if (plan.skillPackPolicy?.frozen) riskFlags.push('Skill pack is frozen; preview reflects pinned behavior only.');

  const executionTrace = [
    `Load draft simulation for ${agentId}.`,
    `Run sample task "${sampleTaskId}" through current suite guardrails.`,
    `Assemble managed/local overlay and compute write plan.`,
    conflicts > 0 ? 'Stop before apply because conflicts require operator review.' : 'Proceed to apply path if operator confirms.',
  ];

  const expectedOutputs = [
    `${pluralize(plan.openclawConfigAddedAgents.length, 'agent')} added to OpenClaw config.`,
    `${pluralize(changedFileItems.length, 'workspace file')} changed (${creates} create, ${updates} update).`,
    `Progress stream expected at start and completion for sample "${sampleTaskId}".`,
  ];

  return {
    outcome: riskFlags.length > 0 ? 'warning' : 'ready',
    executionTrace,
    riskFlags,
    expectedOutputs,
    confidence:
      riskFlags.length > 0
        ? 'Medium confidence: preview is deterministic but includes review-dependent flags.'
        : 'High confidence: preview is deterministic with no active risk flags.',
  };
}

export function AgentSuitePanel({
  authToken = null,
  embedMode = false,
  enabled = true,
  devMode = false,
}: {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
  devMode?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [testAgentId, setTestAgentId] = useState('');
  const [sampleTaskId, setSampleTaskId] = useState('triage-sample');
  const [testResult, setTestResult] = useState<DryRunPreview | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [lastTestedAt, setLastTestedAt] = useState<string | null>(null);
  const [applyingPresetId, setApplyingPresetId] = useState<BehaviorPresetId | null>(null);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const suite = useAgentSuite({ authToken, embedMode, enabled });

  const plan = suite.status?.ok ? suite.status.data : null;
  const totalAgents = plan?.agents?.length ?? 0;
  const missingAgents = plan?.openclawConfigAddedAgents?.length ?? 0;
  const changedFileItems = useMemo(
    () => plan?.workspaceFiles?.filter((f) => f.action !== 'noop') ?? [],
    [plan]
  );
  const changedFiles = changedFileItems.length;
  const createdFiles = useMemo(
    () => changedFileItems.filter((f) => f.action === 'create').length,
    [changedFileItems]
  );
  const updatedFiles = useMemo(
    () => changedFileItems.filter((f) => f.action === 'update').length,
    [changedFileItems]
  );
  const conflictFiles = useMemo(
    () => changedFileItems.filter((f) => f.action === 'conflict').length,
    [changedFileItems]
  );
  const friendlySuiteError = suite.error ? humanizeWarning(suite.error) : null;
  const friendlyInstallError = suite.installError ? humanizeWarning(suite.installError) : null;
  const friendlyTestError = testError ? humanizeWarning(testError) : null;
  const friendlyPresetError = presetError ? humanizeWarning(presetError) : null;

  const summary = useMemo(() => {
    if (suite.isLoading) return 'Loading agent suite status...';
    if (friendlySuiteError) return `Unable to read suite status: ${friendlySuiteError}`;
    if (!plan) return 'Suite status unavailable.';
    if (conflictFiles > 0) return `${pluralize(conflictFiles, 'file')} to review.`;
    if (missingAgents === 0 && changedFiles === 0) return 'Suite is installed and up to date.';
    const parts = [];
    if (missingAgents > 0) parts.push(`will add ${pluralize(missingAgents, 'agent')}`);
    if (changedFiles > 0) parts.push(`will update ${pluralize(changedFiles, 'file')}`);
    return `Preview: ${parts.join(', ')}.`;
  }, [changedFiles, conflictFiles, friendlySuiteError, missingAgents, plan, suite.isLoading]);

  const lastInstall = suite.installResult?.ok ? suite.installResult : null;
  const isDryRun = Boolean(lastInstall?.dryRun);
  const activePreset = resolveBehaviorPreset(plan?.skillPackPolicy ?? null);

  const runConfigTest = async () => {
    if (!plan || suite.isInstalling || isTesting) return;
    const selectedAgentId = testAgentId || (plan.agents[0]?.id ?? 'unassigned-agent');
    setShowDetails(true);
    setIsTesting(true);
    setTestError(null);
    try {
      const response = await suite.installAsync({ dryRun: true });
      if (!response.ok) {
        throw new Error(response.error ?? 'Dry-run failed.');
      }
      setTestResult(
        buildDryRunPreview({
          plan: response.data,
          agentId: selectedAgentId,
          sampleTaskId,
        })
      );
      setLastTestedAt(new Date().toISOString());
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Dry-run failed.';
      setTestError(humanizeWarning(raw));
    } finally {
      setIsTesting(false);
    }
  };

  const updateSkillPackPolicy = async (body: Record<string, unknown>) => {
    await fetch('/orgx/api/skill-pack/policy', {
      method: 'POST',
      headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
      body: JSON.stringify(body),
    }).then(async (res) => {
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        const raw = (payload as any)?.error ?? `Failed to update policy (${res.status})`;
        throw new Error(humanizeWarning(String(raw)));
      }
    });
    await suite.refetchStatus();
  };

  const applyBehaviorPreset = async (presetId: BehaviorPresetId) => {
    if (!plan?.skillPackPolicy || applyingPresetId) return;
    setPresetError(null);
    setPresetNotice(null);
    setApplyingPresetId(presetId);
    try {
      await updateSkillPackPolicy(buildPresetPolicyUpdate(presetId));
      setPresetNotice(`${BEHAVIOR_PRESET_LABELS[presetId]} preset applied.`);
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'Failed to apply preset.';
      setPresetError(humanizeWarning(raw));
    } finally {
      setApplyingPresetId(null);
    }
  };

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] pb-4">
        <div>
          <h3 className="text-heading font-semibold text-white">Suite operations</h3>
          <p className="mt-1 text-body leading-relaxed text-secondary">
            Install domain agents, validate the write plan, and manage the shared behavior policy.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-6">
        <SuiteSection
          step="Operations"
          title="Execution controls"
          description="Refresh status, run a deterministic dry-run, then apply suite updates."
        >
          <div className="rounded-xl border border-white/[0.08] bg-black/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  suite.resetInstall();
                  void suite.refetchStatus();
                }}
                disabled={suite.isRefetching}
                className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {suite.isRefetching ? 'Refreshing...' : 'Refresh'}
              </button>
              <button
                type="button"
                onClick={() => {
                  void runConfigTest();
                }}
                disabled={suite.isInstalling || isTesting}
                className="inline-flex min-h-[44px] items-center rounded-full border border-lime/30 bg-lime/[0.14] px-4 py-2 text-body font-semibold text-lime transition-colors hover:bg-lime/[0.2] disabled:cursor-not-allowed disabled:opacity-50"
                title="Runs a sample dry-run against the current draft settings"
              >
                {isTesting ? 'Testing config...' : 'Test This Config'}
              </button>
              <button
                type="button"
                onClick={() => { suite.install({ dryRun: false, forceSkillPack: true }); }}
                disabled={suite.isInstalling}
                className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                title="Forces a check for the latest OrgX skill pack and applies it (managed/local overlay preserves local edits)"
              >
                Refresh skills
              </button>
              <button
                type="button"
                onClick={() => { suite.install({ dryRun: false }); }}
                disabled={suite.isInstalling}
                className="inline-flex items-center gap-2 rounded-full bg-lime px-4 py-2 text-body font-semibold text-black transition-colors hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-50"
                title="Install missing agents and scaffold managed workspace files"
              >
                {suite.isInstalling ? 'Installing...' : 'Install / Update'}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Tag tone={suite.error ? 'warn' : 'neutral'}>{summary}</Tag>
              {plan && (
                <>
                  <Tag tone={missingAgents === 0 ? 'good' : 'neutral'}>
                    {missingAgents === 0 ? 'agents configured' : `${missingAgents} agents to install`}
                  </Tag>
                  <Tag tone="neutral">{pluralize(totalAgents, 'agent')} total</Tag>
                  <Tag tone={changedFiles === 0 ? 'good' : 'neutral'}>
                    {changedFiles === 0 ? 'no file changes' : `${changedFiles} file changes`}
                  </Tag>
                  {conflictFiles > 0 && <Tag tone="neutral">{pluralize(conflictFiles, 'file to review')}</Tag>}
                  {plan.skillPackUpdateAvailable && <Tag tone="warn">skill update available</Tag>}
                  {plan.skillPackPolicy?.frozen && <Tag tone="neutral">skills frozen</Tag>}
                </>
              )}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2.5">
                <p className="text-micro uppercase tracking-[0.12em] text-muted">Agents</p>
                <p className="mt-1 text-[18px] font-semibold leading-tight text-white">{totalAgents}</p>
                <p className="mt-1 text-caption text-secondary">
                  {missingAgents === 0 ? 'All configured in OpenClaw.' : `${missingAgents} pending install.`}
                </p>
              </div>
              <div className="rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2.5">
                <p className="text-micro uppercase tracking-[0.12em] text-muted">Managed writes</p>
                <p className="mt-1 text-[18px] font-semibold leading-tight text-white">{changedFiles}</p>
                <p className="mt-1 text-caption text-secondary">
                  {changedFiles === 0 ? 'No file updates queued.' : `${createdFiles} create · ${updatedFiles} update`}
                </p>
              </div>
              <div className="rounded-lg border border-white/[0.08] bg-black/30 px-3 py-2.5">
                <p className="text-micro uppercase tracking-[0.12em] text-muted">Review status</p>
                <p className="mt-1 text-[18px] font-semibold leading-tight text-white">{conflictFiles}</p>
                <p className="mt-1 text-caption text-secondary">
                  {conflictFiles === 0 ? 'No file conflicts detected.' : 'Conflicts require operator review.'}
                </p>
              </div>
            </div>
          </div>
        </SuiteSection>
      </div>

      {/* Install error banner */}
      {friendlyInstallError && (
        <div className="mt-3 rounded-xl border border-rose-300/20 bg-rose-400/10 px-4 py-3 text-body text-rose-100">
          {friendlyInstallError}
        </div>
      )}

      {/* Install success banner */}
      {lastInstall && (
        <div className="mt-3 rounded-xl border border-lime/20 bg-lime/[0.06] px-4 py-3">
          <p className="text-caption uppercase tracking-[0.1em] text-lime">
            {isDryRun ? 'Dry run' : 'Applied'}
          </p>
          <p className="mt-1 text-body leading-relaxed text-secondary">
            {devMode && lastInstall.operationId && (
              <>Operation <code className="rounded bg-black/40 px-1">{lastInstall.operationId}</code>{' '}</>
            )}
            {isDryRun
              ? 'Computed the plan without writing any files.'
              : 'Installed config and refreshed managed files.'}
          </p>
        </div>
      )}

      {plan && (
        <div className="mt-4 grid gap-6">
          <SuiteSection
            step="Simulation"
            title="Draft simulation"
            description="Inspect expected execution trace, risk flags, and outputs before applying."
          >
          <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
            <p className="text-body font-semibold text-primary">Dry-run sample</p>
            <p className="mt-1 text-caption leading-relaxed text-secondary">
              Validate expected behavior with draft settings before applying changes.
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="grid gap-1.5 text-caption text-secondary">
                Agent
                <select
                  value={testAgentId}
                  onChange={(event) => setTestAgentId(event.target.value)}
                  className="min-h-[44px] rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 text-body text-primary outline-none transition-colors focus:border-lime/35"
                >
                  <option value="">Auto-select first pending agent</option>
                  {plan.agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.id})
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-caption text-secondary">
                Sample task
                <select
                  value={sampleTaskId}
                  onChange={(event) => setSampleTaskId(event.target.value)}
                  className="min-h-[44px] rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 text-body text-primary outline-none transition-colors focus:border-lime/35"
                >
                  <option value="triage-sample">Triage sample</option>
                  <option value="incident-template">Incident template</option>
                  <option value="handoff-summary">Handoff summary</option>
                </select>
              </label>
            </div>
            {friendlyTestError && (
              <p className="mt-3 rounded-lg border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-caption text-rose-100">
                {friendlyTestError}
              </p>
            )}
            {testResult && (
              <div role="region" aria-live="polite" className="mt-3 rounded-lg border border-teal/30 bg-teal/[0.08] px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-caption font-semibold uppercase tracking-[0.08em] text-teal">
                    Draft simulation
                  </p>
                  <Tag tone={testResult.outcome === 'ready' ? 'good' : 'warn'}>
                    {testResult.outcome === 'ready' ? 'Ready to apply' : 'Review recommended'}
                  </Tag>
                </div>
                {lastTestedAt && (
                  <p className="mt-1 text-caption text-secondary">
                    {new Date(lastTestedAt).toLocaleString()}
                  </p>
                )}
                <div className="mt-3 grid gap-3 lg:grid-cols-3">
                  <div className="rounded-lg border border-white/[0.08] bg-black/20 p-2.5">
                    <p className="text-caption font-semibold text-primary">Execution trace</p>
                    <ol className="mt-1.5 grid gap-1 text-caption text-secondary">
                      {testResult.executionTrace.map((step, index) => (
                        <li key={step}>
                          {index + 1}. {step}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="rounded-lg border border-white/[0.08] bg-black/20 p-2.5">
                    <p className="text-caption font-semibold text-primary">Risk flags</p>
                    <div className="mt-1.5 grid gap-1 text-caption text-secondary">
                      {testResult.riskFlags.length > 0 ? (
                        testResult.riskFlags.map((flag) => <p key={flag}>{flag}</p>)
                      ) : (
                        <p>No risk flags detected.</p>
                      )}
                    </div>
                  </div>
                  <div className="rounded-lg border border-white/[0.08] bg-black/20 p-2.5">
                    <p className="text-caption font-semibold text-primary">Expected outputs</p>
                    <div className="mt-1.5 grid gap-1 text-caption text-secondary">
                      {testResult.expectedOutputs.map((entry) => (
                        <p key={entry}>{entry}</p>
                      ))}
                      <p className="text-primary">{testResult.confidence}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          </SuiteSection>

          <SuiteSection
            step="Internals"
            title="Suite internals"
            description="Inspect policy state, agent roster, and managed/local file write plan."
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-body font-semibold text-primary">Suite details</p>
              <button
                type="button"
                onClick={() => setShowDetails((v) => !v)}
                className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.06]"
              >
                {showDetails ? 'Hide' : 'Show'}
              </button>
            </div>

            {showDetails && (
              <div className="mt-3 grid gap-3">
              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="grid gap-1 text-body text-secondary">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Workspace config</span>
                    {devMode ? (
                      <code className="rounded bg-black/40 px-1.5 py-0.5 text-caption text-primary">{plan.openclawConfigPath}</code>
                    ) : (
                      <span className="text-caption text-primary">Connected</span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Agent workspaces</span>
                    <code className="rounded bg-black/40 px-1.5 py-0.5 text-caption text-primary">
                      {plan.suiteWorkspaceRoot}/{'{agent-id}'}
                    </code>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Pack</span>
                    <code className="rounded bg-black/40 px-1.5 py-0.5 text-caption text-primary">{plan.packId}@{plan.packVersion}</code>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Skill pack</span>
                    <code className="rounded bg-black/40 px-1.5 py-0.5 text-caption text-primary">
                      {plan.skillPack
                        ? `${plan.skillPack.name}@${plan.skillPack.version} (${plan.skillPack.source})`
                        : 'builtin'}
                    </code>
                  </div>
                  {plan.skillPackRemote && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>Skill pack remote</span>
                      <code className="rounded bg-black/40 px-1.5 py-0.5 text-caption text-primary">
                        {plan.skillPackRemote.name}@{plan.skillPackRemote.version}
                      </code>
                    </div>
                  )}
                  {plan.skillPackPolicy && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>Skill pack policy</span>
                      <code className="rounded bg-black/40 px-1.5 py-0.5 text-caption text-primary">
                        {plan.skillPackPolicy.frozen ? 'frozen' : 'live'}
                        {plan.skillPackPolicy.pinnedChecksum ? `, pinned:${plan.skillPackPolicy.pinnedChecksum.slice(0, 8)}…` : ''}
                      </code>
                    </div>
                  )}
                  {plan.skillPackPolicy && (
                    <div className="mt-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-caption font-semibold uppercase tracking-[0.08em] text-secondary">
                          Execution presets
                        </p>
                        <Tag tone={activePreset ? 'good' : 'neutral'}>
                          {activePreset ? `Active: ${BEHAVIOR_PRESET_LABELS[activePreset]}` : 'Active: custom'}
                        </Tag>
                      </div>
                      <p className="mt-1 text-caption text-secondary">
                        Choose how much human approval vs automation your default behavior policy should use.
                      </p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        {(['conservative', 'balanced', 'autonomous'] as const).map((presetId) => {
                          const isActive = activePreset === presetId;
                          const isApplying = applyingPresetId === presetId;
                          return (
                            <button
                              key={presetId}
                              type="button"
                              onClick={() => { void applyBehaviorPreset(presetId); }}
                              disabled={Boolean(applyingPresetId)}
                              className={cn(
                                'min-h-[44px] rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                                isActive
                                  ? 'border-lime/35 bg-lime/[0.12] text-lime'
                                  : 'border-white/[0.12] bg-white/[0.03] text-primary hover:bg-white/[0.06]'
                              )}
                            >
                              <p className="text-body font-semibold">
                                {isApplying ? 'Applying…' : BEHAVIOR_PRESET_LABELS[presetId]}
                              </p>
                              <p className="mt-1 text-caption text-secondary">
                                {BEHAVIOR_PRESET_DESCRIPTIONS[presetId]}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                      {presetNotice && (
                        <p className="mt-2 rounded-lg border border-lime/20 bg-lime/[0.07] px-2.5 py-2 text-caption text-lime">
                          {presetNotice}
                        </p>
                      )}
                      {friendlyPresetError && (
                        <p className="mt-2 rounded-lg border border-rose-300/20 bg-rose-400/10 px-2.5 py-2 text-caption text-rose-100">
                          {friendlyPresetError}
                        </p>
                      )}
                    </div>
                  )}
                  {plan.skillPackPolicy && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          void updateSkillPackPolicy({ frozen: !plan.skillPackPolicy?.frozen });
                        }}
                        className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.06]"
                      >
                        {plan.skillPackPolicy.frozen ? 'Unfreeze skills' : 'Freeze skills'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (plan.skillPackPolicy?.pinnedChecksum) {
                            void updateSkillPackPolicy({ clearPin: true });
                          } else {
                            void updateSkillPackPolicy({ pinToCurrent: true });
                          }
                        }}
                        className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.06]"
                      >
                        {plan.skillPackPolicy.pinnedChecksum ? 'Unpin' : 'Pin current'}
                      </button>
                      <p className="text-caption text-muted">
                        Freeze prevents background checks; pin prevents applying a new checksum.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <p className="text-body font-semibold text-primary">Agents ({totalAgents})</p>
                <div className="mt-2 grid gap-2">
                  {plan.agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-subtle bg-white/[0.02] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-body font-semibold text-bright">{agent.name}</p>
                        <p className="mt-0.5 truncate text-caption text-secondary">
                          <code className="rounded bg-black/40 px-1">{agent.id}</code>
                          <span className="px-1">·</span>
                          <span>{agent.domain}</span>
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Tag tone={agent.configuredInOpenclaw ? 'good' : 'neutral'}>
                          {agent.configuredInOpenclaw ? 'configured' : 'to install'}
                        </Tag>
                        <Tag tone={agent.workspaceExists ? 'good' : 'neutral'}>
                          {agent.workspaceExists ? 'workspace ok' : 'workspace missing'}
                        </Tag>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <p className="text-body font-semibold text-primary">Planned file writes</p>
                <p className="mt-1 text-body leading-relaxed text-secondary">
                  Managed files are written to <code className="rounded bg-black/40 px-1">.orgx/managed</code>. Local overrides
                  are read from <code className="rounded bg-black/40 px-1">.orgx/local</code> and appended into the composite
                  files in the agent workspace root.
                </p>
                <div className="mt-2 grid gap-1 text-caption text-secondary">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Writes</span>
                    <span className="text-primary">{pluralize(plan.workspaceFiles.length, 'file')}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Creates/updates</span>
                    <span className="text-primary">{changedFiles}</span>
                  </div>
                  {(createdFiles > 0 || updatedFiles > 0) && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>Breakdown</span>
                      <span className="text-primary">
                        {createdFiles > 0 ? `${createdFiles} create` : '0 create'},{' '}
                        {updatedFiles > 0 ? `${updatedFiles} update` : '0 update'}
                      </span>
                    </div>
                  )}
                </div>

                {missingAgents > 0 && (
                  <div className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2">
                    <p className="text-caption font-semibold text-primary">Agents to install</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {plan.openclawConfigAddedAgents.map((id) => (
                        <code
                          key={id}
                          className="rounded-full border border-strong bg-black/40 px-2 py-0.5 text-caption text-primary"
                        >
                          {id}
                        </code>
                      ))}
                    </div>
                  </div>
                )}

                {changedFileItems.length > 0 && (
                  <div className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2">
                    <p className="text-caption font-semibold text-primary">Files that will change</p>
                    <div className="mt-2 grid gap-1.5">
                      {changedFileItems.slice(0, 24).map((entry) => (
                        <div key={`${entry.agentId}:${entry.file}`} className="flex flex-wrap items-center justify-between gap-2 text-caption">
                          <code className="rounded bg-black/40 px-1.5 py-0.5 text-primary">
                            {entry.agentId}/{entry.file}
                          </code>
                          <span className="text-secondary">{entry.action}</span>
                        </div>
                      ))}
                      {changedFileItems.length > 24 && (
                        <p className="text-caption text-muted">
                          Showing 24 of {changedFileItems.length}. Install/Update to apply all.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              </div>
            )}
          </SuiteSection>
        </div>
      )}
    </div>
  );
}
