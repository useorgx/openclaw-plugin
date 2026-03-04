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

test("duplicate arm ids are rejected", () => {
  assert.throws(
    () =>
      randomizeExperimentAssignment({
        experimentId: "exp-dup",
        subjectKey: "user:dup",
        channel: "email",
        arms: [
          { id: "control", weight: 70 },
          { id: "control", weight: 30 },
        ],
      }),
    /id must be unique/,
  );
});

test("bucket is always in [0,1) and assignments are not degenerate", () => {
  const assignedArms = new Set();
  for (let i = 0; i < 400; i += 1) {
    const result = randomizeExperimentAssignment({
      experimentId: "growth-onboarding-v2",
      subjectKey: `user:${i}`,
      channel: "email",
      arms: ARMS,
    });

    assert.ok(result.bucket >= 0, `bucket must be >= 0, got ${result.bucket}`);
    assert.ok(result.bucket < 1, `bucket must be < 1, got ${result.bucket}`);
    assignedArms.add(result.armId);
  }

  assert.ok(assignedArms.size > 1, "assignment should not collapse to a single arm");
});
