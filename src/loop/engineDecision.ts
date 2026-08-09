/**
 * V5 Loop Engine Decision Module
 *
 * Determines which evaluation engine to use (Promptfoo or legacy)
 * and provides the candidate keep/rollback decision function.
 *
 * V5 主路径默认使用 Promptfoo；只有明确配置 legacy 才使用旧路径。
 */

import type { ProjectConfig } from "../config/loadProject.js";

/**
 * Loop engine type: Promptfoo (V5 default) or legacy (V4 self-developed evaluator)
 */
export type LoopEngine = "promptfoo" | "legacy";

/**
 * Resolve which loop engine to use based on project config.
 *
 * V5 规则：
 * - optimizationEngine 缺省时按 V5 处理为 "promptfoo"
 * - 只有明确配置 "legacy" 才使用旧路径
 *
 * @param config - Project configuration
 * @returns Loop engine to use
 */
export function resolveLoopEngine(config: ProjectConfig): LoopEngine {
  if (config.optimizationEngine === "legacy") {
    return "legacy";
  }
  // Default to promptfoo for V5
  return "promptfoo";
}

/**
 * V5 shouldKeepCandidate input
 */
export interface ShouldKeepCandidateInput {
  /** Current best score */
  currentScore: number;
  /** Candidate score */
  candidateScore: number;
  /** Minimum improvement required to keep */
  minImprovement: number;
  /** Number of critical assertion failures in candidate */
  criticalFailures: number;
  /** Number of severe scope bloat issues in candidate */
  severeScopeBloatCount: number;
  /** Number of severe over-refusal issues in candidate */
  severeOverRefusalCount: number;
}

/**
 * V5: Decide whether to keep or rollback a candidate.
 *
 * Keep conditions (ALL must be true):
 * 1. candidateScore >= currentScore + minImprovement (sufficient improvement)
 * 2. criticalFailures === 0 (no critical safety failures)
 * 3. severeScopeBloatCount === 0 (no severe scope bloat)
 * 4. severeOverRefusalCount === 0 (no severe over-refusal)
 *
 * If any condition fails, the candidate is rolled back.
 *
 * @param input - Decision input
 * @returns true if candidate should be kept, false if rolled back
 */
export function shouldKeepCandidate(input: ShouldKeepCandidateInput): boolean {
  // Check improvement
  if (input.candidateScore < input.currentScore + input.minImprovement) {
    return false;
  }

  // Check critical failures
  if (input.criticalFailures > 0) {
    return false;
  }

  // Check severe scope bloat
  if (input.severeScopeBloatCount > 0) {
    return false;
  }

  // Check severe over-refusal
  if (input.severeOverRefusalCount > 0) {
    return false;
  }

  return true;
}

/**
 * V5: Fixed stop conditions for the loop.
 *
 * Fixed order:
 * 1. Config error or goal not proceedable -> blocked
 * 2. Baseline meets target -> stop_already_passed
 * 3. Reached maxIters -> stop_max_iters
 * 4. Promptfoo optimize result no improvement -> rollback
 * 5. Promptfoo result unparseable -> blocked, no guessing
 * 6. Target met and all governance rules pass -> holdout and final verdict
 */
export type V5StopReason =
  | "target_reached"
  | "already_passed"
  | "max_iters"
  | "no_repair_cases"
  | "max_iters_zero"
  | "blocked_by_config"
  | "blocked_by_optimize_parse"
  | "blocked_by_goal";

/**
 * V5: Check if a stop reason indicates the run is blocked.
 */
export function isBlockedStopReason(reason: V5StopReason): boolean {
  return (
    reason === "blocked_by_config" ||
    reason === "blocked_by_optimize_parse" ||
    reason === "blocked_by_goal"
  );
}
