import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestCase, TestAuditSummary } from "../types.js";
import { writeJsonl } from "../storage/jsonl.js";

export async function writeGeneratedTestArtifacts(
  outDir: string,
  candidateTests: TestCase[],
  publicTests: TestCase[],
  holdoutTests: TestCase[],
  auditSummary: TestAuditSummary
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeJsonl(join(outDir, "candidate-tests.jsonl"), candidateTests);
  await writeJsonl(join(outDir, "tests.jsonl"), publicTests);
  await writeJsonl(join(outDir, "holdout-tests.jsonl"), holdoutTests);
  await writeFile(join(outDir, "test-audit-summary.json"), JSON.stringify(auditSummary, null, 2), "utf-8");
  await writeFile(
    join(outDir, "source-manifest.json"),
    JSON.stringify(
      {
        status: "generated",
        source: "skillfoo-auto-generated",
        generator: "generateTests",
        generatedAt: new Date().toISOString(),
        candidateCount: candidateTests.length,
        publicCount: publicTests.length,
        holdoutCount: holdoutTests.length,
      },
      null,
      2,
    ),
    "utf-8",
  );

  let report = "# Generated Test Audit Report\n\n";
  report += `Total candidate tests: ${auditSummary.total}\n`;
  report += `Test quality score: ${auditSummary.testQualityScore}\n`;
  report += `Pass: ${auditSummary.pass}\n`;
  report += `Duplicate ratio: ${auditSummary.duplicateRatio.toFixed(2)}\n`;
  report += `High-risk ratio: ${auditSummary.highRiskRatio.toFixed(2)}\n`;
  if (auditSummary.publicHoldoutNearDuplicateRatio !== undefined) {
    report += `Public/holdout near-duplicate ratio: ${auditSummary.publicHoldoutNearDuplicateRatio.toFixed(4)}\n`;
  }
  report += "\n";
  report += "## Category Counts\n\n";
  report += "| Category | Count |\n|---|---:|\n";
  for (const [category, count] of Object.entries(auditSummary.categoryCounts)) {
    report += `| ${category} | ${count} |\n`;
  }
  report += "\n## Issues\n\n";
  if (auditSummary.issues.length === 0) {
    report += "No issues.\n";
  } else {
    report += "| Severity | Code | Test ID | Message |\n|---|---|---|---|\n";
    for (const issue of auditSummary.issues) {
      report += `| ${issue.severity} | ${issue.code} | ${issue.testId ?? ""} | ${issue.message} |\n`;
    }
  }

  await writeFile(join(outDir, "test-audit-report.md"), report, "utf-8");
}
