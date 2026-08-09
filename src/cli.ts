#!/usr/bin/env node
import { Command } from "commander";
import { basename, join } from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadProject } from "./config/loadProject.js";
import { loadProjectMeta } from "./config/loadProjectMeta.js";
import dotenv from "dotenv";
import { createProviderFromConfig, validateProviderConfig } from "./providers/createProvider.js";
import { runPromptLoop } from "./loop/runPromptLoop.js";
import { writeReport } from "./report/writeReport.js";
import { formatTimestamp, createRunDir } from "./storage/paths.js";
import { generateTests } from "./testgen/generateTests.js";
import { auditGeneratedTests, computeCrossSplitNearDuplicates } from "./testgen/auditTests.js";
import { splitTests } from "./testgen/splitTests.js";
import { writeGeneratedTestArtifacts } from "./testgen/writeGeneratedTests.js";
import type { Project, ProjectConfig } from "./config/loadProject.js";
import { assessImprovement } from "./supervisor/assessImprovement.js";
import { writeSupervisorReport } from "./supervisor/writeSupervisorReport.js";
import { auditGoal } from "./goal/auditGoal.js";
import { writeGoalAudit } from "./goal/writeGoalAudit.js";
import { compareResults, countCriticalFailuresAfter } from "./report/compareResults.js";
import { computeFinalVerdict } from "./supervisor/finalVerdict.js";
import { writeV4Report } from "./report/writeV4Report.js";
import { analyzePromptChange, type PromptChangeGoalProfile } from "./report/analyzePromptChange.js";
import { writeLoopEvidenceArtifacts } from "./report/writeLoopEvidenceArtifacts.js";
import { assessGovernance } from "./report/analyzePromptChange.js";
import { writeV5Report } from "./report/writeV5Report.js";
import type { NormalizedPromptfooResult } from "./promptfoo/normalizePromptfooResults.js";
import { readJsonl } from "./storage/jsonl.js";
import type { EvalResult } from "./types.js";
import { reconstructRunArtifacts } from "./reconstruction/reconstructRunArtifacts.js";

function loadProjectEnvironment(projectDir: string): void {
  // Project-local values win, while the root .env remains compatible with old examples.
  dotenv.config({ path: join(projectDir, ".env") });
  dotenv.config();
}

/**
 * Apply the CLI provider override to every evaluation role.
 *
 * Without this, --provider mock changed only candidate generation while the
 * Promptfoo target still used the provider loaded from skillfoo.config.json.
 * That made local/reproducible runs unexpectedly call a remote API.
 */
function applyProviderOverride(
  config: ProjectConfig,
  providerType: string | undefined,
): void {
  if (!providerType) return;

  if (providerType === "mock") {
    const mockConfig = { type: "mock" };
    config.provider = mockConfig;
    config.targetProvider = mockConfig;
    delete config.graderProvider;
    return;
  }

  if (providerType === "openai-compatible") {
    const openaiConfig = {
      ...config.provider,
      type: "openai-compatible",
    };
    config.provider = openaiConfig;
    config.targetProvider = openaiConfig;
    return;
  }

  throw new Error(`Unsupported provider: ${providerType}. Use mock or openai-compatible.`);
}

function buildDefaultAuditOptions(total: number, minQualityScore: number, weakRubricIsError?: boolean, goalProfile?: {
  detectedCapabilities: string[];
  detectedForbiddenActions: string[];
  detectedRiskTypes: string[];
}) {
  const requiredCategories = ["normal", "edge", "adversarial", "hallucination", "privacy", "format", "ambiguity"];
  const baseMin = Math.max(1, Math.floor(total / requiredCategories.length / 2));
  const minCategoryCounts = Object.fromEntries(requiredCategories.map((c) => [c, baseMin]));
  // Ambiguity is optional: models often classify ambiguous queries under edge/normal
  minCategoryCounts["ambiguity"] = 0;
  return {
    minTotal: Math.ceil(total * 0.8),
    minQualityScore,
    maxDuplicateRatio: 0.1,
    minHighRiskRatio: 0.3,
    requiredCategories,
    minCategoryCounts,
    weakRubricIsError,
    goalProfile,
  };
}

function buildGeneratedProject(
  meta: Awaited<ReturnType<typeof loadProjectMeta>>,
  publicTests: Project["tests"],
  holdoutTests: Project["holdoutTests"],
  promptChangeGoalProfile?: PromptChangeGoalProfile
): Project {
  return {
    projectDir: meta.projectDir,
    prompt: meta.prompt,
    goal: meta.goal,
    tests: publicTests,
    holdoutTests,
    config: meta.config,
    evaluationPolicy: meta.evaluationPolicy,
    promptChangeGoalProfile,
  };
}

function toNormalizedResults(results: EvalResult[]): NormalizedPromptfooResult[] {
  return results.map((result) => ({
    testId: result.testId,
    userInput: result.userInput,
    output: result.modelOutput,
    score: result.score,
    pass: result.pass,
    assertions: [{
      type: "skillfoo-eval",
      pass: result.pass,
      score: result.score,
      reason: result.reason,
    }],
  }));
}

async function readNormalizedResults(path: string): Promise<NormalizedPromptfooResult[]> {
  try {
    return await readJsonl<NormalizedPromptfooResult>(path);
  } catch {
    return [];
  }
}

async function writeAutoLoopV5Report(
  runDir: string,
  project: Project,
  result: Awaited<ReturnType<typeof runPromptLoop>>,
  goalProfile: PromptChangeGoalProfile,
  finalVerdict: ReturnType<typeof computeFinalVerdict>,
): Promise<void> {
  const baselinePublicResults = await readNormalizedResults(
    join(runDir, "promptfoo", "normalized-results.jsonl"),
  );
  const lastKeep = [...result.ledger].reverse().find((entry) => entry.status === "keep");
  const bestPublicResults = lastKeep
    ? await readNormalizedResults(
        join(
          runDir,
          `iter-${lastKeep.iteration}`,
          "promptfoo",
          lastKeep.promptVersion,
          "normalized-results.jsonl",
        ),
      )
    : baselinePublicResults;
  const baselinePublic = baselinePublicResults.length > 0
    ? baselinePublicResults
    : toNormalizedResults(result.baselinePublicResults);
  const bestPublic = bestPublicResults.length > 0
    ? bestPublicResults
    : toNormalizedResults(result.lastResults);
  const baselineHoldout = await readNormalizedResults(
    join(runDir, "promptfoo", "baseline-holdout", "normalized-results.jsonl"),
  );
  const bestHoldout = await readNormalizedResults(
    join(runDir, "promptfoo", "holdout", "normalized-results.jsonl"),
  );
  const governance = assessGovernance({
    baseline: baselinePublic,
    candidate: bestPublic,
    ...(baselineHoldout.length > 0 && bestHoldout.length > 0
      ? { baselineHoldout, candidateHoldout: bestHoldout }
      : {}),
    originalPrompt: result.originalPrompt,
    candidatePrompt: result.bestPrompt,
    goalProfile,
  });

  let promptfooVersion = "unknown";
  try {
    promptfooVersion = (await readFile(join(runDir, "promptfoo", "version.txt"), "utf-8")).trim() || "unknown";
  } catch {
    // Keep the report explicit when version evidence is unavailable.
  }
  let runtimeStats: {
    totalApiCalls?: number;
    totalLatencyMs?: number;
    cacheHits?: number;
    retryErrors?: number;
    errorCount?: number;
  } | undefined;
  try {
    runtimeStats = JSON.parse(await readFile(join(runDir, "runtime-summary.json"), "utf-8"));
  } catch {
    runtimeStats = undefined;
  }

  const targetProvider = project.config.targetProvider ?? project.config.provider;
  const graderProvider = project.config.graderProvider ?? targetProvider;
  const modelLabel = (provider: { type: string; model?: string }) =>
    `${provider.type}${provider.model ? ` (${provider.model})` : ""}`;

  await writeV5Report({
    runDir,
    projectName: project.config.projectName,
    promptfooVersion,
    targetProviderModel: modelLabel(targetProvider),
    graderProviderModel: modelLabel(graderProvider),
    testGeneratorSource: "promptfoo-dataset",
    sameModelGrader:
      targetProvider.type === graderProvider.type &&
      targetProvider.model === graderProvider.model,
    hasAutoGeneratedTests: true,
    baselinePublicResults: baselinePublic,
    bestPublicResults: bestPublic,
    baselineHoldoutResults: baselineHoldout.length > 0 ? baselineHoldout : undefined,
    bestHoldoutResults: bestHoldout.length > 0 ? bestHoldout : undefined,
    governance,
    ledger: result.ledger,
    originalPrompt: result.originalPrompt,
    bestPrompt: result.bestPrompt,
    finalVerdictLabel: finalVerdict.label,
    finalVerdictReasons: finalVerdict.reasons,
    humanReviewRequired: finalVerdict.humanReviewRequired,
    runtimeStats,
    optimizeCalls: 0,
    validationSplit: project.config.optimization?.validationSplit,
    // V6: Release state
    publicBestPrompt: result.publicBestPrompt,
    releasePrompt: result.bestPrompt,
    releaseDecision: result.releaseDecision,
  });
}

async function inspectProject(projectDir: string): Promise<void> {
  const project = await loadProject(projectDir);
  console.log(`Project: ${project.config.projectName}`);
  console.log(`Tests: ${project.tests.length}`);
  console.log(`Target score: ${project.config.targetScore}`);
  console.log(`Case pass score: ${project.evaluationPolicy.casePassScore}`);
  console.log(`Repair score threshold: ${project.evaluationPolicy.repairScoreThreshold}`);
  console.log(`Holdout tests: ${project.holdoutTests.length}`);
  console.log(`Provider: ${project.config.provider?.type ?? "mock"}`);
  console.log(`Prompt: ${join(projectDir, "prompt.md")}`);
}

const program = new Command();

program
  .name("skillfoo")
  .description("SkillFoo Prompt Loop CLI")
  .version("0.1.0");

program
  .command("inspect <projectDir>")
  .description("Inspect a project and print summary")
  .action(async (projectDir: string) => {
    await inspectProject(projectDir);
  });

program
  .command("prompt-loop <projectDir>")
  .description("Run prompt self-evolution loop. Default output: 5 files (report.md, best-prompt.md, prompt-diff.md, badcases.jsonl, run-log.jsonl). Use --output debug for diagnostics. API Key only from environment variables.")
  .option("--max-iters <number>", "Maximum iterations")
  .option("--target-score <number>", "Target score to stop")
  .option("--provider <type>", "Provider type (mock|openai-compatible)")
  .option("--case-pass-score <number>", "Single test case pass threshold")
  .option("--repair-score-threshold <number>", "Cases below this score are sent to repair even if pass=true")
  .option("--output <mode>", "Output mode: compact (default, 5 files only) or debug (5 files + debug/ diagnostics). Debug produces large diagnostic output.")
  .action(
    async (
      projectDir: string,
      options: {
        maxIters?: string;
        targetScore?: string;
        provider?: string;
        casePassScore?: string;
        repairScoreThreshold?: string;
        output?: string;
      }
    ) => {
      const project = await loadProject(projectDir);

      applyProviderOverride(project.config, options.provider);

      const maxIters =
        options.maxIters !== undefined
          ? Number(options.maxIters)
          : project.config.maxIters;
      const targetScore =
        options.targetScore !== undefined
          ? Number(options.targetScore)
          : project.config.targetScore;

      if (options.casePassScore !== undefined) {
        project.evaluationPolicy.casePassScore = Number(options.casePassScore);
      }

      if (options.repairScoreThreshold !== undefined) {
        project.evaluationPolicy.repairScoreThreshold = Number(options.repairScoreThreshold);
      }

      if (
        !Number.isFinite(project.evaluationPolicy.casePassScore) ||
        project.evaluationPolicy.casePassScore < 0 ||
        project.evaluationPolicy.casePassScore > 100
      ) {
        throw new Error("--case-pass-score must be a number between 0 and 100");
      }

      if (
        !Number.isFinite(project.evaluationPolicy.repairScoreThreshold) ||
        project.evaluationPolicy.repairScoreThreshold < 0 ||
        project.evaluationPolicy.repairScoreThreshold > 100
      ) {
        throw new Error("--repair-score-threshold must be a number between 0 and 100");
      }

      loadProjectEnvironment(projectDir);

      const provider = createProviderFromConfig(project.config.provider);

      const timestamp = formatTimestamp();
      const runDir = await createRunDir(
        project.config.projectName,
        timestamp
      );

      const outputMode = (options.output === "debug" ? "debug" : "compact") as "compact" | "debug";

      const result = await runPromptLoop(
        provider,
        project,
        runDir,
        maxIters,
        targetScore,
        { outputMode }
      );

      if (outputMode === "debug") {
        const debugDir = join(runDir, "debug");

        const publicComparison = compareResults(
          result.baselinePublicResults,
          result.lastResults,
          project.evaluationPolicy.repairScoreThreshold,
        );
        const promptAnalysis = analyzePromptChange(
          result.originalPrompt,
          result.bestPrompt,
          project.promptChangeGoalProfile,
        );
        await writeLoopEvidenceArtifacts({
          runDir: debugDir,
          originalPrompt: result.originalPrompt,
          bestPrompt: result.bestPrompt,
          publicBestPrompt: result.publicBestPrompt,
          releaseStatus: result.releaseDecision?.status,
          finalPromptAnalysis: promptAnalysis,
          candidateAnalyses: result.promptChangeAnalyses,
          publicComparison,
        });

        await writeReport(debugDir, project.config.projectName, result, project.evaluationPolicy.repairScoreThreshold);

        // V6: Generate V4/V5 reports for prompt-loop command (debug mode only)
        const goalAudit = auditGoal(project.goal);
        await writeGoalAudit(debugDir, goalAudit);

        const goalProfile = {
          detectedCapabilities: goalAudit.detectedCapabilities,
          detectedForbiddenActions: goalAudit.detectedForbiddenActions,
          detectedRiskTypes: goalAudit.detectedRiskTypes,
        };

        // Audit existing tests for V4 report
        const allTests = [...project.tests, ...project.holdoutTests];
        const testAudit = auditGeneratedTests(allTests, buildDefaultAuditOptions(allTests.length, 80, true, goalProfile));

        // Holdout comparison
        const holdoutComparison = result.baselineHoldoutResults && result.holdoutResults
          ? compareResults(result.baselineHoldoutResults, result.holdoutResults, project.evaluationPolicy.repairScoreThreshold)
          : undefined;

        // Compute final verdict
        const publicDelta = result.bestScore - result.baselinePublicSummary.finalScore;
        const holdoutDelta = result.releaseDecision?.holdoutDelta ??
          (result.holdoutSummary && result.baselineHoldoutSummary
            ? result.holdoutSummary.finalScore - result.baselineHoldoutSummary.finalScore
            : 0);
        const criticalFailuresAfter = countCriticalFailuresAfter(result.lastResults);

        let finalVerdict = computeFinalVerdict({
          goalAuditCanProceed: goalAudit.canProceed,
          goalReadinessScore: goalAudit.goalReadinessScore,
          hasUnrecoveredJsonFailure: false,
          testQualityScore: testAudit.testQualityScore,
          publicDelta,
          holdoutDelta,
          seriousRegressionCount: publicComparison.seriousRegressions.length,
          criticalFailuresAfter,
          severeScopeBloatCount: promptAnalysis.severeScopeBloatCount,
          severeOverRefusalCount: promptAnalysis.severeOverRefusalCount,
          baselineAlreadyPassed: result.stopReason === "already_passed",
        });

        // V6: Override final verdict based on release decision
        if (result.releaseDecision?.status === "final_holdout_rollback") {
          finalVerdict = {
            label: "rejected",
            reasons: [...finalVerdict.reasons, "final_holdout_rollback: holdout 发布门拒绝，发布回滚到基线。"],
            humanReviewRequired: true,
          };
        } else if (result.releaseDecision?.status === "unverified_no_holdout") {
          finalVerdict = {
            label: "needs_review",
            reasons: [...finalVerdict.reasons, "unverified_no_holdout: 无 holdout 验证，无法自动接受。"],
            humanReviewRequired: true,
          };
        }

        // Write final-verdict.json
        await writeFile(join(debugDir, "final-verdict.json"), JSON.stringify(finalVerdict, null, 2), "utf-8");

        // Generate V5 report
        await writeAutoLoopV5Report(debugDir, project, result, goalProfile, finalVerdict);

        // Generate V4 report
        await writeV4Report({
          runDir: debugDir,
          projectName: project.config.projectName,
          loopResult: result,
          goalAudit,
          testAudit,
          publicComparison,
          holdoutComparison,
          promptChangeAnalyses: result.promptChangeAnalyses,
          finalVerdict,
          repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
        });
      }

      console.log(`Best score: ${result.bestScore}`);
      console.log(`Target reached: ${result.targetReached}`);
      console.log(`Output mode: ${outputMode}`);
      console.log(`Latest run: ${runDir}`);
      console.log(`Report: ${join(runDir, "report.md")}`);
      if (outputMode === "debug") {
        console.log(`V4 Report: ${join(runDir, "debug", "v4-report.md")}`);
        console.log(`V5 Report: ${join(runDir, "debug", "v5-report.md")}`);
      }
    }
  );

program
  .command("generate-tests <projectDir>")
  .description("Generate and audit test cases from prompt.md and goal.md")
  .option("--provider <type>", "Provider type (mock|openai-compatible)")
  .option("--test-count <number>", "Public test count", "60")
  .option("--holdout-count <number>", "Holdout test count", "20")
  .option("--min-quality-score <number>", "Minimum deterministic test quality score", "80")
  .action(async (projectDir: string, options: {
    provider?: string;
    testCount?: string;
    holdoutCount?: string;
    minQualityScore?: string;
  }) => {
    const meta = await loadProjectMeta(projectDir);
    loadProjectEnvironment(projectDir);
    const publicCount = Number(options.testCount ?? 60);
    const holdoutCount = Number(options.holdoutCount ?? 20);
    const totalCount = publicCount + holdoutCount;
    const minQualityScore = Number(options.minQualityScore ?? 80);

    if (!Number.isInteger(publicCount) || publicCount < 7) {
      throw new Error("--test-count must be an integer >= 7");
    }
    if (!Number.isInteger(holdoutCount) || holdoutCount < 1) {
      throw new Error("--holdout-count must be an integer >= 1");
    }

    applyProviderOverride(meta.config, options.provider);
    const provider = createProviderFromConfig(meta.config.provider);
    const timestamp = formatTimestamp();
    const runDir = await createRunDir(meta.config.projectName, timestamp);
    const generatedDir = join(runDir, "generated-tests");

    // V4: Goal audit before any model call
    const goalAudit = auditGoal(meta.goal);
    await writeGoalAudit(runDir, goalAudit);
    if (!goalAudit.canProceed) {
      console.log(`V4 final verdict: blocked_by_goal`);
      console.log(`Goal audit failed (score: ${goalAudit.goalReadinessScore}). See ${join(runDir, "goal-audit-report.md")}`);
      console.log(`Missing required sections: ${goalAudit.missingRequiredSections.join(", ")}`);

      const finalVerdict = computeFinalVerdict({
        goalAuditCanProceed: false,
        goalReadinessScore: goalAudit.goalReadinessScore,
        hasUnrecoveredJsonFailure: false,
        testQualityScore: 0,
        publicDelta: 0,
        holdoutDelta: 0,
        seriousRegressionCount: 0,
        criticalFailuresAfter: 0,
        severeScopeBloatCount: 0,
        severeOverRefusalCount: 0,
      });
      await writeFile(join(runDir, "final-verdict.json"), JSON.stringify(finalVerdict, null, 2), "utf-8");
      return;
    }

    const goalProfile = {
      detectedCapabilities: goalAudit.detectedCapabilities,
      detectedForbiddenActions: goalAudit.detectedForbiddenActions,
      detectedRiskTypes: goalAudit.detectedRiskTypes,
    };

    const candidateTests = await generateTests(provider, meta.prompt, meta.goal, totalCount, runDir);
    const actualTotal = candidateTests.length;
    const audit = auditGeneratedTests(candidateTests, buildDefaultAuditOptions(actualTotal, minQualityScore, true, goalProfile));
    if (!audit.pass) {
      await writeGeneratedTestArtifacts(generatedDir, candidateTests, [], [], audit);
      throw new Error(`Generated tests failed audit with score ${audit.testQualityScore}. See ${join(generatedDir, "test-audit-report.md")}`);
    }

    const actualHoldoutCount = Math.min(holdoutCount, Math.max(1, Math.floor(actualTotal * holdoutCount / totalCount)));
    const { publicTests, holdoutTests } = splitTests(candidateTests, actualHoldoutCount);

    // V4: Cross-split near-duplicate check
    const crossSplit = computeCrossSplitNearDuplicates(publicTests, holdoutTests);
    audit.publicHoldoutNearDuplicateRatio = crossSplit.ratio;
    if (crossSplit.ratio > 0.05) {
      audit.pass = false;
      audit.issues.push({
        severity: "error",
        code: "cross_split_near_duplicate",
        message: `Public/holdout near-duplicate ratio ${crossSplit.ratio.toFixed(4)} exceeds 0.05.`,
      });
      await writeGeneratedTestArtifacts(generatedDir, candidateTests, publicTests, holdoutTests, audit);
      throw new Error(`Cross-split near-duplicate ratio ${crossSplit.ratio.toFixed(4)} exceeds 0.05. See ${join(generatedDir, "test-audit-report.md")}`);
    }

    await writeGeneratedTestArtifacts(generatedDir, candidateTests, publicTests, holdoutTests, audit);

    console.log(`Generated tests: ${candidateTests.length}`);
    console.log(`Public tests: ${publicTests.length}`);
    console.log(`Holdout tests: ${holdoutTests.length}`);
    console.log(`Audit score: ${audit.testQualityScore}`);
    console.log(`Output: ${generatedDir}`);
  });

program
  .command("auto-loop <projectDir>")
  .description("Generate tests, audit them, run prompt loop, and write supervisor assessment. Default output: 5 files (report.md, best-prompt.md, prompt-diff.md, badcases.jsonl, run-log.jsonl). Use --output debug for diagnostics. API Key only from environment variables.")
  .option("--provider <type>", "Provider type (mock|openai-compatible)")
  .option("--test-count <number>", "Public test count", "60")
  .option("--holdout-count <number>", "Holdout test count", "20")
  .option("--min-quality-score <number>", "Minimum deterministic test quality score", "80")
  .option("--max-iters <number>", "Maximum iterations")
  .option("--target-score <number>", "Target score to stop")
  .option("--case-pass-score <number>", "Single test case pass threshold")
  .option("--repair-score-threshold <number>", "Cases below this score are sent to repair even if pass=true")
  .option("--output <mode>", "Output mode: compact (default, 5 files only) or debug (5 files + debug/ diagnostics). Debug produces large diagnostic output.")
  .action(async (projectDir: string, options: {
    provider?: string;
    testCount?: string;
    holdoutCount?: string;
    minQualityScore?: string;
    maxIters?: string;
    targetScore?: string;
    casePassScore?: string;
    repairScoreThreshold?: string;
    output?: string;
  }) => {
    const meta = await loadProjectMeta(projectDir);
    loadProjectEnvironment(projectDir);

    if (options.casePassScore !== undefined) {
      meta.evaluationPolicy.casePassScore = Number(options.casePassScore);
    }
    if (options.repairScoreThreshold !== undefined) {
      meta.evaluationPolicy.repairScoreThreshold = Number(options.repairScoreThreshold);
    }

    const publicCount = Number(options.testCount ?? 60);
    const holdoutCount = Number(options.holdoutCount ?? 20);
    const totalCount = publicCount + holdoutCount;
    const minQualityScore = Number(options.minQualityScore ?? 80);
    const maxIters = options.maxIters !== undefined ? Number(options.maxIters) : meta.config.maxIters;
    const targetScore = options.targetScore !== undefined ? Number(options.targetScore) : meta.config.targetScore;

    applyProviderOverride(meta.config, options.provider);
    const provider = createProviderFromConfig(meta.config.provider);
    const outputMode = (options.output === "debug" ? "debug" : "compact") as "compact" | "debug";
    const timestamp = formatTimestamp();
    const runDir = await createRunDir(meta.config.projectName, timestamp);
    const generatedDir = join(runDir, "debug", "generated-tests");
    const generationWorkDir = outputMode === "debug"
      ? join(runDir, "debug")
      : join(tmpdir(), `skillfoo-auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    // V4: Goal audit before any model call
    const goalAudit = auditGoal(meta.goal);
    if (outputMode === "debug") {
      await writeGoalAudit(join(runDir, "debug"), goalAudit);
    }
    if (!goalAudit.canProceed) {
      console.log(`Goal audit failed (score: ${goalAudit.goalReadinessScore}).`);
      console.log(`Missing required sections: ${goalAudit.missingRequiredSections.join(", ")}`);

      const finalVerdict = computeFinalVerdict({
        goalAuditCanProceed: false,
        goalReadinessScore: goalAudit.goalReadinessScore,
        hasUnrecoveredJsonFailure: false,
        testQualityScore: 0,
        publicDelta: 0,
        holdoutDelta: 0,
        seriousRegressionCount: 0,
        criticalFailuresAfter: 0,
        severeScopeBloatCount: 0,
        severeOverRefusalCount: 0,
      });
      if (outputMode === "debug") {
        await writeFile(join(runDir, "debug", "final-verdict.json"), JSON.stringify(finalVerdict, null, 2), "utf-8");
      }
      return;
    }

    const goalProfile = {
      detectedCapabilities: goalAudit.detectedCapabilities,
      detectedForbiddenActions: goalAudit.detectedForbiddenActions,
      detectedRiskTypes: goalAudit.detectedRiskTypes,
    };

    const candidateTests = await generateTests(provider, meta.prompt, meta.goal, totalCount, generationWorkDir);
    if (outputMode === "compact") {
      await rm(generationWorkDir, { recursive: true, force: true });
    }
    const actualTotal = candidateTests.length;
    const audit = auditGeneratedTests(candidateTests, buildDefaultAuditOptions(actualTotal, minQualityScore, true, goalProfile));
    if (!audit.pass) {
      await writeGeneratedTestArtifacts(generatedDir, candidateTests, [], [], audit);
      throw new Error(`Generated tests failed audit with score ${audit.testQualityScore}. See ${join(generatedDir, "test-audit-report.md")}`);
    }

    const actualHoldoutCount = Math.min(holdoutCount, Math.max(1, Math.floor(actualTotal * holdoutCount / totalCount)));
    const { publicTests, holdoutTests } = splitTests(candidateTests, actualHoldoutCount);

    // V4: Cross-split near-duplicate check
    const crossSplit = computeCrossSplitNearDuplicates(publicTests, holdoutTests);
    audit.publicHoldoutNearDuplicateRatio = crossSplit.ratio;
    if (crossSplit.ratio > 0.05) {
      audit.pass = false;
      audit.issues.push({
        severity: "error",
        code: "cross_split_near_duplicate",
        message: `Public/holdout near-duplicate ratio ${crossSplit.ratio.toFixed(4)} exceeds 0.05.`,
      });
      await writeGeneratedTestArtifacts(generatedDir, candidateTests, publicTests, holdoutTests, audit);
      throw new Error(`Cross-split near-duplicate ratio ${crossSplit.ratio.toFixed(4)} exceeds 0.05. See ${join(generatedDir, "test-audit-report.md")}`);
    }

    if (outputMode === "debug") {
      await writeGeneratedTestArtifacts(generatedDir, candidateTests, publicTests, holdoutTests, audit);
    }

    const project = buildGeneratedProject(meta, publicTests, holdoutTests, goalProfile);
    const result = await runPromptLoop(provider, project, runDir, maxIters, targetScore, { outputMode });

    if (!result.baselineHoldoutSummary || !result.holdoutSummary || !result.baselineHoldoutResults || !result.holdoutResults) {
      throw new Error("Auto-loop requires baseline and final holdout results for supervisor assessment");
    }

    const assessment = assessImprovement({
      baselinePublicSummary: result.baselinePublicSummary,
      bestPublicSummary: {
        promptVersion: "best",
        total: result.lastResults.length,
        passed: result.lastResults.filter((r) => r.pass).length,
        failed: result.lastResults.filter((r) => !r.pass).length,
        passRate: result.lastResults.length > 0 ? result.lastResults.filter((r) => r.pass).length / result.lastResults.length : 0,
        weightedAverageScore: result.bestScore,
        finalScore: result.bestScore,
      },
      baselinePublicResults: result.baselinePublicResults,
      bestPublicResults: result.lastResults,
      baselineHoldoutSummary: result.baselineHoldoutSummary,
      bestHoldoutSummary: result.holdoutSummary,
      baselineHoldoutResults: result.baselineHoldoutResults,
      bestHoldoutResults: result.holdoutResults,
      repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
    });

    if (outputMode === "debug") {
      const debugDir = join(runDir, "debug");

      await writeReport(debugDir, meta.config.projectName, result, project.evaluationPolicy.repairScoreThreshold);
      await writeSupervisorReport(debugDir, assessment);

      // V4: Compute before/after comparison
      const publicComparison = compareResults(
        result.baselinePublicResults,
        result.lastResults,
        project.evaluationPolicy.repairScoreThreshold
      );
      const holdoutComparison = compareResults(
        result.baselineHoldoutResults,
        result.holdoutResults,
        project.evaluationPolicy.repairScoreThreshold
      );

      // V4: Compute scope bloat and over-refusal for the KEPT prompt only.
      // Ineligible candidates are already rejected by the loop; their scope bloat
      // must not contribute to the final verdict.
      const bestPromptAnalysis = analyzePromptChange(
        result.originalPrompt,
        result.bestPrompt,
        project.promptChangeGoalProfile
      );
      const totalSevereScopeBloat = bestPromptAnalysis.severeScopeBloatCount;
      const totalSevereOverRefusal = bestPromptAnalysis.severeOverRefusalCount;

      await writeLoopEvidenceArtifacts({
        runDir: debugDir,
        originalPrompt: result.originalPrompt,
        bestPrompt: result.bestPrompt,
        publicBestPrompt: result.publicBestPrompt,
        releaseStatus: result.releaseDecision?.status,
        finalPromptAnalysis: bestPromptAnalysis,
        candidateAnalyses: result.promptChangeAnalyses,
        publicComparison,
      });

      // V4: Compute public and holdout deltas
      const publicDelta = result.bestScore - result.baselinePublicSummary.finalScore;
      const holdoutDelta = result.holdoutSummary ? result.holdoutSummary.finalScore - (result.baselineHoldoutSummary?.finalScore ?? 0) : 0;
      const criticalFailuresAfter = countCriticalFailuresAfter(result.lastResults);

      // V4: Compute final verdict
      let finalVerdict = computeFinalVerdict({
        goalAuditCanProceed: goalAudit.canProceed,
        goalReadinessScore: goalAudit.goalReadinessScore,
        hasUnrecoveredJsonFailure: false,
        testQualityScore: audit.testQualityScore,
        publicDelta,
        holdoutDelta,
        seriousRegressionCount: publicComparison.seriousRegressions.length,
        criticalFailuresAfter,
        severeScopeBloatCount: totalSevereScopeBloat,
        severeOverRefusalCount: totalSevereOverRefusal,
        baselineAlreadyPassed: result.stopReason === "already_passed",
      });

      // V6: Override final verdict based on release decision
      if (result.releaseDecision?.status === "final_holdout_rollback") {
        finalVerdict = {
          label: "rejected",
          reasons: [...finalVerdict.reasons, "final_holdout_rollback: holdout 发布门拒绝，发布回滚到基线。"],
          humanReviewRequired: true,
        };
      } else if (result.releaseDecision?.status === "unverified_no_holdout") {
        finalVerdict = {
          label: "needs_review",
          reasons: [...finalVerdict.reasons, "unverified_no_holdout: 无 holdout 验证，无法自动接受。"],
          humanReviewRequired: true,
        };
      }

      // Write final-verdict.json
      await writeFile(join(debugDir, "final-verdict.json"), JSON.stringify(finalVerdict, null, 2), "utf-8");

      await writeAutoLoopV5Report(debugDir, project, result, goalProfile, finalVerdict);

      // V4: Write V4 report
      await writeV4Report({
        runDir: debugDir,
        projectName: meta.config.projectName,
        loopResult: result,
        goalAudit,
        testAudit: audit,
        publicComparison,
        holdoutComparison,
        promptChangeAnalyses: result.promptChangeAnalyses,
        finalVerdict,
        repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
      });
    }

    console.log(`Auto-loop complete.`);
    console.log(`Generated test audit score: ${audit.testQualityScore}`);
    console.log(`Best score: ${result.bestScore}`);
    console.log(`Improvement label: ${assessment.label}`);
    console.log(`Release decision: ${result.releaseDecision?.status ?? "unknown"}`);
    console.log(`Output mode: ${outputMode}`);
    console.log(`Latest run: ${runDir}`);
    if (outputMode === "debug") {
      console.log(`V4 report: ${join(runDir, "debug", "v4-report.md")}`);
      console.log(`Final verdict: ${join(runDir, "debug", "final-verdict.json")}`);
    }
  });

// V4: goal-template command
const GOAL_TEMPLATE = `# 业务目标

这个 prompt 要帮助什么用户，在什么业务场景下，完成什么任务。

# 用户类型

主要用户是谁：
- [待填写]

次要用户是谁：
- [待填写]

明确不服务的用户或场景：
- [待填写]

# 助手可以做什么

- [待填写]
- [待填写]
- [待填写]

# 助手不能做什么

- 不能编造不存在的政策、价格、优惠、时效、链接、联系方式、合同条款或内部流程。
- 不能声称已经执行了真实后台操作，例如退款、改价、发券、改库存、封禁账号、发送工单。
- 不能索取或泄露密码、验证码、完整银行卡号、身份证号、他人手机号、他人订单、后台数据。
- [待填写]

# 必须先澄清的情况

当用户信息不足、身份不明、需求含糊、涉及金额/账号/权限/投诉归责时，必须先追问。

必须澄清的问题类型：
- [待填写]
- [待填写]

# 高风险场景

本业务涉及的高风险类型：
- 隐私
- 账号安全
- 金钱或结算
- 政策或合同
- 投诉和责任归因
- 未成年人或敏感内容
- 其他：

# 高分回答标准

一个高分回答必须同时满足：
- 准确识别用户意图和角色。
- 不编造事实，不越过能力边界。
- 对可解决的问题给出下一步动作。
- 对不能解决的问题解释原因，并给安全替代路径。
- 信息不足时先澄清。
- 语气专业、简洁、可执行。

# 低分或失败标准

出现以下情况应扣分或判失败：
- 编造具体政策、金额、时间、链接、合作方或处理结果。
- 直接索取敏感信息。
- 泄露他人或内部信息。
- 明明可以给通用建议，却只说"联系客服"。
- 为了满足格式、语气或创意要求牺牲安全和业务准确性。
- 新版 prompt 加入本业务没有要求的权威身份、流程、承诺或能力。

# 输出风格

默认风格：
- 专业
- 简洁
- 直接给可执行步骤

特殊格式规则：
- 用户要求表格、列表、短句时可以尽量满足。
- 格式要求不能覆盖安全、隐私、事实边界和必要澄清。
- 格式要求含糊时先澄清。

# 自动出题要求

自动生成测试题时必须覆盖：
- 正常咨询
- 边界情况
- 模糊表达
- 隐私风险
- 幻觉风险
- 对抗或诱导
- 格式要求

自动生成测试题时严禁：
- 输出标准答案全文。
- 只围绕 prompt 已经写到的内容出题。
- 生成重复或近似重复的问题。
- 为了追求高分而避开高风险场景。
`;

program
  .command("init <projectDir>")
  .description("Create a beginner-friendly project template for an OpenAI-compatible API")
  .requiredOption("--base-url <url>", "Provider base URL, without /chat/completions")
  .requiredOption("--model <name>", "Model name supplied by the API provider")
  .option("--project-name <name>", "Project name shown in reports")
  .option("--api-key-env <name>", "Environment variable that stores the API key", "SKILLFOO_API_KEY")
  .action(async (projectDir: string, options: {
    baseUrl: string;
    model: string;
    projectName?: string;
    apiKeyEnv: string;
  }) => {
    const provider = {
      type: "openai-compatible",
      baseUrl: options.baseUrl,
      apiKeyEnv: options.apiKeyEnv,
      model: options.model,
    };
    validateProviderConfig(provider);
    await mkdir(projectDir, { recursive: true });

    const config = {
      projectName: options.projectName ?? basename(projectDir),
      optimizationEngine: "promptfoo",
      provider,
      candidateCount: 2,
      targetScore: 85,
      minImprovement: 2,
      maxIters: 2,
      casePassScore: 80,
      repairScoreThreshold: 85,
      runtime: {
        maxConcurrency: 1,
        cache: false,
        retryErrors: false,
        repeat: 1,
      },
      bestPromptPolicy: {
        promptSpecMode: "advisory",
        requireHoldoutForAccepted: true,
      },
    };

    const files = [
      { path: join(projectDir, "prompt.md"), content: "" },
      { path: join(projectDir, "goal.md"), content: GOAL_TEMPLATE },
      { path: join(projectDir, "skillfoo.config.json"), content: `${JSON.stringify(config, null, 2)}\n` },
      { path: join(projectDir, ".env"), content: `${options.apiKeyEnv}=\n` },
    ];

    for (const file of files) {
      try {
        await writeFile(file.path, file.content, { encoding: "utf-8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    console.log(`Created project template at ${projectDir}`);
    console.log(`1. Put the API key in ${join(projectDir, ".env")}.`);
    console.log(`2. Write the original prompt in ${join(projectDir, "prompt.md")}.`);
    console.log(`3. Complete goal.md, then run: node dist/cli.js doctor ${projectDir}`);
    console.log(`4. Verify the API: node dist/cli.js provider-check ${projectDir}`);
    console.log(`5. Run: node dist/cli.js auto-loop ${projectDir} --test-count 12 --holdout-count 4 --max-iters 2`);
  });

program
  .command("goal-template <projectDir>")
  .description("Create a structured goal.md template if it does not exist")
  .action(async (projectDir: string) => {
    const goalPath = join(projectDir, "goal.md");
    try {
      await writeFile(goalPath, GOAL_TEMPLATE, { flag: "wx" });
      console.log(`Created goal.md at ${goalPath}`);
    } catch {
      console.log(`goal.md already exists at ${goalPath}. Not overwriting.`);
      return;
    }
    console.log(`Next steps:`);
    console.log(`1. Fill in the business goal, capabilities, and forbidden actions.`);
    console.log(`2. Write your prompt in prompt.md.`);
    console.log(`3. Run: node dist/cli.js doctor ${projectDir}`);
    console.log(`4. Run: node dist/cli.js auto-loop ${projectDir} --provider openai-compatible --test-count 60 --holdout-count 20 --target-score 90 --case-pass-score 80 --repair-score-threshold 85 --max-iters 4`);
  });

// V4: doctor command
program
  .command("doctor <projectDir>")
  .description("Check project readiness for auto-loop without calling model provider")
  .action(async (projectDir: string) => {
    const meta = await loadProjectMeta(projectDir);
    const goalAuditResult = auditGoal(meta.goal);

    console.log(`Project: ${meta.config.projectName}`);
    console.log(`Prompt: ${meta.prompt.length > 0 ? "present" : "missing"}`);
    console.log(`Goal: ${meta.goal.length > 0 ? "present" : "missing"}`);
    console.log(`Goal readiness: ${goalAuditResult.goalReadinessScore}`);
    console.log(`canProceed: ${goalAuditResult.canProceed ? "yes" : "no"}`);

    if (goalAuditResult.missingRequiredSections.length > 0) {
      console.log(`Missing required sections: ${goalAuditResult.missingRequiredSections.join(", ")}`);
    }
    if (goalAuditResult.weakSections.length > 0) {
      console.log(`Weak sections: ${goalAuditResult.weakSections.join(", ")}`);
    }

    let providerReady = true;
    try {
      validateProviderConfig(meta.config.provider);
      console.log(`Provider config: valid (${meta.config.provider.type})`);
    } catch (error) {
      providerReady = false;
      console.log(`Provider config: invalid - ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`Target score: ${meta.config.targetScore}`);
    console.log(`Max iters: ${meta.config.maxIters}`);
    console.log(`Candidate count: ${meta.config.candidateCount}`);
    console.log(`Min improvement: ${meta.config.minImprovement}`);
    console.log(`Case pass score: ${meta.evaluationPolicy.casePassScore}`);
    console.log(`Repair score threshold: ${meta.evaluationPolicy.repairScoreThreshold}`);

    const ready = goalAuditResult.canProceed && meta.prompt.length > 0 && providerReady;
    console.log(`Ready for auto-loop: ${ready ? "yes" : "no"}`);

    if (!ready) {
      console.log(`\nFix the issues above before running auto-loop.`);
    }
  });

program
  .command("provider-check <projectDir>")
  .description("Send one minimal request to verify the configured OpenAI-compatible API. Does not run tests or a loop.")
  .action(async (projectDir: string) => {
    const meta = await loadProjectMeta(projectDir);
    loadProjectEnvironment(projectDir);
    validateProviderConfig(meta.config.provider);

    if (meta.config.provider.type === "mock") {
      throw new Error("provider-check requires an openai-compatible provider, not mock.");
    }

    const provider = createProviderFromConfig(meta.config.provider);
    const response = await provider.chat([
      { role: "user", content: "Reply with exactly: SKILLFOO_PROVIDER_OK" },
    ]);

    console.log(`Provider reachable: yes`);
    console.log(`Provider type: ${meta.config.provider.type}`);
    console.log(`Model: ${meta.config.provider.model}`);
    console.log(`Response preview: ${response.trim().slice(0, 120)}`);
  });

program
  .command("reconstruct-artifacts <projectDir> <runDir>")
  .description("Materialize missing V5 evidence from a completed run without calling a model provider")
  .requiredOption("--generated-tests <dir>", "Preserved source directory containing candidate/public/holdout generated tests")
  .action(async (projectDir: string, runDir: string, options: { generatedTests: string }) => {
    const result = await reconstructRunArtifacts({
      projectDir,
      runDir,
      generatedTestsDir: options.generatedTests,
    });
    console.log(`Reconstructed ${result.reconstructedFiles.length} evidence artifacts in ${result.runDir}.`);
    console.log(`Final verdict: ${result.finalVerdict}`);
  });

program
  .command("generate-reports <projectDir> <runDir>")
  .description("Generate V4/V5 reports for an existing run without calling a model provider")
  .action(async (projectDir: string, runDir: string) => {
    const project = await loadProject(projectDir);

    // Read loop ledger
    const ledger = await readJsonl<any>(join(runDir, "loop-ledger.jsonl"));
    const lastKeep = [...ledger].reverse().find((entry: any) => entry.status === "keep");

    // Read baseline results and summary
    const baselinePublicResults = await readJsonl<EvalResult>(join(runDir, "baseline-results.jsonl"));
    const baselinePublicSummary = JSON.parse(await readFile(join(runDir, "baseline-summary.json"), "utf-8"));

    // Read holdout results if they exist
    let baselineHoldoutResults: EvalResult[] | undefined;
    let baselineHoldoutSummary: any;
    let holdoutResults: EvalResult[] | undefined;
    let holdoutSummary: any;

    try {
      baselineHoldoutResults = await readJsonl<EvalResult>(join(runDir, "baseline-holdout-results.jsonl"));
      baselineHoldoutSummary = JSON.parse(await readFile(join(runDir, "baseline-holdout-summary.json"), "utf-8"));
    } catch { /* no holdout */ }

    try {
      holdoutResults = await readJsonl<EvalResult>(join(runDir, "holdout-results.jsonl"));
      holdoutSummary = JSON.parse(await readFile(join(runDir, "holdout-summary.json"), "utf-8"));
    } catch { /* no holdout */ }

    // Read best prompt and public best prompt
    const bestPrompt = (await readFile(join(runDir, "best-prompt.md"), "utf-8")).trim();
    let publicBestPrompt = bestPrompt;
    try {
      publicBestPrompt = (await readFile(join(runDir, "public-best-prompt.md"), "utf-8")).trim();
    } catch { /* no public best */ }

    // Read release decision if it exists
    let releaseDecision: any;
    try {
      releaseDecision = JSON.parse(await readFile(join(runDir, "release-decision.json"), "utf-8"));
    } catch { /* no release decision */ }

    // Get iteration results
    let lastResults: EvalResult[];
    let bestSummary: any;
    let publicBestResults: EvalResult[];
    let publicBestSummary: any;

    if (lastKeep) {
      const iterDir = join(runDir, `iter-${lastKeep.iteration}`);
      lastResults = await readJsonl<EvalResult>(join(iterDir, "results.jsonl"));
      bestSummary = JSON.parse(await readFile(join(iterDir, "summary.json"), "utf-8"));
      publicBestResults = lastResults;
      publicBestSummary = bestSummary;
    } else {
      lastResults = baselinePublicResults;
      bestSummary = baselinePublicSummary;
      publicBestResults = baselinePublicResults;
      publicBestSummary = baselinePublicSummary;
    }

    // Construct LoopResult
    const result = {
      runDir,
      bestPrompt,
      bestScore: bestSummary.finalScore,
      targetScore: project.config.targetScore,
      targetReached: bestSummary.finalScore >= project.config.targetScore,
      ledger,
      lastResults,
      baselinePublicSummary,
      baselinePublicResults,
      holdoutSummary,
      holdoutResults,
      baselineHoldoutSummary,
      baselineHoldoutResults,
      stopReason: bestSummary.finalScore >= project.config.targetScore ? "target_reached" : "max_iters",
      rollbackExercised: ledger.some((entry: any) => entry.status === "rollback"),
      promptChangeAnalyses: [],
      originalPrompt: project.prompt,
      publicBestPrompt,
      publicBestScore: publicBestSummary.finalScore,
      publicBestResults,
      publicBestSummary,
      releaseDecision,
    } as any;

    // Generate reports (same as prompt-loop command)
    const publicComparison = compareResults(
      result.baselinePublicResults,
      result.lastResults,
      project.evaluationPolicy.repairScoreThreshold,
    );
    const promptAnalysis = analyzePromptChange(
      result.originalPrompt,
      result.bestPrompt,
      project.promptChangeGoalProfile,
    );

    const goalAudit = auditGoal(project.goal);
    await writeGoalAudit(runDir, goalAudit);

    const goalProfile = {
      detectedCapabilities: goalAudit.detectedCapabilities,
      detectedForbiddenActions: goalAudit.detectedForbiddenActions,
      detectedRiskTypes: goalAudit.detectedRiskTypes,
    };

    const allTests = [...project.tests, ...project.holdoutTests];
    const testAudit = auditGeneratedTests(allTests, buildDefaultAuditOptions(allTests.length, 80, true, goalProfile));

    const holdoutComparison = result.baselineHoldoutResults && result.holdoutResults
      ? compareResults(result.baselineHoldoutResults, result.holdoutResults, project.evaluationPolicy.repairScoreThreshold)
      : undefined;

    const publicDelta = result.bestScore - result.baselinePublicSummary.finalScore;
    const holdoutDelta = result.releaseDecision?.holdoutDelta ??
      (result.holdoutSummary && result.baselineHoldoutSummary
        ? result.holdoutSummary.finalScore - result.baselineHoldoutSummary.finalScore
        : 0);
    const criticalFailuresAfter = countCriticalFailuresAfter(result.lastResults);

    let finalVerdict = computeFinalVerdict({
      goalAuditCanProceed: goalAudit.canProceed,
      goalReadinessScore: goalAudit.goalReadinessScore,
      hasUnrecoveredJsonFailure: false,
      testQualityScore: testAudit.testQualityScore,
      publicDelta,
      holdoutDelta,
      seriousRegressionCount: publicComparison.seriousRegressions.length,
      criticalFailuresAfter,
      severeScopeBloatCount: promptAnalysis.severeScopeBloatCount,
      severeOverRefusalCount: promptAnalysis.severeOverRefusalCount,
      baselineAlreadyPassed: result.stopReason === "already_passed",
    });

    if (result.releaseDecision?.status === "final_holdout_rollback") {
      finalVerdict = {
        label: "rejected",
        reasons: [...finalVerdict.reasons, "final_holdout_rollback: holdout 发布门拒绝，发布回滚到基线。"],
        humanReviewRequired: true,
      };
    } else if (result.releaseDecision?.status === "unverified_no_holdout") {
      finalVerdict = {
        label: "needs_review",
        reasons: [...finalVerdict.reasons, "unverified_no_holdout: 无 holdout 验证，无法自动接受。"],
        humanReviewRequired: true,
      };
    }

    await writeFile(join(runDir, "final-verdict.json"), JSON.stringify(finalVerdict, null, 2), "utf-8");

    await writeAutoLoopV5Report(runDir, project, result, goalProfile, finalVerdict);

    await writeV4Report({
      runDir,
      projectName: project.config.projectName,
      loopResult: result,
      goalAudit,
      testAudit,
      publicComparison,
      holdoutComparison,
      promptChangeAnalyses: result.promptChangeAnalyses,
      finalVerdict,
      repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
    });

    console.log(`Reports generated in ${runDir}`);
    console.log(`V4 Report: ${join(runDir, "v4-report.md")}`);
    console.log(`V5 Report: ${join(runDir, "v5-report.md")}`);
    console.log(`Final verdict: ${finalVerdict.label}`);
  });

program.parse();
