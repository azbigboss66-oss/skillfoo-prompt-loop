import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProject } from "../config/loadProject.js";
import { createMockProvider } from "../providers/mockProvider.js";
import { runPromptLoop } from "../loop/runPromptLoop.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("high score protection: baseline >= targetScore still probes and never degrades", async () => {
  const project = await loadProject("examples/already-good");
  const provider = createMockProvider();
  const runDir = await mkdtemp(join(tmpdir(), "skillfoo-test-"));

  const result = await runPromptLoop(provider, project, runDir, 3, 60);

  // Reaching the quality floor alone is not enough to exit the loop. The
  // loop only reports targetReached after a strictly better prompt is kept.
  assert.equal(result.targetReached, false);

  // The loop must enter the quality-probe path even though baseline is above 60.
  const repairEntries = result.ledger.filter(
    (e) => e.status === "keep" || e.status === "rollback"
  );
  assert.ok(repairEntries.length > 0);
  assert.ok(repairEntries.some((e) => e.status === "rollback"));
  assert.match(
    result.ledger.at(-1)?.summary ?? "",
    /baseline already met the quality floor/,
  );

  // Best prompt is the original prompt (not modified)
  assert.equal(result.bestPrompt, project.prompt);
  assert.equal(result.bestScore, result.baselinePublicSummary.finalScore);

  await rm(runDir, { recursive: true, force: true });
});
