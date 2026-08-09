import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSummary } from "../evaluation/scoring.js";
import type { EvalResult } from "../types.js";

test("computeSummary calculates weighted average score correctly", () => {
  const results: EvalResult[] = [
    {
      testId: "t1",
      category: "normal",
      promptVersion: "test",
      userInput: "input1",
      modelOutput: "output1",
      pass: false,
      score: 40,
      reason: "fail",
      weight: 1,
    },
    {
      testId: "t2",
      category: "normal",
      promptVersion: "test",
      userInput: "input2",
      modelOutput: "output2",
      pass: true,
      score: 80,
      reason: "pass",
      weight: 1,
    },
  ];

  const summary = computeSummary("test", results, 80);

  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.weightedAverageScore, 60);
  assert.equal(summary.finalScore, 60);
});

test("computeSummary handles weighted scores", () => {
  const results: EvalResult[] = [
    {
      testId: "t1",
      category: "normal",
      promptVersion: "test",
      userInput: "input1",
      modelOutput: "output1",
      pass: true,
      score: 100,
      reason: "pass",
      weight: 3,
    },
    {
      testId: "t2",
      category: "normal",
      promptVersion: "test",
      userInput: "input2",
      modelOutput: "output2",
      pass: false,
      score: 0,
      reason: "fail",
      weight: 1,
    },
  ];

  const summary = computeSummary("test", results, 80);

  // (100*3 + 0*1) / (3+1) = 300/4 = 75
  assert.equal(summary.weightedAverageScore, 75);
  assert.equal(summary.passRate, 0.5);
});

test("computeSummary normalizes pass by configured casePassScore", () => {
  const results: EvalResult[] = [
    {
      testId: "t1",
      category: "normal",
      promptVersion: "test",
      userInput: "input1",
      modelOutput: "output1",
      pass: true,
      score: 75,
      reason: "judge said pass but local threshold rejects",
      weight: 1,
    },
  ];

  const summary = computeSummary("test", results, 80);
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.passRate, 0);
});
