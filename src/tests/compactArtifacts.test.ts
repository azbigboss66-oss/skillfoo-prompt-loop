/**
 * Task 1 Failing Tests: Compact Artifacts Five-File Contract
 *
 * Tests:
 * 1. compact root has exactly 5 files, 0 subdirectories, correct names
 * 4. public regression -> best-prompt.md is baseline, log has rejection
 * 5. holdout rollback -> best-prompt.md is baseline, diff has both, log has rollback
 * 6. no badcases -> badcases.jsonl empty, report shows 0
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPromptLoop } from "../loop/runPromptLoop.js";
import type { LoopResult } from "../loop/runPromptLoop.js";
import type { Project } from "../config/loadProject.js";
import type { ModelProvider, ChatMessage } from "../providers/types.js";

const runLoop = runPromptLoop as (
  provider: ModelProvider,
  project: Project,
  runDir: string,
  maxIters: number,
  targetScore: number,
  options?: { outputMode?: "compact" | "debug" },
) => Promise<LoopResult>;

const EXPECTED_FILES = [
  "badcases.jsonl",
  "best-prompt.md",
  "prompt-diff.md",
  "report.md",
  "run-log.jsonl",
];

// ===================== Scenario: Safe Improvement =====================
const SAFE_BASELINE = "你是一个客服助手。请回答用户的问题。";
const SAFE_CANDIDATE = "你是一个客服助手。请回答用户的问题。改进标记SAFE_IMPROVE。";

function makeSafeImprovementProject(): Project {
  return {
    projectDir: tmpdir(),
    prompt: SAFE_BASELINE,
    goal: "提供礼貌、清楚且不虚构能力的客服回答。",
    tests: [
      { id: "pub-001", category: "normal" as const, userInput: "pub-001-input", expectedBehavior: "pub-001-expected", rubric: "pub-001-rubric", weight: 1 },
      { id: "pub-002", category: "normal" as const, userInput: "pub-002-input", expectedBehavior: "pub-002-expected", rubric: "pub-002-rubric", weight: 1 },
    ],
    holdoutTests: [
      { id: "hold-001", category: "normal" as const, userInput: "hold-001-input", expectedBehavior: "hold-001-expected", rubric: "hold-001-rubric", weight: 1 },
    ],
    config: {
      projectName: "compact-safe-improve",
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

function createSafeImprovementProvider(): ModelProvider {
  return {
    name: "mock-safe-improve",
    async chat(messages: ChatMessage[]): Promise<string> {
      const fullText = messages.map((m) => m.content).join("\n");
      if (fullText.includes("REPAIR_PROMPT_JSON")) {
        return JSON.stringify([{ id: "candidate-1", hypothesis: "safe improvement", prompt: SAFE_CANDIDATE, changeSummary: ["safe improvement change"] }]);
      }
      if (fullText.includes("JUDGE_JSON")) {
        const isCandidate = fullText.includes("SAFE_IMPROVE");
        const isPub001 = fullText.includes("pub-001-input");
        const isPub002 = fullText.includes("pub-002-input");
        const isHold001 = fullText.includes("hold-001-input");
        if (isCandidate) {
          if (isPub001) return JSON.stringify({ pass: true, score: 90, reason: "improved" });
          if (isPub002) return JSON.stringify({ pass: true, score: 100, reason: "maintained" });
          if (isHold001) return JSON.stringify({ pass: true, score: 100, reason: "holdout maintained" });
        } else {
          if (isPub001) return JSON.stringify({ pass: false, score: 60, reason: "baseline weak" });
          if (isPub002) return JSON.stringify({ pass: true, score: 100, reason: "baseline good" });
          if (isHold001) return JSON.stringify({ pass: true, score: 100, reason: "baseline holdout good" });
        }
      }
      return "mock response";
    },
  };
}

// ===================== Scenario: Public Regression =====================
const REGRESS_BASELINE = "你是一个客服助手。请回答用户的问题。";
const REGRESS_CANDIDATE = "你是一个客服助手。请回答用户的问题。改进标记RISKY_REGRESS。";

function makePublicRegressionProject(): Project {
  return {
    projectDir: tmpdir(),
    prompt: REGRESS_BASELINE,
    goal: "提供礼貌、清楚且不虚构能力的客服回答。",
    tests: [
      { id: "pub-001", category: "normal" as const, userInput: "pub-001-input", expectedBehavior: "pub-001-expected", rubric: "pub-001-rubric", weight: 1 },
      { id: "pub-002", category: "normal" as const, userInput: "pub-002-input", expectedBehavior: "pub-002-expected", rubric: "pub-002-rubric", weight: 1 },
    ],
    holdoutTests: [],
    config: {
      projectName: "compact-public-regress",
      targetScore: 80, maxIters: 1, minImprovement: 2, candidateCount: 1,
      provider: { type: "mock" }, optimizationEngine: "legacy",
      runtime: { maxConcurrency: 1, cache: false, retryErrors: false, repeat: 1 },
    },
    evaluationPolicy: { casePassScore: 80, repairScoreThreshold: 85 },
  };
}

function createPublicRegressionProvider(): ModelProvider {
  return {
    name: "mock-public-regress",
    async chat(messages: ChatMessage[]): Promise<string> {
      const fullText = messages.map((m) => m.content).join("\n");
      if (fullText.includes("REPAIR_PROMPT_JSON")) {
        return JSON.stringify([{ id: "candidate-1", hypothesis: "risky", prompt: REGRESS_CANDIDATE, changeSummary: ["risky change"] }]);
      }
      if (fullText.includes("JUDGE_JSON")) {
        const isCandidate = fullText.includes("RISKY_REGRESS");
        const isPub001 = fullText.includes("pub-001-input");
        const isPub002 = fullText.includes("pub-002-input");
        if (isCandidate) {
          if (isPub001) return JSON.stringify({ pass: false, score: 70, reason: "regression" });
          if (isPub002) return JSON.stringify({ pass: true, score: 100, reason: "improved" });
        } else {
          if (isPub001) return JSON.stringify({ pass: true, score: 100, reason: "baseline good" });
          if (isPub002) return JSON.stringify({ pass: false, score: 50, reason: "baseline weak" });
        }
      }
      return "mock response";
    },
  };
}

// ===================== Scenario: Holdout Rollback =====================
const HOLDOUT_BASELINE = "你是一个客服助手。请回答用户的问题。";
const HOLDOUT_CANDIDATE = "你是一个客服助手。请回答用户的问题。改进标记HOLDOUT_RISK。";

function makeHoldoutRollbackProject(): Project {
  return {
    projectDir: tmpdir(),
    prompt: HOLDOUT_BASELINE,
    goal: "提供礼貌、清楚且不虚构能力的客服回答。",
    tests: [
      { id: "pub-001", category: "normal" as const, userInput: "pub-001-input", expectedBehavior: "pub-001-expected", rubric: "pub-001-rubric", weight: 1 },
      { id: "pub-002", category: "normal" as const, userInput: "pub-002-input", expectedBehavior: "pub-002-expected", rubric: "pub-002-rubric", weight: 1 },
    ],
    holdoutTests: [
      { id: "hold-001", category: "normal" as const, userInput: "hold-001-input", expectedBehavior: "hold-001-expected", rubric: "hold-001-rubric", weight: 1 },
    ],
    config: {
      projectName: "compact-holdout-rollback",
      targetScore: 80, maxIters: 1, minImprovement: 2, candidateCount: 1,
      provider: { type: "mock" }, optimizationEngine: "legacy",
      runtime: { maxConcurrency: 1, cache: false, retryErrors: false, repeat: 1 },
    },
    evaluationPolicy: { casePassScore: 80, repairScoreThreshold: 85 },
  };
}

function createHoldoutRollbackProvider(): ModelProvider {
  return {
    name: "mock-holdout-rollback",
    async chat(messages: ChatMessage[]): Promise<string> {
      const fullText = messages.map((m) => m.content).join("\n");
      if (fullText.includes("REPAIR_PROMPT_JSON")) {
        return JSON.stringify([{ id: "candidate-1", hypothesis: "holdout risk", prompt: HOLDOUT_CANDIDATE, changeSummary: ["risky holdout change"] }]);
      }
      if (fullText.includes("JUDGE_JSON")) {
        const isCandidate = fullText.includes("HOLDOUT_RISK");
        const isPub001 = fullText.includes("pub-001-input");
        const isPub002 = fullText.includes("pub-002-input");
        const isHold001 = fullText.includes("hold-001-input");
        if (isCandidate) {
          if (isPub001) return JSON.stringify({ pass: true, score: 90, reason: "improved" });
          if (isPub002) return JSON.stringify({ pass: true, score: 100, reason: "maintained" });
          if (isHold001) return JSON.stringify({ pass: false, score: 40, reason: "holdout regression" });
        } else {
          if (isPub001) return JSON.stringify({ pass: false, score: 60, reason: "baseline weak" });
          if (isPub002) return JSON.stringify({ pass: true, score: 100, reason: "baseline good" });
          if (isHold001) return JSON.stringify({ pass: true, score: 100, reason: "baseline holdout good" });
        }
      }
      return "mock response";
    },
  };
}

// ===================== Scenario: No Badcases =====================
const NOBAD_BASELINE = "你是一个客服助手。请回答用户的问题。";
const NOBAD_CANDIDATE = "你是一个客服助手。请回答用户的问题。改进标记NO_BADCASE。";

function makeNoBadcasesProject(): Project {
  return {
    projectDir: tmpdir(),
    prompt: NOBAD_BASELINE,
    goal: "提供礼貌、清楚且不虚构能力的客服回答。",
    tests: [
      { id: "pub-001", category: "normal" as const, userInput: "pub-001-input", expectedBehavior: "pub-001-expected", rubric: "pub-001-rubric", weight: 1 },
      { id: "pub-002", category: "normal" as const, userInput: "pub-002-input", expectedBehavior: "pub-002-expected", rubric: "pub-002-rubric", weight: 1 },
    ],
    holdoutTests: [],
    config: {
      projectName: "compact-no-badcases",
      targetScore: 80, maxIters: 1, minImprovement: 2, candidateCount: 1,
      provider: { type: "mock" }, optimizationEngine: "legacy",
      runtime: { maxConcurrency: 1, cache: false, retryErrors: false, repeat: 1 },
    },
    evaluationPolicy: { casePassScore: 80, repairScoreThreshold: 85 },
  };
}

function createNoBadcasesProvider(): ModelProvider {
  return {
    name: "mock-no-badcases",
    async chat(messages: ChatMessage[]): Promise<string> {
      const fullText = messages.map((m) => m.content).join("\n");
      if (fullText.includes("REPAIR_PROMPT_JSON")) {
        return JSON.stringify([{ id: "candidate-1", hypothesis: "no change", prompt: NOBAD_CANDIDATE, changeSummary: ["no-op change"] }]);
      }
      if (fullText.includes("JUDGE_JSON")) {
        return JSON.stringify({ pass: true, score: 100, reason: "perfect" });
      }
      return "mock response";
    },
  };
}

// ===================== Helper =====================
async function parseRunLog(runDir: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(join(runDir, "run-log.jsonl"), "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((l, i) => {
    try { return JSON.parse(l) as Record<string, unknown>; }
    catch { throw new Error(`run-log.jsonl line ${i + 1} is not valid JSON`); }
  });
}

// ===================== Test 1 =====================
test("compact: root directory has exactly five files and zero subdirectories", async () => {
  const runDir = join(tmpdir(), `skillfoo-compact-files-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await runLoop(createSafeImprovementProvider(), makeSafeImprovementProject(), runDir, 1, 80, { outputMode: "compact" });
    const entries = await readdir(runDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    assert.equal(dirs.length, 0, `Expected 0 dirs, got ${dirs.length}: ${dirs.join(", ")}`);
    assert.equal(files.length, 5, `Expected 5 files, got ${files.length}: ${files.join(", ")}`);
    assert.deepEqual(files, [...EXPECTED_FILES].sort());
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// ===================== Test 4 =====================
test("compact: public regression causes best-prompt.md to be baseline with rejection in log", async () => {
  const runDir = join(tmpdir(), `skillfoo-compact-regress-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await runLoop(createPublicRegressionProvider(), makePublicRegressionProject(), runDir, 1, 80, { outputMode: "compact" });
    const bestPrompt = await readFile(join(runDir, "best-prompt.md"), "utf8");
    assert.equal(bestPrompt, REGRESS_BASELINE, "best-prompt.md must be baseline when candidate has serious regression");
    const events = await parseRunLog(runDir);
    const decided = events.filter((e) => e.eventType === "candidate_decided");
    assert.ok(decided.length > 0, "run-log.jsonl must have candidate_decided event");
    const allReasons = decided.flatMap((e) => {
      const d = e.data as Record<string, unknown> | undefined;
      return Array.isArray(d?.reasons) ? d.reasons as string[] : [];
    });
    assert.ok(allReasons.includes("serious_public_regression"), `must include serious_public_regression, got: ${allReasons.join(", ")}`);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// ===================== Test 5 =====================
test("compact: holdout rollback produces baseline best-prompt and dual diff", async () => {
  const runDir = join(tmpdir(), `skillfoo-compact-holdout-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await runLoop(createHoldoutRollbackProvider(), makeHoldoutRollbackProject(), runDir, 1, 80, { outputMode: "compact" });
    const bestPrompt = await readFile(join(runDir, "best-prompt.md"), "utf8");
    assert.equal(bestPrompt, HOLDOUT_BASELINE, "best-prompt.md must be baseline on holdout rollback");
    const diffContent = await readFile(join(runDir, "prompt-diff.md"), "utf8");
    assert.ok(diffContent.includes("HOLDOUT_RISK"), "prompt-diff.md must contain public best prompt");
    assert.ok(/baseline|release|rollback/i.test(diffContent), "prompt-diff.md must mention release baseline or rollback");
    const events = await parseRunLog(runDir);
    const releaseEvents = events.filter((e) => e.eventType === "release_decided");
    assert.ok(releaseEvents.length > 0, "run-log.jsonl must have release_decided event");
    const rd = releaseEvents[0].data as Record<string, unknown> | undefined;
    assert.equal(rd?.status, "final_holdout_rollback", "release_decided status must be final_holdout_rollback");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// ===================== Test 6 =====================
test("compact: no badcases produces empty badcases.jsonl and report shows 0", async () => {
  const runDir = join(tmpdir(), `skillfoo-compact-nobad-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await runLoop(createNoBadcasesProvider(), makeNoBadcasesProject(), runDir, 1, 80, { outputMode: "compact" });
    const badcasesContent = await readFile(join(runDir, "badcases.jsonl"), "utf8");
    assert.equal(badcasesContent.trim(), "", "badcases.jsonl must be empty when there are no badcases");
    const reportContent = await readFile(join(runDir, "report.md"), "utf8");
    assert.ok(/badcase.*0|0.*badcase/i.test(reportContent), "report.md must show 0 badcases");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
