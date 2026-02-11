import { homedir } from "node:os";
import { join, resolve } from "node:path";

function normalizeDirOverride(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.includes("\0")) return null;
  return trimmed;
}

/**
 * Root directory for persistent OrgX plugin files.
 *
 * Default: `~/.config/useorgx/openclaw-plugin`
 * Override: `ORGX_OPENCLAW_PLUGIN_CONFIG_DIR`
 */
export function getOrgxPluginConfigDir(): string {
  const override = normalizeDirOverride(process.env.ORGX_OPENCLAW_PLUGIN_CONFIG_DIR);
  if (override) return resolve(override);
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
  if (override) return resolve(override);
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
  if (override) return resolve(override);
  return join(getOpenClawDir(), "orgx-outbox");
}

