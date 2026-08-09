import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assessPromptSpec } from "./assessPromptSpec.js";
import type { PromptSpecMode, PromptSpecAssessment } from "./schema.js";

export interface PromptSpecArtifactsInput {
  runDir: string;
  baselinePrompt: string;
  publicBestPrompt: string;
  releasePrompt: string;
  mode: PromptSpecMode;
}

export interface PromptSpecArtifactsOutput {
  baseline: PromptSpecAssessment;
  publicBest: PromptSpecAssessment;
  release: PromptSpecAssessment;
  selectionImpact: "advisory_only" | "off";
}

/**
 * Write prompt-spec-assessment.json with independent assessments
 * for baseline, public best, and release prompt.
 */
export async function writePromptSpecArtifacts(
  input: PromptSpecArtifactsInput,
): Promise<PromptSpecArtifactsOutput> {
  const baseline = assessPromptSpec(input.baselinePrompt, input.mode);
  const publicBest = assessPromptSpec(input.publicBestPrompt, input.mode);
  const release = assessPromptSpec(input.releasePrompt, input.mode);

  const output: PromptSpecArtifactsOutput = {
    baseline: {
      schemaVersion: "1.0",
      mode: input.mode,
      format: baseline.format,
      detectedSections: baseline.detectedSections,
      missingCoreSections: baseline.missingCoreSections,
      duplicateSections: baseline.duplicateSections,
      unresolvedVariables: baseline.unresolvedVariables,
      emptySections: baseline.emptySections,
      notes: baseline.notes,
    },
    publicBest: {
      schemaVersion: "1.0",
      mode: input.mode,
      format: publicBest.format,
      detectedSections: publicBest.detectedSections,
      missingCoreSections: publicBest.missingCoreSections,
      duplicateSections: publicBest.duplicateSections,
      unresolvedVariables: publicBest.unresolvedVariables,
      emptySections: publicBest.emptySections,
      notes: publicBest.notes,
    },
    release: {
      schemaVersion: "1.0",
      mode: input.mode,
      format: release.format,
      detectedSections: release.detectedSections,
      missingCoreSections: release.missingCoreSections,
      duplicateSections: release.duplicateSections,
      unresolvedVariables: release.unresolvedVariables,
      emptySections: release.emptySections,
      notes: release.notes,
    },
    selectionImpact: input.mode === "off" ? "off" : "advisory_only",
  };

  await writeFile(
    join(input.runDir, "prompt-spec-assessment.json"),
    JSON.stringify(output, null, 2),
    "utf-8",
  );

  return output;
}
