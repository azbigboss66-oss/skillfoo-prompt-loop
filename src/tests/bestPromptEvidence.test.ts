import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeBestPromptEvidence } from "../report/writeBestPromptEvidence.js";
import type { ReleaseDecision } from "../types.js";

const rollbackDecision: ReleaseDecision = {
  status: "final_holdout_rollback",
  releasedPromptVersion: "baseline",
  reasons: ["holdout_serious_regression"],
  holdoutComparison: {
    fixedBadcases: [],
    remainingFailures: [],
    regressions: [],
    seriousRegressions: [],
    improved: [],
    unchanged: [],
  },
  holdoutDelta: -60,
  criticalFailuresAfter: 0,
};

const releasedDecision: ReleaseDecision = {
  status: "released_public_best",
  releasedPromptVersion: "candidate-1",
  reasons: [],
  holdoutComparison: {
    fixedBadcases: [],
    remainingFailures: [],
    regressions: [],
    seriousRegressions: [],
    improved: [],
    unchanged: [],
  },
  holdoutDelta: 10,
  criticalFailuresAfter: 0,
};

test("writeBestPromptEvidence writes all four files for rollback case", async () => {
  const runDir = join(tmpdir(), `skillfoo-evidence-rollback-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await writeBestPromptEvidence({
      runDir,
      runId: "test-project/run-001",
      targetProvider: { type: "mock", model: "test-model" },
      publicBestPrompt: "candidate prompt text",
      publicBestPromptVersion: "candidate-1",
      publicBestScore: 90,
      releasePrompt: "baseline prompt text",
      releaseDecision: rollbackDecision,
      baselinePublicScore: 60,
      baselineHoldoutScore: 100,
      publicKeep: true,
      holdoutDelta: -60,
      seriousHoldoutRegressions: 1,
      criticalFailuresAfter: 0,
      limitations: ["same_model_grader"],
    });

    // Verify public-best-prompt.md
    const publicBest = await readFile(join(runDir, "public-best-prompt.md"), "utf8");
    assert.equal(publicBest, "candidate prompt text");

    // Verify best-prompt.md (release prompt = baseline)
    const bestPrompt = await readFile(join(runDir, "best-prompt.md"), "utf8");
    assert.equal(bestPrompt, "baseline prompt text");

    // Verify release-decision.json
    const decision = JSON.parse(await readFile(join(runDir, "release-decision.json"), "utf8"));
    assert.equal(decision.status, "final_holdout_rollback");
    assert.equal(decision.releasedPromptVersion, "baseline");

    // Verify best-prompt-evidence.json
    const evidence = JSON.parse(await readFile(join(runDir, "best-prompt-evidence.json"), "utf8"));
    assert.equal(evidence.schemaVersion, "1.0");
    assert.equal(evidence.runId, "test-project/run-001");
    assert.equal(evidence.targetProvider.type, "mock");
    assert.equal(evidence.baseline.publicScore, 60);
    assert.equal(evidence.baseline.holdoutScore, 100);
    assert.equal(evidence.publicBest.promptVersion, "candidate-1");
    assert.equal(evidence.publicBest.publicScore, 90);
    assert.equal(evidence.release.promptVersion, "baseline");
    assert.equal(evidence.release.status, "final_holdout_rollback");
    assert.equal(evidence.gates.publicKeep, true);
    assert.equal(evidence.gates.holdoutDelta, -60);
    assert.equal(evidence.gates.seriousHoldoutRegressions, 1);
    assert.equal(evidence.gates.criticalFailuresAfter, 0);
    assert.deepEqual(evidence.limitations, ["same_model_grader"]);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("writeBestPromptEvidence writes all four files for released case", async () => {
  const runDir = join(tmpdir(), `skillfoo-evidence-released-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    await writeBestPromptEvidence({
      runDir,
      runId: "test-project/run-002",
      targetProvider: { type: "openai-compatible", model: "deepseek-chat" },
      publicBestPrompt: "improved prompt text",
      publicBestPromptVersion: "candidate-1",
      publicBestScore: 95,
      releasePrompt: "improved prompt text",
      releaseDecision: releasedDecision,
      baselinePublicScore: 75,
      baselineHoldoutScore: 80,
      publicKeep: true,
      holdoutDelta: 10,
      seriousHoldoutRegressions: 0,
      criticalFailuresAfter: 0,
      limitations: ["same_model_grader", "auto_generated_tests"],
    });

    // Verify best-prompt.md (release prompt = public best)
    const bestPrompt = await readFile(join(runDir, "best-prompt.md"), "utf8");
    assert.equal(bestPrompt, "improved prompt text");

    // Verify public-best-prompt.md (same as release in this case)
    const publicBest = await readFile(join(runDir, "public-best-prompt.md"), "utf8");
    assert.equal(publicBest, "improved prompt text");

    // Verify best-prompt-evidence.json
    const evidence = JSON.parse(await readFile(join(runDir, "best-prompt-evidence.json"), "utf8"));
    assert.equal(evidence.release.status, "released_public_best");
    assert.equal(evidence.release.promptVersion, "candidate-1");
    assert.equal(evidence.gates.publicKeep, true);
    assert.equal(evidence.gates.seriousHoldoutRegressions, 0);
    assert.deepEqual(evidence.limitations, ["same_model_grader", "auto_generated_tests"]);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
