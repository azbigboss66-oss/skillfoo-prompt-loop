import type { ModelProvider } from "../providers/types.js";
import type { TestCase, EvalResult, Summary } from "../types.js";
import type { EvaluationPolicy } from "../config/loadProject.js";
import { renderTargetMessages } from "./renderPrompt.js";
import { judgeResponse } from "./judge.js";
import { computeSummary } from "./scoring.js";

export interface EvalRun {
  results: EvalResult[];
  summary: Summary;
}

/**
 * Run evaluation: for each test case, call the target prompt to get
 * a model output, then judge it. Returns results and summary.
 */
export async function runEval(
  provider: ModelProvider,
  prompt: string,
  promptVersion: string,
  tests: TestCase[],
  policy: EvaluationPolicy
): Promise<EvalRun> {
  const results: EvalResult[] = [];

  for (const test of tests) {
    // 1. Call target prompt to get model output
    const targetMessages = renderTargetMessages(prompt, test.userInput);
    const modelOutput = await provider.chat(targetMessages);

    // 2. Judge the response
    const judgeResult = await judgeResponse(
      provider,
      prompt,
      test,
      modelOutput,
      policy.casePassScore
    );

    results.push({
      testId: test.id,
      category: test.category,
      promptVersion,
      userInput: test.userInput,
      modelOutput,
      pass: judgeResult.pass,
      score: judgeResult.score,
      reason: judgeResult.reason,
      weight: test.weight,
    });
  }

  const summary = computeSummary(promptVersion, results, policy.casePassScore);
  return { results, summary };
}
