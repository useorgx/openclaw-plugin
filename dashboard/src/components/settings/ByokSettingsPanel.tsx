import { useEffect, useMemo, useState } from 'react';
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

function providerFieldName(
  provider: ProviderId
): 'openaiApiKey' | 'anthropicApiKey' | 'openrouterApiKey' {
  if (provider === 'openai') return 'openaiApiKey';
  if (provider === 'anthropic') return 'anthropicApiKey';
  return 'openrouterApiKey';
}

function providerLabel(provider: ProviderId): string {
  return PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

export function ByokSettingsPanel({
  authToken = null,
  embedMode = false,
  enabled = true,
}: {
  authToken?: string | null;
  embedMode?: boolean;
  enabled?: boolean;
}) {
  const byok = useByokSettings({ authToken, embedMode, enabled });

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
    if (!enabled) return;
    setValues({ openai: '', anthropic: '', openrouter: '' });
    setDirty({ openai: false, anthropic: false, openrouter: false });
    setRevealed({ openai: false, anthropic: false, openrouter: false });
    setSavingProvider(null);
    setLocalError(null);
  }, [enabled]);

  const configuredCount = useMemo(() => {
    if (!status?.ok) return 0;
    return (
      Number(status.providers.openai.configured) +
      Number(status.providers.anthropic.configured) +
      Number(status.providers.openrouter.configured)
    );
  }, [status]);

  const saveProvider = async (provider: ProviderId) => {
    if (!enabled) return;
    setLocalError(null);
    const value = values[provider].trim();
    if (!dirty[provider]) return;
    if (!value) {
      setLocalError(
        `Enter a ${providerLabel(provider)} API key or use "Clear" to remove the saved key.`
      );
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
    <div className="flex min-h-0 flex-col">
      <div className="mb-4">
        <h3 className="text-heading font-semibold text-white">Provider keys</h3>
        <p className="mt-1 text-body leading-relaxed text-secondary">
          Bring your own provider keys. Keys are stored locally and used for OpenClaw agent launches.
        </p>
        {configuredCount === 0 ? (
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-amber-200/20 bg-amber-200/10 px-3 py-1 text-caption text-amber-100/85">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-amber-200/80" />
            No keys detected yet. You can also use env vars.
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="chip">{configuredCount} / 3 configured</span>
            {status?.updatedAt && (
              <span className="text-caption text-muted">
                Updated {new Date(status.updatedAt).toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>

      {(localError || byok.error) && (
        <div className="mb-4 rounded-xl border border-rose-300/20 bg-rose-400/10 p-4 text-body text-rose-100">
          {localError ?? byok.error}
        </div>
      )}

      <div className="mb-4 rounded-2xl border border-subtle bg-white/[0.02] p-4">
        <p className="text-body font-semibold text-primary">Where keys come from</p>
        <p className="mt-1 text-body leading-relaxed text-secondary">
          If you set an env var (e.g.{' '}
          <code className="rounded bg-black/40 px-1">OPENAI_API_KEY</code>), it will be used unless a saved key overrides it.
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
          const canSave =
            dirty[provider.id] &&
            values[provider.id].trim().length > 0 &&
            !byok.isSaving &&
            !isSavingThis;
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
                    <p className="text-body font-semibold text-white">{provider.label}</p>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-micro uppercase tracking-[0.12em]',
                        providerStatus?.configured
                          ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100'
                          : 'border-strong bg-white/[0.03] text-secondary'
                      )}
                    >
                      {providerStatus?.configured ? 'Configured' : 'Missing'}
                    </span>
                  </div>
                  <p className="mt-1 text-body text-secondary">
                    {provider.hint}{' '}
                    <span className="text-muted">
                      Env: <code className="rounded bg-black/40 px-1">{provider.envVar}</code>
                    </span>
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {source !== 'none' && <span className="chip">source: {source}</span>}
                    {masked && <span className="chip">key: {masked}</span>}
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
                    onClick={() =>
                      setRevealed((prev) => ({
                        ...prev,
                        [provider.id]: !prev[provider.id],
                      }))
                    }
                    className="rounded-lg border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08]"
                    title={revealed[provider.id] ? 'Hide key' : 'Show key'}
                  >
                    {revealed[provider.id] ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void probe()}
                    className="rounded-lg border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08]"
                    title="Probe configured models"
                  >
                    Probe
                  </button>
                </div>
              </div>

              <div className="mt-3">
                <label className="block">
                  <span className="mb-1.5 block text-caption font-medium uppercase tracking-[0.14em] text-muted">
                    API key (stored locally)
                  </span>
                  <input
                    value={values[provider.id]}
                    onChange={(event) => {
                      setValues((prev) => ({ ...prev, [provider.id]: event.target.value }));
                      setDirty((prev) => ({ ...prev, [provider.id]: true }));
                      if (localError) setLocalError(null);
                    }}
                    type={revealed[provider.id] ? 'text' : 'password'}
                    placeholder={`Paste ${provider.label} key`}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2.5 font-mono text-body text-primary placeholder:text-faint focus:border-[#BFFF00]/40 focus:outline-none"
                  />
                </label>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void saveProvider(provider.id)}
                    disabled={!canSave}
                    className="rounded-full bg-[#BFFF00] px-4 py-2 text-body font-semibold text-black transition-colors hover:bg-[#d3ff42] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isSavingThis ? 'Saving...' : saveLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => void clearProvider(provider.id)}
                    disabled={!canClear}
                    className="rounded-full border border-strong bg-white/[0.03] px-4 py-2 text-body font-semibold text-primary transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    Clear stored
                  </button>
                  <span className="text-caption text-muted">
                    {dirty[provider.id] ? 'Unsaved changes' : ' '}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

