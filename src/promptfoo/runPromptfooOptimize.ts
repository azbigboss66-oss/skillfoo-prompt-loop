/**
 * Promptfoo optimize 适配器
 *
 * 使用 Node child_process.spawn 调用 `npx promptfoo optimize` 命令，
 * 生成优化后的 Prompt 候选，并保存所有中间产物。
 *
 * 职责：
 * 1. 使用 spawn 调用 npx promptfoo optimize（参数以数组传入，禁止字符串拼接）
 * 2. 保存原始 stdout/stderr、命令记录、优化配置
 * 3. 解析优化输出，提取优化后的 Prompt
 * 4. 无法解析时抛出 blocked_by_optimize_output 错误
 *
 * 安全：
 * - 命令参数必须使用数组传入，禁止字符串拼接执行未经校验的命令
 * - command.txt 保存完整命令参数，但不保存 API key
 * - API key 只能通过环境变量引用
 *
 * 官方文档：
 * - Prompt optimization: https://www.promptfoo.dev/docs/usage/prompt-optimization/
 * - Command line: https://www.promptfoo.dev/docs/usage/command-line/
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseOptimizeOutput } from "./parseOptimizeOutput.js";

/**
 * Promptfoo optimize 选项
 */
export interface PromptfooOptimizeOptions {
  /** 运行目录（优化产物保存位置） */
  runDir: string;
  /** Promptfoo 配置文件路径 */
  configPath: string;
  /** 优化的 Prompt 索引（零基） */
  promptIndex: number;
  /** 优化的 Provider 索引（零基） */
  providerIndex: number;
  /** 验证集分割比例（0-0.5） */
  validationSplit: number;
  /** 最大并发数（通过配置文件传递，非 CLI 参数） */
  maxConcurrency: number;
  /**
   * @internal 仅用于测试：覆盖 spawn 执行函数。
   * 生产代码不传此参数，使用真实 spawn。
   */
  _spawnFn?: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Promptfoo optimize 返回结果
 */
export interface PromptfooOptimizeResult {
  /** 优化后的 Prompt 文本 */
  optimizedPrompt: string;
  /** 原始 stdout 文件路径 */
  rawStdoutPath: string;
  /** 原始 stderr 文件路径 */
  rawStderrPath: string;
  /** 优化配置文件路径 */
  optimizeConfigPath: string;
  /** Eval ID（如果 Promptfoo 输出中包含） */
  evalId?: string;
  /** 优化引擎标识 */
  engine: "promptfoo";
}

/**
 * spawn 执行结果
 */
interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * 构建 optimize 命令参数数组。
 *
 * 根据当前安装版本实际支持的参数构建：
 * - promptfoo optimize -c <config> --prompt-index <n> --provider-index <n> --validation-split <fraction>
 *
 * 注意：promptfoo optimize 不支持 --max-concurrency CLI 参数。
 * maxConcurrency 通过配置文件的 evaluateOptions 传递。
 *
 * @param options - 优化选项
 * @returns 命令参数数组（不包含 npx 前缀）
 */
export function buildOptimizeArgs(options: PromptfooOptimizeOptions): string[] {
  return [
    "promptfoo",
    "optimize",
    "-c",
    options.configPath,
    "--prompt-index",
    String(options.promptIndex),
    "--provider-index",
    String(options.providerIndex),
    "--validation-split",
    String(options.validationSplit),
  ];
}

/**
 * 使用 child_process.spawn 执行命令。
 *
 * @param command - 命令（如 "npx"）
 * @param args - 参数数组
 * @returns 执行结果（stdout, stderr, exitCode）
 */
function runSpawn(
  command: string,
  args: string[]
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      shell: true, // Windows 上 npx 需要 shell
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code: number | null) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
      });
    });

    child.on("error", (err: Error) => {
      reject(err);
    });
  });
}

/**
 * 对文本进行 API key 脱敏。
 * 将可能的 API key 值替换为 [REDACTED]。
 */
function redactApiKeys(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "sk-[REDACTED]")
    .replace(
      /(api[_-]?key|apiKey|API_KEY|secret|token|password)\s*[:=]\s*[^\s,}"']+/gi,
      "$1=[REDACTED]"
    );
}

/**
 * 尝试从 stdout/stderr 中提取 evalId。
 * Promptfoo 可能在输出中包含 eval ID。
 */
function extractEvalId(stdout: string, stderr: string): string | undefined {
  const combined = stdout + "\n" + stderr;

  // 匹配 "evalId: xxx" 或 "Eval ID: xxx" 或 "eval id: xxx" 等模式
  const patterns: RegExp[] = [
    /(?:evalId|eval[_\s-]?id)\s*[:：]\s*([a-zA-Z0-9_-]+)/i,
    /(?:evaluation\s+id)\s*[:：]\s*([a-zA-Z0-9_-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return undefined;
}

/**
 * 运行 Promptfoo optimize。
 *
 * 使用 child_process.spawn 调用 `npx promptfoo optimize`，
 * 保存所有中间产物，并返回解析后的优化 Prompt。
 *
 * 产物保存位置：
 * - `<runDir>/promptfoo/optimize-stdout.txt` - 原始标准输出
 * - `<runDir>/promptfoo/optimize-stderr.txt` - 原始标准错误
 * - `<runDir>/promptfoo/command.txt` - 命令参数记录（不含 API key）
 * - `<runDir>/promptfoo/optimize-config.json` - 优化配置
 *
 * @param options - 优化选项
 * @returns 优化结果
 * @throws 当 optimize 输出无法解析时抛出 Error（包含 blocked_by_optimize_output）
 */
export async function runPromptfooOptimize(
  options: PromptfooOptimizeOptions
): Promise<PromptfooOptimizeResult> {
  // 1. 创建输出目录
  const promptfooDir = join(options.runDir, "promptfoo");
  await mkdir(promptfooDir, { recursive: true });

  // 2. 构建命令参数数组（禁止字符串拼接）
  const args = buildOptimizeArgs(options);

  // 3. 执行命令（使用注入的 spawn 函数或真实 spawn）
  const spawnFn = options._spawnFn ?? runSpawn;
  const { stdout, stderr, exitCode } = await spawnFn("npx", args);

  // 4. 保存原始 stdout 和 stderr
  const rawStdoutPath = join(promptfooDir, "optimize-stdout.txt");
  const rawStderrPath = join(promptfooDir, "optimize-stderr.txt");
  await writeFile(rawStdoutPath, stdout, "utf-8");
  await writeFile(rawStderrPath, stderr, "utf-8");

  // 5. 保存命令参数记录（脱敏 API key）
  const commandPath = join(promptfooDir, "command.txt");
  const sanitizedArgs = args.map(redactApiKeys);
  const commandLines = [
    "SkillFoo V5 Promptfoo Optimize (CLI)",
    "======================================",
    `Command: npx ${sanitizedArgs.join(" ")}`,
    `Config Path: ${options.configPath}`,
    `Prompt Index: ${options.promptIndex}`,
    `Provider Index: ${options.providerIndex}`,
    `Validation Split: ${options.validationSplit}`,
    `Max Concurrency: ${options.maxConcurrency} (configured via config file, not CLI flag)`,
    `Exit Code: ${exitCode}`,
    `Timestamp: ${new Date().toISOString()}`,
    "",
    "Security: API keys are referenced via environment variables only.",
    "No API key values are stored in this file.",
  ];
  await writeFile(commandPath, commandLines.join("\n") + "\n", "utf-8");

  // 6. 保存优化配置
  const optimizeConfigPath = join(promptfooDir, "optimize-config.json");
  const optimizeConfig = {
    configPath: options.configPath,
    promptIndex: options.promptIndex,
    providerIndex: options.providerIndex,
    validationSplit: options.validationSplit,
    maxConcurrency: options.maxConcurrency,
    engine: "promptfoo" as const,
    exitCode,
    timestamp: new Date().toISOString(),
  };
  await writeFile(
    optimizeConfigPath,
    JSON.stringify(optimizeConfig, null, 2),
    "utf-8"
  );

  // 7. 解析优化输出
  const parsed = parseOptimizeOutput(stdout, stderr);

  if (parsed.blocked || !parsed.optimizedPrompt) {
    throw new Error(
      parsed.blockReason ??
        "blocked_by_optimize_output: could not extract optimized prompt from promptfoo optimize output"
    );
  }

  // 8. 尝试提取 evalId
  const evalId = extractEvalId(stdout, stderr);

  // 9. 返回结果
  return {
    optimizedPrompt: parsed.optimizedPrompt,
    rawStdoutPath,
    rawStderrPath,
    optimizeConfigPath,
    evalId,
    engine: "promptfoo",
  };
}
