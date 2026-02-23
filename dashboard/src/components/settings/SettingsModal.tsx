import { Modal } from '@/components/shared/Modal';
import { cn } from '@/lib/utils';
import type { OnboardingState } from '@/types';
import { OrgxConnectionPanel } from '@/components/settings/OrgxConnectionPanel';
import { AgentSuitePanel } from '@/components/settings/AgentSuitePanel';
import { ByokSettingsPanel } from '@/components/settings/ByokSettingsPanel';
import { AgentBehaviorPanel } from '@/components/settings/AgentBehaviorPanel';
import { UsageControlPlanePanel } from '@/components/settings/UsageControlPlanePanel';
import { LegalLinks } from '@/components/shared/LegalLinks';
import type { AgentSuiteDomain } from '@/types';

export type SettingsTab = 'orgx' | 'agents' | 'providers';

function PreferenceToggle({
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
    <div className="flex items-start justify-between gap-4 rounded-xl border border-white/[0.08] bg-black/20 px-3 py-3">
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
          enabled
            ? 'border-lime/35 bg-lime/[0.20]'
            : 'border-white/[0.12] bg-white/[0.06]'
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full transition-all',
            enabled
              ? 'left-[20px] bg-lime'
              : 'left-0.5 bg-white/70'
          )}
        />
      </button>
    </div>
  );
}

export function SettingsModal({
  open,
  onClose,
  activeTab,
  onChangeTab,
  demoMode,
  onToggleDemoMode,
  devMode = false,
  onToggleDevMode,
  showSyntheticEntities,
  onToggleShowSyntheticEntities,
  onboarding,
  authToken = null,
  embedMode = false,
  agentBehaviorInitialDomain = null,
}: {
  open: boolean;
  onClose: () => void;
  activeTab: SettingsTab;
  onChangeTab: (tab: SettingsTab) => void;
  demoMode: boolean;
  onToggleDemoMode: (next: boolean) => void;
  devMode?: boolean;
  onToggleDevMode?: (next: boolean) => void;
  showSyntheticEntities: boolean;
  onToggleShowSyntheticEntities: (next: boolean) => void;
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
  agentBehaviorInitialDomain?: AgentSuiteDomain | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidth="max-w-4xl"
      closeOnBackdropClick={false}
      closeOnEscapeWhenTyping={false}
    >
      <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        <div className="w-full border-b border-subtle px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-heading font-semibold text-white">Settings</h3>
              <p className="mt-1 text-body leading-relaxed text-secondary">
                OrgX connection, agent behavior, and provider keys for agent launches.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-strong bg-white/[0.03] text-primary transition-colors hover:bg-white/[0.08] hover:text-white"
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
              { id: 'agents' as const, label: 'Agents' },
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
                    'rounded-full px-3 py-1.5 text-caption font-semibold transition-colors',
                    selected
                      ? 'border border-lime/25 bg-lime/[0.14] text-lime shadow-[0_0_16px_rgba(191,255,0,0.08)]'
                      : 'border border-transparent text-secondary hover:bg-white/[0.06] hover:text-white'
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
              <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
                <h3 className="text-heading font-semibold text-white">Developer tools</h3>
                <p className="mt-1 text-body leading-relaxed text-secondary">
                  Technical details, config paths, and raw data for debugging.
                </p>
                <div className="mt-3 grid gap-3">
                  <PreferenceToggle
                    label="Developer mode"
                    description="Show technical details, config paths, and raw data in session inspectors."
                    enabled={devMode}
                    onToggle={(next) => onToggleDevMode?.(next)}
                  />
                  <div className={devMode ? '' : 'pointer-events-none opacity-40'}>
                    <PreferenceToggle
                      label="Demo mode"
                      description="Load local demo data for walkthroughs."
                      enabled={demoMode}
                      onToggle={onToggleDemoMode}
                    />
                  </div>
                  <div className={devMode ? '' : 'pointer-events-none opacity-40'}>
                    <PreferenceToggle
                      label="Show synthetic entities"
                      description="Include QA/test initiative IDs in the agent column."
                      enabled={showSyntheticEntities}
                      onToggle={onToggleShowSyntheticEntities}
                    />
                  </div>
                </div>
              </div>
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
              <AgentSuitePanel
                authToken={authToken}
                embedMode={embedMode}
                enabled={open && !demoMode}
                devMode={devMode}
              />
              <UsageControlPlanePanel
                authToken={authToken}
                embedMode={embedMode}
                enabled={open && !demoMode}
              />
            </div>
          ) : activeTab === 'agents' ? (
            <AgentBehaviorPanel
              authToken={authToken}
              embedMode={embedMode}
              enabled={open && !demoMode}
              initialDomain={agentBehaviorInitialDomain}
            />
          ) : (
            <ByokSettingsPanel
              authToken={authToken}
              embedMode={embedMode}
              enabled={open && !demoMode}
            />
          )}
        </div>
        <div className="w-full border-t border-subtle px-5 py-2.5 sm:px-6">
          <LegalLinks compact />
        </div>
      </div>
    </Modal>
  );
}
