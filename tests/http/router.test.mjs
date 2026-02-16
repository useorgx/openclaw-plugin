import test from "node:test";
import assert from "node:assert/strict";

import { createRouter } from "../../dist/http/router.js";

test("router matches exact method + path", () => {
  const router = createRouter();
  const handler = () => {};
  router.add("GET", "live/snapshot", handler, "snapshot");

  const matched = router.match("GET", "live/snapshot");
  assert.equal(matched?.handler, handler);
  assert.equal(matched?.description, "snapshot");
});

test("router supports wildcard method", () => {
  const router = createRouter();
  const handler = () => {};
  router.add("*", "onboarding/status", handler);

  assert.equal(router.match("GET", "onboarding/status")?.handler, handler);
  assert.equal(router.match("POST", "onboarding/status")?.handler, handler);
});

test("router supports prefix patterns via /*", () => {
  const router = createRouter();
  const handler = () => {};
  router.add("GET", "live/assets/*", handler);

  assert.equal(router.match("GET", "live/assets/main.js")?.handler, handler);
  assert.equal(router.match("GET", "live/assets/css/app.css")?.handler, handler);
  assert.equal(router.match("GET", "live/assetz/main.js"), undefined);
});

test("router keeps insertion order for matching routes", () => {
  const router = createRouter();
  const first = () => {};
  const second = () => {};
  router.add("GET", "live/*", first);
  router.add("GET", "live/snapshot", second);

  assert.equal(router.match("GET", "live/snapshot")?.handler, first);
  assert.equal(router.routes().length, 2);
});
