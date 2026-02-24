import { useCallback, useState } from 'react';
import { colors } from '@/lib/tokens';
import { humanizeWarning } from '@/lib/humanize';
import { PremiumCard } from '@/components/shared/PremiumCard';

interface MissionControlEmptyProps {
  mode?: 'empty' | 'filtered' | 'degraded';
  hasActiveFilters?: boolean;
  detail?: string | null;
  onClearFilters?: () => void;
  onCreateInitiative?: () => void;
  onPlayNextUp?: () => Promise<void> | void;
  onStartAutopilot?: () => Promise<void> | void;
  onRefresh?: () => void;
  onOpenSettings?: () => void;
}

export function MissionControlEmpty({
  mode = 'empty',
  hasActiveFilters = false,
  detail = null,
  onClearFilters,
  onCreateInitiative,
  onPlayNextUp,
  onStartAutopilot,
  onRefresh,
  onOpenSettings,
}: MissionControlEmptyProps) {
  const [pending, setPending] = useState<'play' | 'autopilot' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runAction = useCallback(
    async (action: 'play' | 'autopilot', handler: (() => Promise<void> | void) | undefined) => {
      if (!handler) return;
      setError(null);
      setPending(action);
      try {
        await handler();
      } catch (nextError) {
        const raw = nextError instanceof Error ? nextError.message : '';
        setError(raw ? humanizeWarning(raw) : 'Action failed');
      } finally {
        setPending((current) => (current === action ? null : current));
      }
    },
    []
  );

  const headline =
    mode === 'filtered'
      ? 'No initiatives match this view'
      : mode === 'degraded'
        ? 'Initiatives are temporarily unavailable'
        : 'No initiatives yet';
  const description =
    mode === 'filtered'
      ? hasActiveFilters
        ? 'Adjust filters or clear them to return to the full hierarchy.'
        : 'Try a broader search or create a new initiative.'
      : mode === 'degraded'
        ? 'Live sync is reconnecting, so initiative and Next Up data may be stale.'
        : 'Create an initiative to unlock hierarchy, Next Up routing, and slice-level tracking.';

  return (
    <div className="flex-1 flex items-center justify-center p-6 sm:p-10">
      <PremiumCard className="w-full max-w-xl p-6 sm:p-7">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3.5">
            <div
              className="relative flex h-12 w-12 items-center justify-center rounded-xl"
              style={{
                backgroundColor: `${colors.iris}1a`,
                border: `1px solid ${colors.iris}33`,
              }}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke={colors.iris}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
            </div>
            <div className="min-w-0">
              <h3 className="text-heading font-semibold text-white">{headline}</h3>
              <p className="mt-1 text-body leading-relaxed text-secondary">{description}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {mode === 'filtered' && onClearFilters && (
              <button
                type="button"
                onClick={onClearFilters}
                className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition hover:bg-white/[0.08]"
              >
                Clear filters
              </button>
            )}
            {mode === 'degraded' && onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition hover:bg-white/[0.08]"
              >
                Open settings
              </button>
            )}
            {onCreateInitiative && (
              <button
                type="button"
                onClick={onCreateInitiative}
                className="rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/12 px-3 py-1.5 text-caption font-semibold text-[#D8FFA1] transition hover:bg-[#BFFF00]/18"
              >
                Create initiative
              </button>
            )}
            {onPlayNextUp && (
              <button
                type="button"
                onClick={() => void runAction('play', onPlayNextUp)}
                disabled={pending !== null}
                className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition hover:bg-white/[0.08] disabled:opacity-45"
              >
                {pending === 'play' ? 'Dispatching...' : 'Play Next Up'}
              </button>
            )}
            {onStartAutopilot && (
              <button
                type="button"
                onClick={() => void runAction('autopilot', onStartAutopilot)}
                disabled={pending !== null}
                className="rounded-full border border-[#0AD4C4]/30 bg-[#0AD4C4]/10 px-3 py-1.5 text-caption font-semibold text-[#98FFF5] transition hover:bg-[#0AD4C4]/16 disabled:opacity-45"
              >
                {pending === 'autopilot' ? 'Starting...' : 'Start Autopilot'}
              </button>
            )}
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-secondary transition hover:bg-white/[0.08] hover:text-primary"
              >
                Refresh
              </button>
            )}
          </div>

          {mode === 'degraded' && detail && (
            <p className="text-caption text-secondary">{humanizeWarning(detail)}</p>
          )}
          {error && <p className="text-caption text-amber-200/80">{error}</p>}
        </div>
      </PremiumCard>
    </div>
  );
}
