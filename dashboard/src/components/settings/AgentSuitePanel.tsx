import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useAgentSuite } from '@/hooks/useAgentSuite';

function pluralize(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

type TagTone = 'good' | 'warn' | 'neutral';

function Tag({ tone, children }: { tone: TagTone; children: ReactNode }) {
  const className = useMemo(() => {
    if (tone === 'good') return 'border-lime/25 bg-lime/[0.10] text-lime';
    if (tone === 'warn') return 'border-amber-300/25 bg-amber-400/10 text-amber-100/90';
    return 'border-white/[0.10] bg-white/[0.02] text-white/70';
  }, [tone]);

  return (
    <span className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold', className)}>
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
  const changedFiles = plan?.workspaceFiles?.filter((f) => f.action !== 'noop').length ?? 0;

  const summary = useMemo(() => {
    if (suite.isLoading) return 'Loading agent suite status...';
    if (suite.error) return 'Unable to read suite status.';
    if (!plan) return 'Suite status unavailable.';
    if (missingAgents === 0 && changedFiles === 0) return 'Suite is installed and up to date.';
    const parts = [];
    if (missingAgents > 0) parts.push(`will add ${pluralize(missingAgents, 'agent')}`);
    if (changedFiles > 0) parts.push(`will ${changedFiles === 1 ? 'update' : 'update'} ${pluralize(changedFiles, 'file')}`);
    return `Preview: ${parts.join(', ')}.`;
  }, [changedFiles, missingAgents, plan, suite.error, suite.isLoading]);

  const lastInstall = suite.installResult?.ok ? suite.installResult : null;

  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-white">OrgX agent suite</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-white/55">
            Installs the OrgX domain agents into OpenClaw (workspaces + guardrails + managed/local overlay).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => { void suite.refetchStatus(); }}
            className="rounded-full border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-[12px] font-semibold text-white/70 transition-colors hover:bg-white/[0.06]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={() => { void suite.install({ dryRun: false }); }}
            disabled={suite.isInstalling || !plan}
            className="inline-flex items-center gap-2 rounded-full bg-[#BFFF00] px-4 py-2 text-[12px] font-semibold text-black transition-colors hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-50"
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
          </>
        )}
      </div>

      {lastInstall && (
        <div className="mt-3 rounded-xl border border-lime/20 bg-lime/[0.06] px-4 py-3">
          <p className="text-[11px] uppercase tracking-[0.1em] text-[#D8FFA1]">Applied</p>
          <p className="mt-1 text-[12px] leading-relaxed text-white/65">
            Operation <code className="rounded bg-black/40 px-1">{lastInstall.operationId}</code> wrote OpenClaw config and refreshed managed files.
          </p>
        </div>
      )}

      {plan && (
        <div className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] font-semibold text-white/80">Suite details</p>
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.06]"
            >
              {showDetails ? 'Hide' : 'Show'}
            </button>
          </div>

          {showDetails && (
            <div className="mt-3 grid gap-3">
              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <div className="grid gap-1 text-[12px] text-white/60">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>OpenClaw config</span>
                    <code className="rounded bg-black/40 px-1.5 py-0.5 text-[11px] text-white/70">{plan.openclawConfigPath}</code>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Suite workspace root</span>
                    <code className="rounded bg-black/40 px-1.5 py-0.5 text-[11px] text-white/70">{plan.suiteWorkspaceRoot}</code>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Pack</span>
                    <code className="rounded bg-black/40 px-1.5 py-0.5 text-[11px] text-white/70">{plan.packId}@{plan.packVersion}</code>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                <p className="text-[12px] font-semibold text-white/80">Agents</p>
                <div className="mt-2 grid gap-2">
                  {plan.agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[12px] font-semibold text-white/85">{agent.name}</p>
                        <p className="mt-0.5 truncate text-[11px] text-white/45">
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
                <p className="text-[12px] font-semibold text-white/80">Planned file writes</p>
                <p className="mt-1 text-[12px] leading-relaxed text-white/45">
                  Managed files are written to <code className="rounded bg-black/40 px-1">.orgx/managed</code>. Local overrides
                  are read from <code className="rounded bg-black/40 px-1">.orgx/local</code> and appended into the composite
                  files in the agent workspace root.
                </p>
                <div className="mt-2 grid gap-1 text-[11px] text-white/50">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Writes</span>
                    <span className="text-white/70">{pluralize(plan.workspaceFiles.length, 'file')}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Creates/updates</span>
                    <span className="text-white/70">{changedFiles}</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
