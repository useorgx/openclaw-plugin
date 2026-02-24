import test from "node:test";
import assert from "node:assert/strict";

import { setCanonicalWorkspaceScopeParams } from "../../dist/http/helpers/workspace-scope.js";

test("setCanonicalWorkspaceScopeParams sets workspace, command center, and center aliases", () => {
  const params = new URLSearchParams();
  setCanonicalWorkspaceScopeParams(params, "workspace-c");

  assert.equal(params.get("workspace_id"), "workspace-c");
  assert.equal(params.get("command_center_id"), "workspace-c");
  assert.equal(params.get("center"), "workspace-c");
});
