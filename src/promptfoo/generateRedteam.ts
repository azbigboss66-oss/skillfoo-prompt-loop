/**
 * Promptfoo redteam generate 适配器
 *
 * 使用 child_process.spawn 调用 `npx promptfoo redteam generate` 生成对抗/安全测试用例，
 * 将原始输出归一化为 SkillFoo TestCase 格式，并执行确定性审查。
 *
 * 职责：
 * 1. 使用 spawn 调用 promptfoo CLI（命令参数使用数组传入）
 * 2. 保存原始输出到 run 目录
 * 3. 解析输出并归一化为 TestCase
 * 4. 执行 auditGeneratedTests 审查
 * 5. 生成失败时抛出 TestGenerationBlockedError（code = blocked_by_test_generation）
 *
 * 注意：redteam 题目只负责对抗、安全和越权测试，不能替代全部业务题。
 *
 * 官方文档：
 * - redteam generate: https://www.promptfoo.dev/docs/red-team/configuration/
 * - Command line: https://www.promptfoo.dev/docs/usage/command-line/
 */

import { readFile } from "node:fs/promises";
import {
  processGenerationResult,
  defaultCommandRunner,
  TestGenerationBlockedError,
  type CommandRunner,
  type GeneratedTestRun,
  type PromptfooTestGenerationOptions,
} from "./generateDataset.js";

/**
 * 构建 promptfoo redteam generate 的命令参数数组。
 *
 * redteam 命令需要 --purpose 描述应用目的（从 goal.md 提取）。
 */
function buildRedteamArgs(
  options: PromptfooTestGenerationOptions,
  goalContent: string
): string[] {
  return [
    "redteam",
    "generate",
    "--output",
    options.outputPath,
    "--num-tests",
    String(options.count),
    "--language",
    options.language,
    "--purpose",
    goalContent.slice(0, 2000),
  ];
}

/**
 * 使用 Promptfoo redteam generate 生成对抗/安全测试用例。
 *
 * 调用 `npx promptfoo redteam generate`，将输出归一化为 SkillFoo TestCase，
 * 执行确定性审查，并保存所有中间产物。
 *
 * 生成失败（命令退出码非 0、输出无法解析、未生成任何测试）时
 * 抛出 TestGenerationBlockedError，阻止自动 loop 继续。
 *
 * @param options - 生成选项
 * @param runner - 可选的命令执行器（用于测试注入 mock）
 * @returns 生成结果，包含测试用例、审查摘要和文件路径
 */
export async function generatePromptfooRedteam(
  options: PromptfooTestGenerationOptions,
  runner: CommandRunner = defaultCommandRunner
): Promise<GeneratedTestRun> {
  const { projectDir, runDir, outputPath, goalPath } = options;

  // 读取 goal.md 作为 redteam purpose
  let goalContent: string;
  try {
    goalContent = await readFile(goalPath, "utf-8");
  } catch {
    goalContent = "Generate redteam tests for safety and security evaluation.";
  }

  const args = buildRedteamArgs(options, goalContent);

  let result;
  try {
    result = await runner(args, projectDir);
  } catch (err) {
    throw new TestGenerationBlockedError(
      `Failed to execute promptfoo redteam generate: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  return processGenerationResult(
    result.stdout,
    result.stderr,
    result.exitCode,
    "promptfoo-redteam",
    runDir,
    outputPath,
    "generate-redteam-raw-output.json"
  );
}
