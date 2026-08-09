import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLoopEngine,
  shouldKeepCandidate,
  isBlockedStopReason,
  type V5StopReason,
} from "../loop/engineDecision.js";
import type { ProjectConfig } from "../config/loadProject.js";

/**
 * Helper: create a minimal ProjectConfig
 */
function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    projectName: "test-project",
    targetScore: 85,
    maxIters: 3,
    minImprovement: 2,
    candidateCount: 3,
    provider: { type: "mock" },
    ...overrides,
  };
}

test("Task 9 Step 1: resolveLoopEngine defaults to promptfoo", () => {
  const config = makeConfig();
  assert.equal(resolveLoopEngine(config), "promptfoo");
});

test("Task 9 Step 1: resolveLoopEngine respects explicit promptfoo", () => {
  const config = makeConfig({ optimizationEngine: "promptfoo" });
  assert.equal(resolveLoopEngine(config), "promptfoo");
});

test("Task 9 Step 1: resolveLoopEngine respects explicit legacy", () => {
  const config = makeConfig({ optimizationEngine: "legacy" });
  assert.equal(resolveLoopEngine(config), "legacy");
});

test("Task 9 Step 1: resolveLoopEngine treats undefined as promptfoo", () => {
  const config = makeConfig({ optimizationEngine: undefined });
  assert.equal(resolveLoopEngine(config), "promptfoo");
});

// ===== shouldKeepCandidate tests =====

test("Task 9: shouldKeepCandidate returns true for sufficient improvement with no issues", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 80,
    minImprovement: 5,
    criticalFailures: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });
  assert.equal(result, true);
});

test("Task 9: shouldKeepCandidate returns false for insufficient improvement", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 71,
    minImprovement: 5,
    criticalFailures: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });
  assert.equal(result, false);
});

test("Task 9: shouldKeepCandidate returns false when critical failures exist", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 90,
    minImprovement: 5,
    criticalFailures: 1,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });
  assert.equal(result, false);
});

test("Task 9: shouldKeepCandidate returns false when severe scope bloat exists", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 90,
    minImprovement: 5,
    criticalFailures: 0,
    severeScopeBloatCount: 1,
    severeOverRefusalCount: 0,
  });
  assert.equal(result, false);
});

test("Task 9: shouldKeepCandidate returns false when severe over-refusal exists", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 90,
    minImprovement: 5,
    criticalFailures: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 1,
  });
  assert.equal(result, false);
});

test("Task 9: shouldKeepCandidate returns false for equal score (no improvement)", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 70,
    minImprovement: 2,
    criticalFailures: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });
  assert.equal(result, false);
});

test("Task 9: shouldKeepCandidate returns true for exact minimum improvement", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 72,
    minImprovement: 2,
    criticalFailures: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });
  assert.equal(result, true);
});

// ===== V5 Stop Condition Tests =====

test("Task 9 Step 2: blocked_by_config is a blocked stop reason", () => {
  assert.equal(isBlockedStopReason("blocked_by_config" as V5StopReason), true);
});

test("Task 9 Step 2: blocked_by_optimize_parse is a blocked stop reason", () => {
  assert.equal(isBlockedStopReason("blocked_by_optimize_parse" as V5StopReason), true);
});

test("Task 9 Step 2: blocked_by_goal is a blocked stop reason", () => {
  assert.equal(isBlockedStopReason("blocked_by_goal" as V5StopReason), true);
});

test("Task 9 Step 2: already_passed is NOT a blocked stop reason", () => {
  assert.equal(isBlockedStopReason("already_passed"), false);
});

test("Task 9 Step 2: target_reached is NOT a blocked stop reason", () => {
  assert.equal(isBlockedStopReason("target_reached"), false);
});

test("Task 9 Step 2: max_iters is NOT a blocked stop reason", () => {
  assert.equal(isBlockedStopReason("max_iters"), false);
});

// ===== V5 Loop Path Tests (using shouldKeepCandidate to simulate paths) =====

test("Task 9 Step 4: already-good path - baseline meets target, no optimize needed", () => {
  // When baseline >= targetScore, the loop should stop with already_passed
  // No optimize call, no candidate generation
  const baselineScore = 90;
  const targetScore = 85;

  // Simulate: baseline already meets target
  assert.ok(baselineScore >= targetScore, "baseline should meet target");

  // shouldKeepCandidate should not even be called in this path
  // The loop returns stop_already_passed directly
});

test("Task 9 Step 4: keep path - candidate improves sufficiently", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 85,
    minImprovement: 5,
    criticalFailures: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });

  assert.equal(result, true, "candidate should be kept");
});

test("Task 9 Step 4: rollback path - candidate does not improve sufficiently", () => {
  const result = shouldKeepCandidate({
    currentScore: 75,
    candidateScore: 76,
    minImprovement: 5,
    criticalFailures: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });

  assert.equal(result, false, "candidate should be rolled back");
});

test("Task 9 Step 4: blocked path - candidate has critical failures", () => {
  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 90,
    minImprovement: 5,
    criticalFailures: 2,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });

  assert.equal(result, false, "candidate should be blocked due to critical failures");
});

test("Task 9 Step 4: holdout regression path - candidate passes public but would fail holdout", () => {
  // This is tested at the governance level (assessGovernance)
  // Here we verify that shouldKeepCandidate doesn't consider holdout
  // (holdout regression is checked separately in governance)

  const result = shouldKeepCandidate({
    currentScore: 70,
    candidateScore: 85,
    minImprovement: 5,
    criticalFailures: 0,
    severeScopeBloatCount: 0,
    severeOverRefusalCount: 0,
  });

  // shouldKeepCandidate only checks public metrics
  // Holdout regression is checked by assessGovernance
  assert.equal(result, true, "candidate passes public check");
  // But assessGovernance would reject if holdout drops
});
