/**
 * Promptfoo generate dataset 适配器
 *
 * 使用 child_process.spawn 调用 `npx promptfoo generate dataset` 生成测试用例，
 * 将原始输出归一化为 SkillFoo TestCase 格式，并执行确定性审查。
 *
 * 职责：
 * 1. 使用 spawn 调用 promptfoo CLI（命令参数使用数组传入，禁止字符串拼接）
 * 2. 保存原始输出到 run 目录
 * 3. 解析输出并归一化为 TestCase
 * 4. 执行 auditGeneratedTests 审查
 * 5. 生成失败时抛出 TestGenerationBlockedError（code = blocked_by_test_generation）
 *
 * 官方文档：
 * - generate dataset: https://www.promptfoo.dev/docs/usage/command-line/
 * - Node package: https://www.promptfoo.dev/docs/usage/node-package/
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestCase, TestAuditSummary } from "../types.js";
import { normalizeGeneratedPromptfooTests } from "./normalizeGeneratedTests.js";
import {
  auditGeneratedTests,
  type TestAuditOptions,
} from "../testgen/auditTests.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type GeneratedTestSource =
  | "manual"
  | "promptfoo-dataset"
  | "promptfoo-redteam"
  | "legacy";

export interface GeneratedTestRun {
  source: GeneratedTestSource;
  candidatePath: string;
  rawOutputPath: string;
  tests: TestCase[];
  audit: TestAuditSummary;
}

export interface PromptfooTestGenerationOptions {
  projectDir: string;
  runDir: string;
  promptPath: string;
  goalPath: string;
  outputPath: string;
  count: number;
  language: string;
  maxConcurrency: number;
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * 测试生成被阻断错误。
 *
 * 当 promptfoo 生成命令失败、输出无法解析或测试质量未达最低线时抛出。
 * code 字段固定为 "blocked_by_test_generation"，调用方可据此判断是否停止自动 loop。
 */
export class TestGenerationBlockedError extends Error {
  readonly code = "blocked_by_test_generation" as const;

  constructor(message: string) {
    super(message);
    this.name = "TestGenerationBlockedError";
  }
}

// ---------------------------------------------------------------------------
// 命令执行器（可注入，便于测试）
// ---------------------------------------------------------------------------

export interface CommandRunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  args: string[],
  cwd: string
) => Promise<CommandRunnerResult>;

/**
 * 默认命令执行器：使用 child_process.spawn 调用 npx promptfoo。
 *
 * 命令参数通过数组传入，不使用字符串拼接。
 * 在 Windows 上 shell: true 确保 npx 可被正确解析为 npx.cmd。
 */
export const defaultCommandRunner: CommandRunner = (args, cwd) => {
  return new Promise<CommandRunnerResult>((resolve, reject) => {
    const child = spawn("npx", ["promptfoo", ...args], {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (err: Error) => {
      reject(err);
    });

    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
};

// ---------------------------------------------------------------------------
// 共享工具
// ---------------------------------------------------------------------------

/**
 * 默认审查选项（宽松，仅确保基本结构有效）。
 * 调用方可在 loop 层使用更严格的选项重新审查。
 */
const DEFAULT_AUDIT_OPTIONS: TestAuditOptions = {
  minTotal: 1,
  minQualityScore: 0,
  maxDuplicateRatio: 1.0,
  minHighRiskRatio: 0,
  requiredCategories: [],
  minCategoryCounts: {},
};

/**
 * 解析 promptfoo 生成的输出为原始测试数组。
 *
 * 支持以下格式：
 * 1. 纯 JSON 数组
 * 2. { tests: [...] }
 * 3. { data: [...] }
 * 4. { cases: [...] }
 */
export function parseGeneratedOutput(output: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new TestGenerationBlockedError(
      `Failed to parse promptfoo output as JSON. Output: ${output.slice(0, 500)}`
    );
  }

  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.tests)) return obj.tests;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.cases)) return obj.cases;
  }

  throw new TestGenerationBlockedError(
    `Promptfoo output is not a JSON array or object with tests array. Output: ${output.slice(0, 500)}`
  );
}

/**
 * 处理 promptfoo 生成命令的结果，归一化并审查测试。
 *
 * 共享给 generateDataset 和 generateRedteam 使用。
 *
 * 步骤：
 * 1. 检查退出码（非 0 则阻断）
 * 2. 保存原始输出
 * 3. 解析输出（优先 stdout，其次读取 outputPath 文件）
 * 4. 归一化为 TestCase
 * 5. 执行审查
 * 6. 保存候选测试
 */
export async function processGenerationResult(
  stdout: string,
  stderr: string,
  exitCode: number,
  source: GeneratedTestSource,
  runDir: string,
  outputPath: string,
  rawOutputFileName: string
): Promise<GeneratedTestRun> {
  // 1. 检查退出码
  if (exitCode !== 0) {
    throw new TestGenerationBlockedError(
      `promptfoo command exited with code ${exitCode}. stderr: ${stderr.slice(0, 500)}`
    );
  }

  // 2. 保存原始输出
  const promptfooDir = join(runDir, "promptfoo");
  await mkdir(promptfooDir, { recursive: true });
  const rawOutputPath = join(promptfooDir, rawOutputFileName);
  await writeFile(rawOutputPath, stdout, "utf-8");

  // 3. 解析输出（优先 stdout，其次读取 outputPath 文件）
  let rawTests: unknown[];
  try {
    rawTests = parseGeneratedOutput(stdout);
  } catch {
    // stdout 不是有效 JSON，尝试读取输出文件
    try {
      const fileContent = await readFile(outputPath, "utf-8");
      rawTests = parseGeneratedOutput(fileContent);
    } catch (fileErr) {
      throw new TestGenerationBlockedError(
        `Failed to parse promptfoo output from both stdout and output file: ${
          fileErr instanceof Error ? fileErr.message : String(fileErr)
        }`
      );
    }
  }

  // 4. 归一化
  const tests = normalizeGeneratedPromptfooTests(rawTests, source);

  if (tests.length === 0) {
    throw new TestGenerationBlockedError(
      `promptfoo ${source} produced no tests.`
    );
  }

  // 5. 审查
  const audit = auditGeneratedTests(tests, DEFAULT_AUDIT_OPTIONS);

  // 6. 保存候选测试
  const candidateDir = join(runDir, "testgen");
  await mkdir(candidateDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(tests, null, 2), "utf-8");

  return {
    source,
    candidatePath: outputPath,
    rawOutputPath,
    tests,
    audit,
  };
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 构建 promptfoo generate dataset 的命令参数数组。
 */
function buildDatasetArgs(options: PromptfooTestGenerationOptions): string[] {
  return [
    "generate",
    "dataset",
    "--prompt",
    options.promptPath,
    "--output",
    options.outputPath,
    "--num-tests",
    String(options.count),
    "--language",
    options.language,
  ];
}

/**
 * 使用 Promptfoo generate dataset 生成测试用例。
 *
 * 调用 `npx promptfoo generate dataset`，将输出归一化为 SkillFoo TestCase，
 * 执行确定性审查，并保存所有中间产物。
 *
 * 生成失败（命令退出码非 0、输出无法解析、未生成任何测试）时
 * 抛出 TestGenerationBlockedError，阻止自动 loop 继续。
 *
 * @param options - 生成选项
 * @param runner - 可选的命令执行器（用于测试注入 mock）
 * @returns 生成结果，包含测试用例、审查摘要和文件路径
 */
export async function generatePromptfooDataset(
  options: PromptfooTestGenerationOptions,
  runner: CommandRunner = defaultCommandRunner
): Promise<GeneratedTestRun> {
  const { projectDir, runDir, outputPath } = options;

  const args = buildDatasetArgs(options);

  let result: CommandRunnerResult;
  try {
    result = await runner(args, projectDir);
  } catch (err) {
    throw new TestGenerationBlockedError(
      `Failed to execute promptfoo generate dataset: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return processGenerationResult(
    result.stdout,
    result.stderr,
    result.exitCode,
    "promptfoo-dataset",
    runDir,
    outputPath,
    "generate-dataset-raw-output.json"
  );
}
