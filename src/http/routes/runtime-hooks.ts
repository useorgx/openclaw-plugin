import { backupCorruptFileSync, writeFileAtomicSync } from "../../fs-utils.js";
import { readOpenClawGatewayPort, readOpenClawSettingsSnapshot } from "../../openclaw-settings.js";
import { getOrgxPluginConfigDir } from "../../paths.js";
import type { RuntimeHookPayload } from "../../runtime-instance-store.js";
import type { Router } from "../router.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

type RuntimeStreamSubscriber = {
  id: string;
  write: (chunk: Buffer) => boolean;
  end: () => void;
};

type RuntimeInstanceLike = {
  id: string;
  state: string;
  event: string;
  displayName: string;
  lastHeartbeatAt: string | null;
  lastEventAt: string;
  runId: string | null;
  correlationId: string | null;
  initiativeId: string | null;
  sourceClient: string;
  taskId: string | null;
  workstreamId: string | null;
  progressPct: number | null;
  metadata: Record<string, unknown> | null;
};

type RegisterRuntimeHookRoutesDeps<TReq, TRes> = {
  parseJsonRequest: (req: TReq) => Promise<JsonRecord>;
  pickString: (record: Record<string, unknown>, keys: string[]) => string | null;
  pickNumber: (record: Record<string, unknown>, keys: string[]) => number | null;
  pickHeaderString: (
    headers: Record<string, string | string[] | undefined>,
    names: string[]
  ) => string | null;
  resolveRuntimeHookToken: () => string;
  maskSecret: (value: string | null) => string | null;
  parseJsonSafe: <T>(value: string) => T | null;
  sendJson: (res: TRes, status: number, payload: unknown) => void;
  safeErrorMessage: (err: unknown) => string;
  randomUUID: () => string;
  listRuntimeInstances: (input: { limit: number }) => unknown;
  writeRuntimeSseEvent: (
    subscriber: RuntimeStreamSubscriber,
    event: string,
    payload: unknown
  ) => void;
  runtimeStreamSubscribers: Map<string, RuntimeStreamSubscriber>;
  ensureRuntimeStreamTimers: () => void;
  stopRuntimeStreamTimers: () => void;
  upsertRuntimeInstanceFromHook: (payload: RuntimeHookPayload) => RuntimeInstanceLike;
  broadcastRuntimeSse: (event: string, payload: unknown) => void;
  clearSnapshotResponseCache: () => void;
  normalizeHookPhase: (
    value: string | null
  ) => "intent" | "execution" | "blocked" | "review" | "handoff" | "completed";
  normalizeRuntimeSourceForReporting: (value: unknown) => string;
  emitActivity: (input: {
    initiative_id: string;
    run_id?: string;
    correlation_id?: string;
    source_client: string;
    message: string;
    phase: "intent" | "execution" | "blocked" | "review" | "handoff" | "completed";
    progress_pct?: number;
    level: "info" | "warn" | "error";
    metadata?: Record<string, unknown>;
  }) => Promise<unknown>;
  securityHeaders: Record<string, string>;
  corsHeaders: Record<string, string>;
};

export function registerRuntimeHookRoutes<
  TReq,
  TRes extends {
    write?: (chunk: string | Buffer) => boolean | void;
    end: () => void;
    writeHead: (statusCode: number, headers?: Record<string, string>) => unknown;
    writableEnded?: boolean;
    on?: (event: string, listener: () => void) => void;
  }
>(
  router: Router<Record<string, never>, TReq, TRes>,
  deps: RegisterRuntimeHookRoutesDeps<TReq, TRes>
): void {
  async function renderRuntimeHookConfig(res: TRes): Promise<void> {
    try {
      const snapshot = readOpenClawSettingsSnapshot();
      const port = readOpenClawGatewayPort(snapshot.raw);
      const runtimeHookUrl = `http://127.0.0.1:${port}/orgx/api/hooks/runtime`;
      const hookToken = deps.resolveRuntimeHookToken();

      const hooksDir = join(getOrgxPluginConfigDir(), "hooks");
      const hookScriptPath = join(hooksDir, "post-reporting-event.mjs");
      const hookScriptInstalled = existsSync(hookScriptPath);

      const codexHome = (process.env.CODEX_HOME ?? "").trim();
      const codexCandidates = [
        codexHome ? join(codexHome, "config.toml") : null,
        join(homedir(), ".codex", "config.toml"),
        join(homedir(), ".config", "codex", "config.toml"),
      ].filter(Boolean) as string[];
      const codexConfigPath =
        codexCandidates.find((candidate) => existsSync(candidate)) ??
        (codexCandidates[0] ?? null);

      let codexInstalled = false;
      let codexHasNotify = false;
      if (codexConfigPath && existsSync(codexConfigPath)) {
        const raw = readFileSync(codexConfigPath, "utf8");
        codexHasNotify = /^\s*notify\s*=/m.test(raw);
        codexInstalled =
          raw.includes("post-reporting-event.mjs") && raw.includes("--source_client=codex");
      }
      const codexNotifyConflict = Boolean(codexHasNotify && !codexInstalled);

      const claudeCandidates = [
        join(homedir(), ".claude", "settings.json"),
        join(homedir(), ".config", "claude", "settings.json"),
      ];
      const claudeSettingsPath =
        claudeCandidates.find((candidate) => existsSync(candidate)) ?? claudeCandidates[0];

      let claudeInstalled = false;
      if (claudeSettingsPath && existsSync(claudeSettingsPath)) {
        const raw = readFileSync(claudeSettingsPath, "utf8");
        claudeInstalled =
          raw.includes("post-reporting-event.mjs") &&
          raw.includes("--source_client=claude-code");
      }

      deps.sendJson(res, 200, {
        ok: true,
        runtimeHookUrl,
        hookToken,
        hookTokenHint: deps.maskSecret(hookToken),
        paths: {
          hookScriptPath,
          codexConfigPath,
          claudeSettingsPath,
        },
        installed: {
          hookScript: hookScriptInstalled,
          codex: codexInstalled,
          claudeCode: claudeInstalled,
        },
        conflicts: {
          codexNotify: codexNotifyConflict,
        },
      });
    } catch (err: unknown) {
      deps.sendJson(res, 500, {
        ok: false,
        error: deps.safeErrorMessage(err),
      });
    }
  }

  router.add(
    "GET",
    "hooks/runtime/config",
    async ({ res }) => renderRuntimeHookConfig(res),
    "Get runtime hook wiring config"
  );
  router.add(
    "HEAD",
    "hooks/runtime/config",
    async ({ res }) => renderRuntimeHookConfig(res),
    "Get runtime hook wiring config (HEAD)"
  );

  router.add(
    "POST",
    "hooks/runtime/setup",
    async ({ req, res }) => {
      try {
        const payloadRecord = await deps.parseJsonRequest(req);
        const requestedTargets = Array.isArray(payloadRecord.targets)
          ? payloadRecord.targets
          : [];
        const requested = requestedTargets
          .map((value) =>
            typeof value === "string" ? value.trim().toLowerCase() : ""
          )
          .filter((value) => value.length > 0);

        const targets = new Set<string>();
        for (const value of requested) {
          if (value === "codex") targets.add("codex");
          if (value === "claude" || value === "claude-code" || value === "claude_code") {
            targets.add("claude-code");
          }
        }
        if (targets.size === 0) {
          targets.add("codex");
          targets.add("claude-code");
        }

        const snapshot = readOpenClawSettingsSnapshot();
        const port = readOpenClawGatewayPort(snapshot.raw);
        const runtimeHookUrl = `http://127.0.0.1:${port}/orgx/api/hooks/runtime`;
        const hookToken = deps.resolveRuntimeHookToken();

        const hooksDir = join(getOrgxPluginConfigDir(), "hooks");
        mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
        const hookScriptPath = join(hooksDir, "post-reporting-event.mjs");

        const handlerFilename = fileURLToPath(import.meta.url);
        const distDir = resolve(join(handlerFilename, ".."));
        const bundledScriptPath = resolve(distDir, "hooks", "post-reporting-event.mjs");
        const fallbackScriptPath = resolve(
          distDir,
          "..",
          "templates",
          "hooks",
          "scripts",
          "post-reporting-event.mjs"
        );

        let scriptContent = "";
        let hookScriptSourcePath = bundledScriptPath;
        try {
          scriptContent = readFileSync(bundledScriptPath, "utf8");
        } catch {
          hookScriptSourcePath = fallbackScriptPath;
          scriptContent = readFileSync(fallbackScriptPath, "utf8");
        }

        writeFileAtomicSync(hookScriptPath, scriptContent, {
          mode: 0o700,
          encoding: "utf8",
        });

        const result = {
          ok: true,
          runtimeHookUrl,
          hookTokenHint: deps.maskSecret(hookToken),
          hookScriptPath,
          hookScriptSourcePath,
          targets: {
            codex: targets.has("codex"),
            claudeCode: targets.has("claude-code"),
          },
          codex: {
            path: null as string | null,
            installed: false,
            conflict: false,
          },
          claudeCode: {
            path: null as string | null,
            installed: false,
          },
        };

        if (targets.has("codex")) {
          const codexHome = (process.env.CODEX_HOME ?? "").trim();
          const codexCandidates = [
            codexHome ? join(codexHome, "config.toml") : null,
            join(homedir(), ".codex", "config.toml"),
            join(homedir(), ".config", "codex", "config.toml"),
          ].filter(Boolean) as string[];
          const codexConfigPath =
            codexCandidates.find((candidate) => existsSync(candidate)) ??
            codexCandidates[0];

          result.codex.path = codexConfigPath;

          const notifySnippet = [
            "",
            "# OrgX runtime telemetry (installed by OpenClaw plugin)",
            "notify = [",
            '  "node",',
            `  "${hookScriptPath}",`,
            '  "--event=heartbeat",',
            '  "--source_client=codex",',
            '  "--phase=execution",',
            '  "--message=Codex heartbeat",',
            `  "--runtime_hook_url=${runtimeHookUrl}",`,
            `  "--hook_token=${hookToken}",`,
            "]",
            "",
          ].join("\n");

          if (!existsSync(codexConfigPath)) {
            mkdirSync(dirname(codexConfigPath), { recursive: true, mode: 0o700 });
            const initial = [
              "# Codex config.toml",
              "# Auto-generated OrgX hook wiring (safe to edit).",
              notifySnippet.trimEnd(),
              "",
            ].join("\n");
            writeFileAtomicSync(codexConfigPath, initial, {
              mode: 0o600,
              encoding: "utf8",
            });
            result.codex.installed = true;
          } else {
            const raw = readFileSync(codexConfigPath, "utf8");
            const alreadyInstalled =
              raw.includes("post-reporting-event.mjs") &&
              raw.includes("--source_client=codex");
            const hasNotify = /^\s*notify\s*=/m.test(raw);

            if (alreadyInstalled) {
              result.codex.installed = true;
            } else if (hasNotify) {
              result.codex.conflict = true;
            } else {
              const next = raw.replace(/\s*$/, "") + notifySnippet;
              writeFileAtomicSync(codexConfigPath, next, {
                mode: 0o600,
                encoding: "utf8",
              });
              result.codex.installed = true;
            }
          }
        }

        if (targets.has("claude-code")) {
          const claudeCandidates = [
            join(homedir(), ".claude", "settings.json"),
            join(homedir(), ".config", "claude", "settings.json"),
          ];
          const claudeSettingsPath =
            claudeCandidates.find((candidate) => existsSync(candidate)) ??
            claudeCandidates[0];

          result.claudeCode.path = claudeSettingsPath;

          mkdirSync(dirname(claudeSettingsPath), { recursive: true, mode: 0o700 });

          let settings: Record<string, unknown> = {};
          if (existsSync(claudeSettingsPath)) {
            const raw = readFileSync(claudeSettingsPath, "utf8");
            const parsed = deps.parseJsonSafe<Record<string, unknown>>(raw);
            if (!parsed) {
              backupCorruptFileSync(claudeSettingsPath);
            } else {
              settings = parsed;
            }
          }

          const hooksRoot =
            settings.hooks &&
            typeof settings.hooks === "object" &&
            !Array.isArray(settings.hooks)
              ? (settings.hooks as Record<string, unknown>)
              : {};
          settings.hooks = hooksRoot;

          const ensureClaudeHook = (hookName: string, matcher: string, command: string) => {
            const list = Array.isArray(hooksRoot[hookName])
              ? (hooksRoot[hookName] as Array<Record<string, unknown>>)
              : [];

            let rule = list.find(
              (entry) =>
                entry &&
                typeof entry === "object" &&
                (entry as Record<string, unknown>).matcher === matcher
            ) as Record<string, unknown> | undefined;
            if (!rule) {
              rule = { matcher, hooks: [] };
              list.push(rule);
            }
            if (!Array.isArray(rule.hooks)) {
              rule.hooks = [];
            }

            const hooks = rule.hooks as Array<Record<string, unknown>>;
            const already = hooks.some(
              (entry) =>
                entry &&
                entry.type === "command" &&
                typeof entry.command === "string" &&
                entry.command.includes("post-reporting-event.mjs") &&
                entry.command.includes(command)
            );

            if (!already) {
              hooks.push({ type: "command", command });
            }

            hooksRoot[hookName] = list;
          };

          const baseArgs = `--runtime_hook_url=${runtimeHookUrl} --hook_token=${hookToken}`;
          const startCmd = `node ${hookScriptPath} --event=session_start --source_client=claude-code --phase=intent --message=\"Claude session started\" ${baseArgs}`;
          const toolCmd = `node ${hookScriptPath} --event=task_update --source_client=claude-code --phase=execution --message=\"Claude tool completed\" ${baseArgs}`;
          const stopCmd = `node ${hookScriptPath} --event=session_stop --source_client=claude-code --phase=completed --message=\"Claude session completed\" ${baseArgs}`;

          ensureClaudeHook("SessionStart", "", startCmd);
          ensureClaudeHook("PostToolUse", "Write|Edit|Bash", toolCmd);
          ensureClaudeHook("Stop", "", stopCmd);

          writeFileAtomicSync(
            claudeSettingsPath,
            `${JSON.stringify(settings, null, 2)}\n`,
            {
              mode: 0o600,
              encoding: "utf8",
            }
          );

          result.claudeCode.installed = true;
        }

        deps.sendJson(res, 200, result);
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Install runtime hooks for Codex/Claude Code"
  );
  router.add(
    "*",
    "hooks/runtime/setup",
    ({ res }) => {
      deps.sendJson(res, 405, {
        ok: false,
        error: "Use POST /orgx/api/hooks/runtime/setup",
      });
    },
    "Reject unsupported methods for hooks/runtime/setup"
  );

  async function renderRuntimeStream(req: TReq, res: TRes): Promise<void> {
    const write = res.write?.bind(res);
    if (!write) {
      deps.sendJson(res, 501, { ok: false, error: "Streaming not supported" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...deps.securityHeaders,
      ...deps.corsHeaders,
    });

    const subscriberId = deps.randomUUID();
    const subscriber: RuntimeStreamSubscriber = {
      id: subscriberId,
      write: (chunk: Buffer) => write(chunk) !== false,
      end: () => {
        if (!res.writableEnded) {
          res.end();
        }
      },
    };

    deps.runtimeStreamSubscribers.set(subscriberId, subscriber);
    deps.ensureRuntimeStreamTimers();

    try {
      const initial = deps.listRuntimeInstances({ limit: 320 });
      deps.writeRuntimeSseEvent(subscriber, "runtime.updated", initial);
    } catch {
      // ignore
    }

    const close = () => {
      deps.runtimeStreamSubscribers.delete(subscriberId);
      try {
        subscriber.end();
      } catch {
        // ignore
      }
      if (deps.runtimeStreamSubscribers.size === 0) {
        deps.stopRuntimeStreamTimers();
      }
    };

    (req as { on?: (event: string, listener: () => void) => void }).on?.("close", close);
    (req as { on?: (event: string, listener: () => void) => void }).on?.("aborted", close);
    res.on?.("close", close);
    res.on?.("finish", close);
  }

  router.add(
    "GET",
    "hooks/runtime/stream",
    async ({ req, res }) => renderRuntimeStream(req, res),
    "Subscribe to runtime stream"
  );
  router.add(
    "HEAD",
    "hooks/runtime/stream",
    async ({ req, res }) => renderRuntimeStream(req, res),
    "Subscribe to runtime stream (HEAD)"
  );

  router.add(
    "POST",
    "hooks/runtime",
    async ({ req, query, res }) => {
      const reqWithHeaders = req as unknown as {
        headers?: Record<string, string | string[] | undefined>;
      };
      const expectedHookToken = deps.resolveRuntimeHookToken();
      const providedHookToken =
        deps.pickHeaderString(reqWithHeaders.headers ?? {}, [
          "x-orgx-hook-token",
          "x-hook-token",
        ]) ??
        query.get("hook_token") ??
        query.get("token");

      if (!providedHookToken || providedHookToken.trim() !== expectedHookToken) {
        deps.sendJson(res, 401, {
          ok: false,
          error: "Invalid hook token",
        });
        return;
      }

      try {
        const payloadRecord = await deps.parseJsonRequest(req);
        const payload: RuntimeHookPayload = {
          source_client:
            deps.pickString(payloadRecord, ["source_client", "sourceClient"]) ?? "unknown",
          event: deps.pickString(payloadRecord, ["event", "hook_event"]) ?? "heartbeat",
          run_id: deps.pickString(payloadRecord, [
            "run_id",
            "runId",
            "session_id",
            "sessionId",
          ]),
          correlation_id: deps.pickString(payloadRecord, ["correlation_id", "correlationId"]),
          initiative_id: deps.pickString(payloadRecord, ["initiative_id", "initiativeId"]),
          workstream_id: deps.pickString(payloadRecord, ["workstream_id", "workstreamId"]),
          task_id: deps.pickString(payloadRecord, ["task_id", "taskId"]),
          agent_id: deps.pickString(payloadRecord, ["agent_id", "agentId"]),
          agent_name: deps.pickString(payloadRecord, ["agent_name", "agentName"]),
          phase: deps.pickString(payloadRecord, ["phase"]),
          progress_pct: deps.pickNumber(payloadRecord, ["progress_pct", "progressPct"]) ?? null,
          message: deps.pickString(payloadRecord, ["message", "summary"]),
          metadata:
            payloadRecord.metadata && typeof payloadRecord.metadata === "object"
              ? (payloadRecord.metadata as Record<string, unknown>)
              : null,
          timestamp: deps.pickString(payloadRecord, ["timestamp", "time", "ts"]),
        };

        const instance = deps.upsertRuntimeInstanceFromHook(payload);
        deps.broadcastRuntimeSse("runtime.updated", instance);
        deps.clearSnapshotResponseCache();

        const fallbackPhaseByEvent: Record<string, string> = {
          session_start: "intent",
          heartbeat: "execution",
          progress: "execution",
          task_update: "execution",
          session_stop: "completed",
          error: "blocked",
        };
        const phase = deps.normalizeHookPhase(
          payload.phase ?? fallbackPhaseByEvent[instance.event] ?? "execution"
        );
        const level: "info" | "warn" | "error" =
          instance.event === "error" ? "error" : phase === "blocked" ? "warn" : "info";
        const message =
          payload.message ?? `${instance.displayName} ${instance.event.replace(/_/g, " ")}`;

        let forwarded = false;
        let forwardError: string | null = null;
        if (instance.initiativeId) {
          try {
            await deps.emitActivity({
              initiative_id: instance.initiativeId,
              run_id: instance.runId ?? undefined,
              correlation_id: instance.runId
                ? undefined
                : (instance.correlationId ?? undefined),
              source_client: deps.normalizeRuntimeSourceForReporting(instance.sourceClient),
              message,
              phase,
              progress_pct: instance.progressPct ?? undefined,
              level,
              metadata: {
                source: "runtime_hook_relay",
                hook_event: instance.event,
                instance_id: instance.id,
                runtime_client: instance.sourceClient,
                task_id: instance.taskId,
                workstream_id: instance.workstreamId,
                ...(instance.metadata ?? {}),
              },
            });
            forwarded = true;
          } catch (err: unknown) {
            forwardError = deps.safeErrorMessage(err);
          }
        }

        deps.sendJson(res, 200, {
          ok: true,
          instance_id: instance.id,
          state: instance.state,
          last_seen_at: instance.lastHeartbeatAt ?? instance.lastEventAt,
          run_id: instance.runId ?? null,
          forwarded,
          forward_error: forwardError,
        });
      } catch (err: unknown) {
        deps.sendJson(res, 500, {
          ok: false,
          error: deps.safeErrorMessage(err),
        });
      }
    },
    "Ingest runtime hook events"
  );
  router.add(
    "*",
    "hooks/runtime",
    ({ res }) => {
      deps.sendJson(res, 405, { ok: false, error: "Use POST /orgx/api/hooks/runtime" });
    },
    "Reject unsupported methods for hooks/runtime"
  );
}
