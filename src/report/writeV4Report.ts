import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LoopResult } from "../loop/runPromptLoop.js";
import type { GoalAuditSummary, TestAuditSummary } from "../types.js";
import type { BeforeAfterComparison, CaseComparison } from "./compareResults.js";
import type { PromptChangeAnalysis } from "./analyzePromptChange.js";

// FinalVerdict type (defined here, will be moved to finalVerdict.ts in Task 6)
export interface FinalVerdictInput {
  label: string;
  reasons: string[];
  humanReviewRequired: boolean;
}

export interface V4ReportInput {
  runDir: string;
  projectName: string;
  loopResult: LoopResult;
  goalAudit: GoalAuditSummary;
  testAudit: TestAuditSummary;
  publicComparison: BeforeAfterComparison;
  holdoutComparison?: BeforeAfterComparison;
  promptChangeAnalyses: PromptChangeAnalysis[];
  finalVerdict: FinalVerdictInput;
  repairScoreThreshold: number;
  jsonCallMetadata?: {
    generateTestsAttempts: number;
    generateTestsRepairAttempts: number;
    generateTestsRecovered: boolean;
    repairCandidatesAttempts: number;
    repairCandidatesRepairAttempts: number;
    repairCandidatesRecovered: boolean;
    unrecoveredFailures: number;
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "...";
}

function caseTable(cases: CaseComparison[], limit: number): string {
  if (cases.length === 0) return "无。\n";
  let table = "| testId | category | userInput | beforeScore | afterScore | delta | beforeReason | afterReason |\n";
  table += "|---|---|---|---:|---:|---:|---|---|\n";
  for (const c of cases.slice(0, limit)) {
    table += `| ${c.testId} | ${c.category} | ${truncate(c.userInput, 30)} | ${c.beforeScore} | ${c.afterScore} | ${c.delta > 0 ? "+" : ""}${c.delta} | ${truncate(c.beforeReason, 40)} | ${truncate(c.afterReason, 40)} |\n`;
  }
  return table;
}

function promptChangeSummary(analyses: PromptChangeAnalysis[]): string {
  if (analyses.length === 0) return "无 prompt 改动分析记录。\n";
  let totalScopeBloat = 0;
  let totalSevereScopeBloat = 0;
  let totalOverRefusal = 0;
  let totalSevereOverRefusal = 0;
  const allNotes: string[] = [];

  for (const a of analyses) {
    totalScopeBloat += a.scopeBloatCount;
    totalSevereScopeBloat += a.severeScopeBloatCount;
    totalOverRefusal += a.overRefusalCount;
    totalSevereOverRefusal += a.severeOverRefusalCount;
    allNotes.push(...a.notes);
  }

  let report = `| 指标 | 数量 |\n|---|---:|\n`;
  report += `| scopeBloatCount | ${totalScopeBloat} |\n`;
  report += `| severeScopeBloatCount | ${totalSevereScopeBloat} |\n`;
  report += `| overRefusalCount | ${totalOverRefusal} |\n`;
  report += `| severeOverRefusalCount | ${totalSevereOverRefusal} |\n\n`;

  if (allNotes.length > 0) {
    report += "### 详细分析\n\n";
    for (const note of allNotes.slice(0, 20)) {
      report += `- ${note}\n`;
    }
    if (allNotes.length > 20) {
      report += `- ...还有 ${allNotes.length - 20} 条\n`;
    }
  }

  return report;
}

function scoreTimeline(loopResult: LoopResult): string {
  let table = "| Iteration | Version | Status | Score | Pass Rate | Passed | Failed | Summary |\n";
  table += "|---|---|---|---:|---:|---:|---:|---|\n";
  for (const entry of loopResult.ledger) {
    table += `| ${entry.iteration} | ${entry.promptVersion} | ${entry.status} | ${entry.score.toFixed(1)} | ${(entry.passRate * 100).toFixed(0)}% | ${entry.passed} | ${entry.failed} | ${truncate(entry.summary, 50)} |\n`;
  }
  return table;
}

export async function writeV4Report(input: V4ReportInput): Promise<void> {
  const { runDir, projectName, loopResult, goalAudit, testAudit, publicComparison, holdoutComparison, promptChangeAnalyses, finalVerdict, repairScoreThreshold, jsonCallMetadata } = input;

  let report = `# SkillFoo Prompt Loop V4 Final Report\n\n`;
  report += `**Project:** ${projectName}\n`;
  report += `**Run Directory:** ${runDir}\n\n`;

  // Final Verdict
  report += `## Final Verdict\n\n`;
  report += `**Label:** ${finalVerdict.label}\n`;
  report += `**Human Review Required:** ${finalVerdict.humanReviewRequired ? "Yes" : "No"}\n`;
  if (finalVerdict.reasons.length > 0) {
    report += `**Reasons:**\n`;
    for (const reason of finalVerdict.reasons) {
      report += `- ${reason}\n`;
    }
  }
  report += `\n`;

  // Run Inputs
  report += `## Run Inputs\n\n`;
  report += `| 项目 | 数值 |\n|---|---|\n`;
  report += `| Target Score | ${loopResult.targetScore} |\n`;
  report += `| Best Score | ${loopResult.bestScore.toFixed(1)} |\n`;
  report += `| Target Reached | ${loopResult.targetReached ? "Yes" : "No"} |\n`;
  report += `| Stop Reason | ${loopResult.stopReason} |\n`;
  report += `| Repair Score Threshold | ${repairScoreThreshold} |\n`;
  report += `| Rollback Exercised | ${loopResult.rollbackExercised ? "Yes" : "No"} |\n\n`;

  // Goal Audit
  report += `## Goal Audit\n\n`;
  report += `| 指标 | 数值 |\n|---|---:|\n`;
  report += `| goalReadinessScore | ${goalAudit.goalReadinessScore} |\n`;
  report += `| canProceed | ${goalAudit.canProceed ? "Yes" : "No"} |\n`;
  report += `| missingRequiredSections | ${goalAudit.missingRequiredSections.join(", ") || "无"} |\n`;
  report += `| weakSections | ${goalAudit.weakSections.join(", ") || "无"} |\n\n`;
  if (goalAudit.issues.length > 0) {
    report += `| Severity | Code | Section | Message |\n|---|---|---|---|\n`;
    for (const issue of goalAudit.issues) {
      report += `| ${issue.severity} | ${issue.code} | ${issue.section ?? ""} | ${issue.message} |\n`;
    }
    report += `\n`;
  }

  // JSON Stability
  report += `## JSON Stability\n\n`;
  if (jsonCallMetadata) {
    report += `| 阶段 | 尝试次数 | 修复次数 | 最终结果 |\n|---|---:|---:|---|\n`;
    report += `| generate-tests | ${jsonCallMetadata.generateTestsAttempts} | ${jsonCallMetadata.generateTestsRepairAttempts} | ${jsonCallMetadata.generateTestsRecovered ? "recovered" : "ok"} |\n`;
    report += `| repair-candidates | ${jsonCallMetadata.repairCandidatesAttempts} | ${jsonCallMetadata.repairCandidatesRepairAttempts} | ${jsonCallMetadata.repairCandidatesRecovered ? "recovered" : "ok"} |\n\n`;
    report += `未恢复 JSON 失败数量: ${jsonCallMetadata.unrecoveredFailures}\n\n`;
  } else {
    report += `JSON 调用元数据未提供。\n\n`;
  }

  // Test Quality
  report += `## Test Quality\n\n`;
  report += `| 指标 | 数值 |\n|---|---:|\n`;
  report += `| candidate tests | ${testAudit.total} |\n`;
  report += `| testQualityScore | ${testAudit.testQualityScore} |\n`;
  report += `| duplicateRatio | ${testAudit.duplicateRatio.toFixed(2)} |\n`;
  report += `| highRiskRatio | ${testAudit.highRiskRatio.toFixed(2)} |\n`;
  if (testAudit.publicHoldoutNearDuplicateRatio !== undefined) {
    report += `| publicHoldoutNearDuplicateRatio | ${testAudit.publicHoldoutNearDuplicateRatio.toFixed(4)} |\n`;
  }
  report += `| audit pass | ${testAudit.pass ? "Yes" : "No"} |\n\n`;

  // Score Timeline
  report += `## Score Timeline\n\n`;
  report += scoreTimeline(loopResult);
  report += `\n`;

  // Before/After Summary
  report += `## Before/After Summary\n\n`;
  report += `| 类型 | 数量 |\n|---|---:|\n`;
  report += `| fixedBadcases | ${publicComparison.fixedBadcases.length} |\n`;
  report += `| remainingFailures | ${publicComparison.remainingFailures.length} |\n`;
  report += `| regressions | ${publicComparison.regressions.length} |\n`;
  report += `| seriousRegressions | ${publicComparison.seriousRegressions.length} |\n`;
  report += `| improved | ${publicComparison.improved.length} |\n`;
  report += `| unchanged | ${publicComparison.unchanged.length} |\n\n`;

  if (holdoutComparison) {
    report += `### Holdout Before/After\n\n`;
    report += `| 类型 | 数量 |\n|---|---:|\n`;
    report += `| fixedBadcases | ${holdoutComparison.fixedBadcases.length} |\n`;
    report += `| remainingFailures | ${holdoutComparison.remainingFailures.length} |\n`;
    report += `| regressions | ${holdoutComparison.regressions.length} |\n`;
    report += `| seriousRegressions | ${holdoutComparison.seriousRegressions.length} |\n\n`;
  }

  // Score delta
  const publicDelta = loopResult.bestScore - loopResult.baselinePublicSummary.finalScore;
  const holdoutDelta = loopResult.holdoutSummary && loopResult.baselineHoldoutSummary
    ? loopResult.holdoutSummary.finalScore - loopResult.baselineHoldoutSummary.finalScore
    : undefined;
  report += `| 项目 | Baseline | Best | Delta |\n|---|---:|---:|---:|\n`;
  report += `| Public | ${loopResult.baselinePublicSummary.finalScore.toFixed(1)} | ${loopResult.bestScore.toFixed(1)} | ${publicDelta > 0 ? "+" : ""}${publicDelta.toFixed(1)} |\n`;
  if (holdoutDelta !== undefined && loopResult.holdoutSummary && loopResult.baselineHoldoutSummary) {
    report += `| Holdout | ${loopResult.baselineHoldoutSummary.finalScore.toFixed(1)} | ${loopResult.holdoutSummary.finalScore.toFixed(1)} | ${holdoutDelta > 0 ? "+" : ""}${holdoutDelta.toFixed(1)} |\n`;
  }
  report += `\n`;

  // Fixed Badcases
  report += `## Fixed Badcases (Top 10)\n\n`;
  report += caseTable(publicComparison.fixedBadcases, 10);
  report += `\n`;

  // Serious Regressions
  report += `## Serious Regressions (Top 10)\n\n`;
  report += caseTable(publicComparison.seriousRegressions, 10);
  report += `\n`;

  // Remaining Failures
  report += `## Remaining Failures (Top 10)\n\n`;
  report += caseTable(publicComparison.remainingFailures, 10);
  report += `\n`;

  // Prompt Change Summary
  report += `## Prompt Change Summary\n\n`;
  report += promptChangeSummary(promptChangeAnalyses);
  report += `\n`;

  // V6: Release Prompt (may differ from public best)
  report += `## Release Prompt\n\n`;
  report += "```markdown\n";
  report += loopResult.bestPrompt;
  report += "\n```\n\n";

  // V6: Public Best Candidate (evidence only, may differ from release prompt)
  if (loopResult.publicBestPrompt && loopResult.publicBestPrompt !== loopResult.bestPrompt) {
    report += `## Public Best Candidate (Evidence Only)\n\n`;
    report += "This candidate passed the public keep gate but was not released.\n\n";
    report += "```markdown\n";
    report += loopResult.publicBestPrompt;
    report += "\n```\n\n";
  }

  // V6: Release Decision
  if (loopResult.releaseDecision) {
    report += `## Release Decision\n\n`;
    report += `| Field | Value |\n`;
    report += `|---|---|\n`;
    report += `| Status | ${loopResult.releaseDecision.status} |\n`;
    report += `| Released Prompt Version | ${loopResult.releaseDecision.releasedPromptVersion} |\n`;
    if (loopResult.releaseDecision.reasons.length > 0) {
      report += `| Reasons | ${loopResult.releaseDecision.reasons.join(", ")} |\n`;
    }
    if (loopResult.releaseDecision.holdoutDelta !== undefined) {
      report += `| Holdout Delta | ${loopResult.releaseDecision.holdoutDelta.toFixed(1)} |\n`;
    }
    report += `\n`;
  }

  // V6: Holdout Release Gate
  if (loopResult.releaseDecision && loopResult.holdoutSummary) {
    report += `## Holdout Release Gate\n\n`;
    report += `| Metric | Value |\n`;
    report += `|---|---:|\n`;
    report += `| Public best holdout score | ${loopResult.holdoutSummary.finalScore.toFixed(1)} |\n`;
    if (loopResult.baselineHoldoutSummary) {
      report += `| Baseline holdout score | ${loopResult.baselineHoldoutSummary.finalScore.toFixed(1)} |\n`;
    }
    if (loopResult.releaseDecision.holdoutDelta !== undefined) {
      report += `| Holdout delta | ${loopResult.releaseDecision.holdoutDelta.toFixed(1)} |\n`;
    }
    if (loopResult.releaseDecision.criticalFailuresAfter !== undefined) {
      report += `| Critical failures after | ${loopResult.releaseDecision.criticalFailuresAfter} |\n`;
    }
    report += `\n`;
  }

  // V6: PromptSpec (Advisory)
  report += `## PromptSpec (Advisory)\n\n`;
  report += `PromptSpec v1 assessment is advisory only. It does not affect candidate scoring or release decisions.\n\n`;
  report += `See prompt-spec-assessment.json for structural analysis of baseline, public best, and release prompt.\n\n`;

  // Human Review Checklist
  report += `## Human Review Checklist\n\n`;
  report += `- [ ] 检查 best prompt 是否保留了原始核心任务\n`;
  report += `- [ ] 检查 fixed badcases 的修复是否合理\n`;
  report += `- [ ] 检查 serious regressions 是否可接受\n`;
  report += `- [ ] 检查 remaining failures 是否需要进一步迭代\n`;
  report += `- [ ] 检查 prompt change 是否有 scope bloat 或 over-refusal\n`;
  report += `- [ ] 确认 final verdict 是否与人工判断一致\n`;

  await writeFile(join(runDir, "v4-report.md"), report, "utf-8");
}
