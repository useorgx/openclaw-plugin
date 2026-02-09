import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/shared/Modal';
import { cn } from '@/lib/utils';
import { useByokSettings } from '@/hooks/useByokSettings';

type ProviderId = 'openai' | 'anthropic' | 'openrouter';

const PROVIDERS: Array<{ id: ProviderId; label: string; hint: string; envVar: string }> = [
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'Used for GPT models.',
    envVar: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Used for Claude models.',
    envVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'Used for multi-vendor routing.',
    envVar: 'OPENROUTER_API_KEY',
  },
];

function providerFieldName(provider: ProviderId): 'openaiApiKey' | 'anthropicApiKey' | 'openrouterApiKey' {
  if (provider === 'openai') return 'openaiApiKey';
  if (provider === 'anthropic') return 'anthropicApiKey';
  return 'openrouterApiKey';
}

function providerLabel(provider: ProviderId): string {
  return PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

export function ByokSettingsModal({
  open,
  onClose,
  authToken = null,
  embedMode = false,
}: {
  open: boolean;
  onClose: () => void;
  authToken?: string | null;
  embedMode?: boolean;
}) {
  const byok = useByokSettings({ authToken, embedMode, enabled: open });

  const status = byok.status;
  const health = byok.health;

  const [values, setValues] = useState<Record<ProviderId, string>>({
    openai: '',
    anthropic: '',
    openrouter: '',
  });
  const [dirty, setDirty] = useState<Record<ProviderId, boolean>>({
    openai: false,
    anthropic: false,
    openrouter: false,
  });
  const [revealed, setRevealed] = useState<Record<ProviderId, boolean>>({
    openai: false,
    anthropic: false,
    openrouter: false,
  });
  const [savingProvider, setSavingProvider] = useState<ProviderId | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues({ openai: '', anthropic: '', openrouter: '' });
    setDirty({ openai: false, anthropic: false, openrouter: false });
    setRevealed({ openai: false, anthropic: false, openrouter: false });
    setSavingProvider(null);
    setLocalError(null);
  }, [open]);

  const configuredCount = useMemo(() => {
    if (!status?.ok) return 0;
    return Number(status.providers.openai.configured) +
      Number(status.providers.anthropic.configured) +
      Number(status.providers.openrouter.configured);
  }, [status]);

  const saveProvider = async (provider: ProviderId) => {
    if (!open) return;
    setLocalError(null);
    const value = values[provider].trim();
    if (!dirty[provider]) return;
    if (!value) {
      setLocalError(`Enter a ${providerLabel(provider)} API key or use “Clear” to remove the saved key.`);
      return;
    }

    const field = providerFieldName(provider);
    try {
      setSavingProvider(provider);
      await byok.update({ [field]: value } as any);
      setDirty((prev) => ({ ...prev, [provider]: false }));
      setValues((prev) => ({ ...prev, [provider]: '' }));
      setRevealed((prev) => ({ ...prev, [provider]: false }));
    } finally {
      setSavingProvider(null);
    }
  };

  const clearProvider = async (provider: ProviderId) => {
    setLocalError(null);
    const field = providerFieldName(provider);
    try {
      setSavingProvider(provider);
      await byok.update({ [field]: null } as any);
      setDirty((prev) => ({ ...prev, [provider]: false }));
      setValues((prev) => ({ ...prev, [provider]: '' }));
      setRevealed((prev) => ({ ...prev, [provider]: false }));
    } finally {
      setSavingProvider(null);
    }
  };

  const probe = async () => {
    setLocalError(null);
    await byok.probe();
  };

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-3xl">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-white/[0.06] px-5 py-4 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-[15px] font-semibold text-white">Provider keys</h3>
              <p className="mt-1 text-[12px] leading-relaxed text-white/55">
                Bring your own provider keys. Keys are stored locally and used for OpenClaw agent launches.
              </p>
              {configuredCount === 0 ? (
                <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-amber-200/20 bg-amber-200/10 px-3 py-1 text-[11px] text-amber-100/85">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-amber-200/80" />
                  No keys detected yet. You can also use env vars.
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="chip">
                    {configuredCount} / 3 configured
                  </span>
                  {status?.updatedAt && (
                    <span className="text-[11px] text-white/35">
                      Updated {new Date(status.updatedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.03] text-white/70 transition-colors hover:bg-white/[0.08] hover:text-white"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {(localError || byok.error) && (
            <div className="mb-4 rounded-xl border border-rose-300/20 bg-rose-400/10 p-4 text-[12px] text-rose-100">
              {localError ?? byok.error}
            </div>
          )}

          <div className="mb-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
            <p className="text-[12px] font-semibold text-white/80">Where keys come from</p>
            <p className="mt-1 text-[12px] leading-relaxed text-white/45">
              If you set an env var (e.g. <code className="rounded bg-black/40 px-1">OPENAI_API_KEY</code>), it will be used unless a saved key overrides it.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {PROVIDERS.map((provider) => {
              const providerStatus = status?.providers?.[provider.id];
              const providerHealth = health?.providers?.[provider.id];
              const masked = providerStatus?.masked ?? null;
              const source = providerStatus?.source ?? 'none';
              const hasStoredKey = source === 'stored';
              const isSavingThis = savingProvider === provider.id;
              const canSave = dirty[provider.id] && values[provider.id].trim().length > 0 && !byok.isSaving && !isSavingThis;
              const canClear = hasStoredKey && !byok.isSaving && !isSavingThis;
              const saveLabel = hasStoredKey ? 'Update' : 'Save';

              return (
                <div
                  key={provider.id}
                  className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[13px] font-semibold text-white">{provider.label}</p>
                        <span
                          className={cn(
                            'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]',
                            providerStatus?.configured
                              ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100'
                              : 'border-white/[0.12] bg-white/[0.03] text-white/55'
                          )}
                        >
                          {providerStatus?.configured ? 'Configured' : 'Missing'}
                        </span>
                      </div>
                      <p className="mt-1 text-[12px] text-white/45">
                        {provider.hint}{' '}
                        <span className="text-white/30">
                          Env: <code className="rounded bg-black/40 px-1">{provider.envVar}</code>
                        </span>
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {source !== 'none' && (
                          <span className="chip">
                            source: {source}
                          </span>
                        )}
                        {masked && (
                          <span className="chip">
                            key: {masked}
                          </span>
                        )}
                        {providerHealth && (
                          <span
                            className={cn(
                              'chip',
                              providerHealth.ok ? 'text-emerald-100' : 'text-rose-100'
                            )}
                          >
                            {providerHealth.ok
                              ? `ready (${providerHealth.modelCount ?? 0} models)`
                              : 'not ready'}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setRevealed((prev) => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                        className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08]"
                        title={revealed[provider.id] ? 'Hide key' : 'Show key'}
                      >
                        {revealed[provider.id] ? 'Hide' : 'Show'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void clearProvider(provider.id)}
                        disabled={!canClear}
                        className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
                        title={
                          hasStoredKey
                            ? 'Clear saved key (env vars remain set)'
                            : 'No saved key to clear (using env var or nothing set)'
                        }
                      >
                        Clear
                      </button>
                    </div>
                  </div>

                  <form
                    className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-end"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveProvider(provider.id);
                    }}
                  >
                    <div>
                      <label className="text-[10px] uppercase tracking-[0.12em] text-white/30">
                        API key (stored locally)
                      </label>
                      <input
                        type={revealed[provider.id] ? 'text' : 'password'}
                        value={values[provider.id]}
                        onChange={(e) => {
                          const next = e.target.value;
                          setValues((prev) => ({ ...prev, [provider.id]: next }));
                          setDirty((prev) => ({ ...prev, [provider.id]: true }));
                        }}
                        placeholder={`Paste ${provider.label} key…`}
                        className="mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-[12px] text-white/80 placeholder:text-white/25 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
                        autoComplete="off"
                        spellCheck={false}
                        data-modal-autofocus={provider.id === 'openai' ? 'true' : undefined}
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={!canSave}
                      className={cn(
                        'h-10 rounded-xl px-4 text-[12px] font-semibold transition-all',
                        canSave
                          ? 'bg-[#BFFF00] text-black hover:bg-[#d3ff42]'
                          : 'cursor-not-allowed border border-white/[0.12] bg-white/[0.03] text-white/45'
                      )}
                    >
                      {isSavingThis || byok.isSaving ? 'Saving…' : saveLabel}
                    </button>
                  </form>

                  {providerHealth && !providerHealth.ok && providerHealth.error && (
                    <p className="mt-2 text-[11px] text-rose-100/80">
                      Probe error: {providerHealth.error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="border-t border-white/[0.06] px-5 py-3 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-white/45">
              Readiness check runs <code className="rounded bg-black/40 px-1">openclaw models list</code> per provider.
            </p>
            <button
              type="button"
              onClick={() => void probe()}
              disabled={byok.isProbing}
              className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
            >
              {byok.isProbing ? 'Testing…' : 'Test keys'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
