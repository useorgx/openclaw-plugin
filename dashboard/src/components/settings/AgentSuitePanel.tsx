import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useAgentSuite } from '@/hooks/useAgentSuite';
import { buildOrgxHeaders } from '@/lib/http';

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

export function AgentSuitePanel({
  authToken = null,
  embedMode = false,
  enabled = true,
}: {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}) {
  const [showDetails, setShowDetails] = useState(false);
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

  const summary = useMemo(() => {
    if (suite.isLoading) return 'Loading agent suite status...';
    if (suite.error) return 'Unable to read suite status.';
    if (!plan) return 'Suite status unavailable.';
    if (conflictFiles > 0) return `Conflicts detected: ${pluralize(conflictFiles, 'file')} need attention.`;
    if (missingAgents === 0 && changedFiles === 0) return 'Suite is installed and up to date.';
    const parts = [];
    if (missingAgents > 0) parts.push(`will add ${pluralize(missingAgents, 'agent')}`);
    if (changedFiles > 0) parts.push(`will ${changedFiles === 1 ? 'update' : 'update'} ${pluralize(changedFiles, 'file')}`);
    return `Preview: ${parts.join(', ')}.`;
  }, [changedFiles, conflictFiles, missingAgents, plan, suite.error, suite.isLoading]);

  const lastInstall = suite.installResult?.ok ? suite.installResult : null;
  const isDryRun = Boolean(lastInstall?.dryRun);

  const updateSkillPackPolicy = async (body: Record<string, unknown>) => {
    await fetch('/orgx/api/skill-pack/policy', {
      method: 'POST',
      headers: buildOrgxHeaders({ authToken, embedMode, contentTypeJson: true }),
      body: JSON.stringify(body),
    }).then(async (res) => {
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error((payload as any)?.error ?? `Failed to update policy (${res.status})`);
      }
    });
    await suite.refetchStatus();
  };

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-heading font-semibold text-white">OrgX agent suite</h3>
          <p className="mt-1 text-body leading-relaxed text-secondary">
            Installs the OrgX domain agents into OpenClaw (workspaces + guardrails + managed/local overlay).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { void suite.refetchStatus(); }}
            className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              setShowDetails(true);
              void suite.install({ dryRun: true });
            }}
            disabled={suite.isInstalling}
            className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
            title="Computes the plan without writing any files"
          >
            Dry run
          </button>
          <button
            type="button"
            onClick={() => { void suite.install({ dryRun: false, forceSkillPack: true }); }}
            disabled={suite.isInstalling}
            className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
            title="Forces a check for the latest OrgX skill pack and applies it (managed/local overlay preserves local edits)"
          >
            Refresh skills
          </button>
          <button
            type="button"
            onClick={() => { void suite.install({ dryRun: false }); }}
            disabled={suite.isInstalling}
            className="inline-flex items-center gap-2 rounded-full bg-[#BFFF00] px-4 py-2 text-body font-semibold text-black transition-colors hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-50"
            title="Adds missing agents to openclaw.json and scaffolds managed workspace files"
          >
            {suite.isInstalling ? 'Installing...' : 'Install / Update'}
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Tag tone={suite.error ? 'warn' : 'neutral'}>{summary}</Tag>
        {plan && (
          <>
            <Tag tone={missingAgents === 0 ? 'good' : 'warn'}>
              {missingAgents === 0 ? 'agents configured' : `${missingAgents} missing in openclaw.json`}
            </Tag>
            <Tag tone="neutral">{pluralize(totalAgents, 'agent')} total</Tag>
            <Tag tone={changedFiles === 0 ? 'good' : 'neutral'}>{changedFiles === 0 ? 'no file changes' : `${changedFiles} file changes`}</Tag>
            {conflictFiles > 0 && <Tag tone="warn">{pluralize(conflictFiles, 'conflict')}</Tag>}
            {plan.skillPackUpdateAvailable && <Tag tone="warn">skill update available</Tag>}
            {plan.skillPackPolicy?.frozen && <Tag tone="neutral">skills frozen</Tag>}
          </>
        )}
      </div>

      {lastInstall && (
        <div className="mt-3 rounded-xl border border-lime/20 bg-lime/[0.06] px-4 py-3">
          <p className="text-caption uppercase tracking-[0.1em] text-[#D8FFA1]">
            {isDryRun ? 'Dry run' : 'Applied'}
          </p>
          <p className="mt-1 text-body leading-relaxed text-secondary">
            Operation <code className="rounded bg-black/40 px-1">{lastInstall.operationId}</code>{' '}
            {isDryRun
              ? 'computed the plan without writing any files.'
              : 'wrote OpenClaw config and refreshed managed files.'}
          </p>
        </div>
      )}

      {plan && (
        <div className="mt-4">
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
                    <span>OpenClaw config</span>
                    <code className="rounded bg-black/40 px-1.5 py-0.5 text-caption text-primary">{plan.openclawConfigPath}</code>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Suite workspace root</span>
                    <code className="rounded bg-black/40 px-1.5 py-0.5 text-caption text-primary">{plan.suiteWorkspaceRoot}</code>
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
                <p className="text-body font-semibold text-primary">Agents</p>
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
                        <Tag tone={agent.configuredInOpenclaw ? 'good' : 'warn'}>
                          {agent.configuredInOpenclaw ? 'configured' : 'not configured'}
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
                    <p className="text-caption font-semibold text-primary">OpenClaw agents to add</p>
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
        </div>
      )}
    </div>
  );
}
