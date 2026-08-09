import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EvalResult, Summary, LedgerEntry, ReleaseDecision } from "../types.js";
import type { PromptChangeAnalysis } from "../report/analyzePromptChange.js";
import { RunLogWriter } from "./runLog.js";
import { redactSensitiveConfig } from "./redactSensitiveConfig.js";
import type { Project } from "../config/loadProject.js";
import type { LoopResult, ObservedChatCalls } from "../loop/runPromptLoop.js";

interface BadcaseEntry {
  severity: "fixed" | "remaining" | "regression" | "serious_regression" | "critical_failure";
  dataset: "public" | "holdout";
  testId: string;
  baselineScore: number;
  finalScore: number;
  delta: number;
  reason: string;
}

/**
 * Compare baseline and final results to generate badcase entries.
 * Only includes cases that are fixed, remaining failures, regressions,
 * serious regressions, or critical failures. Does NOT include all passing cases.
 */
function generateBadcases(
  baselineResults: EvalResult[],
  finalResults: EvalResult[],
  dataset: "public" | "holdout",
): BadcaseEntry[] {
  const baselineMap = new Map(baselineResults.map((r) => [r.testId, r]));
  const entries: BadcaseEntry[] = [];

  for (const finalResult of finalResults) {
    const baselineResult = baselineMap.get(finalResult.testId);
    if (!baselineResult) continue;

    const delta = finalResult.score - baselineResult.score;
    const wasPassing = baselineResult.pass;
    const isPassing = finalResult.pass;

    // Critical failure: privacy/adversarial/hallucination category not passing
    const criticalCategories = ["privacy", "adversarial", "hallucination"];
    if (criticalCategories.includes(finalResult.category) && !isPassing) {
      entries.push({
        severity: "critical_failure",
        dataset,
        testId: finalResult.testId,
        baselineScore: baselineResult.score,
        finalScore: finalResult.score,
        delta,
        reason: finalResult.reason,
      });
      continue;
    }

    // Serious regression: delta <= -10
    if (delta <= -10) {
      entries.push({
        severity: "serious_regression",
        dataset,
        testId: finalResult.testId,
        baselineScore: baselineResult.score,
        finalScore: finalResult.score,
        delta,
        reason: finalResult.reason,
      });
      continue;
    }

    // Fixed: was failing, now passing
    if (!wasPassing && isPassing) {
      entries.push({
        severity: "fixed",
        dataset,
        testId: finalResult.testId,
        baselineScore: baselineResult.score,
        finalScore: finalResult.score,
        delta,
        reason: finalResult.reason,
      });
      continue;
    }

    // Remaining: still failing
    if (!wasPassing && !isPassing) {
      entries.push({
        severity: "remaining",
        dataset,
        testId: finalResult.testId,
        baselineScore: baselineResult.score,
        finalScore: finalResult.score,
        delta,
        reason: finalResult.reason,
      });
      continue;
    }

    // Regression: was passing, now failing (non-serious, delta > -10)
    if (wasPassing && !isPassing) {
      entries.push({
        severity: "regression",
        dataset,
        testId: finalResult.testId,
        baselineScore: baselineResult.score,
        finalScore: finalResult.score,
        delta,
        reason: finalResult.reason,
      });
      continue;
    }
  }

  // Sort by severity, dataset, testId
  const severityOrder: Record<string, number> = {
    critical_failure: 0,
    serious_regression: 1,
    regression: 2,
    remaining: 3,
    fixed: 4,
  };
  entries.sort((a, b) => {
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    if (a.dataset !== b.dataset) {
      return a.dataset < b.dataset ? -1 : 1;
    }
    return a.testId < b.testId ? -1 : 1;
  });

  return entries;
}

function generatePromptDiff(
  originalPrompt: string,
  publicBestPrompt: string,
  releasePrompt: string,
  analyses: PromptChangeAnalysis[],
): string {
  const lines: string[] = ["# Prompt Diff Review", ""];

  // Original vs Public Best
  lines.push("## Original -> Public Best");
  if (originalPrompt === publicBestPrompt) {
    lines.push("No change. Public best is the same as the original prompt.");
  } else {
    lines.push("### Original Prompt");
    lines.push("```");
    lines.push(originalPrompt);
    lines.push("```");
    lines.push("");
    lines.push("### Public Best Prompt");
    lines.push("```");
    lines.push(publicBestPrompt);
    lines.push("```");
  }
  lines.push("");

  // Public Best vs Release
  lines.push("## Public Best -> Release Prompt");
  if (publicBestPrompt === releasePrompt) {
    lines.push("No change. Release prompt is the same as the public best.");
  } else {
    lines.push("**Release rolled back to baseline.** The public best candidate was not released due to holdout regression or no public keep.");
    lines.push("");
    lines.push("### Public Best Prompt (evidence only, not released)");
    lines.push("```");
    lines.push(publicBestPrompt);
    lines.push("```");
    lines.push("");
    lines.push("### Release Prompt (baseline)");
    lines.push("```");
    lines.push(releasePrompt);
    lines.push("```");
  }
  lines.push("");

  // Governance analysis
  if (analyses.length > 0) {
    lines.push("## Governance Analysis");
    for (const analysis of analyses) {
      lines.push(`- Scope bloat: ${analysis.severeScopeBloatCount} severe, ${(analysis.scopeBloatCount - analysis.severeScopeBloatCount)} minor`);
      lines.push(`- Over-refusal: ${analysis.severeOverRefusalCount} severe, ${(analysis.overRefusalCount - analysis.severeOverRefusalCount)} minor`);
    }
  }

  return lines.join("\n") + "\n";
}

function generateReport(
  project: Project,
  result: LoopResult,
  badcases: BadcaseEntry[],
  outputMode: string,
  providerName: string,
  observedChatCalls: ObservedChatCalls,
  callObservationScope: string,
): string {
  const lines: string[] = ["# SkillFoo Prompt Loop Report", ""];

  lines.push(`**Project:** ${project.config.projectName}`);
  lines.push(`**Output Mode:** ${outputMode}`);
  lines.push(`**Run ID:** ${result.runDir}`);
  lines.push("");

  // Input summary
  lines.push("## Input Summary");
  lines.push(`- Goal: ${project.goal.substring(0, 100)}...`);
  lines.push(`- Public tests: ${project.tests.length}`);
  lines.push(`- Holdout tests: ${project.holdoutTests.length}`);
  lines.push(`- Target score: ${result.targetScore}`);
  lines.push(`- Provider used: ${providerName}`);
  lines.push(`- Direct chat calls observed: ${observedChatCalls.total} (${callObservationScope})`);
  lines.push("");

  // Scores
  lines.push("## Scores");
  lines.push(`| Dataset | Version | Score | Pass Rate | Passed | Failed |`);
  lines.push(`|---|---|---|---|---|---|`);
  lines.push(`| Public | Baseline | ${result.baselinePublicSummary.finalScore.toFixed(1)} | ${(result.baselinePublicSummary.passRate * 100).toFixed(0)}% | ${result.baselinePublicSummary.passed} | ${result.baselinePublicSummary.failed} |`);
  lines.push(`| Public | Public Best | ${result.publicBestSummary.finalScore.toFixed(1)} | ${(result.publicBestSummary.passRate * 100).toFixed(0)}% | ${result.publicBestSummary.passed} | ${result.publicBestSummary.failed} |`);
  if (result.holdoutSummary) {
    lines.push(`| Holdout | Candidate | ${result.holdoutSummary.finalScore.toFixed(1)} | ${(result.holdoutSummary.passRate * 100).toFixed(0)}% | ${result.holdoutSummary.passed} | ${result.holdoutSummary.failed} |`);
  }
  if (result.baselineHoldoutSummary) {
    lines.push(`| Holdout | Baseline | ${result.baselineHoldoutSummary.finalScore.toFixed(1)} | ${(result.baselineHoldoutSummary.passRate * 100).toFixed(0)}% | ${result.baselineHoldoutSummary.passed} | ${result.baselineHoldoutSummary.failed} |`);
  }
  lines.push("");

  // Iteration timeline
  lines.push("## Iteration Timeline");
  for (const entry of result.ledger) {
    lines.push(`- Iter ${entry.iteration}: ${entry.status} (score: ${entry.score.toFixed(1)}, ${entry.summary})`);
  }
  lines.push("");

  // Release decision
  lines.push("## Release Decision");
  if (result.releaseDecision) {
    lines.push(`- Status: ${result.releaseDecision.status}`);
    lines.push(`- Released prompt version: ${result.releaseDecision.releasedPromptVersion}`);
    if (result.releaseDecision.reasons.length > 0) {
      lines.push(`- Reasons: ${result.releaseDecision.reasons.join(", ")}`);
    }
    if (result.releaseDecision.holdoutDelta !== undefined) {
      lines.push(`- Holdout delta: ${result.releaseDecision.holdoutDelta.toFixed(1)}`);
    }
  } else {
    lines.push("- No release decision recorded.");
  }
  lines.push("");

  // Stop reason
  lines.push("## Stop Reason");
  lines.push(`- ${result.stopReason}`);
  lines.push("");

  // Badcases
  lines.push("## Badcases");
  lines.push(`- Total badcases: ${badcases.length}`);
  if (badcases.length > 0) {
    const bySeverity: Record<string, number> = {};
    for (const bc of badcases) {
      bySeverity[bc.severity] = (bySeverity[bc.severity] ?? 0) + 1;
    }
    for (const [sev, count] of Object.entries(bySeverity)) {
      lines.push(`  - ${sev}: ${count}`);
    }
  }
  lines.push("");

  // Limitations
  lines.push("## Limitations");
  lines.push("- This tool cannot prove global optimality of any prompt for all scenarios.");
  lines.push("- Same-model grader may introduce bias; use cross-model verification for production.");
  lines.push("- PromptSpec assessment is advisory only, not a scoring layer.");
  lines.push("");

  return lines.join("\n");
}

export interface WriteCompactArtifactsParams {
  runDir: string;
  outputMode: string;
  logWriter: RunLogWriter;
  project: Project;
  result: LoopResult;
  providerName: string;
  observedChatCalls: ObservedChatCalls;
  callObservationScope: string;
}

/**
 * Write the five compact artifact files to runDir.
 * Files: report.md, best-prompt.md, prompt-diff.md, badcases.jsonl, run-log.jsonl
 */
export async function writeCompactArtifacts(
  params: WriteCompactArtifactsParams,
): Promise<void> {
  const { runDir, outputMode, logWriter, project, result, providerName, observedChatCalls, callObservationScope } = params;

  // Generate badcases from public results comparison
  const publicBadcases = generateBadcases(
    result.baselinePublicResults,
    result.publicBestResults,
    "public",
  );

  // Also include holdout badcases if available
  const holdoutBadcases =
    result.baselineHoldoutResults && result.holdoutResults
      ? generateBadcases(
          result.baselineHoldoutResults,
          result.holdoutResults,
          "holdout",
        )
      : [];

  const allBadcases = [...publicBadcases, ...holdoutBadcases];

  // Write best-prompt.md
  await writeFile(
    join(runDir, "best-prompt.md"),
    result.bestPrompt,
    "utf-8",
  );

  // Write prompt-diff.md
  const diffContent = generatePromptDiff(
    result.originalPrompt,
    result.publicBestPrompt,
    result.bestPrompt,
    result.promptChangeAnalyses,
  );
  await writeFile(join(runDir, "prompt-diff.md"), diffContent, "utf-8");

  // Write badcases.jsonl (empty file if no badcases)
  const badcasesContent =
    allBadcases.length > 0
      ? allBadcases.map((bc) => JSON.stringify(bc)).join("\n") + "\n"
      : "";
  await writeFile(join(runDir, "badcases.jsonl"), badcasesContent, "utf-8");

  // Write report.md
  const reportContent = generateReport(
    project,
    result,
    allBadcases,
    outputMode,
    providerName,
    observedChatCalls,
    callObservationScope,
  );
  await writeFile(join(runDir, "report.md"), reportContent, "utf-8");

  // Log run_completed event with five-file manifest
  const fileNames = ["report.md", "best-prompt.md", "prompt-diff.md", "badcases.jsonl", "run-log.jsonl"];
  const manifest: Record<string, string> = {};
  for (const fileName of fileNames) {
    // The completion event is itself appended to run-log.jsonl. Hashing that
    // file here would require hashing content that does not exist yet.
    if (fileName === "run-log.jsonl") {
      manifest[fileName] = "self-referential";
      continue;
    }
    try {
      const content = await readFile(join(runDir, fileName));
      manifest[fileName] = createHash("sha256").update(content).digest("hex");
    } catch {
      manifest[fileName] = "error";
    }
  }

  logWriter.log("run_completed", {
    stopReason: result.stopReason,
    targetReached: result.targetReached,
    bestScore: result.bestScore,
    publicBestScore: result.publicBestScore,
    releaseStatus: result.releaseDecision?.status,
    badcaseCount: allBadcases.length,
    outputMode,
    providerName,
    observedChatCalls,
    callObservationScope,
    files: manifest,
  });

  // Flush run-log.jsonl
  await logWriter.flush(join(runDir, "run-log.jsonl"));
}
