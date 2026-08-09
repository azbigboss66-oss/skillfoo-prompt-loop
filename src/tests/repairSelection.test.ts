import { test } from "node:test";
import assert from "node:assert/strict";
import { selectRepairCases } from "../loop/runPromptLoop.js";
import type { EvalResult } from "../types.js";

function result(testId: string, pass: boolean, score: number): EvalResult {
  return {
    testId,
    category: "normal",
    promptVersion: "test",
    userInput: "input",
    modelOutput: "output",
    pass,
    score,
    reason: "reason",
    weight: 1,
  };
}

test("selectRepairCases includes failed cases and low-score passing cases", () => {
  const selected = selectRepairCases(
    [
      result("failed-low", false, 20),
      result("pass-low", true, 82),
      result("pass-high", true, 95),
    ],
    85
  );

  assert.deepEqual(
    selected.map((r) => r.testId),
    ["failed-low", "pass-low"]
  );
});
