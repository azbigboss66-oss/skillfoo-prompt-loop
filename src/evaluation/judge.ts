import type { ModelProvider } from "../providers/types.js";
import type { TestCase } from "../types.js";
import { renderJudgeMessages } from "./renderPrompt.js";
import { extractJson } from "../storage/extractJson.js";

export interface JudgeResult {
  pass: boolean;
  score: number;
  reason: string;
}

function parseJudgeJson(text: string, casePassScore: number): JudgeResult | null {
  const result = extractJson<{ pass?: boolean; score?: number; reason?: string }>(text);
  if (result && typeof result === "object") {
    const score = Math.max(0, Math.min(100, Number(result.score) || 0));
    return {
      pass: score >= casePassScore,
      score,
      reason: String(result.reason || ""),
    };
  }
  return null;
}

/**
 * Judge a model response. Calls the provider with judge instructions.
 * If the first attempt fails to return valid JSON, retries once.
 * If still failing, returns pass=false, score=0, reason="judge_json_parse_error".
 */
export async function judgeResponse(
  provider: ModelProvider,
  prompt: string,
  test: TestCase,
  modelOutput: string,
  casePassScore: number
): Promise<JudgeResult> {
  const messages = renderJudgeMessages(
    prompt,
    test.userInput,
    test.expectedBehavior,
    test.rubric,
    modelOutput,
    casePassScore
  );

  // First attempt
  const response1 = await provider.chat(messages);
  const result1 = parseJudgeJson(response1, casePassScore);
  if (result1) {
    return result1;
  }

  // Retry once
  const response2 = await provider.chat(messages);
  const result2 = parseJudgeJson(response2, casePassScore);
  if (result2) {
    return result2;
  }

  // Both failed
  return {
    pass: false,
    score: 0,
    reason: "judge_json_parse_error",
  };
}
