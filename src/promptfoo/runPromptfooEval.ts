/**
 * Promptfoo 评测适配器
 *
 * 使用 Promptfoo 公开 Node API (evaluate) 运行评测，
 * 将原始结果归一化为 SkillFoo 统一格式，并保存所有中间产物。
 *
 * 职责：
 * 1. 使用 buildPromptfooConfig 构建配置
 * 2. 调用 evaluate() 运行评测
 * 3. 保存原始结果、命令记录、provider 摘要、归一化结果
 * 4. 如果 graderProvider 未配置，回退 target provider 但设置 same_model_grader_warning
 *
 * 官方文档：
 * - Node package: https://www.promptfoo.dev/docs/usage/node-package/
 * - evaluate() API: https://www.promptfoo.dev/docs/usage/node-package/#evaluate
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { evaluate } from "promptfoo";
import {
  buildPromptfooConfig,
  type PromptfooConfigInput,
} from "./buildPromptfooConfig.js";
import {
  normalizePromptfooResults,
  type NormalizedPromptfooResult,
} from "./normalizePromptfooResults.js";
import type { TestCase } from "../types.js";
import type { ProviderConfig } from "./types.js";

const promptfooRequire = createRequire(import.meta.url);

async function readInstalledPromptfooVersion(): Promise<string> {
  try {
    const mainPath = promptfooRequire.resolve("promptfoo");
    const packagePath = join(dirname(mainPath), "..", "..", "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf-8")) as { version?: string };
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Promptfoo 评测选项
 */
export interface PromptfooEvalOptions {
  /** 运行目录（评测产物保存位置） */
  runDir: string;
  /** 可选的阶段目录；用于避免 baseline、candidate、holdout 产物互相覆盖。 */
  artifactDir?: string;
  /** 系统提示词 */
  prompt: string;
  /** 测试用例列表 */
  tests: TestCase[];
  /** 目标 provider（被评测的模型） */
  targetProvider: ProviderConfig;
  /** 评分 provider（可选，未配置时回退到 target provider） */
  graderProvider?: ProviderConfig;
  /** 最大并发数 */
  maxConcurrency: number;
  /** 是否启用缓存 */
  cache: boolean;
  /** 每条测试重复次数 */
  repeat: number;
}

/**
 * 评测返回结果
 */
export interface PromptfooEvalReturn {
  results: NormalizedPromptfooResult[];
  rawResultPath: string;
  evalId?: string;
}

/**
 * 安全序列化对象为 JSON 字符串，处理循环引用。
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(
    obj,
    (_key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    },
    2
  );
}

/**
 * 运行 Promptfoo 评测。
 *
 * 使用 Promptfoo 公开 Node API (evaluate) 运行评测，保存所有中间产物，
 * 并返回归一化后的结果。
 *
 * 产物保存位置：
 * - `<runDir>/promptfoo/raw-results.json` - 原始评测结果
 * - `<runDir>/promptfoo/command.txt` - 命令记录
 * - `<runDir>/promptfoo/provider-summary.json` - provider 摘要
 * - `<runDir>/promptfoo/normalized-results.jsonl` - 归一化结果
 *
 * @param options - 评测选项
 * @returns 归一化结果、原始结果路径、evalId
 */
export async function runPromptfooEval(
  options: PromptfooEvalOptions
): Promise<PromptfooEvalReturn> {
  // 1. 确定 grader provider（未配置时回退到 target provider）
  const graderProvider = options.graderProvider ?? options.targetProvider;
  const graderFallback = !options.graderProvider;
  const sameModelGraderWarning = graderFallback
    ? "same_model_grader_warning: graderProvider is not configured; falling back to target provider for grading. This may introduce self-grading bias."
    : null;

  // 2. 使用 buildPromptfooConfig 构建配置
  const configInput: PromptfooConfigInput = {
    prompt: options.prompt,
    tests: options.tests,
    targetProvider: options.targetProvider,
    graderProvider,
    mode: "baseline",
    maxConcurrency: options.maxConcurrency,
    cache: options.cache,
  };

  const config = buildPromptfooConfig(configInput);

  // 3. 为每个测试添加 testId 到 vars，便于后续归一化提取
  const configTests = config.tests as Array<{
    vars: Record<string, string>;
  }>;
  options.tests.forEach((test, index) => {
    if (configTests[index]) {
      configTests[index].vars.testId = test.id;
    }
  });

  // 4. 提取 grader 配置，设置到 defaultTest.options.provider
  const graderConfig = config.grader;
  // 移除非 evaluate() 标准字段
  delete (config as Record<string, unknown>).evaluateOptions;
  delete (config as Record<string, unknown>).grader;
  delete (config as Record<string, unknown>).description;

  // 5. 构造 EvaluateTestSuite
  const testSuite: Record<string, unknown> = {
    prompts: config.prompts,
    providers: config.providers,
    tests: config.tests,
    writeLatestResults: false,
  };

  if (graderConfig) {
    testSuite.defaultTest = {
      options: {
        provider: graderConfig,
      },
    };
  }

  // 6. 构造 EvaluateOptions
  const evalOptions: Record<string, unknown> = {
    maxConcurrency: options.maxConcurrency,
    cache: options.cache,
    repeat: options.repeat,
    showProgressBar: false,
    generateSuggestions: false,
  };

  // 7. 调用 evaluate() 运行评测
  const evalResult = await evaluate(
    testSuite as Parameters<typeof evaluate>[0],
    evalOptions as Parameters<typeof evaluate>[1]
  );

  // 8. 创建 promptfoo 输出目录
  const promptfooDir = options.artifactDir ?? join(options.runDir, "promptfoo");
  await mkdir(promptfooDir, { recursive: true });

  // 9. 保存原始结果
  const rawResultPath = join(promptfooDir, "raw-results.json");
  const rawResultsJson = safeStringify(evalResult);
  await writeFile(rawResultPath, rawResultsJson, "utf-8");

  // 10. 保存命令记录
  const commandPath = join(promptfooDir, "command.txt");
  const commandLines = [
    "SkillFoo V5 Promptfoo Eval (Node API)",
    "=====================================",
    `API: evaluate()`,
    `Target Provider: ${options.targetProvider.type}` +
      (options.targetProvider.model ? ` (${options.targetProvider.model})` : ""),
    `Grader Provider: ${graderProvider.type}` +
      (graderProvider.model ? ` (${graderProvider.model})` : ""),
    ...(graderFallback
      ? [`Warning: ${sameModelGraderWarning}`]
      : []),
    `Max Concurrency: ${options.maxConcurrency}`,
    `Cache: ${options.cache}`,
    `Repeat: ${options.repeat}`,
    `Tests: ${options.tests.length}`,
    `Timestamp: ${new Date().toISOString()}`,
  ];
  await writeFile(commandPath, commandLines.join("\n") + "\n", "utf-8");

  // 11. 保存 provider 摘要
  const providerSummaryPath = join(promptfooDir, "provider-summary.json");
  const providerSummary = {
    target: {
      provider: options.targetProvider.type,
      model: options.targetProvider.model,
    },
    grader: {
      provider: graderProvider.type,
      model: graderProvider.model,
    },
    testGenerator: {
      source: "manual-or-skillfoo",
      model: undefined,
    },
    // Keep the explicit config names for older report readers.
    targetProvider: options.targetProvider,
    graderProvider,
    graderFallback,
    sameModelGraderWarning,
    evalId: evalResult.id,
    timestamp: new Date().toISOString(),
  };
  await writeFile(
    providerSummaryPath,
    JSON.stringify(providerSummary, null, 2),
    "utf-8"
  );

  await writeFile(
    join(promptfooDir, "version.txt"),
    `${await readInstalledPromptfooVersion()}\n`,
    "utf-8",
  );

  // 12. 归一化结果
  const normalizedResults = normalizePromptfooResults(evalResult);

  // 13. 保存归一化结果为 JSONL
  const normalizedPath = join(promptfooDir, "normalized-results.jsonl");
  const jsonlContent =
    normalizedResults.map((r) => JSON.stringify(r)).join("\n") +
    (normalizedResults.length > 0 ? "\n" : "");
  await writeFile(normalizedPath, jsonlContent, "utf-8");

  // 14. 返回结果
  return {
    results: normalizedResults,
    rawResultPath,
    evalId: evalResult.id,
  };
}
