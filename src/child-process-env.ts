export type ProcessEnv = Record<string, string | undefined>;

export const GATEWAY_SECRET_ENV_KEYS = [
  "ORGX_API_KEY",
  "ORGX_GATEWAY_KEY",
] as const;

export function sanitizedChildProcessEnv(
  base: ProcessEnv,
  overrides: ProcessEnv = {}
): ProcessEnv {
  const childEnv = { ...base, ...overrides };
  for (const key of GATEWAY_SECRET_ENV_KEYS) delete childEnv[key];
  return childEnv;
}
