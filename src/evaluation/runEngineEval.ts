import { join } from "node:path";
import type { ModelProvider } from "../providers/types.js";
import type { Project, EvaluationPolicy } from "../config/loadProject.js";
import type { EvalResult, Summary, TestCase } from "../types.js";
import { computeSummary } from "./scoring.js";
import { runEval, type EvalRun } from "./runEval.js";
import { resolveLoopEngine } from "../loop/engineDecision.js";
import {
  runPromptfooEval,
  type PromptfooEvalReturn,
} from "../promptfoo/runPromptfooEval.js";
import type { ProviderConfig } from "../promptfoo/types.js";

export interface EngineEvalOptions {
  runDir: string;
  promptVersion: string;
  tests: TestCase[];
  artifactDir?: string;
}

function toPromptfooProvider(project: Project): ProviderConfig {
  const provider = project.config.targetProvider ?? project.config.provider;
  return {
    type: provider.type,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    model: provider.model,
  };
}

function normalizePromptfooEval(
  promptVersion: string,
  tests: TestCase[],
  result: PromptfooEvalReturn,
  policy: EvaluationPolicy,
): EvalRun {
  const testsById = new Map(tests.map((test) => [test.id, test]));
  const evalResults: EvalResult[] = result.results.map((item, index) => {
    const test = testsById.get(item.testId) ?? tests[index % Math.max(1, tests.length)];
    const reason = item.assertions
      .map((assertion) => assertion.reason)
      .filter(Boolean)
      .join("; ") || item.error || "Promptfoo returned no grader reason.";

    return {
      testId: test?.id ?? item.testId,
      category: test?.category ?? "normal",
      promptVersion,
      userInput: test?.userInput ?? item.userInput,
      modelOutput: item.output,
      pass: item.pass,
      score: Math.max(0, Math.min(100, item.score)),
      reason,
      weight: test?.weight ?? 1,
      error: item.error,
    };
  });

  return {
    results: evalResults,
    summary: computeSummary(promptVersion, evalResults, policy.casePassScore),
  };
}

/**
 * Single evaluation boundary for the loop.
 * Promptfoo is the default engine; legacy evaluation is opt-in only.
 * The returned shape is always SkillFoo's EvalRun so governance remains
 * independent of the execution engine.
 */
export async function runEngineEval(
  provider: ModelProvider,
  project: Project,
  prompt: string,
  options: EngineEvalOptions,
): Promise<EvalRun> {
  const engine = resolveLoopEngine(project.config);
  if (engine === "legacy") {
    return runEval(
      provider,
      prompt,
      options.promptVersion,
      options.tests,
      project.evaluationPolicy,
    );
  }

  const runtime = project.config.runtime ?? {
    maxConcurrency: 2,
    cache: true,
    retryErrors: true,
    repeat: 1,
  };

  try {
    const promptfooResult = await runPromptfooEval({
      runDir: options.runDir,
      artifactDir: options.artifactDir,
      prompt,
      tests: options.tests,
      targetProvider: toPromptfooProvider(project),
      graderProvider: project.config.graderProvider,
      maxConcurrency: runtime.maxConcurrency,
      cache: runtime.cache,
      repeat: runtime.repeat,
    });
    return normalizePromptfooEval(
      options.promptVersion,
      options.tests,
      promptfooResult,
      project.evaluationPolicy,
    );
  } catch (error) {
    if (project.config.legacyFallback) {
      console.warn(
        `Promptfoo evaluation failed; explicit legacyFallback=true, using legacy evaluator: ${String(error)}`,
      );
      return runEval(
        provider,
        prompt,
        options.promptVersion,
        options.tests,
        project.evaluationPolicy,
      );
    }
    throw new Error(`Promptfoo evaluation failed: ${String(error)}`);
  }
}
