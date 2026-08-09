import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseDecision } from "../types.js";

export interface BestPromptEvidenceInput {
  runDir: string;
  runId: string;
  targetProvider: { type: string; model?: string };
  publicBestPrompt: string;
  publicBestPromptVersion: string;
  publicBestScore: number;
  releasePrompt: string;
  releaseDecision: ReleaseDecision;
  baselinePublicScore: number;
  baselineHoldoutScore?: number;
  publicKeep: boolean;
  holdoutDelta?: number;
  seriousHoldoutRegressions: number;
  criticalFailuresAfter: number;
  limitations: string[];
}

interface BestPromptEvidence {
  promptSpecAssessment?: string;
  schemaVersion: "1.0";
  runId: string;
  targetProvider: { type: string; model?: string };
  baseline: { promptVersion: "baseline"; publicScore: number; holdoutScore?: number };
  publicBest: { promptVersion: string; publicScore: number };
  release: { promptVersion: string; status: string };
  gates: {
    publicKeep: boolean;
    holdoutDelta?: number;
    seriousHoldoutRegressions: number;
    criticalFailuresAfter: number;
  };
  limitations: string[];
}

/**
 * V6: Write the four release-evidence artifacts.
 *
 * - public-best-prompt.md: the best candidate under public-set evaluation (evidence only)
 * - best-prompt.md: the release prompt (baseline or public best after holdout gate)
 * - release-decision.json: the deterministic release decision
 * - best-prompt-evidence.json: structured evidence record
 */
export async function writeBestPromptEvidence(
  input: BestPromptEvidenceInput,
): Promise<void> {
  // Write public-best-prompt.md (evidence only)
  await writeFile(
    join(input.runDir, "public-best-prompt.md"),
    input.publicBestPrompt,
    "utf-8",
  );

  // Write best-prompt.md (release prompt)
  await writeFile(
    join(input.runDir, "best-prompt.md"),
    input.releasePrompt,
    "utf-8",
  );

  // Write release-decision.json
  await writeFile(
    join(input.runDir, "release-decision.json"),
    JSON.stringify(input.releaseDecision, null, 2),
    "utf-8",
  );

  // Write best-prompt-evidence.json
  const evidence: BestPromptEvidence = {
    schemaVersion: "1.0",
    runId: input.runId,
    targetProvider: input.targetProvider,
    baseline: {
      promptVersion: "baseline",
      publicScore: input.baselinePublicScore,
      holdoutScore: input.baselineHoldoutScore,
    },
    publicBest: {
      promptVersion: input.publicBestPromptVersion,
      publicScore: input.publicBestScore,
    },
    release: {
      promptVersion: input.releaseDecision.releasedPromptVersion,
      status: input.releaseDecision.status,
    },
    gates: {
      publicKeep: input.publicKeep,
      holdoutDelta: input.holdoutDelta,
      seriousHoldoutRegressions: input.seriousHoldoutRegressions,
      criticalFailuresAfter: input.criticalFailuresAfter,
    },
    limitations: input.limitations,
    promptSpecAssessment: "prompt-spec-assessment.json",
  };

  await writeFile(
    join(input.runDir, "best-prompt-evidence.json"),
    JSON.stringify(evidence, null, 2),
    "utf-8",
  );
}
