import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPromptLoop } from "../loop/runPromptLoop.js";
import type { Project } from "../config/loadProject.js";
import type { ModelProvider, ChatMessage } from "../providers/types.js";

const baselinePrompt = "你是一个客服助手。请回答用户的问题。";
const candidatePrompt = "你是一个客服助手。请回答用户的问题。改进版本。标记候选A。";

function makeProject(): Project {
  return {
    projectDir: tmpdir(),
    prompt: baselinePrompt,
    goal: "提供礼貌、清楚且不虚构能力的客服回答。",
    tests: [
      {
        id: "pub-001",
        category: "normal" as const,
        userInput: "pub-001-input",
        expectedBehavior: "pub-001-expected",
        rubric: "pub-001-rubric",
        weight: 1,
      },
    ],
    holdoutTests: [
      {
        id: "hold-001",
        category: "normal" as const,
        userInput: "hold-001-input",
        expectedBehavior: "hold-001-expected",
        rubric: "hold-001-rubric",
        weight: 1,
      },
    ],
    config: {
      projectName: "release-rollback-test",
      targetScore: 80,
      maxIters: 1,
      minImprovement: 2,
      candidateCount: 1,
      provider: { type: "mock" },
      optimizationEngine: "legacy",
      runtime: { maxConcurrency: 1, cache: false, retryErrors: false, repeat: 1 },
    },
    evaluationPolicy: { casePassScore: 80, repairScoreThreshold: 85 },
  };
}

function createProvider(): ModelProvider {
  return {
    name: "mock-release-rollback",
    async chat(messages: ChatMessage[]): Promise<string> {
      const fullText = messages.map((m) => m.content).join("\n");

      // Candidate generation
      if (fullText.includes("REPAIR_PROMPT_JSON")) {
        return JSON.stringify([
          {
            id: "candidate-1",
            hypothesis: "improves public but degrades holdout",
            prompt: candidatePrompt,
            changeSummary: ["risky change"],
          },
        ]);
      }

      // Judge evaluation
      if (fullText.includes("JUDGE_JSON")) {
        const isCandidate = fullText.includes("标记候选A");
        const isHoldout = fullText.includes("hold-001-input");
        const isPublic = fullText.includes("pub-001-input");

        if (isCandidate) {
          // Candidate: public improves to 90, holdout degrades to 40
          if (isPublic) return JSON.stringify({ pass: true, score: 90, reason: "improved" });
          if (isHoldout) return JSON.stringify({ pass: false, score: 40, reason: "holdout regression" });
        } else {
          // Baseline: public is 60, holdout is 100
          if (isPublic) return JSON.stringify({ pass: false, score: 60, reason: "baseline weak" });
          if (isHoldout) return JSON.stringify({ pass: true, score: 100, reason: "baseline good" });
        }
      }

      // Target call (model output)
      return "mock response";
    },
  };
}

test("release rollback: holdout regression causes release to revert to baseline", async () => {
  const runDir = join(tmpdir(), `skillfoo-release-rollback-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    const result = await runPromptLoop(
      createProvider(),
      makeProject(),
      runDir,
      1,
      80,
      { outputMode: "debug" as const }
    );

    // Release decision should be final_holdout_rollback
    assert.equal(result.releaseDecision?.status, "final_holdout_rollback");

    // Release prompt (bestPrompt) should be baseline, not candidate
    assert.equal(result.bestPrompt, baselinePrompt);

    // best-prompt.md should contain baseline prompt
    const bestPromptFile = await readFile(join(runDir, "best-prompt.md"), "utf8");
    assert.equal(bestPromptFile, baselinePrompt);

    // public-best-prompt.md should contain candidate prompt (evidence only)
    const publicBestPromptFile = await readFile(join(runDir, "debug", "public-best-prompt.md"), "utf8");
    assert.equal(publicBestPromptFile, candidatePrompt);

    // release-decision.json should exist
    const releaseDecision = JSON.parse(await readFile(join(runDir, "debug", "release-decision.json"), "utf8"));
    assert.equal(releaseDecision.status, "final_holdout_rollback");
    assert.equal(releaseDecision.releasedPromptVersion, "baseline");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
