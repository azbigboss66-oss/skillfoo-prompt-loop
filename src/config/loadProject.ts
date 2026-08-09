import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  TestCaseSchema,
  type TestCase,
  type RuntimeConfig,
  type OptimizationConfig,
} from "../types.js";
import { readJsonl } from "../storage/jsonl.js";
import { buildEvaluationPolicy } from "./loadProjectMeta.js";
import type { PromptChangeGoalProfile } from "../report/analyzePromptChange.js";

export interface ProviderConfig {
  type: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
  thinking?: "enabled" | "disabled";
}

export interface EvaluationPolicy {
  casePassScore: number;
  repairScoreThreshold: number;
}

export interface ProjectConfig {
  // V4 fields (backward compatible)
  projectName: string;
  targetScore: number;
  maxIters: number;
  minImprovement: number;
  candidateCount: number;
  casePassScore?: number;
  repairScoreThreshold?: number;
  holdoutTestsPath?: string;
  provider: ProviderConfig;

  // V5 fields (optional for backward compatibility)
  optimizationEngine?: "promptfoo" | "legacy";
  legacyFallback?: boolean;
  targetProvider?: ProviderConfig;
  graderProvider?: ProviderConfig;
  runtime?: RuntimeConfig;
  optimization?: OptimizationConfig;

  // V6 fields (optional for backward compatibility)
  bestPromptPolicy?: {
    promptSpecMode?: "off" | "advisory";
    requireHoldoutForAccepted?: boolean;
  };
}

export interface Project {
  projectDir: string;
  prompt: string;
  goal: string;
  tests: TestCase[];
  holdoutTests: TestCase[];
  config: ProjectConfig;
  evaluationPolicy: EvaluationPolicy;
  promptChangeGoalProfile?: PromptChangeGoalProfile;
}

/**
 * Resolve V5 runtime config with defaults.
 * Defaults: maxConcurrency=2, cache=true, retryErrors=true, repeat=1
 */
function resolveRuntimeConfig(
  config: ProjectConfig
): RuntimeConfig {
  return config.runtime ?? {
    maxConcurrency: 2,
    cache: true,
    retryErrors: true,
    repeat: 1,
  };
}

/**
 * Resolve V5 optimization config with defaults.
 * Defaults: validationSplit=0.2, maxIters from config, minImprovement from config
 */
function resolveOptimizationConfig(
  config: ProjectConfig
): OptimizationConfig {
  return config.optimization ?? {
    validationSplit: 0.2,
    maxIters: config.maxIters,
    minImprovement: config.minImprovement,
  };
}

/**
 * Load and validate a SkillFoo project from a directory.
 * Reads prompt.md, goal.md, tests.jsonl, skillfoo.config.json.
 *
 * V5 additions:
 * - Parses optimizationEngine (defaults to "promptfoo")
 * - Parses legacyFallback (defaults to false)
 * - Parses targetProvider (falls back to existing provider)
 * - Parses graderProvider (optional)
 * - Parses runtime config with defaults
 * - Parses optimization config with defaults
 */
export async function loadProject(projectDir: string): Promise<Project> {
  const promptPath = join(projectDir, "prompt.md");
  const goalPath = join(projectDir, "goal.md");
  const testsPath = join(projectDir, "tests.jsonl");
  const configPath = join(projectDir, "skillfoo.config.json");

  const prompt = (await readFile(promptPath, "utf-8")).trim();
  const goal = (await readFile(goalPath, "utf-8")).trim();
  const configRaw = await readFile(configPath, "utf-8");
  const config = JSON.parse(configRaw) as ProjectConfig;

  // V5: Apply defaults for new fields
  if (!config.optimizationEngine) {
    config.optimizationEngine = "promptfoo";
  }
  if (config.legacyFallback === undefined) {
    config.legacyFallback = false;
  }
  if (!config.targetProvider) {
    config.targetProvider = config.provider;
  }
  config.runtime = resolveRuntimeConfig(config);
  config.optimization = resolveOptimizationConfig(config);

  // V6: Resolve bestPromptPolicy with defaults
  if (!config.bestPromptPolicy) {
    config.bestPromptPolicy = {
      promptSpecMode: "advisory",
      requireHoldoutForAccepted: true,
    };
  } else {
    if (!config.bestPromptPolicy.promptSpecMode) {
      config.bestPromptPolicy.promptSpecMode = "advisory";
    }
    if (config.bestPromptPolicy.requireHoldoutForAccepted === undefined) {
      config.bestPromptPolicy.requireHoldoutForAccepted = true;
    }
  }

  // Step 3: Numeric validation for evaluation policy (reused from loadProjectMeta)
  const evaluationPolicy = buildEvaluationPolicy(config);

  const rawTests = await readJsonl<unknown>(testsPath);
  const tests: TestCase[] = rawTests.map((t) => TestCaseSchema.parse(t));

  // Step 4: Holdout loading with strict whitelist
  const holdoutTestsPath = join(
    projectDir,
    config.holdoutTestsPath ?? "holdout-tests.jsonl"
  );

  let holdoutTests: TestCase[] = [];
  try {
    const info = await stat(holdoutTestsPath);
    if (info.isFile()) {
      const rawHoldoutTests = await readJsonl<unknown>(holdoutTestsPath);
      holdoutTests = rawHoldoutTests.map((t) => TestCaseSchema.parse(t));
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      holdoutTests = [];
    } else {
      throw error;
    }
  }

  // Step 5: Return the new fields
  return {
    projectDir,
    prompt,
    goal,
    tests,
    holdoutTests,
    config,
    evaluationPolicy,
  };
}
