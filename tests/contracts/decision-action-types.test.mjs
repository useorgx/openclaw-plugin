import test from "node:test";
import assert from "node:assert/strict";

import {
  isKnownDecisionActionType,
  normalizeDecisionActionType,
} from "../../dist/contracts/shared-types.js";

test("normalizeDecisionActionType canonicalizes known and alias actions", () => {
  assert.equal(normalizeDecisionActionType("approve"), "approve");
  assert.equal(normalizeDecisionActionType("declined"), "reject");
  assert.equal(normalizeDecisionActionType("queue_to_top"), "queue_top");
  assert.equal(normalizeDecisionActionType("add_to_end"), "queue_bottom");
  assert.equal(normalizeDecisionActionType("open_pull_request"), "open_pr");
  assert.equal(normalizeDecisionActionType("auto_resolve"), "auto_fix");
});

test("normalizeDecisionActionType keeps unknown custom actions as lowercase tokens", () => {
  assert.equal(normalizeDecisionActionType("custom_action"), "custom_action");
  assert.equal(normalizeDecisionActionType("CUSTOM_VERB"), "custom_verb");
});

test("normalizeDecisionActionType returns null for invalid values", () => {
  assert.equal(normalizeDecisionActionType(""), null);
  assert.equal(normalizeDecisionActionType("   "), null);
  assert.equal(normalizeDecisionActionType(null), null);
  assert.equal(normalizeDecisionActionType(undefined), null);
  assert.equal(normalizeDecisionActionType(42), null);
});

test("isKnownDecisionActionType validates canonical action taxonomy", () => {
  assert.equal(isKnownDecisionActionType("approve"), true);
  assert.equal(isKnownDecisionActionType("open_pr"), true);
  assert.equal(isKnownDecisionActionType("custom_action"), false);
  assert.equal(isKnownDecisionActionType(""), false);
  assert.equal(isKnownDecisionActionType(null), false);
});
