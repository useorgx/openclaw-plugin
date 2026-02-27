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
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium text-white">{label}</p>
        <p className="mt-0.5 text-caption leading-relaxed text-secondary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onToggle(!enabled)}
        className={cn(
          'relative inline-flex h-[22px] w-[38px] flex-shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lime/50',
          enabled
            ? 'border-lime/30 bg-lime/[0.15]'
            : 'border-white/[0.12] bg-white/[0.04] hover:bg-white/[0.08]'
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-[1px] h-[18px] w-[18px] rounded-full shadow-sm transition-all',
            enabled
              ? 'left-[17px] bg-lime shadow-[0_0_8px_rgba(191,255,0,0.4)]'
              : 'left-[1px] bg-secondary'
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
  workspaceOptions,
  selectedWorkspaceId,
  onSelectWorkspace,
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
  workspaceOptions: Array<{ id: string; title: string }>;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string | null) => void;
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
        <div className="w-full pt-6 px-5 sm:px-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-title font-medium text-white">Settings</h3>
              <p className="mt-1.5 text-body text-secondary">
                OrgX connection, agent behavior, and provider keys.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-secondary transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:bg-white/[0.06]"
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
            className="mt-6 flex items-center gap-6 border-b border-white/[0.06]"
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
                    'relative pb-3 text-caption font-medium transition-colors focus:outline-none',
                    selected
                      ? 'text-white'
                      : 'text-secondary hover:text-primary'
                  )}
                >
                  {tab.label}
                  {selected && (
                    <span
                      className="absolute bottom-0 left-0 right-0 h-px bg-white shadow-[0_0_8px_rgba(255,255,255,0.4)]"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 w-full flex-1 overflow-y-auto px-5 py-6 sm:px-8">
          {activeTab === 'orgx' ? (
            <div className="grid gap-12">
              <div>
                <h3 className="text-body font-medium text-white mb-4">Developer tools</h3>
                <div className="grid gap-1 border-t border-white/[0.04] pt-2">
                  <PreferenceToggle
                    label="Developer mode"
                    description="Show technical details, config paths, and raw data in session inspectors."
                    enabled={devMode}
                    onToggle={(next) => onToggleDevMode?.(next)}
                  />
                  <div className={cn("border-t border-white/[0.04]", devMode ? '' : 'pointer-events-none opacity-40')}>
                    <PreferenceToggle
                      label="Demo mode"
                      description="Load local demo data for walkthroughs."
                      enabled={demoMode}
                      onToggle={onToggleDemoMode}
                    />
                  </div>
                  <div className={cn("border-t border-white/[0.04]", devMode ? '' : 'pointer-events-none opacity-40')}>
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
                workspaceOptions={workspaceOptions}
                selectedWorkspaceId={selectedWorkspaceId}
                onSelectWorkspace={onSelectWorkspace}
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
