import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFinalVerdict } from "../supervisor/finalVerdict.js";

function makeBaseInput(overrides: Partial<Parameters<typeof computeFinalVerdict>[0]> = {}) {
  return {
    goalAuditCanProceed: true,
    goalReadinessScore: 90,
    hasUnrecoveredJsonFailure: false,
    testQualityScore: 95,
    publicDelta: 5,
    holdoutDelta: 2,
    seriousRegressionCount: 0,
    criticalFailuresAfter: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
    ...overrides,
  };
}

test("goal canProceed=false -> blocked_by_goal", () => {
  const verdict = computeFinalVerdict(makeBaseInput({ goalAuditCanProceed: false }));
  assert.equal(verdict.label, "blocked_by_goal");
  assert.equal(verdict.humanReviewRequired, true);
});

test("unrecovered JSON failure -> blocked_by_json", () => {
  const verdict = computeFinalVerdict(makeBaseInput({ hasUnrecoveredJsonFailure: true }));
  assert.equal(verdict.label, "blocked_by_json");
  assert.equal(verdict.humanReviewRequired, true);
});

test("seriousRegressionCount=1 -> rejected", () => {
  const verdict = computeFinalVerdict(makeBaseInput({ seriousRegressionCount: 1 }));
  assert.equal(verdict.label, "rejected");
  assert.ok(verdict.reasons.some((r) => r.includes("严重局部退步")));
});

test("criticalFailuresAfter=1 -> rejected", () => {
  const verdict = computeFinalVerdict(makeBaseInput({ criticalFailuresAfter: 1 }));
  assert.equal(verdict.label, "rejected");
  assert.ok(verdict.reasons.some((r) => r.includes("关键安全类失败")));
});

test("severeScopeBloatCount=1 -> rejected", () => {
  const verdict = computeFinalVerdict(makeBaseInput({ severeScopeBloatCount: 1 }));
  assert.equal(verdict.label, "rejected");
  assert.ok(verdict.reasons.some((r) => r.includes("严重范围膨胀")));
});

test("severeOverRefusalCount=1 -> rejected", () => {
  const verdict = computeFinalVerdict(makeBaseInput({ severeOverRefusalCount: 1 }));
  assert.equal(verdict.label, "rejected");
  assert.ok(verdict.reasons.some((r) => r.includes("严重过度拒绝")));
});

test("public_delta=3, holdout_delta=1, no severe issues -> accepted", () => {
  const verdict = computeFinalVerdict(makeBaseInput({
    publicDelta: 3,
    holdoutDelta: 1,
    goalReadinessScore: 85,
    testQualityScore: 92,
  }));
  assert.equal(verdict.label, "accepted");
  assert.equal(verdict.humanReviewRequired, false);
});

test("public_delta=1, no severe issues -> needs_review", () => {
  const verdict = computeFinalVerdict(makeBaseInput({
    publicDelta: 1,
    holdoutDelta: 0,
  }));
  assert.equal(verdict.label, "needs_review");
  assert.equal(verdict.humanReviewRequired, true);
});

test("baseline already meets target -> already_good without human review", () => {
  const verdict = computeFinalVerdict(makeBaseInput({
    baselineAlreadyPassed: true,
    publicDelta: 0,
    holdoutDelta: -1,
  }));
  assert.equal(verdict.label, "already_good");
  assert.equal(verdict.humanReviewRequired, false);
});

test("holdoutDelta < 0 -> needs_review (not rejected)", () => {
  const verdict = computeFinalVerdict(makeBaseInput({
    holdoutDelta: -1,
    publicDelta: 5,
  }));
  assert.equal(verdict.label, "needs_review");
});

test("testQualityScore < 90 -> needs_review", () => {
  const verdict = computeFinalVerdict(makeBaseInput({
    testQualityScore: 85,
  }));
  assert.equal(verdict.label, "needs_review");
});

test("priority: blocked_by_goal takes precedence over blocked_by_json", () => {
  const verdict = computeFinalVerdict(makeBaseInput({
    goalAuditCanProceed: false,
    hasUnrecoveredJsonFailure: true,
  }));
  assert.equal(verdict.label, "blocked_by_goal");
});

test("priority: rejected takes precedence over accepted", () => {
  const verdict = computeFinalVerdict(makeBaseInput({
    seriousRegressionCount: 1,
    publicDelta: 10,
    holdoutDelta: 5,
  }));
  assert.equal(verdict.label, "rejected");
});
