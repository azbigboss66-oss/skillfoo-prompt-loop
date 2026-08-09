import type { TestCase, TestAuditSummary, TestAuditIssue } from "../types.js";

export interface TestAuditOptions {
  minTotal: number;
  minQualityScore: number;
  maxDuplicateRatio: number;
  minHighRiskRatio: number;
  requiredCategories: string[];
  minCategoryCounts: Record<string, number>;
  weakRubricIsError?: boolean;
  goalProfile?: {
    detectedCapabilities: string[];
    detectedForbiddenActions: string[];
    detectedRiskTypes: string[];
  };
}

const HIGH_RISK = new Set(["privacy", "adversarial", "hallucination"]);

const GOLD_ANSWER_PATTERNS = [
  /标准答案[:：]/,
  /正确答案[:：]/,
  /assistant should say/i,
  /完整回答[:：]/,
];

const WEAK_RUBRIC_PATTERNS = [
  /^回答合理即可$/,
  /^看情况$/,
  /^good answer$/i,
  /^合理即可$/,
];

export function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[，。！？、；：""''"'`~!@#$%^&*()_+=\[\]\\{}|:;,.<>/?-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): Set<string> {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return new Set();
  const wordTokens = normalized.split(" ").filter(Boolean);
  const cjkChars = [...normalized.replace(/\s+/g, "")].filter((ch) =>
    /[\u4e00-\u9fff]/.test(ch)
  );
  const cjkBigrams: string[] = [];
  for (let i = 0; i < cjkChars.length - 1; i++) {
    cjkBigrams.push(`${cjkChars[i]}${cjkChars[i + 1]}`);
  }
  return new Set([...wordTokens, ...cjkBigrams]);
}

export function jaccardSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  const intersection = [...ta].filter((x) => tb.has(x)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

function countCategories(tests: TestCase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const test of tests) {
    counts[test.category] = (counts[test.category] ?? 0) + 1;
  }
  return counts;
}

function countDuplicates(tests: TestCase[]): number {
  let duplicates = 0;
  for (let i = 0; i < tests.length; i++) {
    for (let j = i + 1; j < tests.length; j++) {
      if (jaccardSimilarity(tests[i].userInput, tests[j].userInput) >= 0.85) {
        duplicates++;
      }
    }
  }
  return duplicates;
}

function hasGoldAnswerLeakage(test: TestCase): boolean {
  const combined = `${test.expectedBehavior}\n${test.rubric}`;
  return GOLD_ANSWER_PATTERNS.some((pattern) => pattern.test(combined));
}

function rubricIsStrong(test: TestCase): boolean {
  const rubric = test.rubric.trim();
  if (WEAK_RUBRIC_PATTERNS.some((pattern) => pattern.test(rubric))) return false;
  const chineseChars = (rubric.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const englishWords = (rubric.match(/[A-Za-z]+/g) ?? []).length;
  return chineseChars >= 15 || englishWords >= 10;
}

/**
 * Check if test traces to goal profile or category-specific keywords.
 * When goalProfile is provided, use detected capabilities/forbidden/risk types.
 * Otherwise, fall back to category-specific keyword map.
 */
function goalTraceable(test: TestCase, goalProfile?: TestAuditOptions["goalProfile"]): boolean {
  const text = `${test.expectedBehavior}\n${test.rubric}`;

  // If goal profile is provided, check against it
  if (goalProfile) {
    const allProfileTerms = [
      ...goalProfile.detectedCapabilities,
      ...goalProfile.detectedForbiddenActions,
      ...goalProfile.detectedRiskTypes,
    ];
    // Also check category-specific keywords as fallback
    const categoryKeywordMap: Record<string, string[]> = {
      normal: ["礼貌", "清楚", "通用", "建议"],
      edge: ["风险", "紧急", "安全", "可执行"],
      adversarial: ["拒绝", "忽略规则", "编造", "后台", "泄露"],
      hallucination: ["不能编造", "未经验证", "官方", "无法确认"],
      privacy: ["隐私", "拒绝", "他人", "敏感"],
      format: ["格式", "结构", "JSON", "几点"],
      ambiguity: ["澄清", "信息不足", "追问", "模糊"],
    };
    const categoryKeywords = categoryKeywordMap[test.category] ?? [];
    const hasCategoryMatch = categoryKeywords.some((keyword) => text.includes(keyword));
    const hasProfileMatch = allProfileTerms.some((term) => {
      // Check if any significant word from the term appears in the text
      const words = term.split(/[\s,，、]+/).filter((w) => w.length >= 2);
      return words.some((w) => text.includes(w));
    });
    return hasCategoryMatch || hasProfileMatch;
  }

  // Fallback: category-specific keywords only
  const categoryKeywordMap: Record<string, string[]> = {
    normal: ["礼貌", "清楚", "通用", "建议"],
    edge: ["风险", "紧急", "安全", "可执行"],
    adversarial: ["拒绝", "忽略规则", "编造", "后台", "泄露"],
    hallucination: ["不能编造", "未经验证", "官方", "无法确认"],
    privacy: ["隐私", "拒绝", "他人", "敏感"],
    format: ["格式", "结构", "JSON", "几点"],
    ambiguity: ["澄清", "信息不足", "追问", "模糊"],
  };
  const keywords = categoryKeywordMap[test.category] ?? [];
  return keywords.some((keyword) => text.includes(keyword));
}

/**
 * Compute near-duplicate ratio between public and holdout test sets.
 * Returns ratio of near-duplicate pairs to total pairs.
 */
export function computeCrossSplitNearDuplicates(
  publicTests: TestCase[],
  holdoutTests: TestCase[]
): { ratio: number; nearDuplicatePairs: Array<{ publicId: string; holdoutId: string; similarity: number }> } {
  if (publicTests.length === 0 || holdoutTests.length === 0) {
    return { ratio: 0, nearDuplicatePairs: [] };
  }
  const nearDuplicatePairs: Array<{ publicId: string; holdoutId: string; similarity: number }> = [];
  for (const pub of publicTests) {
    for (const hol of holdoutTests) {
      const sim = jaccardSimilarity(pub.userInput, hol.userInput);
      if (sim >= 0.85) {
        nearDuplicatePairs.push({ publicId: pub.id, holdoutId: hol.id, similarity: sim });
      }
    }
  }
  const ratio = nearDuplicatePairs.length / (publicTests.length * holdoutTests.length);
  return { ratio, nearDuplicatePairs };
}

export function auditGeneratedTests(
  tests: TestCase[],
  options: TestAuditOptions
): TestAuditSummary {
  const issues: TestAuditIssue[] = [];
  const total = tests.length;
  const categoryCounts = countCategories(tests);
  const duplicatePairs = countDuplicates(tests);
  const duplicateRatio = total > 1 ? duplicatePairs / total : 0;
  const highRiskCount = tests.filter((t) => HIGH_RISK.has(t.category)).length;
  const highRiskRatio = total > 0 ? highRiskCount / total : 0;

  if (total < options.minTotal) {
    issues.push({
      severity: "error",
      code: "too_few_tests",
      message: `Expected at least ${options.minTotal} tests, got ${total}.`,
    });
  }

  for (const category of options.requiredCategories) {
    const count = categoryCounts[category] ?? 0;
    const min = options.minCategoryCounts[category] ?? 1;
    if (count < min) {
      issues.push({
        severity: "error",
        code: "category_underrepresented",
        message: `Category ${category} expected at least ${min}, got ${count}.`,
      });
    }
  }

  for (const test of tests) {
    if (hasGoldAnswerLeakage(test)) {
      issues.push({
        severity: "error",
        code: "gold_answer_leakage",
        testId: test.id,
        message: "Expected behavior or rubric appears to contain a full gold-answer marker.",
      });
    }
    if (!rubricIsStrong(test)) {
      const severity = options.weakRubricIsError ? "error" : "warning";
      issues.push({
        severity,
        code: "weak_rubric",
        testId: test.id,
        message: "Rubric is too short or too vague.",
      });
    }
    if (!goalTraceable(test, options.goalProfile)) {
      issues.push({
        severity: "warning",
        code: "weak_goal_traceability",
        testId: test.id,
        message: "Expected behavior and rubric do not clearly trace to category-specific goal keywords or goal profile.",
      });
    }
  }

  if (duplicateRatio > options.maxDuplicateRatio) {
    issues.push({
      severity: "error",
      code: "duplicate_ratio_too_high",
      message: `Duplicate ratio ${duplicateRatio.toFixed(2)} exceeds ${options.maxDuplicateRatio}.`,
    });
  }

  if (highRiskRatio < options.minHighRiskRatio) {
    issues.push({
      severity: "error",
      code: "high_risk_ratio_too_low",
      message: `High-risk ratio ${highRiskRatio.toFixed(2)} is below ${options.minHighRiskRatio}.`,
    });
  }

  const schemaScore = 20;
  const coveredCategories = options.requiredCategories.filter((c) => (categoryCounts[c] ?? 0) > 0).length;
  const coverageScore = Math.round((coveredCategories / options.requiredCategories.length) * 20);
  const highRiskBalanceScore = highRiskRatio >= options.minHighRiskRatio ? 15 : Math.round((highRiskRatio / options.minHighRiskRatio) * 15);
  const uniquenessScore = duplicateRatio <= options.maxDuplicateRatio ? 15 : Math.max(0, Math.round(15 - duplicateRatio * 30));
  const leakageScore = issues.some((i) => i.code === "gold_answer_leakage") ? 0 : 10;
  const strongRubricRatio = total > 0 ? tests.filter(rubricIsStrong).length / total : 0;
  const rubricQualityScore = Math.round(strongRubricRatio * 10);
  const traceableRatio = total > 0 ? tests.filter((t) => goalTraceable(t, options.goalProfile)).length / total : 0;
  const goalTraceabilityScore = Math.round(traceableRatio * 10);

  const testQualityScore =
    schemaScore +
    coverageScore +
    highRiskBalanceScore +
    uniquenessScore +
    leakageScore +
    rubricQualityScore +
    goalTraceabilityScore;

  const pass =
    testQualityScore >= options.minQualityScore &&
    !issues.some((i) => i.severity === "error");

  return {
    total,
    testQualityScore,
    schemaScore,
    coverageScore,
    highRiskBalanceScore,
    uniquenessScore,
    leakageScore,
    rubricQualityScore,
    goalTraceabilityScore,
    duplicateRatio,
    highRiskRatio,
    categoryCounts,
    pass,
    issues,
  };
}
