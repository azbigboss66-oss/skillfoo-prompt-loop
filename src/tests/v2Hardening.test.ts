import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProject } from "../config/loadProject.js";
import { writeReport } from "../report/writeReport.js";
import type { LoopResult } from "../loop/runPromptLoop.js";

test("loadProject throws when holdout file exists but is invalid JSON", async () => {
  const dir = join(tmpdir(), `skillfoo-invalid-holdout-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prompt.md"), "prompt", "utf-8");
  await writeFile(join(dir, "goal.md"), "goal", "utf-8");
  await writeFile(join(dir, "tests.jsonl"), JSON.stringify({
    id: "t1",
    category: "normal",
    userInput: "hi",
    expectedBehavior: "answer",
    rubric: "clear scoring rubric",
    weight: 1
  }) + "\n", "utf-8");
  await writeFile(join(dir, "holdout-tests.jsonl"), "{bad json}\n", "utf-8");
  await writeFile(join(dir, "skillfoo.config.json"), JSON.stringify({
    projectName: "tmp",
    targetScore: 90,
    maxIters: 1,
    minImprovement: 2,
    candidateCount: 1,
    provider: { type: "mock" }
  }), "utf-8");

  await assert.rejects(() => loadProject(dir));
  await rm(dir, { recursive: true, force: true });
});

test("writeReport marks rollback as not exercised when no rollback happened", async () => {
  const runDir = join(tmpdir(), `skillfoo-report-${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  const result: LoopResult = {
    runDir,
    bestPrompt: "prompt",
    bestScore: 91,
    targetScore: 90,
    targetReached: true,
    ledger: [{
      iteration: 1,
      promptVersion: "candidate-1",
      status: "keep",
      score: 91,
      passRate: 1,
      passed: 1,
      failed: 0,
      summary: "kept"
    }],
    lastResults: [],
    baselinePublicSummary: {
      promptVersion: "baseline",
      total: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      weightedAverageScore: 91,
      finalScore: 91,
    },
    baselinePublicResults: [],
    stopReason: "target_reached",
    rollbackExercised: false,
    promptChangeAnalyses: [],
    originalPrompt: "prompt",
    publicBestPrompt: "prompt",
    publicBestScore: 91,
    publicBestResults: [],
    publicBestSummary: {
      promptVersion: "baseline",
      total: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      weightedAverageScore: 91,
      finalScore: 91,
    },
  };

  await writeReport(runDir, "tmp", result, 85);
  const report = await readFile(join(runDir, "report.md"), "utf-8");
  assert.match(report, /Rollback protected best prompt \| not exercised/);
  await rm(runDir, { recursive: true, force: true });
});
