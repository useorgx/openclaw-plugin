import { motion } from 'framer-motion';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { colors } from '@/lib/tokens';

interface ConnectedEmptyRunwayProps {
  workspaceLabel: string;
  suggestedTitle?: string | null;
  sessionSummary?: string | null;
  onCreateInitiative: () => void;
  onCreateFromSession: () => void;
  onOpenSandbox: () => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
}

export function ConnectedEmptyRunway({
  workspaceLabel,
  suggestedTitle,
  sessionSummary,
  onCreateInitiative,
  onCreateFromSession,
  onOpenSandbox,
  onOpenSettings,
  onRefresh,
}: ConnectedEmptyRunwayProps) {
  const hasSuggestedDraft = Boolean(suggestedTitle && suggestedTitle.trim().length > 0);

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 py-8 sm:px-6"
      style={{ backgroundColor: colors.background }}
    >
      <PremiumCard className="w-full max-w-5xl overflow-hidden">
        <div className="grid gap-0 lg:grid-cols-[1.08fr_0.92fr]">
          <div className="border-b border-subtle p-6 sm:p-8 lg:border-b-0 lg:border-r">
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="flex items-center gap-2">
                <EntityIcon type="initiative" size={16} className="opacity-95" />
                <span className="text-caption font-semibold uppercase tracking-[0.12em] text-secondary">
                  First value runway
                </span>
                <span className="chip">{workspaceLabel}</span>
              </div>
              <h2 className="mt-4 max-w-2xl text-[30px] font-semibold leading-[1.08] tracking-[-0.03em] text-white sm:text-[38px]">
                Connected successfully. There is no tracked work here yet.
              </h2>
              <p className="mt-4 max-w-2xl text-body leading-relaxed text-secondary sm:text-heading">
                The fastest path to value is to create one initiative, dispatch one workstream, and
                watch OrgX keep the execution visible inside OpenClaw.
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.06, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="mt-6 grid gap-3"
            >
              <button
                type="button"
                onClick={onCreateInitiative}
                className="flex min-h-[56px] items-center justify-between rounded-2xl border border-lime/28 bg-lime/10 px-4 py-3 text-left transition hover:bg-lime/14"
              >
                <div>
                  <p className="text-body font-semibold text-[#E4FFAD]">Create first initiative</p>
                  <p className="mt-1 text-caption leading-relaxed text-[#D7F3A3]/78">
                    Start with a real initiative and land directly in Mission Control once it exists.
                  </p>
                </div>
                <EntityIcon type="initiative" size={16} className="shrink-0" />
              </button>

              <button
                type="button"
                onClick={onCreateFromSession}
                disabled={!hasSuggestedDraft}
                className="flex min-h-[56px] items-center justify-between rounded-2xl border border-white/[0.1] bg-white/[0.03] px-4 py-3 text-left transition hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <div>
                  <p className="text-body font-semibold text-white">
                    Use current OpenClaw session as draft
                  </p>
                  <p className="mt-1 text-caption leading-relaxed text-secondary">
                    {hasSuggestedDraft
                      ? `Prefill from “${suggestedTitle}” and refine before you launch.`
                      : 'No recent local session is available to prefill right now.'}
                  </p>
                </div>
                <EntityIcon type="session" size={16} className="shrink-0 opacity-92" />
              </button>

              <button
                type="button"
                onClick={onOpenSandbox}
                className="flex min-h-[56px] items-center justify-between rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-3 text-left transition hover:bg-white/[0.04]"
              >
                <div>
                  <p className="text-body font-semibold text-white">Open guided sandbox</p>
                  <p className="mt-1 text-caption leading-relaxed text-secondary">
                    See the operating model in a clearly marked sandbox before you set up real work.
                  </p>
                </div>
                <EntityIcon type="workstream" size={16} className="shrink-0 opacity-92" />
              </button>
            </motion.div>
          </div>

          <div className="p-6 sm:p-8">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4">
              <div className="flex items-center gap-2">
                <EntityIcon type="workstream" size={13} className="text-lime" />
                <p className="text-caption font-semibold uppercase tracking-[0.1em] text-secondary">
                  What happens next
                </p>
              </div>
              <div className="mt-4 space-y-3">
                <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3">
                  <p className="text-caption font-semibold text-white">1. Create one initiative</p>
                  <p className="mt-1 text-caption leading-relaxed text-secondary">
                    Keep the title concrete. This becomes the first object OrgX can route, track,
                    and score.
                  </p>
                </div>
                <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3">
                  <p className="text-caption font-semibold text-white">2. Add the first workstream</p>
                  <p className="mt-1 text-caption leading-relaxed text-secondary">
                    One workstream is enough to prove the queue, dispatch, and progress model.
                  </p>
                </div>
                <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-3">
                  <p className="text-caption font-semibold text-white">3. Watch one live execution</p>
                  <p className="mt-1 text-caption leading-relaxed text-secondary">
                    The aha moment is seeing the work move from Next Up to In Progress with
                    decisions and artifacts attached.
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
              <p className="text-caption font-semibold uppercase tracking-[0.1em] text-secondary">
                Draft signal
              </p>
              <p className="mt-3 text-body font-semibold text-white">
                {hasSuggestedDraft ? suggestedTitle : 'No current OpenClaw session detected'}
              </p>
              <p className="mt-1 text-caption leading-relaxed text-secondary">
                {sessionSummary && sessionSummary.trim().length > 0
                  ? sessionSummary
                  : 'As soon as a local work session exists, this runway can prefill the initiative draft instead of starting from a blank field.'}
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition hover:bg-white/[0.08]"
                >
                  Review settings
                </button>
                <button
                  type="button"
                  onClick={onRefresh}
                  className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-secondary transition hover:bg-white/[0.08] hover:text-primary"
                >
                  Refresh workspace
                </button>
              </div>
            </div>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}
