import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BeforeAfterComparison } from "./compareResults.js";
import type { PromptChangeAnalysis } from "./analyzePromptChange.js";
import { writeJsonl } from "../storage/jsonl.js";

export interface LoopEvidenceArtifactsInput {
  runDir: string;
  originalPrompt: string;
  bestPrompt: string;
  /** V6: The public best candidate prompt (may differ from bestPrompt when release rolled back) */
  publicBestPrompt?: string;
  /** V6: The release decision status, if available */
  releaseStatus?: string;
  finalPromptAnalysis: PromptChangeAnalysis;
  candidateAnalyses: PromptChangeAnalysis[];
  publicComparison: BeforeAfterComparison;
}

/** Write the human-auditable before/after prompt and case evidence. */
export async function writeLoopEvidenceArtifacts(
  input: LoopEvidenceArtifactsInput,
): Promise<void> {
  const finalChanged = input.originalPrompt !== input.bestPrompt;
  const hasPublicBest = input.publicBestPrompt !== undefined && input.publicBestPrompt !== input.bestPrompt;
  const diffLines = [
    "# Prompt Diff",
    "",
    "## Original Prompt (Baseline)",
    "",
    "```text",
    input.originalPrompt,
    "```",
    "",
    hasPublicBest
      ? "## Public Best Candidate (Evidence Only)"
      : "## Release Prompt",
    "",
    "```text",
    hasPublicBest ? input.publicBestPrompt! : input.bestPrompt,
    "```",
    "",
    ...(hasPublicBest ? [
      "## Release Prompt",
      "",
      "```text",
      input.bestPrompt,
      "```",
      "",
      `Release Decision: ${input.releaseStatus ?? "unknown"}`,
      "",
      "The public best candidate was not released. The release prompt is the baseline.",
      "",
    ] : []),
    "## Change Status",
    "",
    finalChanged
      ? "本次运行最终发布了一个发生变化的 Prompt。"
      : hasPublicBest
        ? "本次运行有一个公开最佳候选未通过 holdout 发布门，最终发布回滚到基线。"
        : "本次运行没有保留任何 Prompt 变化；所有候选均未达到安全提升条件或尚未证明提升。",
    "",
    "## Final Prompt Governance",
    "",
    `- Scope bloat: ${input.finalPromptAnalysis.scopeBloatCount}`,
    `- Severe scope bloat: ${input.finalPromptAnalysis.severeScopeBloatCount}`,
    `- Over-refusal: ${input.finalPromptAnalysis.overRefusalCount}`,
    `- Severe over-refusal: ${input.finalPromptAnalysis.severeOverRefusalCount}`,
    ...input.finalPromptAnalysis.notes.map((note) => `- Note: ${note}`),
    "",
    "## Candidate Governance Records",
    "",
    ...(input.candidateAnalyses.length === 0
      ? ["本次没有候选治理记录。"]
      : [
          "候选 Prompt 的完整内容保存在各轮 `iter-*/candidate-prompts.json`，以下记录对应同一顺序。",
          "",
          ...input.candidateAnalyses.flatMap((analysis, index) => [
          `### Candidate ${index + 1}`,
          `- Scope bloat: ${analysis.scopeBloatCount}`,
          `- Severe scope bloat: ${analysis.severeScopeBloatCount}`,
          `- Over-refusal: ${analysis.overRefusalCount}`,
          `- Severe over-refusal: ${analysis.severeOverRefusalCount}`,
          ...analysis.notes.map((note) => `- Note: ${note}`),
          "",
          ]),
        ]),
  ];

  await writeFile(join(input.runDir, "prompt-diff.md"), diffLines.join("\n"), "utf-8");
  await writeJsonl(
    join(input.runDir, "badcases-fixed.jsonl"),
    input.publicComparison.fixedBadcases.map((item) => ({
      ...item,
      fixed: true,
    })),
  );
  await writeJsonl(
    join(input.runDir, "regressions.jsonl"),
    input.publicComparison.regressions,
  );
}
