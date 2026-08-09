import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeGeneratedTestArtifacts } from "../testgen/writeGeneratedTests.js";
import { writePromptfooConfig } from "../promptfoo/writePromptfooConfig.js";
import type { ProviderConfig } from "../promptfoo/types.js";
import type { TestCase, TestAuditSummary } from "../types.js";

const sample: TestCase = {
  id: "g001",
  category: "normal",
  userInput: "hi",
  expectedBehavior: "answer",
  rubric: "高分要求：回答清楚；低分情况：编造事实或泄露隐私。",
  weight: 1,
};

test("writeGeneratedTestArtifacts writes jsonl json and markdown files", async () => {
  const dir = join(tmpdir(), `skillfoo-generated-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const audit: TestAuditSummary = {
    total: 1,
    testQualityScore: 80,
    schemaScore: 20,
    coverageScore: 20,
    highRiskBalanceScore: 15,
    uniquenessScore: 15,
    leakageScore: 10,
    rubricQualityScore: 0,
    goalTraceabilityScore: 0,
    duplicateRatio: 0,
    highRiskRatio: 0,
    categoryCounts: { normal: 1 },
    pass: true,
    issues: [],
  };

  await writeGeneratedTestArtifacts(dir, [sample], [sample], [sample], audit);
  await access(join(dir, "candidate-tests.jsonl"));
  await access(join(dir, "tests.jsonl"));
  await access(join(dir, "holdout-tests.jsonl"));
  await access(join(dir, "test-audit-summary.json"));
  const sourceManifest = JSON.parse(
    await readFile(join(dir, "source-manifest.json"), "utf-8"),
  ) as { status: string; publicCount: number; holdoutCount: number };
  assert.equal(sourceManifest.status, "generated");
  assert.equal(sourceManifest.publicCount, 1);
  assert.equal(sourceManifest.holdoutCount, 1);
  const report = await readFile(join(dir, "test-audit-report.md"), "utf-8");
  assert.match(report, /Generated Test Audit Report/);
  await rm(dir, { recursive: true, force: true });
});

test("writePromptfooConfig respects the requested run artifact filename", async () => {
  const dir = join(tmpdir(), `skillfoo-promptfoo-config-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const provider: ProviderConfig = { type: "mock", model: "mock" };

  const path = await writePromptfooConfig(
    dir,
    {
      prompt: "answer clearly",
      tests: [sample],
      targetProvider: provider,
      mode: "baseline",
      maxConcurrency: 1,
      cache: true,
    },
    "eval-config.yaml",
  );

  assert.equal(path, join(dir, "promptfoo", "eval-config.yaml"));
  await access(path);
  await assert.rejects(access(join(dir, "promptfoo", "promptfooconfig.yaml")));
  await rm(dir, { recursive: true, force: true });
});
