import test from "node:test";
import assert from "node:assert/strict";

import { mergeOnboardingState } from "../dist/contracts/onboarding-state.js";

function createState(overrides = {}) {
  return {
    status: "idle",
    hasApiKey: false,
    connectionVerified: false,
    workspaceName: null,
    lastError: null,
    nextAction: "connect",
    docsUrl: "https://docs.useorgx.com/setup",
    keySource: "none",
    installationId: null,
    connectUrl: null,
    pairingId: null,
    expiresAt: null,
    pollIntervalMs: null,
    ...overrides,
  };
}

test("mergeOnboardingState preserves verified context during reconnect pairing", () => {
  const previous = createState({
    status: "connected",
    hasApiKey: true,
    connectionVerified: true,
    workspaceName: "OrgX Business",
    nextAction: "open_dashboard",
    keySource: "persisted",
    installationId: "install_123",
  });
  const next = createState({
    status: "pairing",
    hasApiKey: false,
    connectionVerified: false,
    workspaceName: null,
    nextAction: "wait_for_browser",
    keySource: "none",
    installationId: null,
    connectUrl: "https://www.useorgx.com/connect/openclaw?pairingId=pair_123",
    pairingId: "pair_123",
  });

  const merged = mergeOnboardingState(previous, next);

  assert.equal(merged.status, "pairing");
  assert.equal(merged.hasApiKey, true);
  assert.equal(merged.connectionVerified, true);
  assert.equal(merged.workspaceName, "OrgX Business");
  assert.equal(merged.keySource, "persisted");
  assert.equal(merged.installationId, "install_123");
  assert.equal(merged.pairingId, "pair_123");
  assert.equal(merged.connectUrl, "https://www.useorgx.com/connect/openclaw?pairingId=pair_123");
});

test("mergeOnboardingState does not invent verified context for fresh pairing flows", () => {
  const previous = createState();
  const next = createState({
    status: "pairing",
    nextAction: "wait_for_browser",
    connectUrl: "https://www.useorgx.com/connect/openclaw?pairingId=pair_fresh",
    pairingId: "pair_fresh",
  });

  const merged = mergeOnboardingState(previous, next);

  assert.equal(merged.hasApiKey, false);
  assert.equal(merged.connectionVerified, false);
  assert.equal(merged.workspaceName, null);
  assert.equal(merged.keySource, "none");
  assert.equal(merged.installationId, null);
});
