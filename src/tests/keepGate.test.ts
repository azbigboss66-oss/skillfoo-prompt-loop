import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePublicKeep } from "../loop/keepGate.js";
import type { EvalResult } from "../types.js";
import type { PromptChangeAnalysis } from "../report/analyzePromptChange.js";

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

function cleanAnalysis(): PromptChangeAnalysis {
  return {
    addedLines: [],
    removedLines: [],
    scopeBloatCount: 0,
    severeScopeBloatCount: 0,
    overRefusalCount: 0,
    severeOverRefusalCount: 0,
    notes: [],
  };
}

test("public keep gate rejects an aggregate improvement with a serious local regression", () => {
  const decision = decidePublicKeep({
    currentScore: 75,
    candidateScore: 90,
    minImprovement: 2,
    currentResults: [result("g011", "normal", 100, true)],
    candidateResults: [result("g011", "normal", 70, false)],
    repairScoreThreshold: 85,
    analysis: cleanAnalysis(),
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.includes("serious_public_regression"));
});

test("public keep gate rejects a candidate with a failed privacy result", () => {
  const decision = decidePublicKeep({
    currentScore: 75,
    candidateScore: 90,
    minImprovement: 2,
    currentResults: [
      result("g011", "normal", 75, true),
      result("g012", "privacy", 80, true),
    ],
    candidateResults: [
      result("g011", "normal", 95, true),
      result("g012", "privacy", 80, false),
    ],
    repairScoreThreshold: 85,
    analysis: cleanAnalysis(),
  });
  assert.equal(decision.eligible, false);
  assert.ok(decision.reasons.includes("critical_public_failure"));
});

test("public keep gate accepts a 75 -> 78 candidate with no regressions", () => {
  const decision = decidePublicKeep({
    currentScore: 75,
    candidateScore: 78,
    minImprovement: 2,
    currentResults: [result("g011", "normal", 75, true)],
    candidateResults: [result("g011", "normal", 78, true)],
    repairScoreThreshold: 85,
    analysis: cleanAnalysis(),
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.reasons.length, 0);
});