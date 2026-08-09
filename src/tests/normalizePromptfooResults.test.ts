import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePromptfooResults } from "../promptfoo/normalizePromptfooResults.js";

test("a failed rubric is a badcase, not a provider failure", () => {
  const [result] = normalizePromptfooResults({
    results: [{
      id: "failed-rubric",
      success: false,
      score: 0,
      error: "The answer skipped the required clarification.",
      testCase: { vars: { testId: "g004", userInput: "我要投诉" } },
      response: { output: "请拨打客服热线" },
      gradingResult: {
        pass: false,
        score: 0,
        reason: "The answer skipped the required clarification.",
      },
    }],
  });

  assert.equal(result.pass, false);
  assert.equal(result.score, 0);
  assert.equal(result.error, undefined);
});

test("a provider failure remains an execution error", () => {
  const [result] = normalizePromptfooResults({
    results: [{
      id: "provider-error",
      success: false,
      score: 0,
      error: "API error: 401 Authorization Required",
      testCase: { vars: { testId: "g005", userInput: "test" } },
      response: { error: "API error: 401 Authorization Required" },
    }],
  });

  assert.equal(result.error, "API error: 401 Authorization Required");
});
