import { Modal } from '@/components/shared/Modal';
import { cn } from '@/lib/utils';
import type { OnboardingState } from '@/types';
import { OrgxConnectionPanel } from '@/components/settings/OrgxConnectionPanel';
import { AgentSuitePanel } from '@/components/settings/AgentSuitePanel';
import { ByokSettingsPanel } from '@/components/settings/ByokSettingsPanel';
import { LegalLinks } from '@/components/shared/LegalLinks';

export type SettingsTab = 'orgx' | 'providers';

export function SettingsModal({
  open,
  onClose,
  activeTab,
  onChangeTab,
  onboarding,
  authToken = null,
  embedMode = false,
}: {
  open: boolean;
  onClose: () => void;
  activeTab: SettingsTab;
  onChangeTab: (tab: SettingsTab) => void;
  onboarding: {
    state: OnboardingState;
    isStarting: boolean;
    isSubmittingManual: boolean;
    refreshStatus: () => Promise<unknown>;
    startPairing: () => Promise<void>;
    submitManualKey: (apiKey: string) => Promise<unknown>;
    backToPairing: () => void;
    setManualMode: () => void;
    disconnect: () => Promise<unknown>;
  };
  authToken?: string | null;
  embedMode?: boolean;
}) {
  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-4xl">
      <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        <div className="w-full border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-[15px] font-semibold text-white">Settings</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-white/55">
                OrgX connection and provider keys for agent launches.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div
            className="mt-4 inline-flex rounded-full border border-white/[0.10] bg-white/[0.03] p-0.5"
            role="tablist"
            aria-label="Settings tabs"
          >
            {([
              { id: 'orgx' as const, label: 'OrgX' },
              { id: 'providers' as const, label: 'Provider keys' },
            ] satisfies Array<{ id: SettingsTab; label: string }>).map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onChangeTab(tab.id)}
                  className={cn(
                    'rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors',
                    selected
                      ? 'border border-lime/25 bg-lime/[0.14] text-lime shadow-[0_0_16px_rgba(191,255,0,0.08)]'
                      : 'border border-transparent text-white/60 hover:bg-white/[0.06] hover:text-white'
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 w-full flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {activeTab === 'orgx' ? (
            <div className="grid gap-4">
              <OrgxConnectionPanel
                state={onboarding.state}
                isStarting={onboarding.isStarting}
                isSubmittingManual={onboarding.isSubmittingManual}
                onRefresh={onboarding.refreshStatus}
                onStartPairing={onboarding.startPairing}
                onSubmitManualKey={onboarding.submitManualKey}
                onBackToPairing={onboarding.backToPairing}
                onUseManualKey={onboarding.setManualMode}
                onDisconnect={onboarding.disconnect}
              />
              <AgentSuitePanel authToken={authToken} embedMode={embedMode} enabled={open} />
            </div>
          ) : (
            <ByokSettingsPanel authToken={authToken} embedMode={embedMode} enabled={open} />
          )}
        </div>
        <div className="w-full border-t border-white/[0.06] px-5 py-2.5 sm:px-6">
          <LegalLinks compact />
        </div>
      </div>
    </Modal>
  );
}
