import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeSupervisorReport } from "../supervisor/writeSupervisorReport.js";

test("writeSupervisorReport writes json and markdown", async () => {
  const runDir = join(tmpdir(), `skillfoo-supervisor-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  await writeSupervisorReport(runDir, {
    label: "clear_improvement",
    publicDelta: 8,
    holdoutDelta: 5,
    publicHoldoutGap: 1,
    regressionCount: 0,
    seriousRegressionCount: 0,
    criticalFailuresAfter: 0,
    lowScoreAfter: 0,
    minScoreBefore: 40,
    minScoreAfter: 85,
    explanation: "clear improvement",
  });

  await access(join(runDir, "improvement-assessment.json"));
  const report = await readFile(join(runDir, "supervisor-report.md"), "utf-8");
  assert.match(report, /clear_improvement/);
  await rm(runDir, { recursive: true, force: true });
});
