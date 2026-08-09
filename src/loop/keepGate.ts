import { compareResults, countCriticalFailuresAfter } from "../report/compareResults.js";
import { isCandidateIneligible } from "../report/analyzePromptChange.js";
import type { PublicKeepGateInput, PublicKeepGateDecision } from "../types.js";

/**
 * V6 Public Keep Gate — deterministic per-candidate keep decision.
 *
 * A candidate is eligible only when ALL of the following are true:
 * 1. candidateResults has results for exactly the current public test IDs
 * 2. no candidate result has an error
 * 3. candidateScore >= currentScore + minImprovement
 * 4. no serious per-case regression (delta <= -10)
 * 5. no critical safety failure (privacy / adversarial / hallucination not passing)
 * 6. no severe scope bloat
 * 7. no severe over-refusal
 *
 * This function does NOT inspect holdout data.
 */
export function decidePublicKeep(input: PublicKeepGateInput): PublicKeepGateDecision {
  const reasons: string[] = [];

  // 1. Check test set mismatch — candidate must have exactly the same test IDs
  const currentIds = new Set(input.currentResults.map((r) => r.testId));
  const candidateIds = new Set(input.candidateResults.map((r) => r.testId));

  if (
    currentIds.size !== candidateIds.size ||
    [...currentIds].some((id) => !candidateIds.has(id))
  ) {
    reasons.push("test_set_mismatch");
  }

  // 2. Check for provider/runtime errors
  if (input.candidateResults.some((r) => r.error)) {
    reasons.push("provider_error");
  }

  // 3. Check aggregate improvement
  if (input.candidateScore < input.currentScore + input.minImprovement) {
    reasons.push("insufficient_public_improvement");
  }

  // 4. Compare results for per-case regressions
  const comparison = compareResults(
    input.currentResults,
    input.candidateResults,
    input.repairScoreThreshold
  );

  if (comparison.seriousRegressions.length > 0) {
    reasons.push("serious_public_regression");
  }

  // 5. Check critical safety failures
  const criticalFailuresAfter = countCriticalFailuresAfter(input.candidateResults);
  if (criticalFailuresAfter > 0) {
    reasons.push("critical_public_failure");
  }

  // 6 & 7. Check severe scope bloat and over-refusal via governance analysis
  // isCandidateIneligible returns true when severeScopeBloatCount > 0 OR severeOverRefusalCount > 0
  if (isCandidateIneligible(input.analysis)) {
    if (input.analysis.severeScopeBloatCount > 0) {
      reasons.push("severe_scope_bloat");
    }
    if (input.analysis.severeOverRefusalCount > 0) {
      reasons.push("severe_over_refusal");
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    comparison,
    criticalFailuresAfter,
  };
}