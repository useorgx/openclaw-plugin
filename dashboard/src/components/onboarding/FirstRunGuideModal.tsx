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
    },
  ];

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-[14px] font-semibold text-white">First Run Checklist</h3>
              <p className="mt-1 text-[12px] text-white/55">
                Quick path to seeing OrgX value inside OpenClaw.
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
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="space-y-3">
              {steps.map((step) => (
                <div key={step.label} className="flex items-start gap-3">
                  <div className="pt-1">{stepDot(step.done)}</div>
                  <div className="min-w-0">
                    <p className={cn('text-[13px] font-semibold', step.done ? 'text-white/80' : 'text-white')}>
                      {step.label}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-white/45">{step.detail}</p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onOpenSettings}
                className="rounded-full border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-3 py-1.5 text-[11px] font-semibold text-[#D8FFA1]"
              >
                Open Settings
              </button>
              <button
                type="button"
                onClick={onOpenMissionControl}
                className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08]"
              >
                Open Mission Control
              </button>
              <button
                type="button"
                onClick={() => {
                  setFirstRunGuideDismissed(true);
                  onClose();
                }}
                className="rounded-full border border-white/[0.12] px-3 py-1.5 text-[11px] text-white/55 transition-colors hover:bg-white/[0.05] hover:text-white/80"
                title="Don't show automatically again"
              >
                Dismiss forever
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

