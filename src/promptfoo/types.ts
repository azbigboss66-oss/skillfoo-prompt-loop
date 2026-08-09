/**
 * Promptfoo 相关类型定义
 *
 * Promptfoo 官方文档：
 * - Node package: https://www.promptfoo.dev/docs/usage/node-package/
 * - Assertions and metrics: https://www.promptfoo.dev/docs/configuration/expected-outputs/
 * - Deterministic metrics: https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/
 */

/**
 * Promptfoo 安装检查结果
 */
export interface PromptfooInstallationResult {
  version: string;
  available: boolean;
}

/**
 * Promptfoo 评测结果的最小接口
 * 至少包含 evalId、resultsPath 和 summary
 */
export interface PromptfooEvalResult {
  evalId?: string;
  resultsPath?: string;
  summary: unknown;
}

/**
 * Promptfoo 运行模式
 */
export type PromptfooRunMode = "baseline" | "optimize" | "holdout" | "redteam";

/**
 * Provider 配置（与 src/types.ts 中的 ProviderConfig 保持兼容）
 */
export interface ProviderConfig {
  type: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  model?: string;
}
