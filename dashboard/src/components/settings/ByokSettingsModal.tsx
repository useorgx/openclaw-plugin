import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/shared/Modal';
import { cn } from '@/lib/utils';
import { useByokSettings } from '@/hooks/useByokSettings';

type ProviderId = 'openai' | 'anthropic' | 'openrouter';

const PROVIDERS: Array<{ id: ProviderId; label: string; hint: string }> = [
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'Used for GPT models. Env: OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    hint: 'Used for Claude models. Env: ANTHROPIC_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    hint: 'Used for multi-vendor routing. Env: OPENROUTER_API_KEY',
  },
];

function providerFieldName(provider: ProviderId): 'openaiApiKey' | 'anthropicApiKey' | 'openrouterApiKey' {
  if (provider === 'openai') return 'openaiApiKey';
  if (provider === 'anthropic') return 'anthropicApiKey';
  return 'openrouterApiKey';
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
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValues({ openai: '', anthropic: '', openrouter: '' });
    setDirty({ openai: false, anthropic: false, openrouter: false });
    setLocalError(null);
  }, [open]);

  const configuredCount = useMemo(() => {
    if (!status?.ok) return 0;
    return Number(status.providers.openai.configured) +
      Number(status.providers.anthropic.configured) +
      Number(status.providers.openrouter.configured);
  }, [status]);

  const save = async () => {
    if (!open) return;
    setLocalError(null);

    const payload: Record<string, unknown> = {};
    for (const provider of PROVIDERS) {
      if (!dirty[provider.id]) continue;
      const value = values[provider.id].trim();
      if (!value) {
        setLocalError(`Enter a ${provider.label} API key or use “Clear” to remove the saved key.`);
        return;
      }
      payload[providerFieldName(provider.id)] = value;
    }

    if (Object.keys(payload).length === 0) {
      setLocalError('No changes to save.');
      return;
    }

    await byok.update(payload as any);
    setDirty({ openai: false, anthropic: false, openrouter: false });
    setValues({ openai: '', anthropic: '', openrouter: '' });
  };

  const clearProvider = async (provider: ProviderId) => {
    setLocalError(null);
    const field = providerFieldName(provider);
    await byok.update({ [field]: null } as any);
    setDirty((prev) => ({ ...prev, [provider]: false }));
    setValues((prev) => ({ ...prev, [provider]: '' }));
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
              <h3 className="text-[14px] font-semibold text-white">Provider Keys (BYOK)</h3>
              <p className="mt-1 text-[12px] text-white/55">
                Save your model provider API keys locally so OpenClaw agent launches can run without extra setup.
              </p>
              {configuredCount === 0 ? (
                <p className="mt-2 text-[11px] text-amber-200/80">
                  No provider keys detected yet. You can also set these via environment variables.
                </p>
              ) : (
                <p className="mt-2 text-[11px] text-white/45">
                  Detected {configuredCount} / 3 configured providers.
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[12px] text-white/60 hover:bg-white/[0.08] hover:text-white"
            >
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {(localError || byok.error) && (
            <div className="mb-4 rounded-xl border border-rose-300/20 bg-rose-400/10 p-4 text-[12px] text-rose-100">
              {localError ?? byok.error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3">
            {PROVIDERS.map((provider) => {
              const providerStatus = status?.providers?.[provider.id];
              const providerHealth = health?.providers?.[provider.id];
              const masked = providerStatus?.masked ?? null;

              return (
                <div
                  key={provider.id}
                  className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[13px] font-semibold text-white">{provider.label}</p>
                      <p className="mt-1 text-[11px] text-white/45">{provider.hint}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
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
                        {providerStatus?.source && providerStatus.source !== 'none' && (
                          <span className="chip">source: {providerStatus.source}</span>
                        )}
                        {masked && (
                          <span className="chip">key: {masked}</span>
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

                    <button
                      type="button"
                      onClick={() => void clearProvider(provider.id)}
                      disabled={byok.isSaving}
                      className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
                      title="Clear saved key (does not unset environment variables)"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                    <div>
                      <label className="text-[10px] uppercase tracking-[0.12em] text-white/30">
                        Paste key (stored locally)
                      </label>
                      <input
                        type="password"
                        value={values[provider.id]}
                        onChange={(e) => {
                          const next = e.target.value;
                          setValues((prev) => ({ ...prev, [provider.id]: next }));
                          setDirty((prev) => ({ ...prev, [provider.id]: true }));
                        }}
                        placeholder={`Enter ${provider.label} API key…`}
                        className="mt-1 w-full rounded-xl border border-white/[0.1] bg-black/30 px-3 py-2 text-[12px] text-white/80 placeholder:text-white/25 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/30"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={byok.isSaving}
                      className="h-10 rounded-xl bg-[#BFFF00] px-4 text-[12px] font-semibold text-black transition-all hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {byok.isSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>

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
