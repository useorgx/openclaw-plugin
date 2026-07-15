import { posthogCapture } from "../telemetry/posthog.js";
import { captureOpenClawException } from "../sentry.js";

type ToolLike = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (callId: string, params?: unknown) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
};

type ServiceLike = {
  id: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type ApiLike = {
  registerTool: (tool: ToolLike, options?: { optional?: boolean }) => void;
  registerService: (service: ServiceLike) => void;
};

export function instrumentPluginApi(input: {
  api: ApiLike;
  installationId: string;
  pluginVersion: string;
  toErrorMessage: (err: unknown) => string;
}): void {
  const registerTool = input.api.registerTool.bind(input.api);
  input.api.registerTool = (tool, options) => {
    const toolName = tool.name;
    const optional = Boolean(options?.optional);

    registerTool(
      {
        ...tool,
        execute: async (callId: string, params?: unknown) => {
          const startedAt = Date.now();

          void posthogCapture({
            event: "openclaw_tool_called",
            distinctId: input.installationId,
            properties: {
              tool_name: toolName,
              tool_optional: optional,
              call_id: callId,
              plugin_version: input.pluginVersion,
            },
          }).catch(() => {
            // best effort
          });

          try {
            const result = await tool.execute(callId, params);
            const durationMs = Date.now() - startedAt;

            void posthogCapture({
              event: "openclaw_tool_succeeded",
              distinctId: input.installationId,
              properties: {
                tool_name: toolName,
                tool_optional: optional,
                call_id: callId,
                duration_ms: durationMs,
                plugin_version: input.pluginVersion,
              },
            }).catch(() => {
              // best effort
            });

            return result;
          } catch (err) {
            const durationMs = Date.now() - startedAt;
            captureOpenClawException(err, {
              stage: "tool_execute",
              tool: toolName,
            });

            void posthogCapture({
              event: "openclaw_tool_failed",
              distinctId: input.installationId,
              properties: {
                tool_name: toolName,
                tool_optional: optional,
                call_id: callId,
                duration_ms: durationMs,
                plugin_version: input.pluginVersion,
                error: input.toErrorMessage(err),
              },
            }).catch(() => {
              // best effort
            });

            throw err;
          }
        },
      },
      options
    );
  };

  const registerService = input.api.registerService.bind(input.api);
  input.api.registerService = (service) => {
    registerService({
      ...service,
      start: async () => {
        const startedAt = Date.now();
        try {
          await service.start();
          const durationMs = Date.now() - startedAt;
          void posthogCapture({
            event: "openclaw_service_started",
            distinctId: input.installationId,
            properties: {
              service_id: service.id,
              duration_ms: durationMs,
              plugin_version: input.pluginVersion,
            },
          }).catch(() => {
            // best effort
          });
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          captureOpenClawException(err, {
            stage: "service_start",
            service: service.id,
          });
          void posthogCapture({
            event: "openclaw_service_start_failed",
            distinctId: input.installationId,
            properties: {
              service_id: service.id,
              duration_ms: durationMs,
              plugin_version: input.pluginVersion,
              error: input.toErrorMessage(err),
            },
          }).catch(() => {
            // best effort
          });
          throw err;
        }
      },
      stop: async () => {
        const startedAt = Date.now();
        try {
          await service.stop();
          const durationMs = Date.now() - startedAt;
          void posthogCapture({
            event: "openclaw_service_stopped",
            distinctId: input.installationId,
            properties: {
              service_id: service.id,
              duration_ms: durationMs,
              plugin_version: input.pluginVersion,
            },
          }).catch(() => {
            // best effort
          });
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          captureOpenClawException(err, {
            stage: "service_stop",
            service: service.id,
          });
          void posthogCapture({
            event: "openclaw_service_stop_failed",
            distinctId: input.installationId,
            properties: {
              service_id: service.id,
              duration_ms: durationMs,
              plugin_version: input.pluginVersion,
              error: input.toErrorMessage(err),
            },
          }).catch(() => {
            // best effort
          });
          throw err;
        }
      },
    });
  };
}
