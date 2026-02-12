import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomicSync, writeJsonFileAtomicSync } from "./fs-utils.js";

import type { Logger } from "./mcp-http-handler.js";

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

export function patchClaudeMcpConfig(input: {
  current: Record<string, unknown>;
  localMcpUrl: string;
}): { updated: boolean; next: Record<string, unknown> } {
  const currentServers = isRecord(input.current.mcpServers) ? input.current.mcpServers : {};
  const currentOrgx = isRecord(currentServers.orgx) ? currentServers.orgx : {};
  const priorUrl = typeof currentOrgx.url === "string" ? currentOrgx.url : "";
  const priorType = typeof currentOrgx.type === "string" ? currentOrgx.type : "";

  const nextOrgx: Record<string, unknown> = {
    ...currentOrgx,
    type: "http",
    url: input.localMcpUrl,
    description:
      typeof currentOrgx.description === "string" && currentOrgx.description.trim().length > 0
        ? currentOrgx.description
        : "OrgX platform via local OpenClaw plugin (no OAuth)",
  };

  const nextServers: Record<string, unknown> = {
    ...currentServers,
    orgx: nextOrgx,
  };

  const next: Record<string, unknown> = {
    ...input.current,
    mcpServers: nextServers,
  };

  const updated = priorUrl !== input.localMcpUrl || priorType !== "http";
  return { updated, next };
}

export function patchCursorMcpConfig(input: {
  current: Record<string, unknown>;
  localMcpUrl: string;
}): { updated: boolean; next: Record<string, unknown> } {
  const currentServers = isRecord(input.current.mcpServers) ? input.current.mcpServers : {};
  const key = "orgx-openclaw";
  const existing = isRecord(currentServers[key]) ? currentServers[key] : {};
  const priorUrl = typeof existing.url === "string" ? existing.url : "";

  const nextEntry: Record<string, unknown> = {
    ...existing,
    url: input.localMcpUrl,
  };

  const nextServers: Record<string, unknown> = {
    ...currentServers,
    [key]: nextEntry,
  };

  const next: Record<string, unknown> = {
    ...input.current,
    mcpServers: nextServers,
  };

  const updated = priorUrl !== input.localMcpUrl;
  return { updated, next };
}

export function patchCodexConfigToml(input: {
  current: string;
  localMcpUrl: string;
}): { updated: boolean; next: string } {
  const lines = input.current.split(/\r?\n/);
  const headerRegex = /^\[mcp_servers\.(?:orgx|"orgx")\]\s*$/;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRegex.test(lines[i].trim())) {
      headerIndex = i;
      break;
    }
  }

  const urlLine = `url = "${input.localMcpUrl}"`;

  if (headerIndex === -1) {
    const suffix = [
      "",
      "[mcp_servers.orgx]",
      urlLine,
      "",
    ].join("\n");
    const normalized = input.current.endsWith("\n") ? input.current : `${input.current}\n`;
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
  }

  return { updated, next: `${lines.join("\n")}\n` };
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
