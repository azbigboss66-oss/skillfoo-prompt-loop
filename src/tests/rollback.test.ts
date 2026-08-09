import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProject } from "../config/loadProject.js";
import { runPromptLoop } from "../loop/runPromptLoop.js";
import type { ModelProvider, ChatMessage } from "../providers/types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * A provider that always returns low scores (25) for judge requests,
 * and returns a candidate prompt without the strong marker.
 * This ensures candidate score does not improve over baseline.
 */
function createLowScoreProvider(): ModelProvider {
  return {
    name: "mock-low",
    async chat(messages: ChatMessage[]): Promise<string> {
      const fullText = messages.map((m) => m.content).join("\n");

      if (fullText.includes("JUDGE_JSON")) {
        return JSON.stringify({
          pass: false,
          score: 25,
          reason: "Low score for testing rollback.",
        });
      }

      if (fullText.includes("REPAIR_PROMPT_JSON")) {
        return JSON.stringify([
          {
            id: "candidate-1",
            hypothesis: "test low score candidate",
            prompt: "你是一个客服助手。请回答用户的问题。",
            changeSummary: ["test change"],
          },
        ]);
      }

      return "好的，我帮您看看。";
    },
  };
}

test("rollback: candidate score not improving over best keeps best unchanged", async () => {
  const project = await loadProject("examples/basic");
  // This fixture deliberately tests the V4 evaluator's deterministic rollback
  // contract. V5 defaults to Promptfoo, so opt into legacy explicitly here.
  project.config.optimizationEngine = "legacy";
  const provider = createLowScoreProvider();
  const runDir = await mkdtemp(join(tmpdir(), "skillfoo-test-"));

  const result = await runPromptLoop(provider, project, runDir, 1, 60);

  // Baseline = 25, candidate = 25, 25 < 25 + 2 (minImprovement), so rollback
  assert.equal(result.bestScore, 25);
  assert.equal(result.targetReached, false);

  // Check ledger has a rollback entry
  const rollbackEntries = result.ledger.filter(
    (e) => e.status === "rollback"
  );
  assert.equal(rollbackEntries.length, 1);

  // Check no keep entries
  const keepEntries = result.ledger.filter((e) => e.status === "keep");
  assert.equal(keepEntries.length, 0);

  // Best prompt is the original prompt (not the candidate)
  assert.equal(result.bestPrompt, project.prompt);

  await rm(runDir, { recursive: true, force: true });
});
