import { useState } from 'react';
import { motion } from 'framer-motion';
import orgxLogo from '@/assets/orgx-logo.png';

interface ManualKeyPanelProps {
  isSubmitting: boolean;
  onSubmit: (apiKey: string) => Promise<unknown>;
  onBack: () => void;
}

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

const rise = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] },
  },
};

export function ManualKeyPanel({ isSubmitting, onSubmit, onBack }: ManualKeyPanelProps) {
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('API key is required.');
      return;
    }

    // Accept either a full key (e.g. oxk_...) or just the suffix after oxk_.
    const normalizedApiKey = /^[a-z]+_/i.test(trimmed)
      ? trimmed
      : `oxk_${trimmed}`;

    try {
      await onSubmit(normalizedApiKey);
      setApiKey('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to validate API key.');
    }
  };

  const hasError = error !== null;

  return (
    <motion.section
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="glass-panel soft-shadow rounded-2xl"
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="px-6 pt-6 sm:px-8 sm:pt-8">
        <motion.div variants={rise} className="flex items-center gap-2.5">
          <img src={orgxLogo} alt="OrgX" className="h-7 w-7 rounded-lg object-contain" />
          <span className="text-[13px] font-semibold text-white/70">OrgX</span>
        </motion.div>

        <motion.h3 variants={rise} className="mt-5 text-[22px] font-semibold tracking-[-0.02em] text-white">
          Manual API key
        </motion.h3>
        <motion.p variants={rise} className="mt-1.5 text-[14px] leading-relaxed text-white/45">
          Paste a key from your <span className="text-white/60">useorgx.com</span> dashboard. Browser pairing is recommended.
        </motion.p>
        <motion.p variants={rise} className="mt-1 text-[12px] text-white/35">
          Paste full key or only the part after <span className="font-mono text-white/50">oxk_</span>.
        </motion.p>
      </div>

      {/* ── Form ────────────────────────────────────────────────── */}
      <motion.div variants={rise} className="mt-6 space-y-4 px-6 sm:px-8">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">
            API key
          </span>
          <div className={`flex items-stretch overflow-hidden rounded-xl border transition-colors focus-within:border-[#BFFF00]/40 ${hasError ? 'border-red-500/30' : 'border-white/[0.08]'}`}>
            <span className="flex items-center border-r border-white/[0.06] bg-white/[0.03] px-3 font-mono text-[13px] text-white/25 select-none">
              oxk_
            </span>
            <input
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                if (error) setError(null);
              }}
              placeholder="paste your key"
              className="w-full bg-transparent px-3 py-2.5 font-mono text-[13px] text-white outline-none placeholder:text-white/15"
            />
          </div>
          {hasError && (
            <motion.p
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-1.5 text-[12px] text-red-400/70"
            >
              {error}
            </motion.p>
          )}
        </label>

        <p className="text-[12px] text-white/35">
          User-scoped keys (<span className="font-mono text-white/50">oxk_...</span>)
          do not require a separate user ID header.
        </p>
      </motion.div>

      {/* ── Actions ─────────────────────────────────────────────── */}
      <motion.div variants={rise} className="mt-6 flex flex-wrap items-center gap-3 px-6 sm:px-8">
        <button
          type="button"
          onClick={() => { void submit(); }}
          disabled={isSubmitting}
          className="inline-flex items-center gap-2 rounded-full bg-[#BFFF00] px-5 py-2.5 text-[13px] font-semibold text-black shadow-[0_0_24px_rgba(191,255,0,0.12)] transition-all hover:bg-[#d3ff42] hover:shadow-[0_0_32px_rgba(191,255,0,0.22)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? (
            <>
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.2" />
                <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              Validating...
            </>
          ) : (
            'Validate & Connect'
          )}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-full border border-white/[0.1] px-4 py-2 text-[13px] text-white/60 transition hover:border-white/[0.18] hover:text-white/85"
        >
          Back to pairing
        </button>
      </motion.div>

      {/* ── Footer ──────────────────────────────────────────────── */}
      <div className="mt-6 border-t border-white/[0.05] px-6 py-4 sm:px-8">
        <p className="text-[12px] text-white/25">
          Keys are stored locally and never leave your device.
        </p>
      </div>
    </motion.section>
  );
}
