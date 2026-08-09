import { compareResults, countCriticalFailuresAfter } from "../report/compareResults.js";
import type { ReleaseGateInput, ReleaseDecision, EvalResult } from "../types.js";

/**
 * Compute weighted average score from an array of EvalResult.
 */
function averageScore(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
  const weightedSum = results.reduce((sum, r) => sum + r.score * r.weight, 0);
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

/**
 * V6 Release Gate — deterministic final release decision.
 *
 * Decides whether the public best candidate may replace the baseline as the
 * final best-prompt.md, based solely on external holdout results.
 *
 * Rules (in order):
 * 1. If no public candidate was kept → released_baseline_no_public_keep
 * 2. If no holdout results exist → unverified_no_holdout (public best retained, review required)
 * 3. If holdout exists, release public best only when ALL are true:
 *    - holdout aggregate delta >= 0
 *    - holdout serious regressions = 0
 *    - holdout critical failures after = 0
 *    - no provider/runtime error
 * 4. Otherwise → final_holdout_rollback (release baseline, retain public best as evidence)
 *
 * This function does NOT use public scores, PromptSpec score, candidate wording,
 * or any LLM call.
 */
export function decideRelease(input: ReleaseGateInput): ReleaseDecision {
  // 1. No public candidate was kept → release baseline
  if (!input.publicKeepOccurred) {
    return {
      status: "released_baseline_no_public_keep",
      releasedPromptVersion: "baseline",
      reasons: ["no_public_keep"],
    };
  }

  // 2. No holdout results → unverified
  const hasBaselineHoldout =
    input.baselineHoldoutResults !== undefined &&
    input.baselineHoldoutResults.length > 0;
  const hasCandidateHoldout =
    input.candidateHoldoutResults !== undefined &&
    input.candidateHoldoutResults.length > 0;

  if (!hasBaselineHoldout || !hasCandidateHoldout) {
    return {
      status: "unverified_no_holdout",
      releasedPromptVersion: input.publicBestPromptVersion ?? "candidate",
      reasons: ["no_holdout"],
    };
  }

  // 3. Evaluate holdout release gate
  const baselineHoldout = input.baselineHoldoutResults!;
  const candidateHoldout = input.candidateHoldoutResults!;

  // Check for provider/runtime errors
  const hasError = candidateHoldout.some((r) => r.error);

  // Compute holdout aggregate delta
  const baselineAvg = averageScore(baselineHoldout);
  const candidateAvg = averageScore(candidateHoldout);
  const holdoutDelta = candidateAvg - baselineAvg;

  // Compare per-case holdout results for serious regressions
  const holdoutComparison = compareResults(
    baselineHoldout,
    candidateHoldout,
    input.repairScoreThreshold
  );

  // Count critical safety failures in candidate holdout
  const criticalFailuresAfter = countCriticalFailuresAfter(candidateHoldout);

  // Check all release conditions
  const deltaOk = holdoutDelta >= 0;
  const noSeriousRegressions = holdoutComparison.seriousRegressions.length === 0;
  const noCriticalFailures = criticalFailuresAfter === 0;
  const noErrors = !hasError;

  if (deltaOk && noSeriousRegressions && noCriticalFailures && noErrors) {
    return {
      status: "released_public_best",
      releasedPromptVersion: input.publicBestPromptVersion ?? "candidate",
      reasons: [],
      holdoutComparison,
      holdoutDelta,
      criticalFailuresAfter,
    };
  }

  // 4. Release rolled back to baseline
  const reasons: string[] = [];
  if (!noErrors) reasons.push("provider_error");
  if (!deltaOk) reasons.push("holdout_aggregate_regression");
  if (!noSeriousRegressions) reasons.push("holdout_serious_regression");
  if (!noCriticalFailures) reasons.push("holdout_critical_failure");

  return {
    status: "final_holdout_rollback",
    releasedPromptVersion: "baseline",
    reasons,
    holdoutComparison,
    holdoutDelta,
    criticalFailuresAfter,
  };
}