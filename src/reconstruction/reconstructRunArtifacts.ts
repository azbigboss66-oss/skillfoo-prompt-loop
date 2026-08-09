import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { loadProject, type Project } from "../config/loadProject.js";
import { auditGoal } from "../goal/auditGoal.js";
import { writeGoalAudit } from "../goal/writeGoalAudit.js";
import type { LoopResult } from "../loop/runPromptLoop.js";
import type { NormalizedPromptfooResult } from "../promptfoo/normalizePromptfooResults.js";
import { analyzePromptChange, assessGovernance } from "../report/analyzePromptChange.js";
import { compareResults } from "../report/compareResults.js";
import { writeV4Report } from "../report/writeV4Report.js";
import { writeV5Report } from "../report/writeV5Report.js";
import { assessImprovement } from "../supervisor/assessImprovement.js";
import { computeV5FinalVerdict } from "../supervisor/finalVerdict.js";
import { writeSupervisorReport } from "../supervisor/writeSupervisorReport.js";
import { readJsonl } from "../storage/jsonl.js";
import { auditGeneratedTests, computeCrossSplitNearDuplicates } from "../testgen/auditTests.js";
import { writeGeneratedTestArtifacts } from "../testgen/writeGeneratedTests.js";
import {
  EvalResultSchema,
  LedgerEntrySchema,
  SummarySchema,
  TestCaseSchema,
  type EvalResult,
  type TestCase,
} from "../types.js";

export interface ReconstructRunArtifactsInput {
  projectDir: string;
  runDir: string;
  generatedTestsDir: string;
}

export interface ReconstructRunArtifactsResult {
  runDir: string;
  finalVerdict: string;
  reconstructedFiles: string[];
}

async function requireFile(path: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(`Cannot reconstruct artifacts: required source file is missing: ${path}`);
  }
}

async function readJson<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  await requireFile(path);
  return parse(JSON.parse(await readFile(path, "utf-8")));
}

async function readValidatedJsonl<T>(path: string, parse: (value: unknown) => T): Promise<T[]> {
  await requireFile(path);
  return (await readJsonl<unknown>(path)).map(parse);
}

function assertSameTests(expected: TestCase[], actual: TestCase[], label: string): void {
  if (expected.length !== actual.length) {
    throw new Error(`Cannot reconstruct artifacts: ${label} count differs from the project test set.`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (JSON.stringify(expected[index]) !== JSON.stringify(actual[index])) {
      throw new Error(`Cannot reconstruct artifacts: ${label} differs from the project test set at index ${index}.`);
    }
  }
}

function buildAuditOptions(total: number, goalAudit: ReturnType<typeof auditGoal>) {
  const requiredCategories = ["normal", "edge", "adversarial", "hallucination", "privacy", "format", "ambiguity"];
  const baseMin = Math.max(1, Math.floor(total / requiredCategories.length / 2));
  const minCategoryCounts = Object.fromEntries(requiredCategories.map((category) => [category, baseMin]));
  minCategoryCounts.ambiguity = 0;
  return {
    minTotal: Math.ceil(total * 0.8),
    minQualityScore: 90,
    maxDuplicateRatio: 0.1,
    minHighRiskRatio: 0.3,
    requiredCategories,
    minCategoryCounts,
    weakRubricIsError: true,
    goalProfile: {
      detectedCapabilities: goalAudit.detectedCapabilities,
      detectedForbiddenActions: goalAudit.detectedForbiddenActions,
      detectedRiskTypes: goalAudit.detectedRiskTypes,
    },
  };
}

function modelLabel(provider: { type: string; model?: string }): string {
  return `${provider.type}${provider.model ? ` (${provider.model})` : ""}`;
}

function sameProvider(left: { type: string; model?: string }, right: { type: string; model?: string }): boolean {
  return left.type === right.type && left.model === right.model;
}

/**
 * Rebuild V5 governance artifacts exclusively from a completed run's saved
 * evidence. It never instantiates a provider or makes an LLM call.
 */
export async function reconstructRunArtifacts(
  input: ReconstructRunArtifactsInput,
): Promise<ReconstructRunArtifactsResult> {
  const project = await loadProject(input.projectDir);
  const source = await loadSource(input, project);
  const goalAudit = auditGoal(project.goal);
  const goalProfile = {
    detectedCapabilities: goalAudit.detectedCapabilities,
    detectedForbiddenActions: goalAudit.detectedForbiddenActions,
    detectedRiskTypes: goalAudit.detectedRiskTypes,
  };
  const audit = auditGeneratedTests(source.candidateTests, buildAuditOptions(source.candidateTests.length, goalAudit));
  const crossSplit = computeCrossSplitNearDuplicates(source.publicTests, source.holdoutTests);
  audit.publicHoldoutNearDuplicateRatio = crossSplit.ratio;
  if (crossSplit.ratio > 0.05) {
    audit.pass = false;
    audit.issues.push({ severity: "error", code: "public_holdout_near_duplicate", message: `Public/holdout near-duplicate ratio ${crossSplit.ratio.toFixed(4)} exceeds 0.05.` });
  }
  if (!audit.pass) {
    throw new Error("Cannot reconstruct artifacts: preserved generated tests do not pass the V5 audit.");
  }

  const governance = assessGovernance({
    baseline: source.baselineNormalized,
    candidate: source.bestNormalized,
    baselineHoldout: source.baselineHoldoutNormalized,
    candidateHoldout: source.bestHoldoutNormalized,
    originalPrompt: project.prompt,
    candidatePrompt: source.bestPrompt,
    goalProfile,
  });
  const assessment = assessImprovement({
    baselinePublicSummary: source.baselineSummary,
    bestPublicSummary: source.bestSummary,
    baselinePublicResults: source.baselineResults,
    bestPublicResults: source.bestResults,
    baselineHoldoutSummary: source.baselineHoldoutSummary,
    bestHoldoutSummary: source.bestHoldoutSummary,
    baselineHoldoutResults: source.baselineHoldoutResults,
    bestHoldoutResults: source.bestHoldoutResults,
    repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
  });
  const targetProvider = project.config.targetProvider ?? project.config.provider;
  const graderProvider = project.config.graderProvider ?? targetProvider;
  const computedVerdict = computeV5FinalVerdict({
    goalAuditCanProceed: goalAudit.canProceed,
    goalReadinessScore: goalAudit.goalReadinessScore,
    governance,
    promptfooVersion: source.promptfooVersion,
    sameModelGrader: sameProvider(targetProvider, graderProvider),
    hasAutoGeneratedTests: true,
  });
  const finalVerdict = {
    ...computedVerdict,
    reasons: [...computedVerdict.reasons, "本裁决由已保存的原始运行产物重建；本次未调用模型或重新评测。"],
    humanReviewRequired: true,
  };

  await writeGoalAudit(input.runDir, goalAudit);
  await writeGeneratedTestArtifacts(join(input.runDir, "generated-tests"), source.candidateTests, source.publicTests, source.holdoutTests, audit);
  await writeFile(join(input.runDir, "generated-tests", "source-manifest.json"), JSON.stringify({
    ...source.generatedManifest,
    materializedFrom: input.generatedTestsDir,
    materializedAt: new Date().toISOString(),
    materialization: "deterministic post-run reconstruction; no model call",
  }, null, 2), "utf-8");
  await writeSupervisorReport(input.runDir, assessment);
  await writeFile(join(input.runDir, "final-verdict.json"), JSON.stringify(finalVerdict, null, 2), "utf-8");

  await writeV5Report({
    runDir: input.runDir,
    projectName: project.config.projectName,
    promptfooVersion: source.promptfooVersion,
    targetProviderModel: modelLabel(targetProvider),
    graderProviderModel: modelLabel(graderProvider),
    testGeneratorSource: "skillfoo-auto-generated (preserved source)",
    sameModelGrader: sameProvider(targetProvider, graderProvider),
    hasAutoGeneratedTests: true,
    baselinePublicResults: source.baselineNormalized,
    bestPublicResults: source.bestNormalized,
    baselineHoldoutResults: source.baselineHoldoutNormalized,
    bestHoldoutResults: source.bestHoldoutNormalized,
    governance,
    ledger: source.ledger,
    originalPrompt: project.prompt,
    bestPrompt: source.bestPrompt,
    finalVerdictLabel: finalVerdict.label,
    finalVerdictReasons: finalVerdict.reasons,
    humanReviewRequired: finalVerdict.humanReviewRequired,
    runtimeStats: source.runtimeStats,
    optimizeCalls: 0,
    validationSplit: project.config.optimization?.validationSplit,
  });

  const finalAnalysis = analyzePromptChange(project.prompt, source.bestPrompt, goalProfile);
  const loopResult: LoopResult = {
    runDir: input.runDir,
    bestPrompt: source.bestPrompt,
    bestScore: source.bestSummary.finalScore,
    targetScore: project.config.targetScore,
    targetReached: source.bestSummary.finalScore >= project.config.targetScore,
    ledger: source.ledger,
    lastResults: source.bestResults,
    baselinePublicSummary: source.baselineSummary,
    baselinePublicResults: source.baselineResults,
    holdoutSummary: source.bestHoldoutSummary,
    holdoutResults: source.bestHoldoutResults,
    baselineHoldoutSummary: source.baselineHoldoutSummary,
    baselineHoldoutResults: source.baselineHoldoutResults,
    stopReason: source.bestSummary.finalScore >= project.config.targetScore ? "target_reached" : "max_iters",
    rollbackExercised: source.ledger.some((entry) => entry.status === "rollback"),
    promptChangeAnalyses: [finalAnalysis],
    originalPrompt: project.prompt,
    publicBestPrompt: source.bestPrompt,
    publicBestScore: source.bestSummary.finalScore,
    publicBestResults: source.bestResults,
    publicBestSummary: source.bestSummary,
  };
  await writeV4Report({
    runDir: input.runDir,
    projectName: project.config.projectName,
    loopResult,
    goalAudit,
    testAudit: audit,
    publicComparison: compareResults(source.baselineResults, source.bestResults, project.evaluationPolicy.repairScoreThreshold),
    holdoutComparison: compareResults(source.baselineHoldoutResults, source.bestHoldoutResults, project.evaluationPolicy.repairScoreThreshold),
    promptChangeAnalyses: [finalAnalysis],
    finalVerdict,
    repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
  });
  await writeFile(join(input.runDir, "artifact-reconstruction.md"), [
    "# Artifact Reconstruction Record",
    "",
    "This run predates V5 artifact materialization. The listed files were reconstructed deterministically from preserved run results and the preserved generated test set.",
    "",
    `- Project source: ${input.projectDir}`,
    `- Generated-test source: ${input.generatedTestsDir}`,
    `- Materialized at: ${new Date().toISOString()}`,
    "- New model/provider calls: 0",
    "- Scores changed by reconstruction: no",
    "- Limitation: target and grader use the same model; generated tests are not an independent business benchmark.",
    "",
  ].join("\n"), "utf-8");

  return {
    runDir: input.runDir,
    finalVerdict: finalVerdict.label,
    reconstructedFiles: [
      "goal-audit-summary.json", "goal-audit-report.md", "generated-tests/candidate-tests.jsonl", "generated-tests/tests.jsonl", "generated-tests/holdout-tests.jsonl", "generated-tests/test-audit-summary.json", "generated-tests/test-audit-report.md", "generated-tests/source-manifest.json", "improvement-assessment.json", "supervisor-report.md", "final-verdict.json", "v5-report.md", "v4-report.md",
    ],
  };
}

async function loadSource(input: ReconstructRunArtifactsInput, project: Project) {
  const ledger = await readValidatedJsonl(join(input.runDir, "loop-ledger.jsonl"), (value) => LedgerEntrySchema.parse(value));
  const lastKeep = [...ledger].reverse().find((entry) => entry.status === "keep");
  if (!lastKeep) {
    throw new Error("Cannot reconstruct artifacts: run has no kept candidate to report as the final prompt.");
  }
  const iterationDir = join(input.runDir, `iter-${lastKeep.iteration}`);
  const candidateArtifactDir = join(iterationDir, "promptfoo", lastKeep.promptVersion);
  const requiredPaths = [
    "baseline-results.jsonl", "baseline-summary.json", "baseline-holdout-results.jsonl", "baseline-holdout-summary.json", "holdout-results.jsonl", "holdout-summary.json", "best-prompt.md", "runtime-summary.json",
  ].map((name) => join(input.runDir, name)).concat([
    join(input.runDir, "promptfoo", "normalized-results.jsonl"),
    join(input.runDir, "promptfoo", "baseline-holdout", "normalized-results.jsonl"),
    join(input.runDir, "promptfoo", "holdout", "normalized-results.jsonl"),
    join(input.runDir, "promptfoo", "version.txt"),
    join(iterationDir, "results.jsonl"), join(iterationDir, "summary.json"), join(candidateArtifactDir, "normalized-results.jsonl"),
    join(input.generatedTestsDir, "candidate-tests.jsonl"), join(input.generatedTestsDir, "tests.jsonl"), join(input.generatedTestsDir, "holdout-tests.jsonl"), join(input.generatedTestsDir, "source-manifest.json"),
  ]);
  await Promise.all(requiredPaths.map(requireFile));

  const [baselineResults, bestResults, baselineHoldoutResults, bestHoldoutResults, baselineNormalized, bestNormalized, baselineHoldoutNormalized, bestHoldoutNormalized, candidateTests, publicTests, holdoutTests] = await Promise.all([
    readValidatedJsonl(join(input.runDir, "baseline-results.jsonl"), (value) => EvalResultSchema.parse(value)),
    readValidatedJsonl(join(iterationDir, "results.jsonl"), (value) => EvalResultSchema.parse(value)),
    readValidatedJsonl(join(input.runDir, "baseline-holdout-results.jsonl"), (value) => EvalResultSchema.parse(value)),
    readValidatedJsonl(join(input.runDir, "holdout-results.jsonl"), (value) => EvalResultSchema.parse(value)),
    readValidatedJsonl(join(input.runDir, "promptfoo", "normalized-results.jsonl"), (value) => value as NormalizedPromptfooResult),
    readValidatedJsonl(join(candidateArtifactDir, "normalized-results.jsonl"), (value) => value as NormalizedPromptfooResult),
    readValidatedJsonl(join(input.runDir, "promptfoo", "baseline-holdout", "normalized-results.jsonl"), (value) => value as NormalizedPromptfooResult),
    readValidatedJsonl(join(input.runDir, "promptfoo", "holdout", "normalized-results.jsonl"), (value) => value as NormalizedPromptfooResult),
    readValidatedJsonl(join(input.generatedTestsDir, "candidate-tests.jsonl"), (value) => TestCaseSchema.parse(value)),
    readValidatedJsonl(join(input.generatedTestsDir, "tests.jsonl"), (value) => TestCaseSchema.parse(value)),
    readValidatedJsonl(join(input.generatedTestsDir, "holdout-tests.jsonl"), (value) => TestCaseSchema.parse(value)),
  ]);
  assertSameTests(project.tests, publicTests, "public tests");
  assertSameTests(project.holdoutTests, holdoutTests, "holdout tests");
  const [baselineSummary, bestSummary, baselineHoldoutSummary, bestHoldoutSummary] = await Promise.all([
    readJson(join(input.runDir, "baseline-summary.json"), (value) => SummarySchema.parse(value)),
    readJson(join(iterationDir, "summary.json"), (value) => SummarySchema.parse(value)),
    readJson(join(input.runDir, "baseline-holdout-summary.json"), (value) => SummarySchema.parse(value)),
    readJson(join(input.runDir, "holdout-summary.json"), (value) => SummarySchema.parse(value)),
  ]);
  return {
    ledger, baselineResults, bestResults, baselineHoldoutResults, bestHoldoutResults, baselineSummary, bestSummary, baselineHoldoutSummary, bestHoldoutSummary, baselineNormalized, bestNormalized, baselineHoldoutNormalized, bestHoldoutNormalized, candidateTests, publicTests, holdoutTests,
    bestPrompt: (await readFile(join(input.runDir, "best-prompt.md"), "utf-8")).trim(),
    promptfooVersion: (await readFile(join(input.runDir, "promptfoo", "version.txt"), "utf-8")).trim(),
    runtimeStats: JSON.parse(await readFile(join(input.runDir, "runtime-summary.json"), "utf-8")) as { totalApiCalls?: number; totalLatencyMs?: number; cacheHits?: number; retryErrors?: number; errorCount?: number },
    generatedManifest: JSON.parse(await readFile(join(input.generatedTestsDir, "source-manifest.json"), "utf-8")) as Record<string, unknown>,
  };
}
