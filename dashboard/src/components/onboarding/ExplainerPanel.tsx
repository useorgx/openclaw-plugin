import type { OnboardingState } from '@/types';

interface ExplainerPanelProps {
  state: OnboardingState;
  isStarting: boolean;
  onConnect: () => void;
  onUseManualKey: () => void;
}

export function ExplainerPanel({
  state,
  isStarting,
  onConnect,
  onUseManualKey,
}: ExplainerPanelProps) {
  return (
    <section className="rounded-2xl border border-white/[0.12] bg-white/[0.04] p-5 sm:p-6">
      <p className="text-[11px] uppercase tracking-[0.22em] text-[#BFFF00]/75">useorgx plugin</p>
      <h2 className="mt-2 text-xl font-semibold text-white">What this plugin unlocks</h2>

      <div className="mt-4 space-y-3 text-sm text-white/75">
        <p>
          Use OrgX orchestration tools directly in OpenClaw with live decisions, model routing, and quality
          gates in one workspace.
        </p>
        <p>
          OrgX receives sync payloads and tool metadata. It does not ingest full terminal history unless your
          workflow explicitly sends it.
        </p>
        <p>
          Next: sign in on web, confirm access, and return. OpenClaw will auto-connect and run first sync.
        </p>
      </div>

      {state.lastError ? (
        <div className="mt-4 rounded-xl border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {state.lastError}
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={onConnect}
          disabled={isStarting}
          className="rounded-full bg-[#BFFF00] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isStarting ? 'Starting...' : 'Connect OrgX'}
        </button>
        <button
          type="button"
          onClick={onUseManualKey}
          className="rounded-full border border-white/[0.2] bg-white/[0.02] px-4 py-2 text-sm text-white/80 transition hover:bg-white/[0.08]"
        >
          Use API key instead
        </button>
      </div>

      <div className="mt-3">
        <a
          href={state.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-white/60 underline underline-offset-4 hover:text-white"
        >
          Deep setup guide
        </a>
      </div>
    </section>
  );
}
