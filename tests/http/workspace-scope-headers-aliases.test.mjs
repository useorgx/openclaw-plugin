import test from "node:test";
import assert from "node:assert/strict";

import { workspaceScopeFromHeaders } from "../../dist/http/helpers/workspace-scope.js";

test("workspaceScopeFromHeaders accepts underscore workspace header alias", () => {
  const scope = workspaceScopeFromHeaders({
    x_orgx_workspace_id: "workspace-a",
  });

  assert.deepEqual(scope, {
    workspace_id: "workspace-a",
    command_center_id: "workspace-a",
    center: "workspace-a",
  });
});

test("workspaceScopeFromHeaders accepts hyphenated workspace header alias", () => {
  const scope = workspaceScopeFromHeaders({
    "x-orgx-workspace-id": "workspace-aa",
  });

  assert.deepEqual(scope, {
    workspace_id: "workspace-aa",
    command_center_id: "workspace-aa",
    center: "workspace-aa",
  });
});

test("workspaceScopeFromHeaders accepts underscore command center header alias", () => {
  const scope = workspaceScopeFromHeaders({
    x_orgx_command_center_id: "workspace-b",
  });

  assert.deepEqual(scope, {
    workspace_id: "workspace-b",
    command_center_id: "workspace-b",
    center: "workspace-b",
  });
});

test("workspaceScopeFromHeaders accepts hyphenated command center header alias", () => {
  const scope = workspaceScopeFromHeaders({
    "x-orgx-command-center-id": "workspace-bb",
  });

  assert.deepEqual(scope, {
    workspace_id: "workspace-bb",
    command_center_id: "workspace-bb",
    center: "workspace-bb",
  });
});

test("workspaceScopeFromHeaders preserves mismatched workspace and command center values", () => {
  const scope = workspaceScopeFromHeaders({
    x_orgx_workspace_id: "workspace-a",
    x_orgx_command_center_id: "workspace-b",
  });

  assert.deepEqual(scope, {
    workspace_id: "workspace-a",
    command_center_id: "workspace-b",
    center: "workspace-a",
  });
});

test("workspaceScopeFromHeaders accepts repeated array-valued headers", () => {
  const scope = workspaceScopeFromHeaders({
    x_orgx_workspace_id: ["", "workspace-c"],
  });

  assert.deepEqual(scope, {
    workspace_id: "workspace-c",
    command_center_id: "workspace-c",
    center: "workspace-c",
  });
});

test("workspaceScopeFromHeaders accepts canonical workspace header keys", () => {
  const scope = workspaceScopeFromHeaders({
    workspace_id: "workspace-d",
  });

  assert.deepEqual(scope, {
    workspace_id: "workspace-d",
    command_center_id: "workspace-d",
    center: "workspace-d",
  });
});

test("workspaceScopeFromHeaders accepts canonical command center header keys", () => {
  const scope = workspaceScopeFromHeaders({
    command_center_id: "workspace-e",
  });

  assert.deepEqual(scope, {
    workspace_id: "workspace-e",
    command_center_id: "workspace-e",
    center: "workspace-e",
  });
});
