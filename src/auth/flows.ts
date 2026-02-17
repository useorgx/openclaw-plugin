export function isAuthRequiredError(result: {
  status: number;
  error: string;
}): boolean {
  if (result.status !== 401) {
    return false;
  }
  return /auth|unauthorized|token/i.test(result.error);
}

export function buildManualKeyConnectUrl(baseApiUrl: string): string {
  try {
    // Deep-link into the Security section where API keys live.
    return new URL("/settings#security", baseApiUrl).toString();
  } catch {
    return "https://www.useorgx.com/settings#security";
  }
}

export async function fetchOrgxJson<T>(input: {
  baseApiUrl: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  options?: { timeoutMs?: number };
  toErrorMessage: (err: unknown) => string;
}): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const controller = new AbortController();
    const timeoutMs =
      typeof input.options?.timeoutMs === "number" &&
      Number.isFinite(input.options.timeoutMs)
        ? Math.max(1_000, Math.floor(input.options.timeoutMs))
        : 12_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    let rawText = "";
    try {
      response = await fetch(`${input.baseApiUrl}${input.path}`, {
        method: input.method,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: input.body ? JSON.stringify(input.body) : undefined,
      });
      rawText = await response.text().catch(() => "");
    } finally {
      clearTimeout(timeout);
    }

    const payload = ((): { ok?: boolean; data?: T; error?: unknown; message?: string } | null => {
      if (!rawText) return null;
      try {
        return JSON.parse(rawText) as {
          ok?: boolean;
          data?: T;
          error?: unknown;
          message?: string;
        };
      } catch {
        return null;
      }
    })();

    if (!response.ok) {
      const rawError = payload?.error ?? payload?.message;
      let errorMessage: string;
      if (typeof rawError === "string") {
        errorMessage = rawError;
      } else if (
        rawError &&
        typeof rawError === "object" &&
        "message" in rawError &&
        typeof (rawError as Record<string, unknown>).message === "string"
      ) {
        errorMessage = (rawError as Record<string, unknown>).message as string;
      } else if (rawText && rawText.trim().length > 0) {
        // Avoid dumping HTML (Cloudflare / Next.js error pages) into UI; keep it short.
        const sanitized = rawText
          .replace(/\s+/g, " ")
          .replace(/<[^>]+>/g, "")
          .trim();
        errorMessage =
          sanitized.length > 0
            ? sanitized.slice(0, 180)
            : `OrgX request failed (${response.status})`;
      } else {
        errorMessage = `OrgX request failed (${response.status})`;
      }

      const statusToken = `HTTP ${response.status}`;
      if (
        response.status &&
        !errorMessage.toLowerCase().includes(statusToken.toLowerCase()) &&
        !errorMessage.includes(`(${response.status})`)
      ) {
        errorMessage = `${errorMessage} (HTTP ${response.status})`;
      }

      const debugParts: string[] = [];
      const requestId = response.headers.get("x-request-id");
      const vercelId = response.headers.get("x-vercel-id");
      const cfRay = response.headers.get("cf-ray");
      const clerkStatus = response.headers.get("x-clerk-auth-status");
      const clerkReason = response.headers.get("x-clerk-auth-reason");

      if (requestId) debugParts.push(`req=${requestId}`);
      if (vercelId && vercelId !== requestId) debugParts.push(`vercel=${vercelId}`);
      if (cfRay) debugParts.push(`cf-ray=${cfRay}`);
      if (clerkStatus) debugParts.push(`clerk=${clerkStatus}`);
      if (clerkReason) debugParts.push(`clerk_reason=${clerkReason}`);

      const debugSuffix = debugParts.length > 0 ? ` (${debugParts.join(", ")})` : "";

      return {
        ok: false,
        status: response.status,
        error: `${errorMessage}${debugSuffix}`,
      };
    }

    if (payload?.data !== undefined) {
      return { ok: true, data: payload.data };
    }

    if (payload !== null) {
      return { ok: true, data: payload as unknown as T };
    }

    return { ok: true, data: rawText as unknown as T };
  } catch (err: unknown) {
    const message =
      err &&
      typeof err === "object" &&
      "name" in err &&
      (err as { name?: string }).name === "AbortError"
        ? `OrgX request timed out (method=${input.method}, path=${input.path})`
        : input.toErrorMessage(err);
    return { ok: false, status: 0, error: message };
  }
}
