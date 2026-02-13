import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { OnboardingState } from '@/types';
import orgxLogo from '@/assets/orgx-logo.png';
import { EntityIcon, type EntityIconType } from '@/components/shared/EntityIcon';

interface ExplainerPanelProps {
  state: OnboardingState;
  isStarting: boolean;
  onConnect: () => void;
  onUseManualKey: () => void;
  onContinueWithoutOrgX: () => void;
}

interface TutorialSlide {
  id: string;
  kicker: string;
  title: string;
  description: string;
  highlights: Array<{
    type: EntityIconType;
    label: string;
    detail: string;
  }>;
  footnote: string;
}

const featureCards: Array<{ label: string; desc: string; iconType: EntityIconType }> = [
  {
    label: 'Model Routing',
    desc: 'Right model, right cost, every prompt',
    iconType: 'initiative',
  },
  {
    label: 'Live Operations',
    desc: 'Decisions, handoffs, sessions in real time',
    iconType: 'workstream',
  },
  {
    label: 'Quality Gates',
    desc: 'Automated checkpoints before shipping',
    iconType: 'milestone',
  },
];

const tutorialSlides: TutorialSlide[] = [
  {
    id: 'hierarchy',
    kicker: 'Mission Control',
    title: 'Map the full execution ladder in one place',
    description:
      'Trace initiatives through workstreams, milestones, and tasks with sticky context, dependency mapping, and inline edits.',
    highlights: [
      { type: 'initiative', label: 'Initiative', detail: 'Top-level outcomes with owner and status.' },
      { type: 'workstream', label: 'Workstream', detail: 'Operational lanes and runner context.' },
      { type: 'milestone', label: 'Milestone', detail: 'Checkpoints that gate readiness.' },
      { type: 'task', label: 'Task', detail: 'Priority, ETA, budget, and dependencies.' },
    ],
    footnote: 'Use the hierarchy filters to isolate open, blocked, or done work instantly.',
  },
  {
    id: 'activity',
    kicker: 'Activity + Decisions',
    title: 'Stay in flow while execution evolves',
    description:
      'Track agent output as it happens, review decision payloads, and keep operational context attached from plan to completion.',
    highlights: [
      { type: 'notification', label: 'Live feed', detail: 'Messages, failures, and progress in one stream.' },
      { type: 'decision', label: 'Decision queue', detail: 'Approve or reject with full execution context.' },
      { type: 'workstream', label: 'Handoffs', detail: 'Runner transitions across domains and tasks.' },
      { type: 'task', label: 'Artifacts', detail: 'Completion evidence attached where it belongs.' },
    ],
    footnote: 'Focus a session to pin a run while the rest of the org remains visible.',
  },
  {
    id: 'dispatch',
    kicker: 'Autopilot + Next Up',
    title: 'Dispatch work confidently with clear guardrails',
    description:
      'Queue the next workstream, open the owning initiative instantly, and escalate from manual play to controlled auto-continue.',
    highlights: [
      { type: 'workstream', label: 'Next Up', detail: 'Queued workstreams with resolved runner and next task.' },
      { type: 'initiative', label: 'Open target', detail: 'Jump to the owning initiative and sticky hierarchy.' },
      { type: 'milestone', label: 'Guardrails', detail: 'Blocked states are surfaced before dispatch.' },
      { type: 'notification', label: 'System notices', detail: 'Inline success and failure feedback loops.' },
    ],
    footnote: 'Start with Play, then enable auto-continue when queue health is stable.',
  },
];

const onboardingBenefits: Array<{ type: EntityIconType; label: string; detail: string }> = [
  {
    type: 'initiative',
    label: 'Live Initiative Sync',
    detail: 'Initiatives and ownership stay aligned with OpenClaw execution.',
  },
  {
    type: 'decision',
    label: 'Decision Control',
    detail: 'Review approvals in-app without losing mission context.',
  },
  {
    type: 'workstream',
    label: 'Queue Visibility',
    detail: 'Understand what runs next, who runs it, and why.',
  },
];

const SETUP_COMMAND = 'openclaw plugins install @useorgx/openclaw-plugin';
const DEMO_MODE_KEY = 'orgx.demo_mode';
const AUTO_ROTATE_MS = 6500;

function keySourceLabel(source: OnboardingState['keySource']): string {
  switch (source) {
    case 'config':
      return 'Plugin config';
    case 'environment':
      return 'Environment variable';
    case 'persisted':
      return 'Saved local credential';
    case 'openclaw-config-file':
      return 'OpenClaw config file';
    case 'legacy-dev':
      return 'Legacy dev fallback';
    default:
      return 'Not detected';
  }
}

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
};

const rise = {
  hidden: { opacity: 0, y: 14 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] },
  },
};

const featureAccentByType: Record<EntityIconType, string> = {
  initiative: 'text-[#A8A0FF]',
  workstream: 'text-[#BFFF00]',
  milestone: 'text-[#43E7D8]',
  task: 'text-white/80',
  session: 'text-[#43E7D8]',
  active: 'text-[#BFFF00]',
  blocked: 'text-[#FF6B88]',
  failed: 'text-[#FF6B88]',
  handoff: 'text-[#A8A0FF]',
  outbox: 'text-[#F5D37A]',
  decision: 'text-[#F5D37A]',
  notification: 'text-[#7EEDE1]',
};

function slideIndexWrap(next: number): number {
  const total = tutorialSlides.length;
  return (next + total) % total;
}

export function ExplainerPanel({
  state,
  isStarting,
  onConnect,
  onUseManualKey,
  onContinueWithoutOrgX,
}: ExplainerPanelProps) {
  const hasError = Boolean(state.lastError);
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [debugCopyState, setDebugCopyState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [pauseAutoRotate, setPauseAutoRotate] = useState(false);
  const showKeySource = state.hasApiKey && state.keySource && state.keySource !== 'none';
  const activeSlide = tutorialSlides[activeSlideIndex];

  useEffect(() => {
    if (copyState === 'idle') return undefined;
    const timer = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (debugCopyState === 'idle') return undefined;
    const timer = window.setTimeout(() => setDebugCopyState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [debugCopyState]);

  useEffect(() => {
    if (pauseAutoRotate) return undefined;
    const timer = window.setInterval(() => {
      setActiveSlideIndex((previous) => slideIndexWrap(previous + 1));
    }, AUTO_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [pauseAutoRotate]);

  const copySetupCommand = async () => {
    try {
      await navigator.clipboard.writeText(SETUP_COMMAND);
      setCopyState('ok');
    } catch {
      setCopyState('error');
    }
  };

  const copyDebugDetails = async () => {
    try {
      const payload = {
        at: new Date().toISOString(),
        onboarding: {
          status: state.status,
          nextAction: state.nextAction,
          hasApiKey: state.hasApiKey,
          keySource: state.keySource,
          installationId: state.installationId,
          lastError: state.lastError,
        },
        page: typeof window !== 'undefined' ? window.location.href : null,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      };
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setDebugCopyState('ok');
    } catch {
      setDebugCopyState('error');
    }
  };

  return (
    <motion.section
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="bg-[--orgx-surface-elevated] border border-[--orgx-border] soft-shadow rounded-2xl"
    >
      <div className="px-6 pt-4 sm:px-8 sm:pt-5">
        <motion.div variants={rise} className="flex items-center gap-2.5">
          <img src={orgxLogo} alt="OrgX" className="h-7 w-7 rounded-lg object-contain" />
          <span className="text-[13px] font-semibold text-white/70">OrgX</span>
        </motion.div>

        <motion.h2
          variants={rise}
          className="mt-3 flex items-center gap-2.5 text-[24px] font-semibold leading-[1.2] tracking-[-0.02em] text-white sm:text-[28px]"
        >
          <EntityIcon type="workstream" size={19} className="opacity-95" />
          Connect your workspace
        </motion.h2>
        <motion.p variants={rise} className="mt-2 max-w-2xl text-[14px] leading-relaxed text-white/50">
          Orchestrate agents, approve decisions, and track progress from a single live dashboard.
        </motion.p>
      </div>

      <div className="mt-3 grid gap-3 px-6 sm:px-8 lg:grid-cols-[1.24fr_0.86fr]">
        <motion.div variants={rise} className="space-y-2.5">
          <div
            className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3.5"
            onMouseEnter={() => setPauseAutoRotate(true)}
            onMouseLeave={() => setPauseAutoRotate(false)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <EntityIcon type="workstream" size={14} className="text-[#BFFF00]" />
                <p className="text-[10px] uppercase tracking-[0.1em] text-white/45">Guided Tour</p>
              </div>
              <span className="chip text-[10px]">
                {activeSlideIndex + 1}/{tutorialSlides.length}
              </span>
            </div>

            <AnimatePresence initial={false} mode="wait">
              <motion.div
                key={activeSlide.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="mt-2.5 min-h-[214px] space-y-2.5"
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-white/40">
                  {activeSlide.kicker}
                </p>
                <h3 className="text-[16px] font-semibold leading-snug text-white/94">
                  {activeSlide.title}
                </h3>
                <p className="text-[12px] leading-relaxed text-white/55">
                  {activeSlide.description}
                </p>

                <div className="grid gap-1.5 sm:grid-cols-2">
                  {activeSlide.highlights.map((item) => (
                    <div
                      key={`${activeSlide.id}-${item.label}`}
                      className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-2"
                    >
                      <div className="flex items-center gap-1.5">
                        <EntityIcon type={item.type} size={12} className="flex-shrink-0 opacity-92" />
                        <p className="text-[11px] font-semibold text-white/88">{item.label}</p>
                      </div>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-white/50">{item.detail}</p>
                    </div>
                  ))}
                </div>

                <p className="text-[10px] leading-relaxed text-white/42">{activeSlide.footnote}</p>
              </motion.div>
            </AnimatePresence>

            <div className="mt-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {tutorialSlides.map((slide, index) => {
                  const active = index === activeSlideIndex;
                  return (
                    <button
                      key={slide.id}
                      type="button"
                      onClick={() => setActiveSlideIndex(index)}
                      aria-label={`View slide ${index + 1}`}
                      className={`h-1.5 rounded-full transition-all ${
                        active ? 'w-6 bg-[#BFFF00]' : 'w-2 bg-white/24 hover:bg-white/38'
                      }`}
                    />
                  );
                })}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setActiveSlideIndex((previous) => slideIndexWrap(previous - 1))}
                  className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.08] hover:text-white"
                >
                  Prev
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSlideIndex((previous) => slideIndexWrap(previous + 1))}
                  className="rounded-full border border-white/[0.12] bg-white/[0.03] px-2.5 py-1 text-[11px] text-white/70 transition hover:bg-white/[0.08] hover:text-white"
                >
                  Next
                </button>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            {featureCards.map((feature) => (
              <div
                key={feature.label}
                className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5"
              >
                <div className={`mb-1.5 ${featureAccentByType[feature.iconType]}`}>
                  <EntityIcon type={feature.iconType} size={15} />
                </div>
                <p className="text-[11px] font-semibold text-white">{feature.label}</p>
                <p className="mt-0.5 text-[10px] leading-snug text-white/44">{feature.desc}</p>
              </div>
            ))}
          </div>

          <motion.div variants={rise} className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onConnect}
              disabled={isStarting}
              className="inline-flex items-center gap-2 rounded-full bg-[#BFFF00] px-5 py-2.5 text-[13px] font-semibold text-black shadow-[0_0_24px_rgba(191,255,0,0.12)] transition-all hover:bg-[#d3ff42] hover:shadow-[0_0_32px_rgba(191,255,0,0.22)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStarting ? (
                <>
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                    <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  Connecting...
                </>
              ) : (
                'Connect OrgX'
              )}
            </button>
            <button
              type="button"
              onClick={onUseManualKey}
              className="rounded-full border border-white/[0.1] px-4 py-2 text-[13px] text-white/60 transition hover:border-white/[0.18] hover:text-white/85"
            >
              Use API key
            </button>
          </motion.div>
        </motion.div>

        <motion.div variants={rise} className="space-y-2.5">
          <div className="rounded-xl border border-[#14B8A6]/20 bg-[#14B8A6]/[0.06] px-3.5 py-3">
            <div className="flex items-center gap-1.5">
              <EntityIcon type="workstream" size={12} className="text-[#7EEDE1]" />
              <p className="text-[11px] uppercase tracking-[0.08em] text-[#7EEDE1]">OpenClaw Integration</p>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[#CFF8F3]">
              OrgX syncs with OpenClaw so initiatives, workstreams, milestones, and tasks stay aligned with live execution.
            </p>
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3">
            <div className="flex items-center gap-1.5">
              <EntityIcon type="task" size={12} className="opacity-90" />
              <p className="text-[11px] uppercase tracking-[0.08em] text-white/38">Quick Setup</p>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded-md border border-white/[0.08] bg-black/30 px-2 py-1 font-mono text-[11px] text-white/75">
                {SETUP_COMMAND}
              </code>
              <button
                type="button"
                onClick={() => {
                  void copySetupCommand();
                }}
                className="rounded-full border border-white/[0.12] px-3 py-1 text-[11px] text-white/65 transition hover:border-white/[0.2] hover:text-white/90"
              >
                {copyState === 'ok' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy command'}
              </button>
            </div>
            {showKeySource && (
              <p className="mt-2 text-[11px] text-white/45">
                API key source detected: {keySourceLabel(state.keySource)}
              </p>
            )}
          </div>

          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3.5 py-3">
            <p className="text-[11px] uppercase tracking-[0.08em] text-white/38">What Unlocks After Connect</p>
            <div className="mt-2 space-y-1.5">
              {onboardingBenefits.map((benefit) => (
                <div key={benefit.label} className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-2">
                  <div className="flex items-center gap-1.5">
                    <EntityIcon type={benefit.type} size={12} className="flex-shrink-0 opacity-90" />
                    <p className="text-[11px] font-semibold text-white/88">{benefit.label}</p>
                  </div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-white/48">{benefit.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>

      <motion.div variants={rise} className="mx-6 mt-2 sm:mx-8">
        {hasError ? (
          <div className="flex items-center gap-3 rounded-xl border border-red-500/15 bg-red-500/[0.04] px-4 py-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/15">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M5 2.5v3M5 7.5h.004" stroke="#FF6B88" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-red-300/80">{state.lastError}</p>
            </div>
            <div className="flex flex-shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void copyDebugDetails()}
                className="rounded-full border border-white/[0.12] bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-white/70 transition hover:bg-white/[0.08] hover:text-white"
                title="Copy debug details for support"
              >
                {debugCopyState === 'ok'
                  ? 'Copied'
                  : debugCopyState === 'error'
                    ? 'Copy failed'
                    : 'Copy debug'}
              </button>
              <button
                type="button"
                onClick={onUseManualKey}
                className="rounded-full border border-white/[0.12] bg-white/[0.04] px-3 py-1 text-[11px] font-medium text-white/70 transition hover:bg-white/[0.08] hover:text-white"
              >
                Use API key
              </button>
              <button
                type="button"
                onClick={onConnect}
                disabled={isStarting}
                className="rounded-full border border-red-500/20 bg-red-500/[0.06] px-3 py-1 text-[11px] font-semibold text-red-200/85 transition hover:bg-red-500/[0.09] hover:text-red-100 disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2">
            <span className="relative flex h-1.5 w-1.5">
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white/40" />
            </span>
            <span className="text-[12px] text-white/40">Ready to connect</span>
          </div>
        )}
      </motion.div>

      <motion.div
        variants={rise}
        className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.05] px-6 py-2 sm:px-8"
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              try {
                window.localStorage.setItem(DEMO_MODE_KEY, '1');
              } catch {
                // ignore
              }
              onContinueWithoutOrgX();
            }}
            className="text-left text-[11px] text-white/35 transition hover:text-white/60"
          >
            Explore demo dashboard
          </button>
          <button
            type="button"
            onClick={() => {
              try {
                window.localStorage.removeItem(DEMO_MODE_KEY);
              } catch {
                // ignore
              }
              onContinueWithoutOrgX();
            }}
            className="text-left text-[11px] text-white/25 transition hover:text-white/55"
          >
            Continue offline
          </button>
        </div>
        <a
          href={state.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-1 text-[11px] text-white/35 transition hover:text-white/60"
        >
          Setup guide
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            className="transition-transform group-hover:translate-x-0.5"
          >
            <path
              d="M3.5 2.5l3 2.5-3 2.5"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </motion.div>
    </motion.section>
  );
}
