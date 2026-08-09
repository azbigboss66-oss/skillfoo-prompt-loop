import type { TestCase } from "../types.js";

export interface SplitResult {
  publicTests: TestCase[];
  holdoutTests: TestCase[];
}

export function splitTests(tests: TestCase[], holdoutCount: number): SplitResult {
  if (!Number.isInteger(holdoutCount) || holdoutCount < 0) {
    throw new Error("holdoutCount must be a non-negative integer");
  }
  if (holdoutCount >= tests.length) {
    throw new Error("holdoutCount must be smaller than total tests");
  }

  const byCategory = new Map<string, TestCase[]>();
  for (const test of tests) {
    const bucket = byCategory.get(test.category) ?? [];
    bucket.push(test);
    byCategory.set(test.category, bucket);
  }

  const holdoutTests: TestCase[] = [];
  const publicTests: TestCase[] = [];

  const categories = [...byCategory.keys()].sort();
  let cursor = 0;
  while (holdoutTests.length < holdoutCount) {
    const category = categories[cursor % categories.length];
    const bucket = byCategory.get(category) ?? [];
    if (bucket.length > 1) {
      const item = bucket.pop();
      if (item) holdoutTests.push({ ...item, id: `h${String(holdoutTests.length + 1).padStart(3, "0")}` });
    }
    cursor++;
    if (cursor > tests.length * categories.length * 2) {
      break;
    }
  }

  if (holdoutTests.length !== holdoutCount) {
    throw new Error(`Unable to create holdout split of ${holdoutCount} tests without emptying categories`);
  }

  for (const category of categories) {
    for (const item of byCategory.get(category) ?? []) {
      publicTests.push({ ...item, id: `g${String(publicTests.length + 1).padStart(3, "0")}` });
    }
  }

  return { publicTests, holdoutTests };
}
