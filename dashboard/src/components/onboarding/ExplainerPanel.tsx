import { motion } from 'framer-motion';
import type { OnboardingState } from '@/types';

interface ExplainerPanelProps {
  state: OnboardingState;
  isStarting: boolean;
  onConnect: () => void;
  onUseManualKey: () => void;
  onContinueWithoutOrgX: () => void;
}

/* ── Feature card data ─────────────────────────────────────────────── */

const features = [
  {
    label: 'Model Routing',
    desc: 'Right model, right cost, every prompt',
    accent: '#BFFF00',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="5" cy="19" r="2.5" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="19" cy="19" r="2.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M12 7.5v3m0 0l-5.5 6m5.5-6l5.5 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: 'Live Operations',
    desc: 'Decisions, handoffs, sessions — real-time',
    accent: '#14B8A6',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M3 12h3l2.5-5 3.5 10 2.5-5H21" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    label: 'Quality Gates',
    desc: 'Automated checkpoints before shipping',
    accent: '#7C7CFF',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M12 2l8 4.5v5.5c0 4.7-3.4 9-8 10.3C7.4 21 4 16.7 4 12V6.5L12 2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M9 12l2.5 2.5L15 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
] as const;

/* ── Animation variants ────────────────────────────────────────────── */

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

/* ── Component ─────────────────────────────────────────────────────── */

export function ExplainerPanel({
  state,
  isStarting,
  onConnect,
  onUseManualKey,
  onContinueWithoutOrgX,
}: ExplainerPanelProps) {
  const hasError = Boolean(state.lastError);

  return (
    <motion.section
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="glass-panel soft-shadow rounded-2xl"
    >
      {/* ── Header zone ─────────────────────────────────────────── */}
      <div className="px-6 pt-6 sm:px-8 sm:pt-8">
        {/* Logo row */}
        <motion.div variants={rise} className="flex items-center gap-2.5">
          <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
            <rect width="32" height="32" rx="8" fill="#BFFF00" fillOpacity="0.12" />
            <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" stroke="#BFFF00" strokeOpacity="0.25" />
            <path
              d="M10 16C10 12.686 12.686 10 16 10C19.314 10 22 12.686 22 16C22 19.314 19.314 22 16 22C12.686 22 10 19.314 10 16Z"
              stroke="#BFFF00" strokeWidth="1.8"
            />
            <path d="M12.5 12.5L19.5 19.5M19.5 12.5L12.5 19.5" stroke="#BFFF00" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span className="text-[13px] font-semibold text-white/70">OrgX</span>
        </motion.div>

        {/* Headline */}
        <motion.h2
          variants={rise}
          className="mt-5 text-[26px] font-semibold leading-[1.2] tracking-[-0.02em] text-white sm:text-[30px]"
        >
          Connect your workspace
        </motion.h2>
        <motion.p variants={rise} className="mt-2 max-w-md text-[15px] leading-relaxed text-white/50">
          Orchestrate agents, approve decisions, and track progress from a single live dashboard.
        </motion.p>
      </div>

      {/* ── Feature cards ───────────────────────────────────────── */}
      <motion.div variants={rise} className="mt-6 grid grid-cols-1 gap-2.5 px-6 sm:grid-cols-3 sm:px-8">
        {features.map((f, i) => (
          <motion.div
            key={f.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.18 + i * 0.08, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="hover-lift rounded-xl border border-white/[0.06] bg-white/[0.025] px-4 py-3.5"
          >
            <div style={{ color: f.accent }} className="mb-2.5 opacity-80">{f.icon}</div>
            <p className="text-[13px] font-semibold text-white">{f.label}</p>
            <p className="mt-0.5 text-[12px] leading-snug text-white/40">{f.desc}</p>
          </motion.div>
        ))}
      </motion.div>

      {/* ── CTAs ────────────────────────────────────────────────── */}
      <motion.div variants={rise} className="mt-6 flex flex-wrap items-center gap-3 px-6 sm:px-8">
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

      {/* ── Inline status / error bar ───────────────────────────── */}
      <motion.div
        variants={rise}
        className="mx-6 mt-6 sm:mx-8"
      >
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
            <button
              type="button"
              onClick={onConnect}
              disabled={isStarting}
              className="shrink-0 text-[12px] font-medium text-red-300/70 transition hover:text-red-200"
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5">
            <span className="relative flex h-1.5 w-1.5">
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white/40" />
            </span>
            <span className="text-[13px] text-white/40">Ready to connect</span>
          </div>
        )}
      </motion.div>

      {/* ── Footer links ────────────────────────────────────────── */}
      <motion.div
        variants={rise}
        className="mt-4 flex items-center justify-between border-t border-white/[0.05] px-6 py-4 sm:px-8"
      >
        <button
          type="button"
          onClick={onContinueWithoutOrgX}
          className="text-[12px] text-white/35 transition hover:text-white/60"
        >
          Continue without OrgX
        </button>
        <a
          href={state.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex items-center gap-1 text-[12px] text-white/35 transition hover:text-white/60"
        >
          Setup guide
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="transition-transform group-hover:translate-x-0.5">
            <path d="M3.5 2.5l3 2.5-3 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </motion.div>
    </motion.section>
  );
}
