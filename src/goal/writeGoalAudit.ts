import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GoalAuditSummary } from "../types.js";

/**
 * Write goal audit artifacts to the run directory.
 *
 * Writes:
 * - goal-audit-summary.json
 * - goal-audit-report.md
 */
export async function writeGoalAudit(
  runDir: string,
  summary: GoalAuditSummary
): Promise<void> {
  // Write JSON summary
  await writeFile(
    join(runDir, "goal-audit-summary.json"),
    JSON.stringify(summary, null, 2),
    "utf-8"
  );

  // Write Markdown report
  const lines: string[] = [
    "# Goal Audit Report",
    "",
    "## Summary",
    "",
    `| 指标 | 值 |`,
    `|---|---|`,
    `| Goal Readiness Score | ${summary.goalReadinessScore} |`,
    `| Can Proceed | ${summary.canProceed ? "Yes" : "No"} |`,
    "",
  ];

  if (summary.missingRequiredSections.length > 0) {
    lines.push("## Missing Required Sections", "");
    summary.missingRequiredSections.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }

  if (summary.weakSections.length > 0) {
    lines.push("## Weak Sections", "");
    summary.weakSections.forEach((s) => lines.push(`- ${s}`));
    lines.push("");
  }

  if (summary.detectedCapabilities.length > 0) {
    lines.push("## Detected Capabilities", "");
    summary.detectedCapabilities.forEach((c) => lines.push(`- ${c}`));
    lines.push("");
  }

  if (summary.detectedForbiddenActions.length > 0) {
    lines.push("## Detected Forbidden Actions", "");
    summary.detectedForbiddenActions.forEach((a) => lines.push(`- ${a}`));
    lines.push("");
  }

  if (summary.detectedRiskTypes.length > 0) {
    lines.push("## Detected Risk Types", "");
    summary.detectedRiskTypes.forEach((r) => lines.push(`- ${r}`));
    lines.push("");
  }

  if (summary.issues.length > 0) {
    lines.push("## Issues", "");
    lines.push("| Severity | Code | Message | Section |");
    lines.push("|---|---|---|---|");
    summary.issues.forEach((i) => {
      lines.push(`| ${i.severity} | ${i.code} | ${i.message} | ${i.section ?? "-"} |`);
    });
    lines.push("");
  }

  await writeFile(
    join(runDir, "goal-audit-report.md"),
    lines.join("\n"),
    "utf-8"
  );
}
