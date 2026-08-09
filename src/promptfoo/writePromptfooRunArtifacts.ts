import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "../config/loadProject.js";
import { writePromptfooConfig } from "./writePromptfooConfig.js";

/**
 * Write the Promptfoo evidence contract for one V5 run.
 *
 * Native Promptfoo optimize is optional in the current fixed loop. Its
 * configuration and streams are still written with an explicit not_executed
 * marker, so a complete artifact set never implies a false API call.
 */
export async function writePromptfooRunArtifacts(
  runDir: string,
  project: Project,
): Promise<void> {
  const targetProvider = project.config.targetProvider ?? project.config.provider;
  const inputBase = {
    prompt: project.prompt,
    tests: project.tests,
    targetProvider,
    graderProvider: project.config.graderProvider,
    maxConcurrency: project.config.runtime?.maxConcurrency ?? 2,
    cache: project.config.runtime?.cache ?? true,
  };

  await writePromptfooConfig(
    runDir,
    { ...inputBase, mode: "baseline" },
    "eval-config.yaml",
  );

  await writePromptfooConfig(
    runDir,
    {
      ...inputBase,
      mode: "optimize",
      validationSplit: project.config.optimization?.validationSplit ?? 0.2,
    },
    "optimize-config.yaml",
    [
      "# SkillFoo execution status: not_executed\n",
      "# Native Promptfoo optimize was not invoked in this V5 fixed loop.\n",
      "# This file records the equivalent candidate-optimization configuration only.\n",
    ].join(""),
  );

  const notExecuted = [
    "SkillFoo V5 execution status: not_executed",
    "Native Promptfoo optimize was not invoked.",
    "Candidate generation is handled by SkillFoo fixed loop; Promptfoo evaluate() scores each candidate.",
    "",
  ].join("\n");
  const promptfooDir = join(runDir, "promptfoo");
  await writeFile(join(promptfooDir, "optimize-stdout.txt"), notExecuted, "utf-8");
  await writeFile(join(promptfooDir, "optimize-stderr.txt"), notExecuted, "utf-8");
}
