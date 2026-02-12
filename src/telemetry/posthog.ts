const POSTHOG_DEFAULT_API_KEY =
  "phc_s4KPgkYEFZgvkMYw4zXG41H5FN6haVwbEWPYHfNjxOc";
const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "y":
    case "on":
      return true;
    default:
      return false;
  }
}

export function isOrgxTelemetryDisabled(): boolean {
  return (
    isTruthyEnv(process.env.ORGX_TELEMETRY_DISABLED) ||
    isTruthyEnv(process.env.OPENCLAW_TELEMETRY_DISABLED) ||
    isTruthyEnv(process.env.POSTHOG_DISABLED)
  );
}

export function resolvePosthogApiKey(): string | null {
  const fromEnv =
    process.env.ORGX_POSTHOG_API_KEY ??
    process.env.POSTHOG_API_KEY ??
    process.env.ORGX_POSTHOG_KEY ??
    process.env.POSTHOG_KEY ??
    "";

  const trimmed = fromEnv.trim();
  if (trimmed) return trimmed;

  return POSTHOG_DEFAULT_API_KEY;
}

export function resolvePosthogHost(): string {
  const fromEnv =
    process.env.ORGX_POSTHOG_HOST ??
    process.env.POSTHOG_HOST ??
    process.env.ORGX_POSTHOG_API_HOST ??
    process.env.POSTHOG_API_HOST ??
    "";

  const trimmed = fromEnv.trim();
  return trimmed || POSTHOG_DEFAULT_HOST;
}

function toPosthogBatchUrl(host: string): string {
  try {
    return new URL("/batch/", host).toString();
  } catch {
    return `${POSTHOG_DEFAULT_HOST}/batch/`;
  }
}

export async function posthogCapture(input: {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}): Promise<void> {
  if (isOrgxTelemetryDisabled()) return;

  const apiKey = resolvePosthogApiKey();
  if (!apiKey) return;

  const url = toPosthogBatchUrl(resolvePosthogHost());

  const now = new Date().toISOString();
  const body = {
    api_key: apiKey,
    batch: [
      {
        type: "capture",
        event: input.event,
        distinct_id: input.distinctId,
        properties: {
          $lib: "orgx-openclaw-plugin",
          ...(input.properties ?? {}),
        },
        timestamp: now,
      },
    ],
    sent_at: now,
  };

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(() => undefined);
}

