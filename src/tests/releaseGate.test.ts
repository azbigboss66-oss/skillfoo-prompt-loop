import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRelease } from "../loop/releaseGate.js";
import type { EvalResult } from "../types.js";

function result(
  testId: string,
  category: string,
  score: number,
  pass: boolean,
  userInput = "test",
  modelOutput = "output",
  reason = "reason"
): EvalResult {
  return {
    testId,
    category,
    promptVersion: "v",
    userInput,
    modelOutput,
    pass,
    score,
    reason,
    weight: 1,
  };
}

const repairScoreThreshold = 85;

test("release gate rolls back when holdout aggregate improves but one case seriously regresses", () => {
  const decision = decideRelease({
    publicKeepOccurred: true,
    publicBestPromptVersion: "candidate-1",
    baselineHoldoutResults: [
      result("h001", "normal", 100, true),
      result("h002", "normal", 30, false),
    ],
    candidateHoldoutResults: [
      result("h001", "normal", 40, false),
      result("h002", "normal", 100, true),
    ],
    repairScoreThreshold,
  });
  assert.equal(decision.status, "final_holdout_rollback");
  assert.equal(decision.releasedPromptVersion, "baseline");
  assert.ok(decision.holdoutDelta !== undefined && decision.holdoutDelta >= 0);
  assert.ok(decision.holdoutComparison !== undefined);
  assert.ok(decision.holdoutComparison!.seriousRegressions.length > 0);
});

test("release gate releases public best when all holdout scores are unchanged or improved", () => {
  const decision = decideRelease({
    publicKeepOccurred: true,
    publicBestPromptVersion: "candidate-1",
    baselineHoldoutResults: [
      result("h001", "normal", 80, true),
    ],
    candidateHoldoutResults: [
      result("h001", "normal", 90, true),
    ],
    repairScoreThreshold,
  });
  assert.equal(decision.status, "released_public_best");
  assert.equal(decision.releasedPromptVersion, "candidate-1");
  assert.ok(decision.holdoutDelta !== undefined && decision.holdoutDelta >= 0);
});

test("release gate rolls back when candidate holdout has a privacy failure", () => {
  const decision = decideRelease({
    publicKeepOccurred: true,
    publicBestPromptVersion: "candidate-1",
    baselineHoldoutResults: [
      result("h001", "normal", 80, true),
      result("h002", "privacy", 80, true),
    ],
    candidateHoldoutResults: [
      result("h001", "normal", 90, true),
      result("h002", "privacy", 80, false),
    ],
    repairScoreThreshold,
  });
  assert.equal(decision.status, "final_holdout_rollback");
  assert.equal(decision.releasedPromptVersion, "baseline");
  assert.ok(decision.criticalFailuresAfter !== undefined && decision.criticalFailuresAfter > 0);
});

test("release gate returns unverified when no holdout result exists", () => {
  const decision = decideRelease({
    publicKeepOccurred: true,
    publicBestPromptVersion: "candidate-1",
    baselineHoldoutResults: undefined,
    candidateHoldoutResults: undefined,
    repairScoreThreshold,
  });
  assert.equal(decision.status, "unverified_no_holdout");
  assert.equal(decision.releasedPromptVersion, "candidate-1");
});

test("release gate releases baseline when no public candidate was kept", () => {
  const decision = decideRelease({
    publicKeepOccurred: false,
    publicBestPromptVersion: undefined,
    baselineHoldoutResults: [
      result("h001", "normal", 80, true),
    ],
    candidateHoldoutResults: undefined,
    repairScoreThreshold,
  });
  assert.equal(decision.status, "released_baseline_no_public_keep");
  assert.equal(decision.releasedPromptVersion, "baseline");
});