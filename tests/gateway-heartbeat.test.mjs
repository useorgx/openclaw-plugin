import assert from "node:assert/strict";
import test from "node:test";

import { buildGatewayHeartbeatPayloads } from "../dist/services/gateway-heartbeat.js";

test("gateway heartbeat binds each subscription runtime to one workspace", () => {
  const payloads = buildGatewayHeartbeatPayloads({
    workspaceId: "11111111-1111-4111-8111-111111111111",
    installationId: "ocw_test",
    pluginVersion: "0.7.35",
    gatewayVersion: "2026.6.11",
    runtimes: [
      {
        pluginId: "orgx-codex-plugin",
        driver: "codex",
        runtime: "codex",
        planTier: "chatgpt",
        subscriptionType: "chatgpt",
        version: "codex-cli 0.133.0",
      },
      {
        pluginId: "orgx-claude-code-plugin",
        driver: "claude_code",
        runtime: "claude-code",
        planTier: "max",
        subscriptionType: "max",
        version: "2.1.178",
      },
    ],
  });

  assert.equal(payloads.length, 2);
  assert.deepEqual(
    payloads.map((payload) => payload.workspace_id),
    [
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
    ]
  );
  assert.deepEqual(payloads[0].drivers_installed, ["codex"]);
  assert.deepEqual(payloads[1].drivers_installed, ["claude_code"]);
  assert.notEqual(payloads[0].installation_id, payloads[1].installation_id);
});
