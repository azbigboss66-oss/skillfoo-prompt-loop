/**
 * buildPromptfooConfig 单元测试
 *
 * 验收门槛：覆盖以下 5 种情况
 * 1. 正常映射
 * 2. 空测试
 * 3. 密钥泄露
 * 4. system/user 顺序
 * 5. optimize 不含 holdout
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptfooConfig,
  ConfigSecurityError,
  type PromptfooConfigInput,
} from "../promptfoo/buildPromptfooConfig.js";
import type { TestCase } from "../types.js";
import type { ProviderConfig } from "../promptfoo/types.js";

function makeTest(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "t001",
    category: "normal",
    userInput: "你好",
    expectedBehavior: "礼貌回复",
    rubric: "回答应礼貌、清楚",
    weight: 1,
    ...overrides,
  };
}

const mockProvider: ProviderConfig = {
  type: "mock",
};

const deepseekProvider: ProviderConfig = {
  type: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  model: "deepseek-chat",
};

function makeInput(
  overrides: Partial<PromptfooConfigInput> = {}
): PromptfooConfigInput {
  return {
    prompt: "你是一个客服助手。请回答用户的问题。",
    tests: [makeTest()],
    targetProvider: mockProvider,
    mode: "baseline",
    maxConcurrency: 2,
    cache: true,
    ...overrides,
  };
}

describe("buildPromptfooConfig", () => {
  it("1. normal mapping: valid config produces correct Promptfoo format", () => {
    const input = makeInput({ targetProvider: deepseekProvider });
    const config = buildPromptfooConfig(input);

    assert.equal(config.description, "SkillFoo V5 baseline eval");

    const prompts = config.prompts as Array<{ raw: string; label: string }>;
    assert.ok(Array.isArray(prompts));
    assert.ok(prompts.length > 0);
    assert.equal(prompts[0].label, "skillfoo-system-user");
    assert.deepEqual(JSON.parse(prompts[0].raw), [
      { role: "system", content: input.prompt },
      { role: "user", content: "{{userInput}}" },
    ]);

    const providers = config.providers as unknown[];
    assert.ok(Array.isArray(providers));
    assert.ok(providers.length > 0);

    const tests = config.tests as Array<{
      vars: { userInput: string };
      assert: unknown[];
      weight: number;
    }>;
    assert.ok(Array.isArray(tests));
    assert.equal(tests.length, 1);
    assert.equal(tests[0].vars.userInput, "你好");
    assert.equal(tests[0].weight, 1);
    assert.ok(tests[0].assert.length > 0);

    const evalOptions = config.evaluateOptions as {
      maxConcurrency: number;
      useCache: boolean;
    };
    assert.equal(evalOptions.maxConcurrency, 2);
    assert.equal(evalOptions.useCache, true);
  });

  it("2. empty tests: should throw ConfigSecurityError for non-optimize mode", () => {
    const input = makeInput({ tests: [], mode: "baseline" });
    assert.throws(
      () => buildPromptfooConfig(input),
      (err: Error) =>
        err instanceof ConfigSecurityError &&
        /tests must not be empty/.test(err.message)
    );
  });

  it("3. API key leakage: should throw ConfigSecurityError when apiKeyEnv contains actual key", () => {
    const input = makeInput({
      targetProvider: {
        type: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: ["sk", "testonly12345678901234567890"].join("-"),
        model: "deepseek-chat",
      },
    });
    assert.throws(
      () => buildPromptfooConfig(input),
      (err: Error) =>
        err instanceof ConfigSecurityError &&
        /apiKeyEnv appears to contain an actual API key/.test(err.message)
    );
  });

  it("4. system/user order: system prompt must come before user message", () => {
    const input = makeInput();
    const config = buildPromptfooConfig(input);
    const prompts = config.prompts as Array<{ raw: string; label: string }>;
    const messages = JSON.parse(prompts[0].raw) as Array<{
      role: string;
      content: string;
    }>;

    assert.ok(Array.isArray(messages));
    assert.ok(messages.length >= 2);

    assert.equal(messages[0].role, "system");
    assert.equal(messages[0].content, input.prompt);

    assert.equal(messages[1].role, "user");
    assert.equal(messages[1].content, "{{userInput}}");
  });

  it("5. optimize mode: holdout tests must not be included", () => {
    const holdoutTest = makeTest({ id: "holdout-001" });
    (
      holdoutTest as TestCase & { isHoldout?: boolean }
    ).isHoldout = true;

    const input = makeInput({
      tests: [holdoutTest],
      mode: "optimize",
      validationSplit: 0.2,
    });

    assert.throws(
      () => buildPromptfooConfig(input),
      (err: Error) =>
        err instanceof ConfigSecurityError &&
        /holdout tests must not be included in optimize mode/.test(
          err.message
        )
    );
  });

  it("provider config: openai-compatible passes the API-key environment variable name", () => {
    const input = makeInput({ targetProvider: deepseekProvider });
    const config = buildPromptfooConfig(input);
    const providers = config.providers as Array<{
      id: string;
      config: { apiKey?: string; apiKeyEnvar?: string };
    }>;

    assert.equal(providers[0].id, "openai:chat:deepseek-chat");
    assert.equal(providers[0].config.apiKeyEnvar, "DEEPSEEK_API_KEY");
    assert.equal(
      providers[0].config.apiKey,
      undefined,
      "Promptfoo must resolve the secret through apiKeyEnvar, not send a literal template string.",
    );
  });

  it("unsupported provider type fails instead of creating an implicit fallback", () => {
    assert.throws(
      () => buildPromptfooConfig(makeInput({
        targetProvider: { type: "unsupported-provider", model: "x" },
      })),
      /Unsupported provider type/,
    );
  });

  it("validationSplit out of range: should throw ConfigSecurityError", () => {
    const input = makeInput({ validationSplit: 0.8 });
    assert.throws(
      () => buildPromptfooConfig(input),
      (err: Error) =>
        err instanceof ConfigSecurityError &&
        /validationSplit/.test(err.message)
    );
  });
});
