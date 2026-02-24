import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveWorkspaceScope,
  setCanonicalWorkspaceScopeParams,
} from "../../dist/http/helpers/workspace-scope.js";

test("resolveWorkspaceScope rejects mixed workspace aliases when values conflict across payload/query", () => {
  const query = new URLSearchParams({ command_center_id: "workspace-b" });
  const payload = { workspace_id: "workspace-a" };

  const scope = resolveWorkspaceScope(query, payload, { allowProjectScope: false });
  assert.equal(scope.workspaceId, null);
  assert.match(
    String(scope.error ?? ""),
    /workspace_id and command_center_id must match/i
  );
});

test("resolveWorkspaceScope falls back to canonical workspace alias and rejects project-only scope", () => {
  const canonicalScope = resolveWorkspaceScope(
    new URLSearchParams({ center: "workspace-c" }),
    null,
    { allowProjectScope: false }
  );
  assert.deepEqual(canonicalScope, { workspaceId: "workspace-c" });

  const rejectedProjectScope = resolveWorkspaceScope(
    new URLSearchParams({ project_id: "workspace-c" }),
    null,
    { allowProjectScope: false }
  );
  assert.equal(rejectedProjectScope.workspaceId, null);
  assert.match(
    String(rejectedProjectScope.error ?? ""),
    /project_id is no longer accepted/i
  );
});

test("setCanonicalWorkspaceScopeParams writes both canonical query params", () => {
  const params = new URLSearchParams();
  setCanonicalWorkspaceScopeParams(params, "workspace-z");

  assert.equal(params.get("workspace_id"), "workspace-z");
  assert.equal(params.get("command_center_id"), "workspace-z");
  assert.equal(params.get("center"), "workspace-z");
});
