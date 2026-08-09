/**
 * Promptfoo optimize 输出解析模块
 *
 * 解析 `npx promptfoo optimize` 命令的 stdout/stderr，
 * 提取优化后的 Prompt 文本。
 *
 * 设计原则：
 * - 防御性解析：处理多种输出格式，不假设固定结构
 * - 无法解析时返回 blocked_by_optimize_output，不猜测 Prompt 文本
 * - 保留原始 stdout/stderr 供审计
 *
 * 官方文档：
 * - Prompt optimization: https://www.promptfoo.dev/docs/usage/prompt-optimization/
 * - Command line: https://www.promptfoo.dev/docs/usage/command-line/
 */

/**
 * 解析后的 optimize 输出
 */
export interface ParsedOptimizeOutput {
  /** 优化后的 Prompt 文本，无法解析时为 null */
  optimizedPrompt: string | null;
  /** 是否被阻断（无法解析） */
  blocked: boolean;
  /** 阻断原因（blocked 为 true 时有值） */
  blockReason?: string;
}

/**
 * 从 JSON 对象中提取 Prompt 文本。
 *
 * 检查常见的字段名：prompt, optimizedPrompt, optimized_prompt, result, output。
 * 也检查嵌套对象：optimizedResult, result, data。
 */
function extractPromptFromJson(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const promptFields = [
    "prompt",
    "optimizedPrompt",
    "optimized_prompt",
    "result",
    "output",
    "bestPrompt",
    "best_prompt",
  ];

  // 检查顶层字段
  for (const field of promptFields) {
    if (typeof obj[field] === "string" && (obj[field] as string).trim().length > 0) {
      return (obj[field] as string).trim();
    }
  }

  // 检查嵌套对象
  const nestedFields = ["optimizedResult", "result", "data", "bestResult"];
  for (const nestedField of nestedFields) {
    if (obj[nestedField] && typeof obj[nestedField] === "object") {
      const nested = obj[nestedField] as Record<string, unknown>;
      for (const field of promptFields) {
        if (
          typeof nested[field] === "string" &&
          (nested[field] as string).trim().length > 0
        ) {
          return (nested[field] as string).trim();
        }
      }
    }
  }

  return null;
}

/**
 * 从 stdout 中提取 Prompt 文本。
 *
 * 尝试多种解析策略：
 * 1. JSON 解析（stdout 以 { 或 [ 开头）
 * 2. 头部模式匹配（"Optimized prompt:", "Best prompt:" 等）
 * 3. Markdown 代码块提取
 * 4. 多行文本直接使用（非状态消息）
 * 5. 以上均失败时返回 blocked
 *
 * @param stdout - optimize 命令的标准输出
 * @param stderr - optimize 命令的标准错误输出
 * @returns 解析结果
 */
export function parseOptimizeOutput(
  stdout: string,
  stderr: string
): ParsedOptimizeOutput {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  // 完全无输出
  if (!trimmedStdout && !trimmedStderr) {
    return {
      optimizedPrompt: null,
      blocked: true,
      blockReason:
        "blocked_by_optimize_output: no stdout or stderr output from promptfoo optimize",
    };
  }

  // 如果 stdout 为空但 stderr 有错误信息
  if (!trimmedStdout) {
    return {
      optimizedPrompt: null,
      blocked: true,
      blockReason: `blocked_by_optimize_output: empty stdout, stderr: ${trimmedStderr.slice(0, 500)}`,
    };
  }

  // 策略 1: 尝试 JSON 解析
  if (trimmedStdout.startsWith("{") || trimmedStdout.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedStdout);
      const prompt = extractPromptFromJson(parsed);
      if (prompt) {
        return { optimizedPrompt: prompt, blocked: false };
      }
    } catch {
      // 不是有效 JSON，继续尝试其他策略
    }
  }

  // 策略 2: 头部模式匹配
  // 匹配 "Optimized prompt:", "Best prompt:", "优化后的提示词:" 等头部
  const headerPatterns: RegExp[] = [
    /(?:^|\n)\s*(?:Optimized|Best|Final|Improved)\s+[Pp]rompt\s*[:：]\s*\n([\s\S]*?)(?:\n\s*(?:---|===|Evaluation|Score|Result|$))/i,
    /(?:^|\n)\s*(?:优化|最终|改进后)\s*(?:的)?\s*[Pp]rompt\s*[:：]\s*\n([\s\S]*?)(?:\n\s*(?:---|===|评测|分数|结果|$))/i,
    /(?:^|\n)\s*[Pp]rompt\s*[:：]\s*\n([\s\S]*?)(?:\n\s*(?:---|===|Evaluation|Score|Result|$))/i,
  ];

  for (const pattern of headerPatterns) {
    const match = trimmedStdout.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      return { optimizedPrompt: match[1].trim(), blocked: false };
    }
  }

  // 策略 3: Markdown 代码块提取
  // 匹配 ```markdown ... ``` 或 ```text ... ``` 或 ``` ... ```
  const codeBlockPatterns: RegExp[] = [
    /```(?:markdown|md|text|prompt)?\s*\n([\s\S]*?)```/i,
  ];

  for (const pattern of codeBlockPatterns) {
    const match = trimmedStdout.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      const promptText = match[1].trim();
      // 确保不是太短的状态消息
      if (promptText.length >= 10) {
        return { optimizedPrompt: promptText, blocked: false };
      }
    }
  }

  // 策略 4: 多行文本直接使用
  // 如果 stdout 有多行内容且不包含明显的错误信息，尝试使用最后一个非空段落
  if (!trimmedStderr.toLowerCase().includes("error") &&
      !trimmedStderr.toLowerCase().includes("fatal")) {
    const lines = trimmedStdout.split("\n").filter((l) => l.trim().length > 0);

    // 如果内容足够长且像是一个 Prompt（多行）
    if (lines.length >= 2 && trimmedStdout.length >= 20) {
      // 尝试找到最后一个较长的段落（可能是最终输出）
      const paragraphs = trimmedStdout.split(/\n\s*\n/).filter((p) => p.trim().length >= 20);

      if (paragraphs.length > 0) {
        const lastParagraph = paragraphs[paragraphs.length - 1].trim();
        // 排除明显是状态信息的段落
        if (!lastParagraph.toLowerCase().startsWith("done") &&
            !lastParagraph.toLowerCase().startsWith("complete") &&
            !lastParagraph.toLowerCase().startsWith("finished")) {
          return { optimizedPrompt: lastParagraph, blocked: false };
        }
      }

      // 如果没有明显的段落分隔，使用整个 stdout
      return { optimizedPrompt: trimmedStdout, blocked: false };
    }
  }

  // 策略 5: 无法解析
  return {
    optimizedPrompt: null,
    blocked: true,
    blockReason: `blocked_by_optimize_output: could not parse optimized prompt from output. stdout (first 500 chars): ${trimmedStdout.slice(0, 500)}`,
  };
}
