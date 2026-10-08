import { useEffect, useState, type ReactNode } from 'react';

export function GatewaySignIn({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch('/orgx/api/onboarding/status').then(response => {
      if (response.ok) setReady(true);
    });
  }, []);
  if (ready) return children;
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--ox-bg)] px-4 text-[var(--ox-text)]">
      <form className="w-full max-w-md rounded-xl border border-[var(--ox-border)] bg-[var(--ox-panel-solid)] p-6" onSubmit={async event => {
        event.preventDefault();
        setBusy(true);
        setError('');
        try {
          const response = await fetch('/orgx/api/gateway-session', {
            method: 'POST', headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok) throw new Error('Check your OpenClaw gateway token and try again.');
          setToken('');
          setReady(true);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Sign-in failed. Try again.');
        } finally { setBusy(false); }
      }}>
        <h1 className="text-lg font-semibold">Sign in to OrgX Live</h1>
        <label className="mt-4 block text-sm" htmlFor="gateway-token">OpenClaw gateway token</label>
        <input id="gateway-token" type="password" autoComplete="off" required value={token} onChange={event => setToken(event.target.value)} className="mt-2 min-h-11 w-full rounded-lg border border-[var(--ox-border)] bg-transparent px-3" />
        {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
        <button disabled={busy} className="mt-4 min-h-11 w-full rounded-lg bg-[var(--ox-lime)] px-4 text-black">{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
