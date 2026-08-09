import { join } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import type { ChatMessage, ModelProvider } from "../providers/types.js";
import type {
  EvalResult,
  Summary,
  LedgerEntry,
  CandidatePrompt,
} from "../types.js";
import type { Project } from "../config/loadProject.js";
import { runEngineEval } from "../evaluation/runEngineEval.js";
import { generateCandidates } from "../repair/generateCandidates.js";
import { writeJsonl } from "../storage/jsonl.js";
import { appendLedgerEntry } from "./ledger.js";
import { analyzePromptChange, isCandidateIneligible } from "../report/analyzePromptChange.js";
import type { PromptChangeAnalysis } from "../report/analyzePromptChange.js";
import { resolveLoopEngine } from "./engineDecision.js";
import { writePromptfooRunArtifacts } from "../promptfoo/writePromptfooRunArtifacts.js";
import { decidePublicKeep } from "./keepGate.js";
import { decideRelease } from "./releaseGate.js";
import { writeBestPromptEvidence } from "../report/writeBestPromptEvidence.js";
import { writePromptSpecArtifacts } from "../promptspec/writePromptSpecArtifacts.js";
import type { ReleaseDecision } from "../types.js";
import { tmpdir } from "node:os";
import { rm, readdir, readFile } from "node:fs/promises";
import { RunLogWriter } from "../output/runLog.js";
import { writeCompactArtifacts } from "../output/compactArtifacts.js";
import { redactSensitiveConfig } from "../output/redactSensitiveConfig.js";
import type { OutputMode, RunLogEvent } from "../types.js";
import { createHash } from "node:crypto";

export interface LoopResult {
  runDir: string;
  bestPrompt: string;
  bestScore: number;
  targetScore: number;
  targetReached: boolean;
  ledger: LedgerEntry[];
  lastResults: EvalResult[];
  baselinePublicSummary: Summary;
  baselinePublicResults: EvalResult[];
  holdoutSummary?: Summary;
  holdoutResults?: EvalResult[];
  baselineHoldoutSummary?: Summary;
  baselineHoldoutResults?: EvalResult[];
  stopReason: "target_reached" | "already_passed" | "max_iters" | "no_repair_cases" | "max_iters_zero" | "blocked";
  rollbackExercised: boolean;
  promptChangeAnalyses: PromptChangeAnalysis[];
  originalPrompt: string;
  publicBestPrompt: string;
  publicBestScore: number;
  publicBestResults: EvalResult[];
  publicBestSummary: Summary;
  releaseDecision?: ReleaseDecision;
}

export interface ObservedChatCalls {
  total: number;
  target: number;
  judge: number;
  candidateGeneration: number;
  other: number;
}

function observeProvider(provider: ModelProvider): {
  provider: ModelProvider;
  observedChatCalls: ObservedChatCalls;
} {
  const observedChatCalls: ObservedChatCalls = {
    total: 0,
    target: 0,
    judge: 0,
    candidateGeneration: 0,
    other: 0,
  };

  const classify = (messages: ChatMessage[]): keyof Omit<ObservedChatCalls, "total"> => {
    const content = messages.map((message) => message.content).join("\n");
    if (content.includes("REPAIR_PROMPT_JSON")) return "candidateGeneration";
    if (content.includes("JUDGE_JSON")) return "judge";
    return "target";
  };

  return {
    provider: {
      name: provider.name,
      async chat(messages: ChatMessage[]): Promise<string> {
        const role = classify(messages);
        observedChatCalls.total++;
        observedChatCalls[role]++;
        return provider.chat(messages);
      },
    },
    observedChatCalls,
  };
}

export function selectRepairCases(
  results: EvalResult[],
  repairScoreThreshold: number,
  forceQualityProbe = false,
): EvalResult[] {
  const repairCases = results.filter((r) => !r.pass || r.score < repairScoreThreshold);
  if (repairCases.length > 0 || !forceQualityProbe) {
    return repairCases;
  }

  // A passing baseline still needs one controlled optimization attempt. Use
  // the lowest-scoring public cases as improvement probes, never holdout cases.
  return [...results]
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.max(1, Math.min(5, results.length)));
}

async function runHoldoutIfPresent(
  provider: ModelProvider,
  project: Project,
  runDir: string,
  bestPrompt: string
): Promise<{ holdoutResults?: EvalResult[]; holdoutSummary?: Summary }> {
  if (project.holdoutTests.length === 0) {
    return {};
  }

  const { results, summary } = await runEngineEval(
    provider,
    project,
    bestPrompt,
    {
      runDir,
      promptVersion: "holdout",
      tests: project.holdoutTests,
      artifactDir: join(runDir, "promptfoo", "holdout"),
    },
  );

  await writeJsonl(join(runDir, "holdout-results.jsonl"), results);
  await writeFile(
    join(runDir, "holdout-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8"
  );

  return { holdoutResults: results, holdoutSummary: summary };
}

async function runBaselineHoldoutIfPresent(
  provider: ModelProvider,
  project: Project,
  runDir: string
): Promise<{ baselineHoldoutResults?: EvalResult[]; baselineHoldoutSummary?: Summary }> {
  if (project.holdoutTests.length === 0) {
    return {};
  }

  const { results, summary } = await runEngineEval(
    provider,
    project,
    project.prompt,
    {
      runDir,
      promptVersion: "baseline-holdout",
      tests: project.holdoutTests,
      artifactDir: join(runDir, "promptfoo", "baseline-holdout"),
    },
  );

  await writeJsonl(join(runDir, "baseline-holdout-results.jsonl"), results);
  await writeFile(
    join(runDir, "baseline-holdout-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8"
  );

  return { baselineHoldoutResults: results, baselineHoldoutSummary: summary };
}

async function writeRuntimeSummary(
  runDir: string,
  project: Project,
  ledger: LedgerEntry[],
  baselineAlreadyPassed: boolean,
  errorCount = 0,
): Promise<void> {
  const runtime = project.config.runtime ?? {
    maxConcurrency: 2,
    cache: true,
    retryErrors: true,
    repeat: 1,
  };
  const engine = resolveLoopEngine(project.config);
  const summary = {
    timestamp: new Date().toISOString(),
    engine,
    maxConcurrency: runtime.maxConcurrency,
    repeat: runtime.repeat,
    cacheEnabled: runtime.cache,
    cacheHits: 0,
    cacheMisses: 0,
    retryErrors: 0,
    resumed: false,
    promptfooOptimizeCalls: 0,
    optimizationExecuted: false,
    baselineAlreadyPassed,
    loopIterations: ledger.filter(
      (entry) => entry.status === "keep" || entry.status === "rollback",
    ).length,
    errorCount,
  };
  await writeFile(join(runDir, "runtime-summary.json"), JSON.stringify(summary, null, 2), "utf-8");
}

/**
 * Run the full prompt self-evolution loop.
 *
 * Flow:
 * 1. Eval baseline -> write baseline-results.jsonl + summary.json
 * 2. Record baseline; targetScore is a quality floor, not an optimization stop.
 * 3. For each iteration (including when baseline already meets targetScore):
 *    a. Generate candidates from failed results
 *    b. Eval each candidate, pick the best
 *    c. If best >= currentBest + minImprovement: keep, update best
 *    d. Else: rollback
 *    e. If best >= targetScore: stop
 * 4. Write best-prompt.md
 */
/**
 * V5 quality-floor rule:
 * When baseline already meets targetScore, the loop still performs a controlled
 * public-set quality probe. It can only replace the baseline after meeting the
 * normal improvement and governance rules. A failed probe is rolled back.
 *
 * V5 Governance preservation:
 * - Goal gate is checked before any model call (in CLI auto-loop command)
 * - Scope bloat review is preserved via analyzePromptChange
 * - Over-refusal review is preserved via analyzePromptChange
 * - Partial regression rules are preserved via assessImprovement
 * - Only final kept Prompt gets main safety conclusion
 */
async function runPromptLoopRaw(
  provider: ModelProvider,
  project: Project,
  runDir: string,
  maxIters: number,
  targetScore: number
): Promise<LoopResult> {
  const ledger: LedgerEntry[] = [];
  const minImprovement = project.config.minImprovement;
  const promptChangeAnalyses: PromptChangeAnalysis[] = [];

  if (resolveLoopEngine(project.config) === "promptfoo") {
    await writePromptfooRunArtifacts(runDir, project);
  }

  // Step 1: Eval baseline
  const { results: baselineResults, summary: baselineSummary } =
    await runEngineEval(provider, project, project.prompt, {
      runDir,
      promptVersion: "baseline",
      tests: project.tests,
      artifactDir: join(runDir, "promptfoo"),
    });

  await writeJsonl(
    join(runDir, "baseline-results.jsonl"),
    baselineResults
  );
  await writeFile(
    join(runDir, "summary.json"),
    JSON.stringify(baselineSummary, null, 2),
    "utf-8"
  );
  await writeFile(
    join(runDir, "baseline-summary.json"),
    JSON.stringify(baselineSummary, null, 2),
    "utf-8"
  );

  console.log(`Baseline score: ${baselineSummary.finalScore}`);
  console.log(
    `Pass rate: ${(baselineSummary.passRate * 100).toFixed(0)}% (${baselineSummary.passed}/${baselineSummary.total})`
  );

  // Record baseline entry. A passing baseline is not an automatic stop.
  const baselineEntry: LedgerEntry = {
    iteration: 0,
    promptVersion: "baseline",
    status: "baseline",
    score: baselineSummary.finalScore,
    passRate: baselineSummary.passRate,
    passed: baselineSummary.passed,
    failed: baselineSummary.failed,
    summary: "Initial prompt evaluation.",
  };
  ledger.push(baselineEntry);
  await appendLedgerEntry(runDir, baselineEntry);

  // V6: Track public best prompt separately from release prompt
  let publicBestPrompt = project.prompt;
  let publicBestScore = baselineSummary.finalScore;
  let publicBestResults: EvalResult[] = baselineResults;
  let publicBestSummary: Summary = baselineSummary;
  let publicBestPromptVersion = "baseline";

  // Provider/authentication failures are not prompt-quality failures. Stop
  // before holdout or candidate calls so a broken connection cannot consume
  // another loop iteration and be misreported as a score of zero.
  const baselineErrors = baselineResults.filter((result) => result.error);
  if (baselineErrors.length > 0) {
    const blockedEntry: LedgerEntry = {
      iteration: 0,
      promptVersion: "baseline",
      status: "blocked",
      score: baselineSummary.finalScore,
      passRate: baselineSummary.passRate,
      passed: baselineSummary.passed,
      failed: baselineSummary.failed,
      summary: `Provider evaluation failed for ${baselineErrors.length} case(s): ${baselineErrors[0].error}`,
    };
    ledger.push(blockedEntry);
    await appendLedgerEntry(runDir, blockedEntry);
    await writeFile(join(runDir, "best-prompt.md"), project.prompt, "utf-8");
    await writeRuntimeSummary(
      runDir,
      project,
      ledger,
      false,
      baselineErrors.length,
    );
    console.error(`Provider evaluation blocked: ${baselineErrors[0].error}`);
    return {
      runDir,
      bestPrompt: project.prompt,
      bestScore: baselineSummary.finalScore,
      targetScore,
      targetReached: false,
      ledger,
      lastResults: baselineResults,
      baselinePublicSummary: baselineSummary,
      baselinePublicResults: baselineResults,
      stopReason: "blocked",
      rollbackExercised: false,
      promptChangeAnalyses,
      originalPrompt: project.prompt,
      publicBestPrompt: project.prompt,
      publicBestScore: baselineSummary.finalScore,
      publicBestResults: baselineResults,
      publicBestSummary: baselineSummary,
    };
  }

  const baselineHoldout = await runBaselineHoldoutIfPresent(provider, project, runDir);

  if (maxIters <= 0) {
    await writeFile(join(runDir, "best-prompt.md"), project.prompt, "utf-8");
    const holdout2 = await runHoldoutIfPresent(
      provider,
      project,
      runDir,
      project.prompt
    );
    await writeRuntimeSummary(runDir, project, ledger, baselineSummary.finalScore >= targetScore);
    return {
      runDir,
      bestPrompt: project.prompt,
      bestScore: baselineSummary.finalScore,
      targetScore,
      targetReached: false,
      ledger,
      lastResults: baselineResults,
      baselinePublicSummary: baselineSummary,
      baselinePublicResults: baselineResults,
      stopReason: "max_iters_zero",
      rollbackExercised: false,
      promptChangeAnalyses,
      originalPrompt: project.prompt,
      publicBestPrompt: project.prompt,
      publicBestScore: baselineSummary.finalScore,
      publicBestResults: baselineResults,
      publicBestSummary: baselineSummary,
      ...baselineHoldout,
      ...holdout2,
    };
  }

  // Step 3: Iterations
  let currentPrompt = project.prompt;
  let currentBestScore = baselineSummary.finalScore;
  let lastResults: EvalResult[] = baselineResults;
  let lastSummary: Summary = baselineSummary;
  let targetReached = false;
  let stoppedBecauseNoRepairCases = false;

  for (let i = 1; i <= maxIters; i++) {
    const iterDir = join(runDir, `iter-${i}`);
    await mkdir(iterDir, { recursive: true });

    const repairCases = selectRepairCases(
      lastResults,
      project.evaluationPolicy.repairScoreThreshold,
      true,
    );

    if (repairCases.length === 0) {
      const entry: LedgerEntry = {
        iteration: i,
        promptVersion: "best",
        status: "stop_no_repair_cases",
        score: currentBestScore,
        passRate: lastSummary.passRate,
        passed: lastSummary.passed,
        failed: lastSummary.failed,
        summary: `No failed or low-score cases below repairScoreThreshold (${project.evaluationPolicy.repairScoreThreshold}).`,
      };
      ledger.push(entry);
      await appendLedgerEntry(runDir, entry);
      stoppedBecauseNoRepairCases = true;
      break;
    }

    // Generate candidates
    const candidates = await generateCandidates(
      provider,
      currentPrompt,
      project.goal,
      repairCases,
      project.config.candidateCount,
      runDir,
      i
    );

    await writeFile(
      join(iterDir, "candidate-prompts.json"),
      JSON.stringify(candidates, null, 2),
      "utf-8"
    );

    // V6: Evaluate each candidate through the public keep gate
    const candidateDecisions: Array<{
      candidateId: string;
      publicScore: number;
      eligible: boolean;
      reasons: string[];
      criticalFailuresAfter: number;
      seriousRegressionCount: number;
    }> = [];

    let bestSummary: Summary | null = null;
    let bestResults: EvalResult[] = [];
    let bestPrompt = "";
    let bestCandidate: CandidatePrompt | null = null;
    let bestAnalysis: PromptChangeAnalysis | null = null;
    const iterationAnalyses: PromptChangeAnalysis[] = [];

    // Track overall highest-scoring candidate (regardless of eligibility) for fallback reporting
    let overallBestSummary: Summary | null = null;
    let overallBestResults: EvalResult[] = [];
    let overallBestCandidate: CandidatePrompt | null = null;

    for (const candidate of candidates) {
      const { results, summary } = await runEngineEval(
        provider,
        project,
        candidate.prompt,
        {
          runDir,
          promptVersion: candidate.id,
          tests: project.tests,
          artifactDir: join(iterDir, "promptfoo", candidate.id),
        },
      );

      // V4: Analyze prompt change for scope bloat and over-refusal
      const analysis = analyzePromptChange(
        project.prompt,
        candidate.prompt,
        project.promptChangeGoalProfile
      );
      iterationAnalyses.push(analysis);

      // Track overall best for fallback reporting (no re-evaluation needed)
      if (!overallBestSummary || summary.finalScore > overallBestSummary.finalScore) {
        overallBestSummary = summary;
        overallBestResults = results;
        overallBestCandidate = candidate;
      }

      // V6: Use public keep gate for deterministic candidate filtering
      const keepDecision = decidePublicKeep({
        currentScore: currentBestScore,
        candidateScore: summary.finalScore,
        minImprovement,
        currentResults: lastResults,
        candidateResults: results,
        repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
        analysis,
      });

      candidateDecisions.push({
        candidateId: candidate.id,
        publicScore: summary.finalScore,
        eligible: keepDecision.eligible,
        reasons: keepDecision.reasons,
        criticalFailuresAfter: keepDecision.criticalFailuresAfter,
        seriousRegressionCount: keepDecision.comparison.seriousRegressions.length,
      });

      if (!keepDecision.eligible) {
        console.log(`  -> candidate ${candidate.id} rejected: ${keepDecision.reasons.join(", ")}`);
        continue;
      }

      if (!bestSummary || summary.finalScore > bestSummary.finalScore) {
        bestSummary = summary;
        bestResults = results;
        bestPrompt = candidate.prompt;
        bestCandidate = candidate;
        bestAnalysis = analysis;
      }
    }

    // V6: Write candidate decisions for this iteration
    await writeFile(
      join(iterDir, "candidate-decisions.json"),
      JSON.stringify(candidateDecisions, null, 2),
      "utf-8"
    );

    // If all candidates were rejected by the keep gate, use overall best for rollback reporting
    if (!bestSummary || !bestCandidate) {
      if (!overallBestSummary || !overallBestCandidate) {
        throw new Error(`No candidate evaluated in iteration ${i}`);
      }

      // Write iter results for the overall best candidate (no re-evaluation)
      await writeJsonl(join(iterDir, "results.jsonl"), overallBestResults);
      await writeFile(
        join(iterDir, "summary.json"),
        JSON.stringify(overallBestSummary, null, 2),
        "utf-8"
      );

      // Save prompt change analyses for this iteration
      await writeFile(
        join(iterDir, "prompt-change-analyses.json"),
        JSON.stringify(iterationAnalyses, null, 2),
        "utf-8"
      );

      console.log(`Iter ${i}: all candidates rejected by keep gate, rollback`);

      // V6: Collect sorted unique rejection reason codes
      const allReasons = candidateDecisions.flatMap((d) => d.reasons);
      const uniqueReasons = [...new Set(allReasons)].sort();

      const entry: LedgerEntry = {
        iteration: i,
        promptVersion: overallBestCandidate.id,
        status: "rollback",
        score: overallBestSummary.finalScore,
        passRate: overallBestSummary.passRate,
        passed: overallBestSummary.passed,
        failed: overallBestSummary.failed,
        summary: `All candidates rejected: ${uniqueReasons.join(", ")}`,
      };
      ledger.push(entry);
      await appendLedgerEntry(runDir, entry);

      promptChangeAnalyses.push(...iterationAnalyses);
      continue;
    }

    // Write iter results
    await writeJsonl(join(iterDir, "results.jsonl"), bestResults);
    await writeFile(
      join(iterDir, "summary.json"),
      JSON.stringify(bestSummary, null, 2),
      "utf-8"
    );

    // Save prompt change analyses for this iteration
    await writeFile(
      join(iterDir, "prompt-change-analyses.json"),
      JSON.stringify(iterationAnalyses, null, 2),
      "utf-8"
    );

    promptChangeAnalyses.push(...iterationAnalyses);

    console.log(`Iter ${i}: candidate score = ${bestSummary.finalScore}`);

    // Keep or rollback
    if (bestSummary.finalScore >= currentBestScore + minImprovement) {
      currentPrompt = bestPrompt;
      currentBestScore = bestSummary.finalScore;
      lastResults = bestResults;
      lastSummary = bestSummary;
      publicBestPrompt = bestPrompt;
      publicBestScore = bestSummary.finalScore;
      publicBestResults = bestResults;
      publicBestSummary = bestSummary;
      publicBestPromptVersion = bestCandidate!.id;

      const entry: LedgerEntry = {
        iteration: i,
        promptVersion: bestCandidate.id,
        status: "keep",
        score: bestSummary.finalScore,
        passRate: bestSummary.passRate,
        passed: bestSummary.passed,
        failed: bestSummary.failed,
        summary: bestCandidate.changeSummary.join("; "),
      };
      ledger.push(entry);
      await appendLedgerEntry(runDir, entry);

      console.log(`  -> keep`);

      if (currentBestScore >= targetScore) {
        targetReached = true;
        console.log("Target reached!");
        break;
      }
    } else {
      const entry: LedgerEntry = {
        iteration: i,
        promptVersion: bestCandidate.id,
        status: "rollback",
        score: bestSummary.finalScore,
        passRate: bestSummary.passRate,
        passed: bestSummary.passed,
        failed: bestSummary.failed,
        summary: `Candidate score ${bestSummary.finalScore.toFixed(1)} did not improve over best ${currentBestScore.toFixed(1)} by at least ${minImprovement}.`,
      };
      ledger.push(entry);
      await appendLedgerEntry(runDir, entry);

      console.log(`  -> rollback (no improvement)`);
    }
  }

  // If max iters reached without target, record stop_max_iters
  if (!targetReached && !stoppedBecauseNoRepairCases) {
    const entry: LedgerEntry = {
      iteration: maxIters,
      promptVersion: "best",
      status: "stop_max_iters",
      score: currentBestScore,
      passRate: lastSummary.passRate,
      passed: lastSummary.passed,
      failed: lastSummary.failed,
      summary:
        baselineSummary.finalScore >= targetScore
          ? `Reached max iterations (${maxIters}) without a strictly improved candidate; baseline already met the quality floor (${targetScore}).`
          : `Reached max iterations (${maxIters}) without meeting target score (${targetScore}).`,
    };
    ledger.push(entry);
    await appendLedgerEntry(runDir, entry);
  }

  // V6: Release gate — determine if a public candidate was kept
  const publicKeepOccurred = publicBestPrompt !== project.prompt;

  let releaseDecision: ReleaseDecision;
  let candidateHoldoutResults: EvalResult[] | undefined;
  let candidateHoldoutSummary: Summary | undefined;

  if (publicKeepOccurred) {
    // Evaluate holdout once against the public best prompt
    const candidateHoldout = await runHoldoutIfPresent(
      provider,
      project,
      runDir,
      publicBestPrompt
    );
    candidateHoldoutResults = candidateHoldout.holdoutResults;
    candidateHoldoutSummary = candidateHoldout.holdoutSummary;

    releaseDecision = decideRelease({
      publicKeepOccurred: true,
      publicBestPromptVersion,
      baselineHoldoutResults: baselineHoldout.baselineHoldoutResults,
      candidateHoldoutResults,
      repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
    });
  } else {
    // No public candidate was kept — release baseline without new holdout evaluation
    releaseDecision = decideRelease({
      publicKeepOccurred: false,
      publicBestPromptVersion,
      baselineHoldoutResults: baselineHoldout.baselineHoldoutResults,
      candidateHoldoutResults: undefined,
      repairScoreThreshold: project.evaluationPolicy.repairScoreThreshold,
    });
  }

  // Determine release prompt based on release decision
  let releasePrompt = publicBestPrompt;
  let releaseScore = publicBestScore;
  let releaseResults = publicBestResults;
  let releaseSummary = publicBestSummary;

  if (
    releaseDecision.status === "final_holdout_rollback" ||
    releaseDecision.status === "released_baseline_no_public_keep"
  ) {
    // Release rolls back to baseline
    releasePrompt = project.prompt;
    releaseScore = baselineSummary.finalScore;
    releaseResults = baselineResults;
    releaseSummary = baselineSummary;
  }
  // For released_public_best and unverified_no_holdout, releasePrompt stays as publicBestPrompt

  // V6: Compute limitations for evidence record
  const targetProviderConfig = project.config.targetProvider ?? project.config.provider;
  const graderProviderConfig = project.config.graderProvider ?? targetProviderConfig;
  const sameModelGrader =
    targetProviderConfig.type === graderProviderConfig.type &&
    targetProviderConfig.model === graderProviderConfig.model;
  const limitations: string[] = [];
  if (sameModelGrader) {
    limitations.push("same_model_grader");
  }

  // V6: Write release evidence artifacts via writeBestPromptEvidence
  const baselineHoldoutScore = baselineHoldout.baselineHoldoutSummary?.finalScore;
  await writeBestPromptEvidence({
    runDir,
    runId: join(project.config.projectName, runDir.split(/[/\\]/).pop() ?? ""),
    targetProvider: {
      type: targetProviderConfig.type,
      model: targetProviderConfig.model,
    },
    publicBestPrompt,
    publicBestPromptVersion,
    publicBestScore,
    releasePrompt,
    releaseDecision,
    baselinePublicScore: baselineSummary.finalScore,
    baselineHoldoutScore,
    publicKeep: publicKeepOccurred,
    holdoutDelta: releaseDecision.holdoutDelta,
    seriousHoldoutRegressions: releaseDecision.holdoutComparison?.seriousRegressions.length ?? 0,
    criticalFailuresAfter: releaseDecision.criticalFailuresAfter ?? 0,
    limitations,
  });

  // V6: Write PromptSpec advisory artifacts
  await writePromptSpecArtifacts({
    runDir,
    baselinePrompt: project.prompt,
    publicBestPrompt,
    releasePrompt,
    mode: project.config.bestPromptPolicy?.promptSpecMode ?? "advisory",
  });

  await writeRuntimeSummary(runDir, project, ledger, baselineSummary.finalScore >= targetScore);

  const rollbackExercised = ledger.some((e) => e.status === "rollback");

  const stopReason = targetReached
    ? "target_reached"
    : stoppedBecauseNoRepairCases
      ? "no_repair_cases"
      : "max_iters";

  return {
    runDir,
    bestPrompt: releasePrompt,
    bestScore: releaseScore,
    targetScore,
    targetReached,
    ledger,
    lastResults: releaseResults,
    baselinePublicSummary: baselineSummary,
    baselinePublicResults: baselineResults,
    holdoutSummary: candidateHoldoutSummary,
    holdoutResults: candidateHoldoutResults,
    ...baselineHoldout,
    stopReason,
    rollbackExercised,
    promptChangeAnalyses,
    originalPrompt: project.prompt,
    publicBestPrompt,
    publicBestScore,
    publicBestResults,
    publicBestSummary,
    releaseDecision,
  };
}

/**
 * V6 Compact: Wrapper around runPromptLoopRaw that manages output mode.
 *
 * - compact (default): runs in a temp directory, outputs exactly 5 files to runDir
 * - debug: runs in runDir/debug/, outputs 5 files to runDir + diagnostic files in debug/
 */
export async function runPromptLoop(
  provider: ModelProvider,
  project: Project,
  runDir: string,
  maxIters: number,
  targetScore: number,
  options?: { outputMode?: OutputMode },
): Promise<LoopResult> {
  const outputMode = options?.outputMode ?? "compact";
  const workDir = outputMode === "compact"
    ? join(tmpdir(), `skillfoo-compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    : join(runDir, "debug");
  await mkdir(workDir, { recursive: true });

  const runId = `${project.config.projectName}/${runDir.split(/[/\\]/).pop() ?? "unknown"}`;
  const logWriter = new RunLogWriter(runId);
  const observed = observeProvider(provider);
  const callObservationScope = resolveLoopEngine(project.config) === "legacy"
    ? "all_loop_calls"
    : "direct_candidate_generation_only";

  // Log run_started with redacted config
  const configHash = createHash("sha256");
  const publicTestsHash = createHash("sha256");
  const holdoutTestsHash = createHash("sha256");

  const redactedConfig = redactSensitiveConfig(project.config);
  configHash.update(JSON.stringify(redactedConfig));
  publicTestsHash.update(JSON.stringify(project.tests));
  holdoutTestsHash.update(JSON.stringify(project.holdoutTests));

  logWriter.log("run_started", {
    outputMode,
    providerName: provider.name,
    callObservationScope,
    cliArgs: { maxIters, targetScore },
    config: redactedConfig,
    originalPrompt: project.prompt,
    goal: project.goal,
    publicTests: project.tests,
    holdoutTests: project.holdoutTests,
    publicTestsSha256: publicTestsHash.digest("hex"),
    holdoutTestsSha256: holdoutTestsHash.digest("hex"),
    configSha256: configHash.digest("hex"),
  });

  try {
    // Run the loop in workDir
    const result = await runPromptLoopRaw(observed.provider, project, workDir, maxIters, targetScore);

    // Log baseline_evaluated
    logWriter.log("baseline_evaluated", {
      results: result.baselinePublicResults,
      summary: result.baselinePublicSummary,
    });

    // Log baseline_holdout_evaluated if present
    if (result.baselineHoldoutResults && result.baselineHoldoutResults.length > 0) {
      logWriter.log("baseline_holdout_evaluated", {
        results: result.baselineHoldoutResults,
        summary: result.baselineHoldoutSummary,
      });
    }

    // Log candidate events from ledger and promptChangeAnalyses
    for (let i = 0; i < result.ledger.length; i++) {
      const entry = result.ledger[i];
      if (entry.iteration === 0) continue; // skip baseline

      // Try to read candidate-decisions.json from workDir
      const iterDir = join(workDir, `iter-${entry.iteration}`);
      try {
        const decisionsRaw = await readFile(join(iterDir, "candidate-decisions.json"), "utf8");
        const decisions = JSON.parse(decisionsRaw) as Array<{
          candidateId: string;
          publicScore: number;
          eligible: boolean;
          reasons: string[];
          criticalFailuresAfter: number;
          seriousRegressionCount: number;
        }>;

        // Try to read candidate prompts
        let candidates: Array<{ id: string; prompt: string; hypothesis: string; changeSummary: string[] }> = [];
        try {
          const candidatesRaw = await readFile(join(iterDir, "candidate-prompts.json"), "utf8");
          candidates = JSON.parse(candidatesRaw);
        } catch {
          // ok if not found
        }

        for (const decision of decisions) {
          const candidate = candidates.find((c) => c.id === decision.candidateId);
          // Log candidate_generated
          if (candidate) {
            logWriter.log("candidate_generated", {
              iteration: entry.iteration,
              candidateId: decision.candidateId,
              prompt: candidate.prompt,
              hypothesis: candidate.hypothesis,
              changeSummary: candidate.changeSummary,
            });
          }

          // Log candidate_evaluated
          logWriter.log("candidate_evaluated", {
            iteration: entry.iteration,
            candidateId: decision.candidateId,
            publicScore: decision.publicScore,
          });

          // Log candidate_decided
          logWriter.log("candidate_decided", {
            iteration: entry.iteration,
            candidateId: decision.candidateId,
            publicScore: decision.publicScore,
            eligible: decision.eligible,
            reasons: decision.reasons,
            criticalFailuresAfter: decision.criticalFailuresAfter,
            seriousRegressionCount: decision.seriousRegressionCount,
          });
        }
      } catch {
        // ok if candidate-decisions.json not found
      }
    }

    // Log holdout_evaluated if present
    if (result.holdoutResults && result.holdoutResults.length > 0) {
      logWriter.log("holdout_evaluated", {
        results: result.holdoutResults,
        summary: result.holdoutSummary,
        publicBestPrompt: result.publicBestPrompt,
      });
    }

    // Log release_decided
    if (result.releaseDecision) {
      logWriter.log("release_decided", {
        status: result.releaseDecision.status,
        releasedPromptVersion: result.releaseDecision.releasedPromptVersion,
        reasons: result.releaseDecision.reasons,
        holdoutDelta: result.releaseDecision.holdoutDelta,
        criticalFailuresAfter: result.releaseDecision.criticalFailuresAfter,
      });
    }

    // Fix runDir in result to point to actual output dir
    const fixedResult: LoopResult = { ...result, runDir };

    // Write compact artifacts (5 files) to runDir
    await writeCompactArtifacts({
      runDir,
      outputMode,
      logWriter,
      project,
      result: fixedResult,
      providerName: provider.name,
      observedChatCalls: observed.observedChatCalls,
      callObservationScope,
    });

    return fixedResult;
  } catch (error) {
    // Log run_failed
    logWriter.log("run_failed", {
      error: error instanceof Error ? error.message : String(error),
      retryable: false,
      providerName: provider.name,
      observedChatCalls: observed.observedChatCalls,
      callObservationScope,
    });

    // Write failure compact files
    try {
      await writeFile(join(runDir, "best-prompt.md"), project.prompt, "utf-8");
      await writeFile(
        join(runDir, "report.md"),
        `# SkillFoo Prompt Loop Report\n\n**Status:** FAILED\n\n**Error:** ${error instanceof Error ? error.message : String(error)}\n\n**Badcases:** 0\n`,
        "utf-8",
      );
      await writeFile(join(runDir, "prompt-diff.md"), "# Prompt Diff\n\nRun failed before completion.\n", "utf-8");
      await writeFile(join(runDir, "badcases.jsonl"), "", "utf-8");
      await logWriter.flush(join(runDir, "run-log.jsonl"));
    } catch {
      // Best effort - if we can't write failure files, just continue
    }

    throw error;
  } finally {
    // Clean up workDir in compact mode
    if (outputMode === "compact") {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        // Cleanup failure is not a run failure
      }
    }
  }
}
