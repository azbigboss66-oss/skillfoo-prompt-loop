/**
 * Promptfoo 评测结果归一化模块
 *
 * 将 Promptfoo evaluate() 返回的原始结果解析为 SkillFoo 统一的
 * NormalizedPromptfooResult 格式。
 *
 * 设计原则：
 * - 防御性解析：处理缺失字段，不抛异常
 * - 兼容多种原始格式：Eval 对象、EvaluateSummaryV3、纯数组
 * - 分数归一化：promptfoo 使用 0-1，SkillFoo 使用 0-100
 *
 * 官方文档：
 * - Node package: https://www.promptfoo.dev/docs/usage/node-package/
 * - Results schema: https://www.promptfoo.dev/docs/configuration/reference/
 */

/**
 * 归一化后的 Promptfoo 评测结果
 */
export interface NormalizedPromptfooResult {
  testId: string;
  userInput: string;
  output: string;
  score: number;
  pass: boolean;
  assertions: Array<{
    type: string;
    pass: boolean;
    score: number;
    reason: string;
    metric?: string;
  }>;
  tokenUsage?: Record<string, number>;
  latencyMs?: number;
  error?: string;
}

/**
 * 将 promptfoo 的 0-1 分数转换为 SkillFoo 的 0-100 分数。
 * 如果分数已经 > 1，则保持原值不变。
 */
function normalizeScore(score: unknown): number {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return 0;
  }
  if (score >= 0 && score <= 1) {
    return Math.round(score * 100);
  }
  return Math.round(score);
}

/**
 * 安全地从对象中获取字符串值
 */
function getString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (value != null) {
    return String(value);
  }
  return fallback;
}

/**
 * 安全地从对象中获取数字值
 */
function getNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

/**
 * 安全地从对象中获取布尔值
 */
function getBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

/**
 * 从 gradingResult 的 componentResults 中提取断言结果。
 * 如果没有 componentResults，则从 gradingResult 本身创建一个断言。
 */
function extractAssertions(
  gradingResult: unknown
): NormalizedPromptfooResult["assertions"] {
  const assertions: NormalizedPromptfooResult["assertions"] = [];

  if (!gradingResult || typeof gradingResult !== "object") {
    return assertions;
  }

  const gr = gradingResult as Record<string, unknown>;

  // 从 componentResults 提取各断言结果
  if (Array.isArray(gr.componentResults)) {
    for (const component of gr.componentResults) {
      if (!component || typeof component !== "object") {
        continue;
      }
      const c = component as Record<string, unknown>;
      const assertion = (c.assertion ?? {}) as Record<string, unknown>;

      const assertionResult: NormalizedPromptfooResult["assertions"][number] = {
        type: getString(assertion.type, "unknown"),
        pass: getBoolean(c.pass),
        score: normalizeScore(c.score),
        reason: getString(c.reason),
      };

      if (typeof assertion.metric === "string") {
        assertionResult.metric = assertion.metric;
      }

      assertions.push(assertionResult);
    }
  }

  // 如果没有 componentResults，从 gradingResult 本身创建一个汇总断言
  if (assertions.length === 0) {
    assertions.push({
      type: "llm-rubric",
      pass: getBoolean(gr.pass),
      score: normalizeScore(gr.score),
      reason: getString(gr.reason),
    });
  }

  return assertions;
}

/**
 * 从原始结果对象中提取 tokenUsage
 */
function extractTokenUsage(
  result: Record<string, unknown>,
  response: Record<string, unknown>
): Record<string, number> | undefined {
  const rawTokenUsage = result.tokenUsage ?? response.tokenUsage;

  if (!rawTokenUsage || typeof rawTokenUsage !== "object") {
    return undefined;
  }

  const tokenUsage: Record<string, number> = {};
  const tu = rawTokenUsage as Record<string, unknown>;

  for (const [key, value] of Object.entries(tu)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      tokenUsage[key] = value;
    }
  }

  return Object.keys(tokenUsage).length > 0 ? tokenUsage : undefined;
}

/**
 * 归一化单条评测结果
 */
function normalizeSingleResult(
  rawResult: unknown,
  index: number
): NormalizedPromptfooResult {
  const r = (rawResult ?? {}) as Record<string, unknown>;

  // 提取 testCase 和 vars
  const testCase = (r.testCase ?? {}) as Record<string, unknown>;
  const vars = (testCase.vars ?? {}) as Record<string, unknown>;

  // 提取 response
  const response = (r.response ?? {}) as Record<string, unknown>;

  // 提取 gradingResult
  const gradingResult = r.gradingResult ?? null;

  // 提取 testId：优先从 vars.testId，然后 testCase.description，然后 r.id，最后用索引
  const testId =
    typeof vars.testId === "string"
      ? vars.testId
      : typeof testCase.description === "string"
        ? testCase.description
        : typeof r.id === "string"
          ? r.id
          : `test-${index}`;

  // 提取 userInput
  const userInput = getString(vars.userInput);

  // 提取 output
  const output =
    typeof response.output === "string"
      ? response.output
      : response.output != null
        ? String(response.output)
        : "";

  // 提取 score（优先使用顶层 score，其次 gradingResult.score）
  const rawScore = r.score ?? (gradingResult as Record<string, unknown>)?.score;
  const score = normalizeScore(rawScore);

  // 提取 pass（优先使用 success，其次 gradingResult.pass）
  const pass = getBoolean(
    r.success,
    getBoolean((gradingResult as Record<string, unknown>)?.pass)
  );

  // 提取 assertions
  const assertions = extractAssertions(gradingResult);

  // 构建 normalized result
  const result: NormalizedPromptfooResult = {
    testId,
    userInput,
    output,
    score,
    pass,
    assertions,
  };

  // 提取 tokenUsage
  const tokenUsage = extractTokenUsage(r, response);
  if (tokenUsage) {
    result.tokenUsage = tokenUsage;
  }

  // 提取 latencyMs
  const latencyMs =
    getNumber(r.latencyMs) ?? getNumber(response.latencyMs);
  if (latencyMs !== undefined) {
    result.latencyMs = latencyMs;
  }

  // Promptfoo uses the top-level `error` field for both provider failures and
  // failed assertions. A failed rubric with a real model output is a badcase,
  // not an execution failure that should stop the loop before repair.
  const responseError = typeof response.error === "string" ? response.error : undefined;
  const hasGradingResult = gradingResult !== null && typeof gradingResult === "object";
  const error = responseError ?? (
    !hasGradingResult && output.length === 0 && typeof r.error === "string"
      ? r.error
      : undefined
  );
  if (error) {
    result.error = error;
  }

  return result;
}

/**
 * 从原始结果对象中提取结果数组。
 *
 * 支持以下输入格式：
 * 1. Eval 对象：{ id: string, results: EvalResult[] }
 * 2. EvaluateSummaryV3：{ version: 3, results: EvaluateResult[], ... }
 * 3. ResultsFile：{ data: { results: EvaluateSummaryV3 } }
 * 4. 纯数组：EvaluateResult[]
 */
function extractResultsArray(rawResults: unknown): unknown[] {
  if (!rawResults) {
    return [];
  }

  // 情况 4: 纯数组
  if (Array.isArray(rawResults)) {
    return rawResults;
  }

  if (typeof rawResults !== "object") {
    return [];
  }

  const obj = rawResults as Record<string, unknown>;

  // 情况 1: Eval 对象 (有 results 数组)
  if (Array.isArray(obj.results)) {
    return obj.results;
  }

  // 情况 3: ResultsFile (有 data 字段)
  if (obj.data && typeof obj.data === "object") {
    const data = obj.data as Record<string, unknown>;
    if (data.results && typeof data.results === "object") {
      const summary = data.results as Record<string, unknown>;
      if (Array.isArray(summary.results)) {
        return summary.results;
      }
    }
  }

  return [];
}

/**
 * 解析 Promptfoo evaluate() 返回的原始结果，提取每条测试的
 * testId, userInput, output, score, pass, assertions, tokenUsage, latencyMs, error。
 *
 * 处理缺失字段，不抛异常。
 *
 * @param rawResults - Promptfoo evaluate() 的返回值（Eval 对象或结果数组）
 * @returns 归一化后的结果数组
 */
export function normalizePromptfooResults(
  rawResults: unknown
): NormalizedPromptfooResult[] {
  const resultsArray = extractResultsArray(rawResults);

  return resultsArray.map((rawResult, index) =>
    normalizeSingleResult(rawResult, index)
  );
}
