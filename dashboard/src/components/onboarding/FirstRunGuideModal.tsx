import { useMemo } from 'react';
import { Modal } from '@/components/shared/Modal';
import { cn } from '@/lib/utils';
import { useByokSettings } from '@/hooks/useByokSettings';

const GUIDE_DISMISS_KEY = 'orgx.first_run_guide.dismissed';

function stepDot(done: boolean) {
  return (
    <span
      className={cn(
        'inline-flex h-2 w-2 rounded-full',
        done ? 'bg-emerald-400' : 'bg-white/35'
      )}
    />
  );
}

export function getFirstRunGuideDismissed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(GUIDE_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export function setFirstRunGuideDismissed(value: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    if (value) window.localStorage.setItem(GUIDE_DISMISS_KEY, '1');
    else window.localStorage.removeItem(GUIDE_DISMISS_KEY);
  } catch {
    // ignore
  }
}

export function FirstRunGuideModal({
  open,
  onClose,
  onOpenSettings,
  onOpenMissionControl,
  demoMode,
  connectionVerified,
  hasSessions,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenMissionControl: () => void;
  demoMode: boolean;
  connectionVerified: boolean;
  hasSessions: boolean;
}) {
  const byok = useByokSettings({ enabled: open });
  const configuredProviders = useMemo(() => {
    if (!byok.status?.ok) return 0;
    return Number(byok.status.providers.openai.configured) +
      Number(byok.status.providers.anthropic.configured) +
      Number(byok.status.providers.openrouter.configured);
  }, [byok.status]);

  const hasProviderKeys = configuredProviders > 0;
  const recommendedAction: 'settings' | 'mission-control' = hasProviderKeys ? 'mission-control' : 'settings';

  const steps = [
    {
      label: demoMode ? 'Exit demo (optional)' : 'Connect OrgX',
      done: demoMode ? false : connectionVerified,
      detail: demoMode
        ? 'Demo mode shows sample data. Connect OrgX to sync initiatives/tasks.'
        : 'Approve the pairing flow so your initiatives, tasks, and activity can sync.',
    },
    {
      label: 'Add provider key(s)',
      done: hasProviderKeys,
      detail: 'Set OpenAI / Anthropic / OpenRouter keys for agent launches, or rely on env vars.',
      action:
        !hasProviderKeys
          ? { label: 'Open settings', onClick: onOpenSettings }
          : null,
    },
    {
      label: 'Launch your first agent',
      done: hasSessions,
      detail: 'Use the “Launch” button in Agents / Chats to start a scoped run.',
    },
    {
      label: 'Open Mission Control',
      done: false,
      detail: 'Track dependency-ready next-up tasks and start auto-continue for execution.',
      action: { label: 'Open', onClick: onOpenMissionControl },
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const progressPct = Math.round((doneCount / steps.length) * 100);

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-[15px] font-semibold text-white">First run checklist</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-white/55">
                A fast path to seeing OrgX value inside OpenClaw.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="chip">
                  {doneCount} / {steps.length} complete
                </span>
                <span className="text-[11px] text-white/35">
                  {progressPct}% done
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full max-w-[340px] overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-full rounded-full bg-[#BFFF00]/80"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setFirstRunGuideDismissed(true);
                  onClose();
                }}
                className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08]"
                title="Don't show automatically again"
              >
                Don't show again
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close checklist"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18" />
                  <path d="M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="space-y-3">
              {steps.map((step) => (
                <div
                  key={step.label}
                  className={cn(
                    'flex items-start justify-between gap-3 rounded-xl border p-3',
                    step.done
                      ? 'border-white/[0.06] bg-white/[0.02]'
                      : 'border-white/[0.10] bg-white/[0.03]'
                  )}
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="pt-1">{stepDot(step.done)}</div>
                    <div className="min-w-0">
                      <p className={cn('text-[13px] font-semibold', step.done ? 'text-white/80' : 'text-white')}>
                        {step.label}
                      </p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-white/45">{step.detail}</p>
                    </div>
                  </div>

                  {step.action && !step.done ? (
                    <button
                      type="button"
                      onClick={step.action.onClick}
                      data-modal-autofocus={
                        recommendedAction === 'settings' && step.label === 'Add provider key(s)'
                          ? 'true'
                          : recommendedAction === 'mission-control' && step.label === 'Open Mission Control'
                            ? 'true'
                            : undefined
                      }
                      className="shrink-0 rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-3 py-1.5 text-[11px] font-semibold text-[#D8FFA1]"
                    >
                      {step.action.label}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onOpenSettings}
                data-modal-autofocus={recommendedAction === 'settings' ? 'true' : undefined}
                className="rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-3 py-1.5 text-[11px] font-semibold text-[#D8FFA1]"
              >
                Open settings
              </button>
              <button
                type="button"
                onClick={onOpenMissionControl}
                data-modal-autofocus={recommendedAction === 'mission-control' ? 'true' : undefined}
                className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08]"
              >
                Open Mission Control
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-white/[0.12] px-3 py-1.5 text-[11px] text-white/55 transition-colors hover:bg-white/[0.05] hover:text-white/80"
                title="Hide for now"
              >
                Not now
              </button>
            </div>
          </div>
        </div>

        <div className="border-t border-white/[0.06] px-5 py-3 sm:px-6">
          <p className="text-[11px] text-white/40">
            Tip: auto-continue is available per initiative from Mission Control quick actions.
          </p>
        </div>
      </div>
    </Modal>
  );
}
