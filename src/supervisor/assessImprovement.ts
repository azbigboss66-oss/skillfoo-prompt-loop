import type { EvalResult, Summary } from "../types.js";

export type ImprovementLabel =
  | "clear_improvement"
  | "slight_improvement"
  | "no_change"
  | "overfit_risk"
  | "regression";

export interface ImprovementInput {
  baselinePublicSummary: Summary;
  bestPublicSummary: Summary;
  baselinePublicResults: EvalResult[];
  bestPublicResults: EvalResult[];
  baselineHoldoutSummary?: Summary;
  bestHoldoutSummary?: Summary;
  baselineHoldoutResults?: EvalResult[];
  bestHoldoutResults?: EvalResult[];
  repairScoreThreshold: number;
}

export interface ImprovementAssessment {
  label: ImprovementLabel;
  publicDelta: number;
  holdoutDelta: number | null;
  publicHoldoutGap: number | null;
  regressionCount: number;
  seriousRegressionCount: number;
  criticalFailuresAfter: number;
  lowScoreAfter: number;
  minScoreBefore: number;
  minScoreAfter: number;
  explanation: string;
}

const CRITICAL = new Set(["privacy", "adversarial", "hallucination"]);

function scoreMap(results: EvalResult[]): Map<string, number> {
  return new Map(results.map((r) => [r.testId, r.score]));
}

function countRegressions(before: EvalResult[], after: EvalResult[]) {
  const beforeMap = scoreMap(before);
  let regressionCount = 0;
  let seriousRegressionCount = 0;
  for (const result of after) {
    const oldScore = beforeMap.get(result.testId);
    if (oldScore === undefined) continue;
    const delta = result.score - oldScore;
    if (delta < 0) regressionCount++;
    if (delta <= -10) seriousRegressionCount++;
  }
  return { regressionCount, seriousRegressionCount };
}

function minScore(results: EvalResult[]): number {
  if (results.length === 0) return 0;
  return Math.min(...results.map((r) => r.score));
}

export function assessImprovement(input: ImprovementInput): ImprovementAssessment {
  const publicDelta =
    input.bestPublicSummary.finalScore - input.baselinePublicSummary.finalScore;
  const holdoutDelta =
    input.bestHoldoutSummary && input.baselineHoldoutSummary
      ? input.bestHoldoutSummary.finalScore - input.baselineHoldoutSummary.finalScore
      : null;
  const publicHoldoutGap =
    input.bestHoldoutSummary
      ? input.bestPublicSummary.finalScore - input.bestHoldoutSummary.finalScore
      : null;

  const publicReg = countRegressions(input.baselinePublicResults, input.bestPublicResults);
  const holdoutReg =
    input.baselineHoldoutResults && input.bestHoldoutResults
      ? countRegressions(input.baselineHoldoutResults, input.bestHoldoutResults)
      : { regressionCount: 0, seriousRegressionCount: 0 };

  const regressionCount = publicReg.regressionCount + holdoutReg.regressionCount;
  const seriousRegressionCount =
    publicReg.seriousRegressionCount + holdoutReg.seriousRegressionCount;

  const afterAll = [
    ...input.bestPublicResults,
    ...(input.bestHoldoutResults ?? []),
  ];
  const beforeAll = [
    ...input.baselinePublicResults,
    ...(input.baselineHoldoutResults ?? []),
  ];

  const criticalFailuresAfter = afterAll.filter(
    (r) => CRITICAL.has(r.category) && !r.pass
  ).length;
  const lowScoreAfter = afterAll.filter(
    (r) => r.score < input.repairScoreThreshold
  ).length;

  let label: ImprovementLabel;
  if (
    (holdoutDelta !== null && holdoutDelta < -3) ||
    seriousRegressionCount > 0 ||
    criticalFailuresAfter > 0
  ) {
    label = "regression";
  } else if (
    (holdoutDelta !== null && publicDelta >= 5 && holdoutDelta <= 0) ||
    (publicHoldoutGap !== null && publicHoldoutGap > 10)
  ) {
    label = "overfit_risk";
  } else if (
    publicDelta >= 5 &&
    holdoutDelta !== null &&
    holdoutDelta >= 3
  ) {
    label = "clear_improvement";
  } else if (
    publicDelta >= 2 &&
    (holdoutDelta === null || holdoutDelta >= 0)
  ) {
    label = "slight_improvement";
  } else {
    label = "no_change";
  }

  return {
    label,
    publicDelta,
    holdoutDelta,
    publicHoldoutGap,
    regressionCount,
    seriousRegressionCount,
    criticalFailuresAfter,
    lowScoreAfter,
    minScoreBefore: minScore(beforeAll),
    minScoreAfter: minScore(afterAll),
    explanation: `label=${label}, publicDelta=${publicDelta.toFixed(1)}, holdoutDelta=${holdoutDelta === null ? "NA" : holdoutDelta.toFixed(1)}`,
  };
}


// V5: Promptfoo-based improvement assessment
import type { NormalizedPromptfooResult } from "../promptfoo/normalizePromptfooResults.js";
import { summarizeMetricResults, isCriticalMetric } from "../promptfoo/assertions.js";

/**
 * V5: Promptfoo 改善评估输入
 */
export interface PromptfooImprovementInput {
  baselinePublic: NormalizedPromptfooResult[];
  bestPublic: NormalizedPromptfooResult[];
  baselineHoldout?: NormalizedPromptfooResult[];
  bestHoldout?: NormalizedPromptfooResult[];
}

/**
 * V5: Promptfoo 改善评估结果
 */
export interface PromptfooImprovementAssessment {
  label: ImprovementLabel;
  publicDelta: number;
  holdoutDelta: number | null;
  regressionCount: number;
  seriousRegressionCount: number;
  criticalFailuresAfter: number;
  explanation: string;
}

/**
 * V5: 基于 NormalizedPromptfooResult 的改善评估。
 *
 * 保留局部退步规则：
 * - 严重回归（分数下降 >= 10）时，label = regression
 * - 关键安全断言失败时，label = regression
 * - holdout 下降超过 3 分时，label = regression
 * - public 提升但 holdout 下降时，label = overfit_risk
 */
export function assessPromptfooImprovement(
  input: PromptfooImprovementInput
): PromptfooImprovementAssessment {
  const baselineSummary = summarizeMetricResults(input.baselinePublic);
  const bestSummary = summarizeMetricResults(input.bestPublic);

  const publicDelta = bestSummary.overallScore - baselineSummary.overallScore;

  let holdoutDelta: number | null = null;
  if (input.baselineHoldout && input.bestHoldout) {
    const baselineHoldoutSummary = summarizeMetricResults(input.baselineHoldout);
    const bestHoldoutSummary = summarizeMetricResults(input.bestHoldout);
    holdoutDelta = bestHoldoutSummary.overallScore - baselineHoldoutSummary.overallScore;
  }

  // Count regressions
  const baselineMap = new Map(input.baselinePublic.map((r) => [r.testId, r.score]));
  let regressionCount = 0;
  let seriousRegressionCount = 0;
  for (const result of input.bestPublic) {
    const oldScore = baselineMap.get(result.testId);
    if (oldScore === undefined) continue;
    const delta = result.score - oldScore;
    if (delta < 0) regressionCount++;
    if (delta <= -10) seriousRegressionCount++;
  }

  // Count holdout regressions
  if (input.baselineHoldout && input.bestHoldout) {
    const holdoutBaselineMap = new Map(input.baselineHoldout.map((r) => [r.testId, r.score]));
    for (const result of input.bestHoldout) {
      const oldScore = holdoutBaselineMap.get(result.testId);
      if (oldScore === undefined) continue;
      const delta = result.score - oldScore;
      if (delta < 0) regressionCount++;
      if (delta <= -10) seriousRegressionCount++;
    }
  }

  // Count critical failures after
  const criticalFailuresAfter = input.bestPublic.reduce((count, result) => {
    return count + result.assertions.filter((a) => {
      if (a.pass) return false;
      const metric = a.metric ?? a.type;
      return isCriticalMetric(metric);
    }).length;
  }, 0);

  let label: ImprovementLabel;
  if (
    (holdoutDelta !== null && holdoutDelta < -3) ||
    seriousRegressionCount > 0 ||
    criticalFailuresAfter > 0
  ) {
    label = "regression";
  } else if (
    (holdoutDelta !== null && publicDelta >= 5 && holdoutDelta <= 0) ||
    (holdoutDelta !== null && publicDelta - holdoutDelta > 10)
  ) {
    label = "overfit_risk";
  } else if (
    publicDelta >= 5 &&
    (holdoutDelta === null || holdoutDelta >= 3)
  ) {
    label = "clear_improvement";
  } else if (
    publicDelta >= 2 &&
    (holdoutDelta === null || holdoutDelta >= 0)
  ) {
    label = "slight_improvement";
  } else {
    label = "no_change";
  }

  return {
    label,
    publicDelta,
    holdoutDelta,
    regressionCount,
    seriousRegressionCount,
    criticalFailuresAfter,
    explanation: `label=${label}, publicDelta=${publicDelta.toFixed(1)}, holdoutDelta=${holdoutDelta === null ? "NA" : holdoutDelta.toFixed(1)}`,
  };
}
