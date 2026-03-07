import { AnimatePresence, motion } from 'framer-motion';
import type { ReactNode } from 'react';
import { Modal } from '@/components/shared/Modal';
import { cn } from '@/lib/utils';
import { tabCrossFade, motion as motionTokens } from '@/lib/tokens';
import type { OnboardingState } from '@/types';
import { OrgxConnectionPanel } from '@/components/settings/OrgxConnectionPanel';
import { AgentSuitePanel } from '@/components/settings/AgentSuitePanel';
import { ByokSettingsPanel } from '@/components/settings/ByokSettingsPanel';
import { AgentBehaviorPanel } from '@/components/settings/AgentBehaviorPanel';
import { UsageControlPlanePanel } from '@/components/settings/UsageControlPlanePanel';
import { UserProfileSection } from '@/components/settings/UserProfileSection';
import { LegalLinks } from '@/components/shared/LegalLinks';
import type { AgentSuiteDomain } from '@/types';

export type SettingsTab = 'orgx' | 'agents' | 'providers';

type SettingsTabMeta = {
  id: SettingsTab;
  label: string;
  subtitle: string;
};

const SETTINGS_TABS: SettingsTabMeta[] = [
  {
    id: 'orgx',
    label: 'Workspace',
    subtitle: 'Identity, OrgX connection, and environment controls.',
  },
  {
    id: 'agents',
    label: 'Agents',
    subtitle: 'Runtime behavior, decision policy, and execution guidance.',
  },
  {
    id: 'providers',
    label: 'Provider keys',
    subtitle: 'Model provider credentials and launch readiness.',
  },
];

function TabGlyph({ id }: { id: SettingsTab }) {
  if (id === 'orgx') {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 8h16" />
        <path d="M4 16h16" />
        <rect x="4" y="5" width="16" height="14" rx="3" />
      </svg>
    );
  }
  if (id === 'agents') {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="8" cy="8" r="3" />
        <circle cx="16" cy="16" r="3" />
        <path d="M10.6 10.6 13.4 13.4" />
        <path d="M12 5h6v6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 3v18" />
      <path d="M5 7.5h5.5v4H5z" />
      <path d="M13.5 12.5H19v4h-5.5z" />
    </svg>
  );
}

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
      <motion.button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onToggle(!enabled)}
        whileTap={{ scale: 0.965 }}
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
      </motion.button>
    </div>
  );
}

function SettingsSubspace({
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
    <section className="grid gap-4 border-t border-white/[0.06] pt-6 first:border-t-0 first:pt-0">
      <div className="max-w-3xl">
        <p className="text-micro uppercase tracking-[0.16em] text-lime/72">{step}</p>
        <h4 className="mt-2 text-[18px] font-semibold leading-tight text-white">{title}</h4>
        <p className="mt-1.5 text-body leading-relaxed text-secondary">{description}</p>
      </div>
      {children}
    </section>
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
    cancelPairing: () => Promise<unknown>;
    submitManualKey: (apiKey: string) => Promise<unknown>;
    backToPairing: () => void;
    setManualMode: () => void;
    disconnect: () => Promise<unknown>;
  };
  authToken?: string | null;
  embedMode?: boolean;
  agentBehaviorInitialDomain?: AgentSuiteDomain | null;
}) {
  const activeMeta = SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];

  const renderTabContent = () => {
    if (activeTab === 'orgx') {
      return (
        <motion.div key="orgx" {...tabCrossFade} className="grid gap-8">
          <SettingsSubspace
            step="Identity"
            title="Operator identity"
            description="Name, avatar signature, and live workspace connection context."
          >
            <UserProfileSection
              connectionPhase={
                onboarding.state.status === 'connected'
                  ? 'connected'
                  : onboarding.state.status === 'error'
                    ? 'error'
                    : onboarding.state.status === 'starting' ||
                        onboarding.state.status === 'awaiting_browser_auth' ||
                        onboarding.state.status === 'pairing'
                      ? 'connecting'
                      : 'idle'
              }
              workspaceName={onboarding.state.workspaceName}
            />
          </SettingsSubspace>

          <SettingsSubspace
            step="Controls"
            title="Environment controls"
            description="Debug and rehearsal switches that shape what appears in mission control."
          >
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-5">
              {!devMode ? (
                <div className="mb-4 rounded-xl border border-white/[0.08] bg-black/20 px-3.5 py-3">
                  <p className="text-caption font-semibold text-primary">Developer mode unlocks rehearsal controls.</p>
                  <p className="mt-1 text-caption leading-relaxed text-secondary">
                    Keep runtime details hidden during normal operation. Enable Developer mode when you need demo data
                    or synthetic entities for QA and walkthroughs.
                  </p>
                </div>
              ) : null}

              <div className="grid gap-1">
                <PreferenceToggle
                  label="Developer mode"
                  description="Show technical details, config paths, and raw data in session inspectors."
                  enabled={devMode}
                  onToggle={(next) => onToggleDevMode?.(next)}
                />
                <div className={cn('border-t border-white/[0.06]', devMode ? '' : 'pointer-events-none opacity-45')}>
                  <PreferenceToggle
                    label="Guided sandbox"
                    description="Load local sandbox data for walkthroughs without touching a real workspace."
                    enabled={demoMode}
                    onToggle={onToggleDemoMode}
                  />
                </div>
                <div className={cn('border-t border-white/[0.06]', devMode ? '' : 'pointer-events-none opacity-45')}>
                  <PreferenceToggle
                    label="Show synthetic entities"
                    description="Include QA/test initiative IDs in the agent column."
                    enabled={showSyntheticEntities}
                    onToggle={onToggleShowSyntheticEntities}
                  />
                </div>
              </div>
            </div>
          </SettingsSubspace>

          <SettingsSubspace
            step="Connection"
            title="OrgX connection lifecycle"
            description="Credentialing, verification, and workspace scope selection."
          >
            <OrgxConnectionPanel
              state={onboarding.state}
              isStarting={onboarding.isStarting}
              isSubmittingManual={onboarding.isSubmittingManual}
              workspaceOptions={workspaceOptions}
              selectedWorkspaceId={selectedWorkspaceId}
              onSelectWorkspace={onSelectWorkspace}
              onRefresh={onboarding.refreshStatus}
              onStartPairing={onboarding.startPairing}
              onCancelPairing={onboarding.cancelPairing}
              onSubmitManualKey={onboarding.submitManualKey}
              onBackToPairing={onboarding.backToPairing}
              onUseManualKey={onboarding.setManualMode}
              onDisconnect={onboarding.disconnect}
            />
          </SettingsSubspace>

          <SettingsSubspace
            step="Suite"
            title="Agent suite operations"
            description="Install, validate, and tune default execution policy across the local suite."
          >
            <AgentSuitePanel
              authToken={authToken}
              embedMode={embedMode}
              enabled={open && !demoMode}
              devMode={devMode}
            />
          </SettingsSubspace>

          <SettingsSubspace
            step="Usage"
            title="Usage telemetry"
            description="Budget, token, and runtime risk visibility for the active billing window."
          >
            <UsageControlPlanePanel
              authToken={authToken}
              embedMode={embedMode}
              enabled={open && !demoMode}
            />
          </SettingsSubspace>
        </motion.div>
      );
    }

    if (activeTab === 'agents') {
      return (
        <motion.div key="agents" {...tabCrossFade} className="grid gap-3">
          <SettingsSubspace
            step="Runtime policy"
            title="Per-agent runtime policy"
            description="Select an agent, tune guardrails, then persist all draft behavior changes."
          >
            <AgentBehaviorPanel
              authToken={authToken}
              embedMode={embedMode}
              enabled={open && !demoMode}
              initialDomain={agentBehaviorInitialDomain}
              onOpenSuiteOps={() => onChangeTab('orgx')}
            />
          </SettingsSubspace>
        </motion.div>
      );
    }

    return (
      <motion.div key="providers" {...tabCrossFade} className="grid gap-3">
        <SettingsSubspace
          step="Credentials"
          title="Provider credentials"
          description="Provision keys, validate provider readiness, and lock in routing confidence."
        >
          <ByokSettingsPanel
            authToken={authToken}
            embedMode={embedMode}
            enabled={open && !demoMode}
          />
        </SettingsSubspace>
      </motion.div>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      maxWidth="max-w-6xl"
      closeOnBackdropClick={false}
      closeOnEscapeWhenTyping={false}
    >
      <div className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(1200px 280px at 20% -10%, rgba(191,255,0,0.08), transparent 65%), radial-gradient(900px 240px at 95% -20%, rgba(10,212,196,0.07), transparent 68%)',
          }}
          aria-hidden
        />

        <div className="relative z-[1] flex h-full min-h-0 flex-1 flex-col px-5 pb-3 pt-5 sm:px-7 sm:pt-6">
          <div className="flex items-start justify-between gap-4 border-b border-white/[0.06] pb-5">
            <div className="min-w-0 max-w-3xl">
              <p className="text-micro uppercase tracking-[0.08em] text-lime/75">
                Control Surfaces
              </p>
              <h3 className="mt-2 text-display font-semibold leading-none tracking-[-0.02em] text-white sm:text-[36px]">
                Settings
              </h3>
              <p className="mt-3 max-w-2xl text-body leading-relaxed text-secondary">
                A single surface for identity, connection, execution policy, and provider readiness. The chrome stays
                quiet so the control you need is always the first thing you see.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-strong bg-transparent text-secondary transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-lime/45"
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

          <div className="mt-5 min-h-0 flex-1 gap-5 lg:grid lg:grid-cols-[220px_minmax(0,1fr)]">
            <aside className="hidden min-h-0 lg:block">
              <nav
                className="sticky top-0 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-2.5"
                role="tablist"
                aria-label="Settings tabs"
              >
                {SETTINGS_TABS.map((tab) => {
                  const selected = activeTab === tab.id;
                  return (
                    <motion.button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => onChangeTab(tab.id)}
                      whileHover={{ x: 1.5 }}
                      whileTap={{ scale: 0.985 }}
                      transition={{ duration: 0.16 }}
                      className={cn(
                        'relative mt-1.5 flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left first:mt-0',
                        selected ? 'text-white' : 'text-secondary hover:text-primary'
                      )}
                    >
                      {selected && (
                        <motion.span
                          layoutId="settings-tab-surface"
                          className="absolute inset-0 rounded-xl border border-lime/24 bg-lime/[0.10]"
                          transition={{ duration: 0.24, ease: motionTokens.easingStandard as unknown as number[] }}
                          aria-hidden
                        />
                      )}
                      <span
                        className={cn(
                          'relative z-[1] mt-[1px] inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border text-[11px]',
                          selected
                            ? 'border-lime/30 bg-lime/[0.14] text-lime'
                            : 'border-white/[0.12] bg-white/[0.03] text-secondary'
                        )}
                      >
                        <TabGlyph id={tab.id} />
                      </span>
                      <span className="relative z-[1] min-w-0">
                        <span className="block truncate text-body font-semibold">{tab.label}</span>
                      </span>
                    </motion.button>
                  );
                })}
              </nav>
            </aside>

            <section className="mt-4 min-h-0 lg:mt-0">
              <div
                className="mb-4 flex items-center gap-2 overflow-x-auto border-b border-white/[0.07] pb-3 lg:hidden"
                role="tablist"
                aria-label="Settings tabs"
              >
                {SETTINGS_TABS.map((tab) => {
                  const selected = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => onChangeTab(tab.id)}
                      className={cn(
                        'relative whitespace-nowrap rounded-full border px-3 py-1.5 text-caption font-semibold transition-colors',
                        selected
                          ? 'border-lime/32 bg-lime/[0.12] text-lime'
                          : 'border-white/[0.12] bg-white/[0.02] text-secondary'
                      )}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#05070d]/75">
                <div className="border-b border-white/[0.08] px-4 py-4 sm:px-6 sm:py-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="max-w-2xl">
                      <p className="text-micro uppercase tracking-[0.16em] text-lime/72">
                        Control area
                      </p>
                      <h4 className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.02em] text-white">
                        {activeMeta.label}
                      </h4>
                      <p className="mt-2 text-body leading-relaxed text-secondary">
                        {activeMeta.subtitle}
                      </p>
                    </div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-lime/15 bg-lime/[0.08] px-3 py-1.5 text-caption font-medium text-lime">
                      <span className="h-1.5 w-1.5 rounded-full bg-lime/80" />
                      Live configuration surface
                    </div>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
                  <AnimatePresence mode="wait">{renderTabContent()}</AnimatePresence>
                </div>
              </div>
            </section>
          </div>

          <div className="mt-3 border-t border-subtle px-1 pt-2">
            <LegalLinks compact />
          </div>
        </div>
      </div>
    </Modal>
  );
}
