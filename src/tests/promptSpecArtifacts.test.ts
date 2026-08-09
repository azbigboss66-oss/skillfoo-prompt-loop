import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePromptSpecArtifacts } from "../promptspec/writePromptSpecArtifacts.js";

test("writePromptSpecArtifacts writes assessment for three prompts independently", async () => {
  const runDir = join(tmpdir(), `skillfoo-promptspec-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    const baselinePrompt = "You are a helpful assistant. Answer questions.";
    const publicBestPrompt = [
      "# \u76EE\u6807",
      "Provide customer service.",
      "",
      "# \u8F93\u5165\u8303\u56F4",
      "User questions.",
      "",
      "# \u51B3\u7B56\u6D41\u7A0B",
      "Check and answer.",
      "",
      "# \u8FB9\u754C",
      "No fabrication.",
      "",
      "# \u8F93\u51FA\u683C\u5F0F",
      "Clear text.",
    ].join("\n");
    const releasePrompt = baselinePrompt;

    const output = await writePromptSpecArtifacts({
      runDir,
      baselinePrompt,
      publicBestPrompt,
      releasePrompt,
      mode: "advisory",
    });

    assert.equal(output.baseline.format, "freeform");
    assert.equal(output.publicBest.format, "structured");
    assert.equal(output.release.format, "freeform");
    assert.equal(output.selectionImpact, "advisory_only");

    // Verify file was written
    const file = JSON.parse(await readFile(join(runDir, "prompt-spec-assessment.json"), "utf8"));
    assert.equal(file.baseline.format, "freeform");
    assert.equal(file.publicBest.format, "structured");
    assert.equal(file.release.format, "freeform");
    assert.equal(file.selectionImpact, "advisory_only");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("writePromptSpecArtifacts with off mode returns off selectionImpact", async () => {
  const runDir = join(tmpdir(), `skillfoo-promptspec-off-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  try {
    const output = await writePromptSpecArtifacts({
      runDir,
      baselinePrompt: "Simple prompt.",
      publicBestPrompt: "Another simple prompt.",
      releasePrompt: "Simple prompt.",
      mode: "off",
    });

    assert.equal(output.selectionImpact, "off");
    assert.equal(output.baseline.mode, "off");
    assert.equal(output.publicBest.mode, "off");
    assert.equal(output.release.mode, "off");

    const file = JSON.parse(await readFile(join(runDir, "prompt-spec-assessment.json"), "utf8"));
    assert.equal(file.selectionImpact, "off");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});
