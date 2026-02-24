import test from "node:test";
import assert from "node:assert/strict";

import { randomizeExperimentAssignment } from "../../dist/services/experiment-randomization.js";

const ARMS = [
  { id: "control", weight: 50 },
  { id: "variant_a", weight: 30 },
  { id: "variant_b", weight: 20 },
];

test("cross-channel assignment stays deterministic for same subject", () => {
  const email = randomizeExperimentAssignment({
    experimentId: "growth-onboarding-v2",
    subjectKey: "user:12345",
    channel: "email",
    arms: ARMS,
  });

  const push = randomizeExperimentAssignment({
    experimentId: "growth-onboarding-v2",
    subjectKey: "user:12345",
    channel: "push",
    arms: ARMS,
  });

  assert.equal(email.armId, push.armId);
  assert.equal(email.assignmentKey, push.assignmentKey);
  assert.equal(email.bucket, push.bucket);
  assert.equal(email.exposureKey, push.exposureKey);
});

test("seed rotates assignment deterministically", () => {
  const baseline = randomizeExperimentAssignment({
    experimentId: "growth-onboarding-v2",
    subjectKey: "user:67890",
    channel: "sms",
    arms: ARMS,
    seed: "v1",
  });

  const rotated = randomizeExperimentAssignment({
    experimentId: "growth-onboarding-v2",
    subjectKey: "user:67890",
    channel: "sms",
    arms: ARMS,
    seed: "v2",
  });

  assert.notEqual(baseline.assignmentKey, rotated.assignmentKey);
  assert.notEqual(baseline.bucket, rotated.bucket);
});

test("invalid arm weights are rejected", () => {
  assert.throws(
    () =>
      randomizeExperimentAssignment({
        experimentId: "exp-1",
        subjectKey: "user:1",
        channel: "email",
        arms: [{ id: "control", weight: 0 }],
      }),
    /weight must be > 0/,
  );
});
