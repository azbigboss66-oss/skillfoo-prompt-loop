/**
 * Promptfoo 运行可靠性选项
 *
 * 解析 CLI 运行参数（并发、重复、缓存、断点恢复、错误重试），
 * 构建 evaluate() 可用的配置对象。
 *
 * 默认值：
 * - maxConcurrency = 2（禁止默认无限并发）
 * - repeat = 1
 * - cache = true
 * - resume = false
 * - retryErrors = false
 *
 * 官方文档：
 * - Node package evaluate() options: https://www.promptfoo.dev/docs/usage/node-package/#evaluate
 * - Command line: https://www.promptfoo.dev/docs/usage/command-line/
 */

/**
 * Promptfoo 运行可靠性选项。
 */
export interface PromptfooRuntimeOptions {
  /** 最大并发数（正整数，默认 2） */
  maxConcurrency: number;
  /** 每条测试重复次数（正整数，默认 1） */
  repeat: number;
  /** 是否启用缓存（默认 true） */
  cache: boolean;
  /** 是否断点恢复（默认 false） */
  resume: boolean;
  /** 是否重试错误项（默认 false） */
  retryErrors: boolean;
}

/**
 * CLI 参数输入接口。
 *
 * maxConcurrency 和 repeat 以字符串传入（来自 CLI），
 * cache/noCache 为布尔标志，resume/retryErrors 为布尔标志。
 */
export interface RuntimeOptionArgs {
  maxConcurrency?: string;
  repeat?: string;
  cache?: boolean;
  noCache?: boolean;
  resume?: boolean;
  retryErrors?: boolean;
}

/**
 * 默认运行选项。
 */
export const DEFAULT_RUNTIME_OPTIONS: PromptfooRuntimeOptions = {
  maxConcurrency: 2,
  repeat: 1,
  cache: true,
  resume: false,
  retryErrors: false,
};

/**
 * 解析 CLI 运行参数为 PromptfooRuntimeOptions。
 *
 * 规则：
 * - maxConcurrency：从字符串解析为正整数，默认 2；非正整数抛出错误
 * - repeat：从字符串解析为正整数，默认 1；非正整数抛出错误
 * - cache：--no-cache 优先级最高；否则使用 --cache 的值；都未设置时默认 true
 * - resume：默认 false
 * - retryErrors：默认 false
 *
 * @param args - CLI 参数
 * @returns 解析后的运行选项
 * @throws 当 maxConcurrency 或 repeat 不是正整数时抛出 Error
 */
export function parseRuntimeOptions(args: RuntimeOptionArgs): PromptfooRuntimeOptions {
  // 解析 maxConcurrency
  let maxConcurrency: number;
  if (args.maxConcurrency !== undefined) {
    maxConcurrency = parseInt(args.maxConcurrency, 10);
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error(
        `maxConcurrency must be a positive integer, got "${args.maxConcurrency}"`
      );
    }
  } else {
    maxConcurrency = DEFAULT_RUNTIME_OPTIONS.maxConcurrency;
  }

  // 解析 repeat
  let repeat: number;
  if (args.repeat !== undefined) {
    repeat = parseInt(args.repeat, 10);
    if (!Number.isInteger(repeat) || repeat < 1) {
      throw new Error(
        `repeat must be a positive integer, got "${args.repeat}"`
      );
    }
  } else {
    repeat = DEFAULT_RUNTIME_OPTIONS.repeat;
  }

  // 解析 cache：--no-cache 优先
  const cache = args.noCache
    ? false
    : args.cache !== undefined
      ? args.cache
      : DEFAULT_RUNTIME_OPTIONS.cache;

  // 解析 resume
  const resume = args.resume ?? DEFAULT_RUNTIME_OPTIONS.resume;

  // 解析 retryErrors
  const retryErrors = args.retryErrors ?? DEFAULT_RUNTIME_OPTIONS.retryErrors;

  return {
    maxConcurrency,
    repeat,
    cache,
    resume,
    retryErrors,
  };
}

/**
 * 从 PromptfooRuntimeOptions 构建 evaluate() 可用的配置对象。
 *
 * 返回的对象可直接传给 promptfoo 的 evaluate() 函数
 * 或用于构建 promptfooconfig.yaml 的运行选项部分。
 *
 * @param runtime - 运行选项
 * @returns evaluate() 配置对象
 */
export function buildEvaluateOptions(
  runtime: PromptfooRuntimeOptions
): Record<string, unknown> {
  const options: Record<string, unknown> = {
    maxConcurrency: runtime.maxConcurrency,
    repeat: runtime.repeat,
    cache: runtime.cache,
  };

  // resume 和 retryErrors 仅在启用时包含，避免覆盖 promptfoo 默认行为
  if (runtime.resume) {
    options.resume = true;
  }

  if (runtime.retryErrors) {
    options.retryErrors = true;
  }

  return options;
}
