import test from "node:test";
import assert from "node:assert/strict";

import { setCanonicalWorkspaceScopeParams } from "../../dist/http/helpers/workspace-scope.js";

test("setCanonicalWorkspaceScopeParams sets workspace, command center, and center aliases", () => {
  const params = new URLSearchParams({ project_id: "legacy-project" });
  setCanonicalWorkspaceScopeParams(params, "workspace-c");

  assert.equal(params.get("workspace_id"), "workspace-c");
  assert.equal(params.get("command_center_id"), "workspace-c");
  assert.equal(params.get("center"), "workspace-c");
  assert.equal(params.has("project_id"), false);
});

test("setCanonicalWorkspaceScopeParams clears existing scope aliases when workspace is missing", () => {
  const params = new URLSearchParams({
    workspace_id: "workspace-c",
    command_center_id: "workspace-c",
    center: "workspace-c",
    project_id: "legacy-project",
    projectId: "legacy-project-camel",
  });
  setCanonicalWorkspaceScopeParams(params, null);

  assert.equal(params.has("workspace_id"), false);
  assert.equal(params.has("command_center_id"), false);
  assert.equal(params.has("center"), false);
  assert.equal(params.has("project_id"), false);
  assert.equal(params.has("projectId"), false);
});

test("setCanonicalWorkspaceScopeParams uses all token when workspace is missing and enabled", () => {
  const params = new URLSearchParams();
  setCanonicalWorkspaceScopeParams(params, null, { allTokenWhenMissing: true });

  assert.equal(params.get("workspace_id"), "all");
  assert.equal(params.get("command_center_id"), "all");
  assert.equal(params.get("center"), "all");
});
