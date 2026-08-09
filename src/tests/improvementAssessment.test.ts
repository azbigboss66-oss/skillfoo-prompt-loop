import { test } from "node:test";
import assert from "node:assert/strict";
import { assessImprovement } from "../supervisor/assessImprovement.js";
import type { EvalResult, Summary } from "../types.js";

function summary(score: number): Summary {
  return {
    promptVersion: "x",
    total: 1,
    passed: 1,
    failed: 0,
    passRate: 1,
    weightedAverageScore: score,
    finalScore: score,
  };
}

function result(id: string, score: number, category = "normal", pass = true): EvalResult {
  return {
    testId: id,
    category,
    promptVersion: "x",
    userInput: "input",
    modelOutput: "output",
    pass,
    score,
    reason: "reason",
    weight: 1,
  };
}

test("assessImprovement labels clear improvement when public and holdout improve", () => {
  const assessment = assessImprovement({
    baselinePublicSummary: summary(80),
    bestPublicSummary: summary(90),
    baselinePublicResults: [result("p1", 80)],
    bestPublicResults: [result("p1", 90)],
    baselineHoldoutSummary: summary(82),
    bestHoldoutSummary: summary(88),
    baselineHoldoutResults: [result("h1", 82)],
    bestHoldoutResults: [result("h1", 88)],
    repairScoreThreshold: 85,
  });
  assert.equal(assessment.label, "clear_improvement");
});

test("assessImprovement labels overfit risk when public improves but holdout does not", () => {
  const assessment = assessImprovement({
    baselinePublicSummary: summary(80),
    bestPublicSummary: summary(92),
    baselinePublicResults: [result("p1", 80)],
    bestPublicResults: [result("p1", 92)],
    baselineHoldoutSummary: summary(85),
    bestHoldoutSummary: summary(84),
    baselineHoldoutResults: [result("h1", 85)],
    bestHoldoutResults: [result("h1", 84)],
    repairScoreThreshold: 85,
  });
  assert.equal(assessment.label, "overfit_risk");
});

test("assessImprovement labels regression when critical case fails after", () => {
  const assessment = assessImprovement({
    baselinePublicSummary: summary(80),
    bestPublicSummary: summary(90),
    baselinePublicResults: [result("p1", 80, "privacy", true)],
    bestPublicResults: [result("p1", 70, "privacy", false)],
    repairScoreThreshold: 85,
  });
  assert.equal(assessment.label, "regression");
});
