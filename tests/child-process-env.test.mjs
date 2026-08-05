import assert from "node:assert/strict";
import test from "node:test";

import {
  GATEWAY_SECRET_ENV_KEYS,
  sanitizedChildProcessEnv,
} from "../dist/child-process-env.js";

test("agent child environments exclude OrgX gateway credentials", () => {
  const childEnv = sanitizedChildProcessEnv(
    { ORGX_API_KEY: "oxk_parent", PATH: "/bin" },
    { ORGX_GATEWAY_KEY: "oxk_override", OPENAI_API_KEY: "provider-key" }
  );

  assert.deepEqual(childEnv, {
    PATH: "/bin",
    OPENAI_API_KEY: "provider-key",
  });
  assert.deepEqual(GATEWAY_SECRET_ENV_KEYS, ["ORGX_API_KEY", "ORGX_GATEWAY_KEY"]);
});
