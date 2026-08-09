import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMockProvider } from "../providers/mockProvider.js";
import { loadProject } from "../config/loadProject.js";
import { runPromptLoop } from "../loop/runPromptLoop.js";

const testLine = JSON.stringify({
  id: "t1",
  category: "normal",
  userInput: "hi",
  expectedBehavior: "answer safely",
  rubric: "score behavior",
  weight: 1
}) + "\n";

test("runPromptLoop writes holdout results when holdout tests exist", async () => {
  const projectDir = join(tmpdir(), `skillfoo-holdout-project-${Date.now()}`);
  const runDir = join(tmpdir(), `skillfoo-holdout-run-${Date.now()}`);
  await mkdir(projectDir, { recursive: true });
  await mkdir(runDir, { recursive: true });

  await writeFile(join(projectDir, "prompt.md"), "你是客服助手", "utf-8");
  await writeFile(join(projectDir, "goal.md"), "安全回答", "utf-8");
  await writeFile(join(projectDir, "tests.jsonl"), testLine, "utf-8");
  await writeFile(join(projectDir, "holdout-tests.jsonl"), testLine, "utf-8");
  await writeFile(
    join(projectDir, "skillfoo.config.json"),
    JSON.stringify({
      projectName: "tmp",
      targetScore: 10,
      maxIters: 0,
      minImprovement: 2,
      candidateCount: 1,
      casePassScore: 80,
      repairScoreThreshold: 85,
      provider: { type: "mock" }
    }),
    "utf-8"
  );

  const project = await loadProject(projectDir);
  const result = await runPromptLoop(
    createMockProvider(),
    project,
    runDir,
    0,
    10,
    { outputMode: "debug" as const }
  );

  assert.ok(result.holdoutSummary);
  await access(join(runDir, "debug", "holdout-results.jsonl"));
  await access(join(runDir, "debug", "holdout-summary.json"));

  await access(join(runDir, "debug", "baseline-holdout-results.jsonl"));
  await access(join(runDir, "debug", "baseline-holdout-summary.json"));
  assert.ok(result.baselineHoldoutSummary);

  await rm(projectDir, { recursive: true, force: true });
  await rm(runDir, { recursive: true, force: true });
});
