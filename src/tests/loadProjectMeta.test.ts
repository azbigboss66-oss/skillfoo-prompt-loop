import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadProjectMeta } from "../config/loadProjectMeta.js";

test("loadProjectMeta reads prompt goal and config without tests", async () => {
  const dir = join(tmpdir(), `skillfoo-meta-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "prompt.md"), "prompt", "utf-8");
  await writeFile(join(dir, "goal.md"), "goal", "utf-8");
  await writeFile(join(dir, "skillfoo.config.json"), JSON.stringify({
    projectName: "tmp",
    targetScore: 90,
    maxIters: 1,
    minImprovement: 2,
    candidateCount: 1,
    casePassScore: 81,
    repairScoreThreshold: 86,
    provider: { type: "mock" }
  }), "utf-8");

  const meta = await loadProjectMeta(dir);
  assert.equal(meta.prompt, "prompt");
  assert.equal(meta.goal, "goal");
  assert.equal(meta.evaluationPolicy.casePassScore, 81);
  assert.equal(meta.evaluationPolicy.repairScoreThreshold, 86);

  await rm(dir, { recursive: true, force: true });
});
