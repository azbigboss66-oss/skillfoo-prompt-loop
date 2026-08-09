import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPromptLoop } from "../loop/runPromptLoop.js";
import type { Project } from "../config/loadProject.js";

function makeProject(): Project {
  const testCase = {
    id: "main-001",
    category: "normal" as const,
    userInput: "你好",
    expectedBehavior: "礼貌回答",
    rubric: "回答应礼貌清楚",
    weight: 1,
  };
  return {
    projectDir: tmpdir(),
    prompt: "你是一个客服助手。请回答用户的问题。",
    goal: "提供礼貌、清楚且不虚构能力的客服回答。",
    tests: [testCase],
    holdoutTests: [],
    config: {
      projectName: "promptfoo-main-loop-test",
      targetScore: 60,
      maxIters: 1,
      minImprovement: 2,
      candidateCount: 1,
      provider: { type: "mock" },
      optimizationEngine: "promptfoo",
      runtime: { maxConcurrency: 1, cache: false, retryErrors: false, repeat: 1 },
    },
    evaluationPolicy: { casePassScore: 80, repairScoreThreshold: 85 },
  };
}

test("main loop uses Promptfoo eval and writes public evidence", async () => {
  const runDir = join(tmpdir(), `skillfoo-main-loop-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    const result = await runPromptLoop(
      {
        name: "mock",
        chat: async (messages) => {
          const text = messages.map((message) => message.content).join("\n");
          if (text.includes("REPAIR_PROMPT_JSON")) {
            return JSON.stringify([{
              id: "candidate-1",
              hypothesis: "quality probe",
              prompt: "你是一个客服助手。请回答用户的问题，并保持安全边界。",
              changeSummary: ["补充安全边界"],
            }]);
          }
          return "mock response";
        },
      },
      makeProject(),
      runDir,
      1,
      60,
      { outputMode: "debug" as const }
    );

    assert.ok(result.ledger.some((entry) => entry.status === "baseline"));
    assert.ok(result.ledger.some((entry) => entry.status === "rollback" || entry.status === "keep"));
    const raw = JSON.parse(await readFile(join(runDir, "debug", "promptfoo", "raw-results.json"), "utf8"));
    assert.ok(raw, "Promptfoo raw results should be present");
    const summary = JSON.parse(await readFile(join(runDir, "debug", "baseline-summary.json"), "utf8"));
    assert.equal(summary.promptVersion, "baseline");
    const command = await readFile(join(runDir, "debug", "promptfoo", "command.txt"), "utf8");
    assert.match(command, /evaluate\(\)/);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
