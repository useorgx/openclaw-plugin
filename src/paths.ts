import { homedir } from "node:os";
import { join, resolve } from "node:path";

function normalizeDirOverride(value: string | undefined): string | null {
  let trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const startsDoubleQuoted = trimmed.startsWith('"');
  const startsSingleQuoted = trimmed.startsWith("'");
  const endsDoubleQuoted = trimmed.endsWith('"');
  const endsSingleQuoted = trimmed.endsWith("'");
  const startsQuoted = startsDoubleQuoted || startsSingleQuoted;
  const endsQuoted = endsDoubleQuoted || endsSingleQuoted;
  if (startsQuoted !== endsQuoted) return null;
  // Reject mismatched wrappers like `"path'` and `'path"`.
  if ((startsDoubleQuoted && endsSingleQuoted) || (startsSingleQuoted && endsDoubleQuoted)) {
    return null;
  }
  // `.env` values are often quoted; normalize them before validation.
  if (
    (startsDoubleQuoted && endsDoubleQuoted) ||
    (startsSingleQuoted && endsSingleQuoted)
  ) {
    trimmed = trimmed.slice(1, -1).trim();
    if (!trimmed) return null;
  }
  // Reject control characters to avoid malformed or ambiguous filesystem paths.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  // Reject common escaped/encoded null-byte sequences as well.
  if (/\\0|\\x00|\\u0000|%00/i.test(trimmed)) return null;
  return trimmed;
}

function resolveOverridePath(override: string): string {
  if (override === "~") return homedir();
  if (override.startsWith("~/") || override.startsWith("~\\")) {
    return resolve(homedir(), override.slice(2));
  }
  return resolve(override);
}

/**
 * Root directory for persistent OrgX plugin files.
 *
 * Default: `~/.config/useorgx/openclaw-plugin`
 * Override: `ORGX_OPENCLAW_PLUGIN_CONFIG_DIR`
 */
export function getOrgxPluginConfigDir(): string {
  const override = normalizeDirOverride(process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR);
  if (override) return resolveOverridePath(override);
  return join(homedir(), ".config", "useorgx", "openclaw-plugin");
}

export function getOrgxPluginConfigPath(filename: string): string {
  return join(getOrgxPluginConfigDir(), filename);
}

/**
 * Root directory for OpenClaw local files.
 *
 * Default: `~/.openclaw`
 * Override: `OPENCLAW_HOME`
 */
export function getOpenClawDir(): string {
  const override = normalizeDirOverride(process.env.OPENCLAW_HOME);
  if (override) return resolveOverridePath(override);
  return join(homedir(), ".openclaw");
}

/**
 * Root directory for the OrgX outbox queue.
 *
 * Default: `~/.openclaw/orgx-outbox`
 * Override: `ORGX_OUTBOX_DIR`
 */
export function getOrgxOutboxDir(): string {
  const override = normalizeDirOverride(process.env.ORGX_OUTBOX_DIR);
  if (override) return resolveOverridePath(override);
  return join(getOpenClawDir(), "orgx-outbox");
}
