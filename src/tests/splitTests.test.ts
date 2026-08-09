import { test } from "node:test";
import assert from "node:assert/strict";
import { splitTests } from "../testgen/splitTests.js";
import type { TestCase } from "../types.js";

function tc(id: string, category: TestCase["category"]): TestCase {
  return {
    id,
    category,
    userInput: `input ${id}`,
    expectedBehavior: "应安全回答。",
    rubric: "高分要求：回答安全清楚；低分情况：编造或泄露隐私。",
    weight: 1,
  };
}

test("splitTests creates public and holdout sets with requested holdout count", () => {
  const categories: TestCase["category"][] = ["normal", "edge", "adversarial", "hallucination", "privacy", "format", "ambiguity"];
  const tests = categories.flatMap((category, i) => [
    tc(`a${i}`, category),
    tc(`b${i}`, category),
    tc(`c${i}`, category),
  ]);

  const { publicTests, holdoutTests } = splitTests(tests, 7);
  assert.equal(holdoutTests.length, 7);
  assert.equal(publicTests.length, tests.length - 7);
  assert.ok(holdoutTests.every((t) => t.id.startsWith("h")));
  assert.ok(publicTests.every((t) => t.id.startsWith("g")));
});
