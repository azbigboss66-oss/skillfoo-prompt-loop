/**
 * Task 1 Failing Tests: Output Mode Behavior
 *
 * Tests:
 * 7. --output debug: root has 5 files + one debug/ dir with diagnostics
 * 8. no --output: equivalent to compact
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

const BASELINE = "你是一个客服助手。请回答用户的问题。";
const CANDIDATE = "你是一个客服助手。请回答用户的问题。改进标记SAFE_IMPROVE。";

function makeProject(): Project {
  return {
    projectDir: tmpdir(),
    prompt: BASELINE,
    goal: "提供礼貌、清楚且不虚构能力的客服回答。",
    tests: [
      { id: "pub-001", category: "normal" as const, userInput: "pub-001-input", expectedBehavior: "pub-001-expected", rubric: "pub-001-rubric", weight: 1 },
      { id: "pub-002", category: "normal" as const, userInput: "pub-002-input", expectedBehavior: "pub-002-expected", rubric: "pub-002-rubric", weight: 1 },
    ],
    holdoutTests: [
      { id: "hold-001", category: "normal" as const, userInput: "hold-001-input", expectedBehavior: "hold-001-expected", rubric: "hold-001-rubric", weight: 1 },
    ],
    config: {
      projectName: "output-mode-test",
      targetScore: 80, maxIters: 1, minImprovement: 2, candidateCount: 1,
      provider: { type: "mock" }, optimizationEngine: "legacy",
      runtime: { maxConcurrency: 1, cache: false, retryErrors: false, repeat: 1 },
    },
    evaluationPolicy: { casePassScore: 80, repairScoreThreshold: 85 },
  };
}

function createProvider(): ModelProvider {
  return {
    name: "mock-output-mode",
    async chat(messages: ChatMessage[]): Promise<string> {
      const fullText = messages.map((m) => m.content).join("\n");
      if (fullText.includes("REPAIR_PROMPT_JSON")) {
        return JSON.stringify([{ id: "candidate-1", hypothesis: "safe", prompt: CANDIDATE, changeSummary: ["safe change"] }]);
      }
      if (fullText.includes("JUDGE_JSON")) {
        const isCandidate = fullText.includes("SAFE_IMPROVE");
        const isPub001 = fullText.includes("pub-001-input");
        const isPub002 = fullText.includes("pub-002-input");
        const isHold001 = fullText.includes("hold-001-input");
        if (isCandidate) {
          if (isPub001) return JSON.stringify({ pass: true, score: 90, reason: "improved" });
          if (isPub002) return JSON.stringify({ pass: true, score: 100, reason: "maintained" });
          if (isHold001) return JSON.stringify({ pass: true, score: 100, reason: "holdout ok" });
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

// ===================== Test 7: debug mode =====================
test("debug mode: root has five files plus one debug/ directory with diagnostics", async () => {
  const runDir = join(tmpdir(), `skillfoo-debug-mode-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await runLoop(createProvider(), makeProject(), runDir, 1, 80, { outputMode: "debug" });

    const entries = await readdir(runDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    // Root must still have exactly 5 files
    assert.equal(files.length, 5, `Expected 5 files in root, got ${files.length}: ${files.join(", ")}`);
    assert.deepEqual(files, [...EXPECTED_FILES].sort());

    // Only one additional directory: debug/
    assert.equal(dirs.length, 1, `Expected exactly 1 directory (debug/), got ${dirs.length}: ${dirs.join(", ")}`);
    assert.equal(dirs[0], "debug", `Expected debug/ directory, got ${dirs[0]}`);

    // debug/ must contain diagnostic files
    const debugEntries = await readdir(join(runDir, "debug"), { withFileTypes: true });
    assert.ok(debugEntries.length > 0, "debug/ directory must contain diagnostic files");

    // report.md and run-log.jsonl must record outputMode=debug
    const reportContent = await readFile(join(runDir, "report.md"), "utf8");
    assert.ok(/debug/i.test(reportContent), "report.md must record outputMode=debug");

    const logContent = await readFile(join(runDir, "run-log.jsonl"), "utf8");
    const logLines = logContent.split("\n").filter((l) => l.trim().length > 0);
    const firstEvent = JSON.parse(logLines[0]);
    const eventData = firstEvent.data as Record<string, unknown> | undefined;
    assert.ok(
      eventData?.outputMode === "debug" || firstEvent.outputMode === "debug",
      "run-log.jsonl must record outputMode=debug",
    );
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// ===================== Test 8: default mode (no --output) =====================
test("default mode: no --output option is equivalent to compact", async () => {
  const runDir = join(tmpdir(), `skillfoo-default-mode-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    // Call WITHOUT options parameter — should default to compact
    await runLoop(createProvider(), makeProject(), runDir, 1, 80);

    const entries = await readdir(runDir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    // Must be identical to compact: 5 files, 0 directories
    assert.equal(dirs.length, 0, `Expected 0 dirs in default mode, got ${dirs.length}: ${dirs.join(", ")}`);
    assert.equal(files.length, 5, `Expected 5 files in default mode, got ${files.length}: ${files.join(", ")}`);
    assert.deepEqual(files, [...EXPECTED_FILES].sort());

    // run-log.jsonl must exist and record outputMode=compact (or no outputMode = compact)
    const logContent = await readFile(join(runDir, "run-log.jsonl"), "utf8");
    const logLines = logContent.split("\n").filter((l) => l.trim().length > 0);
    const firstEvent = JSON.parse(logLines[0]);
    const eventData = firstEvent.data as Record<string, unknown> | undefined;
    const recordedMode = eventData?.outputMode ?? firstEvent.outputMode;
    assert.ok(
      recordedMode === "compact" || recordedMode === undefined,
      `Default outputMode should be compact or absent, got ${recordedMode}`,
    );
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
