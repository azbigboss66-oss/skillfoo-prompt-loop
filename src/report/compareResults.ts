import { z } from "zod";
import type { EvalResult } from "../types.js";

export const CaseComparisonSchema = z.object({
  testId: z.string(),
  category: z.string(),
  userInput: z.string(),
  beforeScore: z.number(),
  afterScore: z.number(),
  delta: z.number(),
  beforePass: z.boolean(),
  afterPass: z.boolean(),
  beforeReason: z.string(),
  afterReason: z.string(),
  beforeOutput: z.string(),
  afterOutput: z.string(),
});
export type CaseComparison = z.infer<typeof CaseComparisonSchema>;

export const BeforeAfterComparisonSchema = z.object({
  fixedBadcases: z.array(CaseComparisonSchema),
  remainingFailures: z.array(CaseComparisonSchema),
  regressions: z.array(CaseComparisonSchema),
  seriousRegressions: z.array(CaseComparisonSchema),
  improved: z.array(CaseComparisonSchema),
  unchanged: z.array(CaseComparisonSchema),
});
export type BeforeAfterComparison = z.infer<typeof BeforeAfterComparisonSchema>;

/**
 * Compare baseline (before) and best (after) evaluation results.
 *
 * Rules:
 * - fixedBadcases: before not passed or below repairScoreThreshold, after passed and after >= repairScoreThreshold
 * - remainingFailures: after not passed or after < repairScoreThreshold
 * - regressions: delta < 0
 * - seriousRegressions: delta <= -10
 * - improved: delta > 0 (and not in fixedBadcases)
 * - unchanged: delta === 0
 *
 * Sorting:
 * - fixedBadcases by delta descending
 * - seriousRegressions by delta ascending
 * - regressions by delta ascending
 * - remainingFailures by afterScore ascending
 */
export function compareResults(
  before: EvalResult[],
  after: EvalResult[],
  repairScoreThreshold: number
): BeforeAfterComparison {
  const beforeMap = new Map(before.map((r) => [r.testId, r]));
  const afterMap = new Map(after.map((r) => [r.testId, r]));

  const comparisons: CaseComparison[] = [];

  // Join by testId, skip after cases not present in before
  for (const afterResult of after) {
    const beforeResult = beforeMap.get(afterResult.testId);
    if (!beforeResult) continue;

    const delta = afterResult.score - beforeResult.score;

    comparisons.push({
      testId: afterResult.testId,
      category: afterResult.category,
      userInput: afterResult.userInput,
      beforeScore: beforeResult.score,
      afterScore: afterResult.score,
      delta,
      beforePass: beforeResult.pass,
      afterPass: afterResult.pass,
      beforeReason: beforeResult.reason,
      afterReason: afterResult.reason,
      beforeOutput: beforeResult.modelOutput,
      afterOutput: afterResult.modelOutput,
    });
  }

  const fixedBadcases: CaseComparison[] = [];
  const remainingFailures: CaseComparison[] = [];
  const regressions: CaseComparison[] = [];
  const seriousRegressions: CaseComparison[] = [];
  const improved: CaseComparison[] = [];
  const unchanged: CaseComparison[] = [];

  for (const c of comparisons) {
    const beforeWasBad = !c.beforePass || c.beforeScore < repairScoreThreshold;
    const afterIsGood = c.afterPass && c.afterScore >= repairScoreThreshold;
    const afterIsBad = !c.afterPass || c.afterScore < repairScoreThreshold;

    if (beforeWasBad && afterIsGood) {
      fixedBadcases.push(c);
    }

    if (afterIsBad) {
      remainingFailures.push(c);
    }

    if (c.delta < 0) {
      regressions.push(c);
    }

    if (c.delta <= -10) {
      seriousRegressions.push(c);
    }

    if (c.delta > 0 && !(beforeWasBad && afterIsGood)) {
      improved.push(c);
    }

    if (c.delta === 0) {
      unchanged.push(c);
    }
  }

  // Sort
  fixedBadcases.sort((a, b) => b.delta - a.delta);
  seriousRegressions.sort((a, b) => a.delta - b.delta);
  regressions.sort((a, b) => a.delta - b.delta);
  remainingFailures.sort((a, b) => a.afterScore - b.afterScore);
  improved.sort((a, b) => b.delta - a.delta);

  return {
    fixedBadcases,
    remainingFailures,
    regressions,
    seriousRegressions,
    improved,
    unchanged,
  };
}

/**
 * Count critical failures after (privacy/adversarial/hallucination categories that fail).
 */
export function countCriticalFailuresAfter(
  after: EvalResult[]
): number {
  const CRITICAL_CATEGORIES = new Set(["privacy", "adversarial", "hallucination"]);
  return after.filter(
    (r) => CRITICAL_CATEGORIES.has(r.category) && !r.pass
  ).length;
}
