import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProject } from "../config/loadProject.js";

test("loadProject applies evaluation policy defaults", async () => {
  const dir = join(tmpdir(), `skillfoo-policy-default-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "prompt.md"), "你是客服助手", "utf-8");
  await writeFile(join(dir, "goal.md"), "安全回答", "utf-8");
  await writeFile(
    join(dir, "skillfoo.config.json"),
    JSON.stringify({
      projectName: "tmp",
      targetScore: 90,
      maxIters: 2,
      minImprovement: 2,
      candidateCount: 2,
      provider: { type: "mock" }
    }),
    "utf-8"
  );
  await writeFile(
    join(dir, "tests.jsonl"),
    JSON.stringify({
      id: "t1",
      category: "normal",
      userInput: "hi",
      expectedBehavior: "answer",
      rubric: "score behavior",
      weight: 1
    }) + "\n",
    "utf-8"
  );

  const project = await loadProject(dir);
  assert.equal(project.evaluationPolicy.casePassScore, 80);
  assert.equal(project.evaluationPolicy.repairScoreThreshold, 85);
  assert.deepEqual(project.holdoutTests, []);

  await rm(dir, { recursive: true, force: true });
});

test("loadProject reads configured thresholds and optional holdout tests", async () => {
  const dir = join(tmpdir(), `skillfoo-policy-custom-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "prompt.md"), "你是客服助手", "utf-8");
  await writeFile(join(dir, "goal.md"), "安全回答", "utf-8");
  await writeFile(
    join(dir, "skillfoo.config.json"),
    JSON.stringify({
      projectName: "tmp",
      targetScore: 90,
      maxIters: 2,
      minImprovement: 2,
      candidateCount: 2,
      casePassScore: 82,
      repairScoreThreshold: 88,
      holdoutTestsPath: "holdout-tests.jsonl",
      provider: { type: "mock" }
    }),
    "utf-8"
  );

  const line = JSON.stringify({
    id: "t1",
    category: "normal",
    userInput: "hi",
    expectedBehavior: "answer",
    rubric: "score behavior",
    weight: 1
  }) + "\n";

  await writeFile(join(dir, "tests.jsonl"), line, "utf-8");
  await writeFile(join(dir, "holdout-tests.jsonl"), line, "utf-8");

  const project = await loadProject(dir);
  assert.equal(project.evaluationPolicy.casePassScore, 82);
  assert.equal(project.evaluationPolicy.repairScoreThreshold, 88);
  assert.equal(project.holdoutTests.length, 1);

  await rm(dir, { recursive: true, force: true });
});
