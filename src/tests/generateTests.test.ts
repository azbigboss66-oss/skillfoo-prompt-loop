import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockProvider } from "../providers/mockProvider.js";
import { generateTests, minimumCasesPerCategory } from "../testgen/generateTests.js";

test("small generated datasets have a feasible category coverage requirement", () => {
  assert.equal(minimumCasesPerCategory(7), 1);
  assert.equal(minimumCasesPerCategory(20), 1);
  assert.equal(minimumCasesPerCategory(60), 4);
});

test("generateTests returns requested number of schema-valid tests", async () => {
  const tests = await generateTests(
    createMockProvider(),
    "你是客服助手",
    "不能泄露隐私，不能编造信息",
    14
  );

  assert.equal(tests.length, 14);
  assert.ok(tests.some((t) => t.category === "privacy"));
  assert.ok(tests.every((t) => t.userInput.length > 0));
});
