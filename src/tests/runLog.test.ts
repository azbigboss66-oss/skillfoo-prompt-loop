/**
 * Task 1 Failing Tests: Run Log Format and Sensitive Data Redaction
 *
 * Tests:
 * 2. run-log.jsonl all parseable, seq continuous, first=run_started, last=run_completed
 * 3. no sensitive data (API Key, token, secret, password) in any of the 5 files
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
      projectName: "runlog-test",
      targetScore: 80, maxIters: 1, minImprovement: 2, candidateCount: 1,
      provider: { type: "mock", apiKeyEnv: "TEST_FAKE_API_KEY" },
      optimizationEngine: "legacy",
      runtime: { maxConcurrency: 1, cache: false, retryErrors: false, repeat: 1 },
    },
    evaluationPolicy: { casePassScore: 80, repairScoreThreshold: 85 },
  };
}

function createProvider(): ModelProvider {
  return {
    name: "mock-runlog",
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

// ===================== Test 2: run-log.jsonl format =====================
test("run-log: all lines parseable, seq continuous, first=run_started, last=run_completed", async () => {
  const runDir = join(tmpdir(), `skillfoo-runlog-format-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await runLoop(createProvider(), makeProject(), runDir, 1, 80, { outputMode: "compact" });

    const content = await readFile(join(runDir, "run-log.jsonl"), "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 2, "run-log.jsonl must have at least 2 lines");

    // All lines must parse
    const events = lines.map((l, i) => {
      try { return JSON.parse(l) as Record<string, unknown>; }
      catch { throw new Error(`Line ${i + 1} is not valid JSON: ${l.substring(0, 80)}`); }
    });

    // Check required fields
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      assert.ok(e.schemaVersion, `Line ${i + 1} missing schemaVersion`);
      assert.ok(e.seq !== undefined, `Line ${i + 1} missing seq`);
      assert.ok(e.timestamp, `Line ${i + 1} missing timestamp`);
      assert.ok(e.eventType, `Line ${i + 1} missing eventType`);
      assert.ok(e.runId, `Line ${i + 1} missing runId`);
      assert.ok(e.data !== undefined, `Line ${i + 1} missing data`);
    }

    // seq must be continuous starting from 1
    for (let i = 0; i < events.length; i++) {
      assert.equal(events[i].seq, i + 1, `seq must be ${i + 1}, got ${events[i].seq}`);
    }

    // First event must be run_started
    assert.equal(events[0].eventType, "run_started", `First event must be run_started, got ${events[0].eventType}`);

    // Last event must be run_completed
    const last = events[events.length - 1];
    assert.equal(last.eventType, "run_completed", `Last event must be run_completed, got ${last.eventType}`);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("run-log: completion manifest does not report its own log file as an error", async () => {
  const runDir = join(tmpdir(), `skillfoo-runlog-manifest-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await runLoop(createProvider(), makeProject(), runDir, 1, 80, { outputMode: "compact" });

    const lines = (await readFile(join(runDir, "run-log.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { eventType: string; data?: Record<string, unknown> });
    const completed = lines.at(-1);
    const files = completed?.data?.files as Record<string, unknown> | undefined;

    assert.equal(completed?.eventType, "run_completed");
    assert.equal(files?.["run-log.jsonl"], "self-referential");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("run-log: records the actual provider name and observed chat-call count", async () => {
  const runDir = join(tmpdir(), `skillfoo-runlog-provider-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await runLoop(createProvider(), makeProject(), runDir, 1, 80, { outputMode: "compact" });

    const events = (await readFile(join(runDir, "run-log.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { eventType: string; data: Record<string, unknown> });
    const started = events[0];
    const completed = events.at(-1);

    assert.ok(started, "run_started event must exist");
    assert.ok(completed, "run_completed event must exist");
    assert.equal(started.data.providerName, "mock-runlog");
    assert.equal(completed.data.providerName, "mock-runlog");
    assert.equal(started.data.callObservationScope, "all_loop_calls");
    assert.equal(completed.data.callObservationScope, "all_loop_calls");
    assert.deepEqual(completed.data.observedChatCalls, {
      total: 13,
      target: 6,
      judge: 6,
      candidateGeneration: 1,
      other: 0,
    });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

// ===================== Test 3: no sensitive data =====================
test("redaction: no API Key, token, secret, password in any of the five files", async () => {
  const runDir = join(tmpdir(), `skillfoo-redact-${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  // Inject fake sensitive values into environment
  const fakeApiKey = ["sk", "fake", "api", "key", "123456789abcdef"].join("-");
  const fakeToken = "Bearer-fake-token-987654321";
  const fakeSecret = "fake-secret-xyz789abc";
  const fakePassword = "fake-password-abc123def456";
  process.env.TEST_FAKE_API_KEY = fakeApiKey;
  process.env.TEST_FAKE_TOKEN = fakeToken;
  process.env.TEST_FAKE_SECRET = fakeSecret;
  process.env.TEST_FAKE_PASSWORD = fakePassword;

  try {
    await runLoop(createProvider(), makeProject(), runDir, 1, 80, { outputMode: "compact" });

    const files = ["report.md", "best-prompt.md", "prompt-diff.md", "badcases.jsonl", "run-log.jsonl"];
    for (const file of files) {
      const content = await readFile(join(runDir, file), "utf8");
      assert.ok(!content.includes(fakeApiKey), `${file} must not contain API key value`);
      assert.ok(!content.includes(fakeToken), `${file} must not contain token value`);
      assert.ok(!content.includes(fakeSecret), `${file} must not contain secret value`);
      assert.ok(!content.includes(fakePassword), `${file} must not contain password value`);
    }
  } finally {
    await rm(runDir, { recursive: true, force: true });
    delete process.env.TEST_FAKE_API_KEY;
    delete process.env.TEST_FAKE_TOKEN;
    delete process.env.TEST_FAKE_SECRET;
    delete process.env.TEST_FAKE_PASSWORD;
  }
});
