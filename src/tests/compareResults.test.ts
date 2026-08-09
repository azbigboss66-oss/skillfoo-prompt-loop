import { test } from "node:test";
import assert from "node:assert/strict";
import { compareResults, countCriticalFailuresAfter } from "../report/compareResults.js";
import type { EvalResult } from "../types.js";

function makeResult(
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

test("before fail 40 -> after pass 90 appears in fixedBadcases", () => {
  const before = [makeResult("t1", "normal", 40, false)];
  const after = [makeResult("t1", "normal", 90, true)];
  const result = compareResults(before, after, repairScoreThreshold);
  assert.equal(result.fixedBadcases.length, 1);
  assert.equal(result.fixedBadcases[0].testId, "t1");
  assert.equal(result.fixedBadcases[0].delta, 50);
});

test("before 90 -> after 60 appears in seriousRegressions", () => {
  const before = [makeResult("t1", "normal", 90, true)];
  const after = [makeResult("t1", "normal", 60, false)];
  const result = compareResults(before, after, repairScoreThreshold);
  assert.ok(result.seriousRegressions.some((c) => c.testId === "t1"));
  assert.ok(result.regressions.some((c) => c.testId === "t1"));
});

test("after 75 with repairScoreThreshold 85 appears in remainingFailures", () => {
  const before = [makeResult("t1", "normal", 50, false)];
  const after = [makeResult("t1", "normal", 75, true)];
  const result = compareResults(before, after, repairScoreThreshold);
  assert.ok(result.remainingFailures.some((c) => c.testId === "t1"));
});

test("improved but not fixed appears in improved", () => {
  const before = [makeResult("t1", "normal", 88, true)];
  const after = [makeResult("t1", "normal", 92, true)];
  const result = compareResults(before, after, repairScoreThreshold);
  assert.ok(result.improved.some((c) => c.testId === "t1"));
  assert.equal(result.fixedBadcases.length, 0);
});

test("unchanged score appears in unchanged", () => {
  const before = [makeResult("t1", "normal", 85, true)];
  const after = [makeResult("t1", "normal", 85, true)];
  const result = compareResults(before, after, repairScoreThreshold);
  assert.ok(result.unchanged.some((c) => c.testId === "t1"));
});

test("fixedBadcases sorted by delta descending", () => {
  const before = [
    makeResult("t1", "normal", 30, false),
    makeResult("t2", "normal", 50, false),
  ];
  const after = [
    makeResult("t1", "normal", 90, true),
    makeResult("t2", "normal", 88, true),
  ];
  const result = compareResults(before, after, repairScoreThreshold);
  assert.equal(result.fixedBadcases[0].testId, "t1");
  assert.equal(result.fixedBadcases[1].testId, "t2");
});

test("seriousRegressions sorted by delta ascending", () => {
  const before = [
    makeResult("t1", "normal", 90, true),
    makeResult("t2", "normal", 85, true),
  ];
  const after = [
    makeResult("t1", "normal", 60, false),
    makeResult("t2", "normal", 50, false),
  ];
  const result = compareResults(before, after, repairScoreThreshold);
  assert.equal(result.seriousRegressions[0].testId, "t2");
  assert.equal(result.seriousRegressions[1].testId, "t1");
});

test("countCriticalFailuresAfter counts privacy/adversarial/hallucination failures", () => {
  const after = [
    makeResult("t1", "privacy", 40, false),
    makeResult("t2", "adversarial", 90, true),
    makeResult("t3", "hallucination", 30, false),
    makeResult("t4", "normal", 50, false),
  ];
  assert.equal(countCriticalFailuresAfter(after), 2);
});

test("cases not in before are skipped", () => {
  const before = [makeResult("t1", "normal", 40, false)];
  const after = [
    makeResult("t1", "normal", 90, true),
    makeResult("t2", "normal", 90, true),
  ];
  const result = compareResults(before, after, repairScoreThreshold);
  assert.equal(result.fixedBadcases.length, 1);
  assert.equal(result.fixedBadcases[0].testId, "t1");
});
