import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomicSync, writeJsonFileAtomicSync } from "./fs-utils.js";

import type { Logger } from "./mcp-http-handler.js";

const ORGX_LOCAL_MCP_KEY = "orgx-openclaw";
const ORGX_HOSTED_MCP_URL = "https://mcp.useorgx.com/mcp";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseJsonObjectSafe(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function fileModeOrDefault(path: string, fallback: number): number {
  try {
    const stat = statSync(path);
    return stat.mode & 0o777;
  } catch {
    return fallback;
  }
}

function backupPath(path: string): string {
  return `${path}.bak.${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function backupFileSync(path: string, mode: number): string | null {
  try {
    const content = readFileSync(path);
    const next = backupPath(path);
    writeFileAtomicSync(next, content.toString("utf8"), { mode, encoding: "utf8" });
    return next;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stale scoped-entry keys that were previously written to client configs.
// We actively remove these during patching so configs don't accumulate junk.
// ---------------------------------------------------------------------------
const STALE_SCOPED_KEYS = [
  "orgx-openclaw-engineering",
  "orgx-openclaw-product",
  "orgx-openclaw-design",
  "orgx-openclaw-marketing",
  "orgx-openclaw-sales",
  "orgx-openclaw-operations",
  "orgx-openclaw-orchestration",
] as const;

export function patchClaudeMcpConfig(input: {
  current: Record<string, unknown>;
  localMcpUrl: string;
}): { updated: boolean; next: Record<string, unknown> } {
  const currentServers = isRecord(input.current.mcpServers) ? input.current.mcpServers : {};
  const existingOrgx = isRecord(currentServers.orgx) ? currentServers.orgx : {};
  const existingOrgxUrl = typeof existingOrgx.url === "string" ? existingOrgx.url : "";
  const existingOrgxType = typeof existingOrgx.type === "string" ? existingOrgx.type : "";
  const existing = isRecord(currentServers[ORGX_LOCAL_MCP_KEY]) ? currentServers[ORGX_LOCAL_MCP_KEY] : {};
  const priorUrl = typeof existing.url === "string" ? existing.url : "";
  const priorType = typeof existing.type === "string" ? existing.type : "";

  // Ensure hosted OrgX is available alongside the local proxy. Avoid overwriting
  // custom `orgx` entries unless it's clearly redundant (pointing at the same
  // local proxy URL we install under `orgx-openclaw`).
  const shouldSetHostedOrgx =
    !isRecord(currentServers.orgx) ||
    (existingOrgxUrl === input.localMcpUrl && existingOrgxType === "http");

  const nextOrgxEntry: Record<string, unknown> = {
    ...existingOrgx,
    type: "http",
    url: ORGX_HOSTED_MCP_URL,
    description:
      typeof existingOrgx.description === "string" && existingOrgx.description.trim().length > 0
        ? existingOrgx.description
        : "OrgX cloud MCP (OAuth)",
  };

  const nextEntry: Record<string, unknown> = {
    ...existing,
    type: "http",
    url: input.localMcpUrl,
    description:
      typeof existing.description === "string" && existing.description.trim().length > 0
        ? existing.description
        : "OrgX platform via local OpenClaw plugin (no OAuth)",
  };

  const nextServers: Record<string, unknown> = {
    ...currentServers,
    ...(shouldSetHostedOrgx ? { orgx: nextOrgxEntry } : {}),
    [ORGX_LOCAL_MCP_KEY]: nextEntry,
  };

  // Remove stale scoped entries from previous versions.
  let removedStale = false;
  for (const key of STALE_SCOPED_KEYS) {
    if (key in nextServers) {
      delete nextServers[key];
      removedStale = true;
    }
  }

  const next: Record<string, unknown> = {
    ...input.current,
    mcpServers: nextServers,
  };

  const updatedLocal = priorUrl !== input.localMcpUrl || priorType !== "http";
  const updatedHosted =
    shouldSetHostedOrgx &&
    (existingOrgxUrl !== ORGX_HOSTED_MCP_URL || existingOrgxType !== "http");
  const updated = updatedLocal || updatedHosted || removedStale;
  return { updated, next };
}

export function patchCursorMcpConfig(input: {
  current: Record<string, unknown>;
  localMcpUrl: string;
}): { updated: boolean; next: Record<string, unknown> } {
  const currentServers = isRecord(input.current.mcpServers) ? input.current.mcpServers : {};
  const existing = isRecord(currentServers[ORGX_LOCAL_MCP_KEY]) ? currentServers[ORGX_LOCAL_MCP_KEY] : {};
  const priorUrl = typeof existing.url === "string" ? existing.url : "";

  const nextEntry: Record<string, unknown> = {
    ...existing,
    url: input.localMcpUrl,
  };

  const nextServers: Record<string, unknown> = {
    ...currentServers,
    [ORGX_LOCAL_MCP_KEY]: nextEntry,
  };

  // Remove stale scoped entries from previous versions.
  let removedStale = false;
  for (const key of STALE_SCOPED_KEYS) {
    if (key in nextServers) {
      delete nextServers[key];
      removedStale = true;
    }
  }

  const next: Record<string, unknown> = {
    ...input.current,
    mcpServers: nextServers,
  };

  const updated = priorUrl !== input.localMcpUrl || removedStale;
  return { updated, next };
}

function upsertCodexMcpServerSection(input: {
  current: string;
  key: string;
  url: string;
}): { updated: boolean; next: string } {
  const currentText = input.current;
  const lines = currentText.split(/\r?\n/);
  const escapedKey = escapeRegExp(input.key);
  const headerRegex = new RegExp(`^\\[mcp_servers\\.(?:"${escapedKey}"|${escapedKey})\\]\\s*$`);
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRegex.test(lines[i].trim())) {
      headerIndex = i;
      break;
    }
  }

  const urlLine = `url = "${input.url}"`;

  if (headerIndex === -1) {
    const needsQuote = /[^A-Za-z0-9_]/.test(input.key);
    const keyLiteral = needsQuote ? `"${input.key}"` : input.key;
    const suffix = ["", `[mcp_servers.${keyLiteral}]`, urlLine, ""].join("\n");
    const normalized = currentText.endsWith("\n") ? currentText : `${currentText}\n`;
    return { updated: true, next: `${normalized}${suffix}` };
  }

  let sectionEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("[")) {
      sectionEnd = i;
      break;
    }
  }

  let updated = false;
  let urlIndex = -1;
  for (let i = headerIndex + 1; i < sectionEnd; i += 1) {
    if (/^\s*url\s*=/.test(lines[i])) {
      urlIndex = i;
      break;
    }
  }

  if (urlIndex >= 0) {
    if (lines[urlIndex].trim() !== urlLine) {
      lines[urlIndex] = urlLine;
      updated = true;
    }
  } else {
    lines.splice(headerIndex + 1, 0, urlLine);
    updated = true;
    // Recalculate sectionEnd after splice
    sectionEnd = lines.length;
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      if (lines[i].trim().startsWith("[")) {
        sectionEnd = i;
        break;
      }
    }
  }

  // Strip stale stdio-transport fields that conflict with url-only entries.
  // Codex rejects `url` when `command`/`args` are present (stdio transport).
  const staleFieldRegex = /^\s*(command|args|startup_timeout_sec)\s*=/;
  for (let i = sectionEnd - 1; i > headerIndex; i -= 1) {
    if (staleFieldRegex.test(lines[i])) {
      lines.splice(i, 1);
      updated = true;
    }
  }

  return { updated, next: `${lines.join("\n")}\n` };
}

/**
 * Remove an entire `[mcp_servers."<key>"]` section (header + body) from TOML text.
 * Returns { updated, next } — updated is true if the section was found and removed.
 */
function removeCodexMcpServerSection(input: {
  current: string;
  key: string;
}): { updated: boolean; next: string } {
  const lines = input.current.split(/\r?\n/);
  const escapedKey = escapeRegExp(input.key);
  const headerRegex = new RegExp(`^\\[mcp_servers\\.(?:"${escapedKey}"|${escapedKey})\\]\\s*$`);
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRegex.test(lines[i].trim())) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    return { updated: false, next: input.current };
  }

  let sectionEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("[")) {
      sectionEnd = i;
      break;
    }
  }

  // Also remove a leading blank line if present (keeps formatting tidy).
  const start = headerIndex > 0 && lines[headerIndex - 1].trim() === "" ? headerIndex - 1 : headerIndex;
  lines.splice(start, sectionEnd - start);

  return { updated: true, next: `${lines.join("\n")}\n` };
}

export function patchCodexConfigToml(input: {
  current: string;
  localMcpUrl: string;
}): { updated: boolean; next: string } {
  let current = input.current;
  let updated = false;

  // Ensure the hosted OrgX entry uses a direct `url` (streamable HTTP) so that
  // `codex mcp login orgx` can perform OAuth.  Route through upsertCodexMcpServerSection
  // so stale stdio-transport fields (command/args) are stripped automatically.
  const hosted = upsertCodexMcpServerSection({
    current,
    key: "orgx",
    url: ORGX_HOSTED_MCP_URL,
  });
  updated = updated || hosted.updated;
  current = hosted.next;

  const base = upsertCodexMcpServerSection({
    current,
    key: ORGX_LOCAL_MCP_KEY,
    url: input.localMcpUrl,
  });
  updated = updated || base.updated;
  current = base.next;

  // Remove stale scoped entries from previous versions.
  for (const key of STALE_SCOPED_KEYS) {
    const removed = removeCodexMcpServerSection({ current, key });
    updated = updated || removed.updated;
    current = removed.next;
  }

  return { updated, next: current };
}

export async function autoConfigureDetectedMcpClients(input: {
  localMcpUrl: string;
  logger?: Logger;
  homeDir?: string;
}): Promise<{ updatedPaths: string[]; skippedPaths: string[] }> {
  const logger = input.logger ?? {};
  const home = input.homeDir ?? homedir();
  const updatedPaths: string[] = [];
  const skippedPaths: string[] = [];

  const targets: Array<{
    kind: "claude" | "cursor" | "codex";
    path: string;
  }> = [
    { kind: "claude", path: join(home, ".claude", "mcp.json") },
    { kind: "cursor", path: join(home, ".cursor", "mcp.json") },
    { kind: "codex", path: join(home, ".codex", "config.toml") },
  ];

  for (const target of targets) {
    if (!existsSync(target.path)) {
      skippedPaths.push(target.path);
      continue;
    }

    const mode = fileModeOrDefault(target.path, 0o600);

    try {
      if (target.kind === "codex") {
        const current = readFileSync(target.path, "utf8");
        const patched = patchCodexConfigToml({ current, localMcpUrl: input.localMcpUrl });
        if (!patched.updated) {
          skippedPaths.push(target.path);
          continue;
        }
        const backup = backupFileSync(target.path, mode);
        if (!backup) {
          logger.warn?.("[orgx] MCP client autoconfig: backup failed; skipping", {
            path: target.path,
            kind: target.kind,
          });
          skippedPaths.push(target.path);
          continue;
        }
        writeFileAtomicSync(target.path, patched.next, { mode, encoding: "utf8" });
        updatedPaths.push(target.path);
        continue;
      }

      const currentText = readFileSync(target.path, "utf8");
      const current = parseJsonObjectSafe(currentText);
      if (!current) {
        logger.warn?.("[orgx] MCP client autoconfig: invalid JSON; skipping", {
          path: target.path,
          kind: target.kind,
        });
        skippedPaths.push(target.path);
        continue;
      }

      const patched =
        target.kind === "claude"
          ? patchClaudeMcpConfig({ current, localMcpUrl: input.localMcpUrl })
          : patchCursorMcpConfig({ current, localMcpUrl: input.localMcpUrl });

      if (!patched.updated) {
        skippedPaths.push(target.path);
        continue;
      }

      const backup = backupFileSync(target.path, mode);
      if (!backup) {
        logger.warn?.("[orgx] MCP client autoconfig: backup failed; skipping", {
          path: target.path,
          kind: target.kind,
        });
        skippedPaths.push(target.path);
        continue;
      }

      writeJsonFileAtomicSync(target.path, patched.next, mode);
      updatedPaths.push(target.path);
    } catch (err: unknown) {
      logger.warn?.("[orgx] MCP client autoconfig failed; leaving backup in place", {
        path: target.path,
        kind: target.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      skippedPaths.push(target.path);
    }
  }

  if (updatedPaths.length > 0) {
    logger.info?.("[orgx] MCP client autoconfig applied", {
      localMcpUrl: input.localMcpUrl,
      updated: updatedPaths,
    });
  }

  return { updatedPaths, skippedPaths };
}
