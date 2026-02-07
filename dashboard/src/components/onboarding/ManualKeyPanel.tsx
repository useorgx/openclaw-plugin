import { useState } from 'react';

interface ManualKeyPanelProps {
  isSubmitting: boolean;
  onSubmit: (apiKey: string, userId?: string) => Promise<unknown>;
  onBack: () => void;
}

export function ManualKeyPanel({ isSubmitting, onSubmit, onBack }: ManualKeyPanelProps) {
  const [apiKey, setApiKey] = useState('');
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('API key is required.');
      return;
    }

    try {
      await onSubmit(trimmed, userId.trim() || undefined);
      setApiKey('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to validate API key.');
    }
  };

  return (
    <section className="rounded-2xl border border-white/[0.12] bg-black/30 p-5 sm:p-6">
      <h3 className="text-lg font-semibold text-white">Manual API key fallback</h3>
      <p className="mt-2 text-sm text-white/70">
        Browser pairing is recommended. If needed, paste a key from useorgx.com settings and validate now.
      </p>

      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-[0.14em] text-white/55">OrgX API key</span>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="oxk_..."
            className="w-full rounded-xl border border-white/[0.14] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none transition focus:border-[#BFFF00]/70"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs uppercase tracking-[0.14em] text-white/55">User ID (optional)</span>
          <input
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="user_..."
            className="w-full rounded-xl border border-white/[0.14] bg-white/[0.03] px-3 py-2 text-sm text-white outline-none transition focus:border-[#BFFF00]/70"
          />
        </label>
      </div>

      {error ? (
        <div className="mt-3 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={submit}
          disabled={isSubmitting}
          className="rounded-full bg-[#BFFF00] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isSubmitting ? 'Validating...' : 'Validate and Connect'}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-full border border-white/[0.2] bg-white/[0.02] px-4 py-2 text-sm text-white/80 transition hover:bg-white/[0.08]"
        >
          Back to pairing
        </button>
      </div>
    </section>
  );
}
