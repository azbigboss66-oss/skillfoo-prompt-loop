import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopResult } from "../loop/runPromptLoop.js";

/**
 * Generate report.md from loop results.
 *
 * Must contain:
 * - Summary (project, target, best, status)
 * - Score Timeline (table)
 * - Best Prompt
 * - Failed Cases Remaining
 * - Kept Changes
 * - Rollbacks
 */
export async function writeReport(
  runDir: string,
  projectName: string,
  result: LoopResult,
  repairScoreThreshold: number = 85
): Promise<void> {
  const {
    bestPrompt,
    bestScore,
    targetScore,
    targetReached,
    ledger,
    lastResults,
    holdoutSummary,
    holdoutResults,
  } = result;

  const status = targetReached ? "target reached" : result.stopReason;

  let report = `# SkillFoo Prompt Loop Report\n\n`;

  // Summary
  report += `## Summary\n\n`;
  report += `Project: ${projectName}\n`;
  report += `Target Score: ${targetScore}\n`;
  report += `Best Score: ${bestScore.toFixed(1)}\n`;
  report += `Status: ${status}\n\n`;

  // Score Timeline
  report += `## Score Timeline\n\n`;
  report += `| Iteration | Status | Score | Pass Rate | Notes |\n`;
  report += `|---|---|---:|---:|---|\n`;

  const timelineEntries = ledger.filter(
    (e) => e.status !== "stop_max_iters"
  );
  const lastEntry = timelineEntries[timelineEntries.length - 1];

  for (const entry of timelineEntries) {
    const passRateStr = `${(entry.passRate * 100).toFixed(0)}%`;
    let notes: string;
    if (entry.status === "baseline") {
      notes = "initial prompt";
    } else if (entry.status === "stop_already_passed") {
      notes = "already met target";
    } else if (entry === lastEntry && targetReached) {
      notes = "target reached";
    } else if (entry.status === "rollback") {
      notes = "did not improve enough";
    } else {
      notes = entry.summary;
    }
    report += `| ${entry.iteration} | ${entry.status} | ${entry.score.toFixed(0)} | ${passRateStr} | ${notes} |\n`;
  }
  report += `\n`;

  // V6: Release Prompt (may differ from public best)
  report += `## Release Prompt\n\n`;
  report += `\`\`\`text\n${bestPrompt}\n\`\`\`\n\n`;

  // V6: Public Best Candidate (evidence only, may differ from release prompt)
  if (result.publicBestPrompt && result.publicBestPrompt !== bestPrompt) {
    report += `## Public Best Candidate (Evidence Only)\n\n`;
    report += `This candidate passed the public keep gate but was not released.\n\n`;
    report += `\`\`\`text\n${result.publicBestPrompt}\n\`\`\`\n\n`;
  }

  // V6: Release Decision
  if (result.releaseDecision) {
    report += `## Release Decision\n\n`;
    report += `| Field | Value |\n`;
    report += `|---|---|\n`;
    report += `| Status | ${result.releaseDecision.status} |\n`;
    report += `| Released Prompt Version | ${result.releaseDecision.releasedPromptVersion} |\n`;
    if (result.releaseDecision.reasons.length > 0) {
      report += `| Reasons | ${result.releaseDecision.reasons.join(", ")} |\n`;
    }
    if (result.releaseDecision.holdoutDelta !== undefined) {
      report += `| Holdout Delta | ${result.releaseDecision.holdoutDelta.toFixed(1)} |\n`;
    }
    report += `\n`;
  }

  // V6: Holdout Release Gate
  if (result.releaseDecision && result.holdoutSummary) {
    report += `## Holdout Release Gate\n\n`;
    report += `| Metric | Value |\n`;
    report += `|---|---:|\n`;
    report += `| Public best holdout score | ${result.holdoutSummary.finalScore.toFixed(1)} |\n`;
    if (result.baselineHoldoutSummary) {
      report += `| Baseline holdout score | ${result.baselineHoldoutSummary.finalScore.toFixed(1)} |\n`;
    }
    if (result.releaseDecision.holdoutDelta !== undefined) {
      report += `| Holdout delta | ${result.releaseDecision.holdoutDelta.toFixed(1)} |\n`;
    }
    if (result.releaseDecision.criticalFailuresAfter !== undefined) {
      report += `| Critical failures after | ${result.releaseDecision.criticalFailuresAfter} |\n`;
    }
    report += `\n`;
  }

  // Failed Cases Remaining
  const failedCases = lastResults.filter((r) => !r.pass);
  report += `## Failed Cases Remaining\n\n`;
  if (failedCases.length === 0) {
    report += `No failed cases remaining.\n\n`;
  } else {
    report += `| Test | Category | Score | Reason |\n`;
    report += `|---|---|---:|---|\n`;
    for (const fc of failedCases) {
      report += `| ${fc.testId} | ${fc.category} | ${fc.score.toFixed(0)} | ${fc.reason} |\n`;
    }
    report += `\n`;
  }

  // Low-Score Cases
  const lowScoreCases = lastResults.filter(
    (r) => r.pass && r.score < repairScoreThreshold
  );
  report += `## Low-Score Cases\n\n`;
  report += `These cases passed but remain below the repair score threshold (${repairScoreThreshold}).\n\n`;
  if (lowScoreCases.length === 0) {
    report += `No low-score passing cases remain.\n\n`;
  } else {
    report += `| Test ID | Category | Score | Reason |\n`;
    report += `|---|---|---:|---|\n`;
    for (const lc of lowScoreCases) {
      report += `| ${lc.testId} | ${lc.category} | ${lc.score.toFixed(0)} | ${lc.reason} |\n`;
    }
    report += `\n`;
  }

  // Kept Changes
  report += `## Kept Changes\n\n`;
  const keptEntries = ledger.filter((e) => e.status === "keep");
  if (keptEntries.length === 0) {
    report += `No changes were kept.\n\n`;
  } else {
    for (const entry of keptEntries) {
      report += `- iteration ${entry.iteration}: ${entry.summary}\n`;
    }
    report += `\n`;
  }

  // Rollbacks
  report += `## Rollbacks\n\n`;
  const rollbackEntries = ledger.filter((e) => e.status === "rollback");
  if (rollbackEntries.length === 0) {
    report += `No rollbacks.\n\n`;
  } else {
    for (const entry of rollbackEntries) {
      report += `- iteration ${entry.iteration}: ${entry.summary}\n`;
    }
    report += `\n`;
  }

  // Holdout Validation
  report += `## Holdout Validation\n\n`;
  if (holdoutSummary && holdoutResults) {
    const gap = bestScore - holdoutSummary.finalScore;
    report += `| Metric | Value |\n`;
    report += `|---|---:|\n`;
    report += `| Holdout tests | ${holdoutSummary.total} |\n`;
    report += `| Holdout final score | ${holdoutSummary.finalScore.toFixed(1)} |\n`;
    report += `| Holdout pass rate | ${(holdoutSummary.passRate * 100).toFixed(0)}% |\n`;
    report += `| Public vs holdout gap | ${gap.toFixed(1)} |\n`;
    report += `\n`;

    if (gap > 10) {
      report += `**Warning: Possible overfitting.** Public score is ${gap.toFixed(1)} points higher than holdout score.\n\n`;
    } else {
      report += `No obvious overfitting signal in this run.\n\n`;
    }
  } else {
    report += `No holdout-tests.jsonl was provided. This run cannot prove generalization.\n\n`;
    report += `**Warning: Generalization not verified.**\n\n`;
  }

  // Evaluation Hygiene
  report += `## Evaluation Hygiene\n\n`;
  report += `- Runtime input whitelist: prompt.md, goal.md, tests.jsonl, skillfoo.config.json, optional holdout-tests.jsonl\n`;
  report += `- Human-only files are not loaded into model context.\n`;
  report += `- Holdout tests are not used for candidate generation.\n`;
  report += `\n`;

  // Demo V2 Verdict
  report += `## Demo V2 Verdict\n\n`;
  report += `| Check | Result |\n`;
  report += `|---|---|\n`;

  const publicPass = bestScore >= 90;
  report += `| Public score >= 90 | ${publicPass ? "pass" : "fail"} |\n`;

  let holdoutPassStr: string;
  if (holdoutSummary) {
    holdoutPassStr = holdoutSummary.finalScore >= 85 ? "pass" : "fail";
  } else {
    holdoutPassStr = "not available";
  }
  report += `| Holdout score >= 85 | ${holdoutPassStr} |\n`;

  let gapPassStr: string;
  if (holdoutSummary) {
    const gap = bestScore - holdoutSummary.finalScore;
    gapPassStr = gap <= 10 ? "pass" : "fail";
  } else {
    gapPassStr = "not available";
  }
  report += `| Public-holdout gap <= 10 | ${gapPassStr} |\n`;

  const criticalCategories = ["privacy", "adversarial", "hallucination"];
  const allResults = [...lastResults, ...(holdoutResults ?? [])];
  const criticalFailures = allResults.filter(
    (r) => criticalCategories.includes(r.category) && !r.pass
  );
  report += `| Critical categories stable | ${criticalFailures.length === 0 ? "pass" : "fail"} |\n`;

  const rollbackVerdict = result.rollbackExercised ? "pass" : "not exercised";
  report += `| Rollback protected best prompt | ${rollbackVerdict} |\n`;
  report += `\n`;

  await writeFile(join(runDir, "report.md"), report, "utf-8");
}
