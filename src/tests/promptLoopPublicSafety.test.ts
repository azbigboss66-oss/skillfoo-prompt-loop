import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPromptLoop } from "../loop/runPromptLoop.js";
import type { Project } from "../config/loadProject.js";
import type { ModelProvider, ChatMessage } from "../providers/types.js";

const baselinePrompt = "你是一个客服助手。请回答用户的问题。";
const unsafeCandidatePrompt = "你是一个客服助手。请回答用户的问题。标记不安全候选A。";
const safeCandidatePrompt = "你是一个客服助手。请回答用户的问题。请保持安全边界。标记安全候选B。";

function makeProject(): Project {
  return {
    projectDir: tmpdir(),
    prompt: baselinePrompt,
    goal: "提供礼貌、清楚且不虚构能力的客服回答。",
    tests: [
      {
        id: "g011",
        category: "normal" as const,
        userInput: "g011-input",
        expectedBehavior: "g011-expected",
        rubric: "g011-rubric",
        weight: 1,
      },
      {
        id: "g012",
        category: "normal" as const,
        userInput: "g012-input",
        expectedBehavior: "g012-expected",
        rubric: "g012-rubric",
        weight: 1,
      },
    ],
    holdoutTests: [],
    config: {
      projectName: "public-safety-test",
      targetScore: 80,
      maxIters: 1,
      minImprovement: 2,
      candidateCount: 2,
      provider: { type: "mock" },
      optimizationEngine: "legacy",
      runtime: { maxConcurrency: 1, cache: false, retryErrors: false, repeat: 1 },
    },
    evaluationPolicy: { casePassScore: 80, repairScoreThreshold: 85 },
  };
}

function createProvider(): ModelProvider {
  return {
    name: "mock-public-safety",
    async chat(messages: ChatMessage[]): Promise<string> {
      const fullText = messages.map((m) => m.content).join("\n");

      // Candidate generation
      if (fullText.includes("REPAIR_PROMPT_JSON")) {
        return JSON.stringify([
          {
            id: "candidate-1",
            hypothesis: "unsafe higher aggregate",
            prompt: unsafeCandidatePrompt,
            changeSummary: ["unsafe change"],
          },
          {
            id: "candidate-2",
            hypothesis: "safe moderate improvement",
            prompt: safeCandidatePrompt,
            changeSummary: ["safe change"],
          },
        ]);
      }

      // Judge evaluation
      if (fullText.includes("JUDGE_JSON")) {
        const isUnsafe = fullText.includes("标记不安全候选A");
        const isSafe = fullText.includes("标记安全候选B");
        const isG011 = fullText.includes("g011-input");
        const isG012 = fullText.includes("g012-input");

        if (isUnsafe) {
          if (isG011) return JSON.stringify({ pass: false, score: 70, reason: "regression" });
          if (isG012) return JSON.stringify({ pass: true, score: 100, reason: "improved" });
        }
        if (isSafe) {
          if (isG011) return JSON.stringify({ pass: true, score: 100, reason: "maintained" });
          if (isG012) return JSON.stringify({ pass: true, score: 64, reason: "improved" });
        }
        // Baseline
        if (isG011) return JSON.stringify({ pass: true, score: 100, reason: "baseline good" });
        if (isG012) return JSON.stringify({ pass: false, score: 50, reason: "baseline bad" });
      }

      // Target call (model output)
      return "mock response";
    },
  };
}

test("public safety: loop rejects candidate with serious regression and keeps safe candidate", async () => {
  const runDir = join(tmpdir(), `skillfoo-public-safety-${Date.now()}`);
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

    assert.equal(result.publicBestPrompt, safeCandidatePrompt);
    assert.equal(result.bestPrompt, safeCandidatePrompt);
    assert.ok(result.ledger.some((entry) => entry.status === "keep"));
    const decisions = JSON.parse(await readFile(join(runDir, "debug", "iter-1", "candidate-decisions.json"), "utf8"));
    assert.deepEqual(decisions[0].reasons, ["serious_public_regression"]);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});