import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
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

type RunPreviewProvider = {
  id: ProviderId;
  label: string;
  configured: boolean;
  source: string;
  pending: 'save' | 'none';
};

function ByokSubspace({
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
    <section className="grid gap-3">
      <div>
        <p className="text-micro uppercase tracking-[0.12em] text-[#D8FFA1]/80">{step}</p>
        <h4 className="mt-1 text-heading font-semibold text-white">{title}</h4>
        <p className="mt-1 text-caption leading-relaxed text-secondary">{description}</p>
      </div>
      {children}
    </section>
  );
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

  const runPreview = useMemo(() => {
    const providers: RunPreviewProvider[] = PROVIDERS.map((provider) => {
      const providerStatus = status?.providers?.[provider.id];
      const pendingSave = dirty[provider.id] && values[provider.id].trim().length > 0;
      return {
        id: provider.id,
        label: provider.label,
        configured: pendingSave || Boolean(providerStatus?.configured),
        source: pendingSave ? 'pending stored key' : providerStatus?.source ?? 'none',
        pending: pendingSave ? 'save' : 'none',
      };
    });

    const activeProviders = providers.filter((provider) => provider.configured);
    const summary =
      activeProviders.length === 0
        ? 'Run preview: launch blocked until at least one provider key is configured.'
        : activeProviders.length === 1
          ? `Run preview: launches with ${activeProviders[0]?.label} as the only provider.`
          : `Run preview: launches with ${activeProviders.length} providers available for routing.`;

    return { providers, activeProviders, summary };
  }, [dirty, status, values]);

  const readinessMetrics = useMemo(() => {
    const readyProviders = PROVIDERS.filter((provider) => {
      const providerHealth = health?.providers?.[provider.id];
      return Boolean(providerHealth?.ok);
    }).length;

    const pendingSaves = PROVIDERS.filter((provider) => {
      return dirty[provider.id] && values[provider.id].trim().length > 0;
    }).length;

    return {
      readyProviders,
      pendingSaves,
    };
  }, [dirty, health?.providers, values]);

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
    <div className="flex min-h-0 flex-col gap-7">
      <div className="mb-4">
        <h3 className="text-heading font-semibold text-white">Provider keys</h3>
        <p className="mt-1 text-body leading-relaxed text-secondary">
          Bring your own provider keys. Keys are stored locally and used for agent launches.
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
        <div className="rounded-xl border border-rose-300/20 bg-rose-400/10 p-4 text-body text-rose-100">
          {localError ?? byok.error}
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
          <p className="text-micro uppercase tracking-[0.12em] text-muted">Step 1</p>
          <p className="mt-1 text-caption font-semibold text-primary">Review source policy</p>
        </div>
        <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
          <p className="text-micro uppercase tracking-[0.12em] text-muted">Step 2</p>
          <p className="mt-1 text-caption font-semibold text-primary">Save provider keys</p>
        </div>
        <div className="rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2">
          <p className="text-micro uppercase tracking-[0.12em] text-muted">Step 3</p>
          <p className="mt-1 text-caption font-semibold text-primary">Probe run readiness</p>
        </div>
      </div>

      <ByokSubspace
        step="Subspace 01"
        title="Source policy + readiness"
        description="Environment variables remain fallback defaults. Saved keys override env values per provider."
      >
        <div className="rounded-2xl border border-subtle bg-white/[0.02] p-4">
          <p className="text-body font-semibold text-primary">Where keys come from</p>
          <p className="mt-1 text-body leading-relaxed text-secondary">
            If you set an env var (e.g.{' '}
            <code className="rounded bg-black/40 px-1">OPENAI_API_KEY</code>), it will be used unless a saved key overrides it.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Configured keys</p>
              <p className="mt-1 text-heading font-semibold text-white">{configuredCount} / 3</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Ready providers</p>
              <p className="mt-1 text-heading font-semibold text-white">{readinessMetrics.readyProviders}</p>
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2.5">
              <p className="text-micro uppercase tracking-[0.12em] text-muted">Pending saves</p>
              <p className="mt-1 text-heading font-semibold text-white">{readinessMetrics.pendingSaves}</p>
            </div>
          </div>
        </div>
      </ByokSubspace>

      <ByokSubspace
        step="Subspace 02"
        title="Agent run preview"
        description="A dry operational read on launch viability based on current + pending credentials."
      >
        <div className="rounded-2xl border border-lime/20 bg-lime/[0.05] p-4">
          <p className="text-body font-semibold text-[#D8FFA1]">{runPreview.summary}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {runPreview.providers.map((provider) => (
              <div key={provider.id} className="rounded-xl border border-white/[0.08] bg-black/20 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption font-semibold text-primary">{provider.label}</span>
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-micro uppercase tracking-[0.12em]',
                      provider.configured
                        ? 'border-lime/30 bg-lime/[0.14] text-[#D8FFA1]'
                        : 'border-white/[0.14] bg-white/[0.04] text-secondary'
                    )}
                  >
                    {provider.configured ? 'Available' : 'Missing'}
                  </span>
                </div>
                <p className="mt-1 text-caption text-muted">
                  Source: {provider.source}
                  {provider.pending === 'save' ? ' (pending save)' : ''}
                </p>
              </div>
            ))}
          </div>
        </div>
      </ByokSubspace>

      <ByokSubspace
        step="Subspace 03"
        title="Provider slots"
        description="Each slot is independent: enter key, save/clear, then probe readiness."
      >
        <div className="grid grid-cols-1 gap-4">
          {PROVIDERS.map((provider, index) => {
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
            <motion.div
              key={provider.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(index, 5) * 0.03, duration: 0.2 }}
              className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] pb-3">
                <div>
                  <p className="text-micro uppercase tracking-[0.12em] text-[#D8FFA1]/80">
                    Slot {index + 1}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
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

              <form
                className="mt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveProvider(provider.id);
                }}
              >
                <input
                  type="text"
                  name={`provider-user-${provider.id}`}
                  autoComplete="username"
                  value={`${provider.id}-key`}
                  readOnly
                  tabIndex={-1}
                  aria-hidden="true"
                  className="sr-only"
                />
                <label className="block" htmlFor={`provider-key-${provider.id}`}>
                  <span className="mb-1.5 block text-caption font-medium uppercase tracking-[0.14em] text-muted">
                    API key (stored locally)
                  </span>
                  <input
                    id={`provider-key-${provider.id}`}
                    name={`provider-key-${provider.id}`}
                    value={values[provider.id]}
                    onChange={(event) => {
                      setValues((prev) => ({ ...prev, [provider.id]: event.target.value }));
                      setDirty((prev) => ({ ...prev, [provider.id]: true }));
                      if (localError) setLocalError(null);
                    }}
                    type={revealed[provider.id] ? 'text' : 'password'}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={`Paste ${provider.label} key`}
                    className="w-full rounded-xl border border-white/[0.08] bg-black/30 px-3 py-2.5 font-mono text-body text-primary placeholder:text-faint focus:border-[#BFFF00]/40 focus:outline-none"
                  />
                </label>

                <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/[0.06] pt-3">
                  <button
                    type="submit"
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
                    {dirty[provider.id] ? 'Unsaved changes' : 'Saved'}
                  </span>
                </div>
              </form>
            </motion.div>
          );
          })}
        </div>
      </ByokSubspace>
    </div>
  );
}
