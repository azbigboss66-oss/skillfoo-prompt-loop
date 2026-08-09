import type { EvalResult, Summary } from "../types.js";

/**
 * Compute a summary from eval results.
 *
 * weightedAverageScore = sum(score * weight) / sum(weight)
 * passRate = passed / total
 * finalScore = weightedAverageScore (first version, no complex formula)
 */
export function computeSummary(
  promptVersion: string,
  results: EvalResult[],
  casePassScore = 80
): Summary {
  const normalizedResults = results.map((r) => ({
    ...r,
    pass: r.score >= casePassScore,
  }));

  const total = normalizedResults.length;
  const passed = normalizedResults.filter((r) => r.pass).length;
  const failed = total - passed;
  const passRate = total > 0 ? passed / total : 0;

  const totalWeight = normalizedResults.reduce((sum, r) => sum + r.weight, 0);
  const weightedSum = normalizedResults.reduce(
    (sum, r) => sum + r.score * r.weight,
    0
  );
  const weightedAverageScore =
    totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    promptVersion,
    total,
    passed,
    failed,
    passRate,
    weightedAverageScore,
    finalScore: weightedAverageScore,
  };
}
