/**
 * Promptfoo 配置生成适配层
 *
 * 将 SkillFoo 项目配置映射为 Promptfoo promptfooconfig.yaml 格式。
 *
 * 固定映射：
 * | SkillFoo | Promptfoo |
 * |---|---|
 * | prompt.md (system) | prompts[].messages[system] |
 * | tests.jsonl.userInput (user) | tests[].vars.userInput → prompts[].messages[user] |
 * | expectedBehavior + rubric | llm-rubric assertion |
 * | weight | test weight |
 * | target provider | providers |
 * | grader provider | grader provider |
 *
 * 官方文档：
 * - Configuration: https://www.promptfoo.dev/docs/configuration/
 * - Providers: https://www.promptfoo.dev/docs/providers/
 * - Assertions: https://www.promptfoo.dev/docs/configuration/expected-outputs/
 */

import type { TestCase } from "../types.js";
import type { PromptfooRunMode, ProviderConfig } from "./types.js";

/**
 * 配置生成输入
 */
export interface PromptfooConfigInput {
  prompt: string;
  tests: TestCase[];
  targetProvider: ProviderConfig;
  graderProvider?: ProviderConfig;
  mode: PromptfooRunMode;
  validationSplit?: number;
  maxConcurrency: number;
  cache: boolean;
}

/**
 * 配置安全检查错误
 */
export class ConfigSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigSecurityError";
  }
}

// Patterns that look like actual API keys, not env var names
const API_KEY_VALUE_PATTERNS: RegExp[] = [
  /^sk-[a-zA-Z0-9]{20,}$/,
  /^[a-f0-9]{32}$/i,
  /^[a-zA-Z0-9]{40,}$/,
];

/**
 * Check if a string looks like an actual API key value rather than an env var name.
 */
function looksLikeApiKeyValue(value: string): boolean {
  return API_KEY_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Validate provider config for security.
 */
function validateProvider(provider: ProviderConfig, label: string): void {
  if (!provider || !provider.type) {
    throw new ConfigSecurityError(`${label}: provider type is required`);
  }

  if (provider.apiKeyEnv) {
    if (looksLikeApiKeyValue(provider.apiKeyEnv)) {
      throw new ConfigSecurityError(
        `${label}: apiKeyEnv appears to contain an actual API key value, not an environment variable name. Use the env var name (e.g., DEEPSEEK_API_KEY), not the key itself.`
      );
    }
  }

  if (provider.baseUrl) {
    if (provider.baseUrl.includes("@")) {
      throw new ConfigSecurityError(
        `${label}: baseUrl must not contain embedded credentials`
      );
    }
  }
}

/**
 * Validate the full config input for security and correctness.
 */
export function validateConfigInput(input: PromptfooConfigInput): void {
  if (!input.targetProvider) {
    throw new ConfigSecurityError("targetProvider is required");
  }
  validateProvider(input.targetProvider, "targetProvider");

  if (input.graderProvider) {
    validateProvider(input.graderProvider, "graderProvider");
  }

  if (input.mode !== "optimize" && (!input.tests || input.tests.length === 0)) {
    throw new ConfigSecurityError(
      "tests must not be empty for non-optimize modes"
    );
  }

  if (input.validationSplit !== undefined) {
    if (input.validationSplit < 0 || input.validationSplit > 0.5) {
      throw new ConfigSecurityError(
        `validationSplit must be between 0 and 0.5, got ${input.validationSplit}`
      );
    }
  }

  if (!input.prompt || input.prompt.trim().length === 0) {
    throw new ConfigSecurityError("prompt must not be empty");
  }

  if (input.mode === "optimize") {
    for (const test of input.tests) {
      if ((test as TestCase & { isHoldout?: boolean }).isHoldout) {
        throw new ConfigSecurityError(
          "holdout tests must not be included in optimize mode configuration"
        );
      }
    }
  }
}

/**
 * Build Promptfoo provider configuration from SkillFoo ProviderConfig.
 */
function buildProviderConfig(
  provider: ProviderConfig
): Record<string, unknown> {
  if (provider.type === "mock") {
    return {
      id: "echo",
      label: "mock-provider",
    };
  }

  if (provider.type === "openai-compatible") {
    const config: Record<string, unknown> = {
      model: provider.model ?? "default",
    };

    if (provider.baseUrl) {
      config.apiBaseUrl = provider.baseUrl;
    }

    const envVar = provider.apiKeyEnv ?? "OPENAI_API_KEY";
    // Promptfoo resolves a custom secret name through apiKeyEnvar. A
    // {{ENV_VAR}} template here is not interpolated by the Node evaluate API
    // and is sent to the provider literally, which causes authentication 401s.
    config.apiKeyEnvar = envVar;

    return {
      // Promptfoo resolves OpenAI-compatible endpoints through its built-in
      // openai:chat provider; "openai-compatible" is not a registered id.
      id: `openai:chat:${provider.model ?? "default"}`,
      label: provider.model ?? "target-model",
      config,
    };
  }

  throw new ConfigSecurityError(
    `Unsupported provider type: ${provider.type}. This release supports mock and openai-compatible only.`,
  );
}

/**
 * Build Promptfoo tests configuration.
 *
 * Each test maps to a Promptfoo test with:
 * - vars.userInput: the user's input text
 * - assert: llm-rubric assertion based on the test's rubric
 * - weight: the test's weight
 */
function buildTestsConfig(tests: TestCase[]): unknown[] {
  return tests.map((test) => ({
    vars: {
      userInput: test.userInput,
    },
    assert: [
      {
        type: "llm-rubric",
        value: test.rubric,
      },
    ],
    weight: test.weight,
  }));
}

/**
 * Build a complete Promptfoo configuration object from SkillFoo project inputs.
 *
 * This function:
 * 1. Validates the input for security (no API keys in config)
 * 2. Maps SkillFoo prompt to Promptfoo prompts (preserving system/user message order)
 * 3. Maps SkillFoo tests to Promptfoo tests with llm-rubric assertions
 * 4. Maps SkillFoo providers to Promptfoo provider configs
 * 5. Sets runtime options (concurrency, cache)
 *
 * @returns Promptfoo configuration as a plain object (can be serialized to YAML)
 */
export function buildPromptfooConfig(
  input: PromptfooConfigInput
): Record<string, unknown> {
  validateConfigInput(input);

  const config: Record<string, unknown> = {
    description: `SkillFoo V5 ${input.mode} eval`,
  };

  // Promptfoo's Node API expects Prompt objects here. The raw value is a JSON
  // chat prompt so its OpenAI-compatible provider preserves system/user roles.
  // The user input is inserted by Promptfoo after test vars are bound.
  config.prompts = [
    {
      label: "skillfoo-system-user",
      raw: JSON.stringify([
        { role: "system", content: input.prompt },
        { role: "user", content: "{{userInput}}" },
      ]),
    },
  ];

  // Providers
  config.providers = [buildProviderConfig(input.targetProvider)];

  // Tests
  config.tests = buildTestsConfig(input.tests);

  // Grader provider (if configured)
  if (input.graderProvider) {
    config.grader = buildProviderConfig(input.graderProvider);
  }

  // Runtime options
  config.evaluateOptions = {
    maxConcurrency: input.maxConcurrency,
    useCache: input.cache,
  };

  // Validation split for optimize mode
  if (input.validationSplit !== undefined && input.mode === "optimize") {
    config.optimize = {
      validationSplit: input.validationSplit,
    };
  }

  return config;
}
