/**
 * 断言构建和指标汇总单元测试
 *
 * 验收门槛（V5 Task 4 Step 4）：
 * 1. critical assertion 失败时最终不能 accepted
 * 2. 普通质量分提高但关键安全分下降时必须 rejected
 * 3. 单个低分用例能在报告中显示对应 assertion
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAssertions,
  summarizeMetricResults,
  isCriticalMetric,
} from "../promptfoo/assertions.js";
import {
  createDefaultMetricPolicy,
  decideAcceptance,
  type MetricPolicy,
  type MetricSummary,
} from "../promptfoo/metricPolicy.js";
import type { NormalizedPromptfooResult } from "../promptfoo/normalizePromptfooResults.js";
import type { TestCase } from "../types.js";

/**
 * 创建测试用例
 */
function makeTest(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "t001",
    category: "normal",
    userInput: "你好",
    expectedBehavior: "礼貌回复",
    rubric: "回答应礼貌、清楚",
    weight: 1,
    ...overrides,
  };
}

/**
 * 创建模拟的归一化评测结果
 */
function makeResult(overrides: Partial<NormalizedPromptfooResult> = {}): NormalizedPromptfooResult {
  return {
    testId: "test-001",
    userInput: "你好",
    output: "你好！有什么可以帮助您的吗？",
    score: 80,
    pass: true,
    assertions: [
      {
        type: "llm-rubric",
        pass: true,
        score: 80,
        reason: "回答礼貌、清楚",
      },
    ],
    ...overrides,
  };
}

/**
 * 创建模拟的关键安全断言失败结果
 */
function makeCriticalFailureResult(
  metric: string,
  overrides: Partial<NormalizedPromptfooResult> = {}
): NormalizedPromptfooResult {
  return makeResult({
    score: 40,
    pass: false,
    assertions: [
      {
        type: "llm-rubric",
        pass: true,
        score: 80,
        reason: "质量尚可",
        metric: "overall-quality",
      },
      {
        type: "not-regex",
        pass: false,
        score: 0,
        reason: "检测到敏感数据",
        metric,
      },
    ],
    ...overrides,
  });
}

describe("promptfooAssertions", () => {
  describe("buildAssertions backward compatibility", () => {
    it("1. buildAssertions(test) without policy still works (backward compatible)", () => {
      const test = makeTest({ category: "normal" });
      const assertions = buildAssertions(test);

      assert.ok(Array.isArray(assertions), "should return an array");
      assert.ok(assertions.length >= 1, "should have at least one assertion");

      // Should have llm-rubric as the first assertion
      const first = assertions[0] as Record<string, unknown>;
      assert.equal(first.type, "llm-rubric");
      assert.equal(first.value, test.rubric);
    });

    it("2. buildAssertions(test) for privacy category includes safety assertion", () => {
      const test = makeTest({ category: "privacy" });
      const assertions = buildAssertions(test);

      assert.ok(assertions.length >= 2, "privacy test should have at least 2 assertions");

      const metrics = assertions.map((a) => (a as Record<string, unknown>).metric);
      assert.ok(
        metrics.includes("privacy-no-sensitive-data"),
        "should include privacy-no-sensitive-data metric"
      );
    });
  });

  describe("buildAssertions with MetricPolicy", () => {
    it("3. buildAssertions(test, policy) adds forbidden output patterns", () => {
      const test = makeTest();
      const policy: MetricPolicy = {
        criticalMetrics: ["forbidden-output"],
        subjectiveMetrics: [],
        forbiddenOutputPatterns: ["(secret|confidential)"],
        minimumOverallScore: 60,
      };

      const assertions = buildAssertions(test, policy);

      // Should include a not-regex assertion for forbidden output
      const forbiddenAssertions = assertions.filter((a) => {
        const obj = a as Record<string, unknown>;
        return obj.metric === "forbidden-output";
      });
      assert.equal(
        forbiddenAssertions.length,
        1,
        "should have one forbidden-output assertion"
      );

      const forbidden = forbiddenAssertions[0] as Record<string, unknown>;
      assert.equal(forbidden.type, "not-regex");
      assert.equal(forbidden.value, "(secret|confidential)");
    });

    it("4. buildAssertions(test, policy) adds subjective rubric dimensions", () => {
      const test = makeTest();
      const policy = createDefaultMetricPolicy();

      const assertions = buildAssertions(test, policy);

      // Should include subjective metric assertions
      for (const metric of policy.subjectiveMetrics) {
        const found = assertions.find((a) => {
          const obj = a as Record<string, unknown>;
          return obj.metric === metric;
        });
        assert.ok(found, `should have assertion with metric: ${metric}`);
      }
    });

    it("5. buildAssertions(test, policy) tags base rubric with overall-quality metric", () => {
      const test = makeTest();
      const policy = createDefaultMetricPolicy();

      const assertions = buildAssertions(test, policy);

      const first = assertions[0] as Record<string, unknown>;
      assert.equal(first.type, "llm-rubric");
      assert.equal(first.metric, "overall-quality");
    });

    it("6. subjective rubric generates dimension-specific text", () => {
      const test = makeTest({ rubric: "回答应礼貌" });
      const policy: MetricPolicy = {
        criticalMetrics: [],
        subjectiveMetrics: ["task-completion"],
        forbiddenOutputPatterns: [],
        minimumOverallScore: 60,
      };

      const assertions = buildAssertions(test, policy);

      const subjectiveAssertion = assertions.find((a) => {
        const obj = a as Record<string, unknown>;
        return obj.metric === "task-completion";
      }) as Record<string, unknown> | undefined;

      assert.ok(subjectiveAssertion, "should have task-completion assertion");
      assert.ok(
        typeof subjectiveAssertion!.value === "string" &&
          (subjectiveAssertion!.value as string).includes("任务完成度"),
        "rubric should mention the dimension name"
      );
    });
  });

  describe("summarizeMetricResults", () => {
    it("7. calculates overallScore as average of all result scores", () => {
      const results = [
        makeResult({ score: 80 }),
        makeResult({ score: 60, testId: "test-002" }),
        makeResult({ score: 100, testId: "test-003" }),
      ];

      const summary = summarizeMetricResults(results);

      assert.equal(summary.overallScore, 80); // (80 + 60 + 100) / 3
    });

    it("8. aggregates metric scores by metric name", () => {
      const results = [
        makeResult({
          assertions: [
            { type: "llm-rubric", pass: true, score: 80, reason: "", metric: "overall-quality" },
            { type: "not-regex", pass: true, score: 100, reason: "", metric: "privacy-no-sensitive-data" },
          ],
        }),
        makeResult({
          testId: "test-002",
          assertions: [
            { type: "llm-rubric", pass: true, score: 60, reason: "", metric: "overall-quality" },
            { type: "not-regex", pass: true, score: 100, reason: "", metric: "privacy-no-sensitive-data" },
          ],
        }),
      ];

      const summary = summarizeMetricResults(results);

      assert.equal(summary.metricScores["overall-quality"], 70); // (80 + 60) / 2
      assert.equal(summary.metricScores["privacy-no-sensitive-data"], 100); // (100 + 100) / 2
    });

    it("9. returns empty results for empty input", () => {
      const summary = summarizeMetricResults([]);

      assert.equal(summary.overallScore, 0);
      assert.equal(summary.criticalFailures, 0);
      assert.deepEqual(summary.metricScores, {});
    });
  });

  describe("Test 1: critical assertion failure prevents acceptance", () => {
    it("10. critical assertion failure → cannot be accepted even with high overall score", () => {
      // Scenario: overall score is high (85) but a critical privacy assertion failed
      const results: NormalizedPromptfooResult[] = [
        makeResult({
          testId: "privacy-001",
          score: 85,
          pass: false,
          assertions: [
            { type: "llm-rubric", pass: true, score: 90, reason: "质量好", metric: "overall-quality" },
            { type: "not-regex", pass: false, score: 0, reason: "检测到 SSN 泄露", metric: "privacy-no-sensitive-data" },
          ],
        }),
        makeResult({
          testId: "normal-001",
          score: 85,
          pass: true,
          assertions: [
            { type: "llm-rubric", pass: true, score: 85, reason: "正常", metric: "overall-quality" },
          ],
        }),
      ];

      const summary = summarizeMetricResults(results);
      const policy = createDefaultMetricPolicy();
      const decision = decideAcceptance(summary, policy);

      // Overall score is good
      assert.ok(summary.overallScore >= policy.minimumOverallScore, "overall score should be above minimum");

      // But critical failures exist
      assert.ok(summary.criticalFailures > 0, "should have critical failures");
      assert.equal(summary.criticalFailures, 1, "should have exactly 1 critical failure");

      // Must NOT be accepted
      assert.equal(decision.accepted, false, "must not be accepted when critical failures exist");
      assert.match(decision.reason, /critical_failures/, "reason should mention critical failures");
    });

    it("11. multiple critical failures are all counted", () => {
      const results: NormalizedPromptfooResult[] = [
        makeCriticalFailureResult("privacy-no-sensitive-data", { testId: "t1" }),
        makeCriticalFailureResult("adversarial-refusal", { testId: "t2" }),
        makeCriticalFailureResult("hallucination-no-overconfidence", { testId: "t3" }),
      ];

      const summary = summarizeMetricResults(results);

      assert.equal(summary.criticalFailures, 3, "should count all 3 critical failures");
    });
  });

  describe("Test 2: quality up but critical safety down → rejected", () => {
    it("12. candidate with higher overall but critical regression must be rejected", () => {
      // Baseline: overall 70, no critical failures
      const baselineResults: NormalizedPromptfooResult[] = [
        makeResult({
          testId: "baseline-001",
          score: 70,
          assertions: [
            { type: "llm-rubric", pass: true, score: 70, reason: "", metric: "overall-quality" },
            { type: "not-regex", pass: true, score: 100, reason: "", metric: "privacy-no-sensitive-data" },
          ],
        }),
      ];

      // Candidate: overall 85 (higher!) but privacy assertion FAILED
      const candidateResults: NormalizedPromptfooResult[] = [
        makeResult({
          testId: "candidate-001",
          score: 85,
          pass: false,
          assertions: [
            { type: "llm-rubric", pass: true, score: 90, reason: "质量更好", metric: "overall-quality" },
            { type: "not-regex", pass: false, score: 0, reason: "泄露了用户数据", metric: "privacy-no-sensitive-data" },
          ],
        }),
      ];

      const baselineSummary = summarizeMetricResults(baselineResults);
      const candidateSummary = summarizeMetricResults(candidateResults);
      const policy = createDefaultMetricPolicy();

      const baselineDecision = decideAcceptance(baselineSummary, policy);
      const candidateDecision = decideAcceptance(candidateSummary, policy);

      // Candidate has higher overall score
      assert.ok(
        candidateSummary.overallScore > baselineSummary.overallScore,
        "candidate should have higher overall score"
      );

      // But critical safety regressed
      assert.equal(baselineSummary.criticalFailures, 0, "baseline should have 0 critical failures");
      assert.ok(
        candidateSummary.criticalFailures > 0,
        "candidate should have critical failures"
      );

      // Baseline is acceptable (by metrics), candidate is NOT
      assert.equal(baselineDecision.accepted, true, "baseline should be acceptable");
      assert.equal(
        candidateDecision.accepted,
        false,
        "candidate must be rejected despite higher overall score"
      );

      // Verify the specific critical metric score dropped
      const baselinePrivacyScore = baselineSummary.metricScores["privacy-no-sensitive-data"];
      const candidatePrivacyScore = candidateSummary.metricScores["privacy-no-sensitive-data"];
      assert.ok(
        candidatePrivacyScore < baselinePrivacyScore,
        "privacy metric score should drop in candidate"
      );
    });

    it("13. candidate with higher overall AND no critical failures is accepted", () => {
      const baselineResults: NormalizedPromptfooResult[] = [
        makeResult({
          testId: "b1",
          score: 65,
          assertions: [
            { type: "llm-rubric", pass: true, score: 65, reason: "", metric: "overall-quality" },
          ],
        }),
      ];

      const candidateResults: NormalizedPromptfooResult[] = [
        makeResult({
          testId: "c1",
          score: 85,
          assertions: [
            { type: "llm-rubric", pass: true, score: 85, reason: "", metric: "overall-quality" },
          ],
        }),
      ];

      const baselineSummary = summarizeMetricResults(baselineResults);
      const candidateSummary = summarizeMetricResults(candidateResults);
      const policy = createDefaultMetricPolicy();

      const candidateDecision = decideAcceptance(candidateSummary, policy);

      assert.equal(candidateSummary.criticalFailures, 0, "no critical failures");
      assert.ok(
        candidateSummary.overallScore > baselineSummary.overallScore,
        "candidate score should be higher"
      );
      assert.equal(candidateDecision.accepted, true, "candidate should be accepted");
    });
  });

  describe("Test 3: single low-score case shows corresponding assertion", () => {
    it("14. low-score case's failed assertion is visible in metric scores", () => {
      // One case has a low score due to a specific assertion failure
      const results: NormalizedPromptfooResult[] = [
        makeResult({
          testId: "good-001",
          score: 90,
          assertions: [
            { type: "llm-rubric", pass: true, score: 90, reason: "好", metric: "overall-quality" },
            { type: "llm-rubric", pass: true, score: 90, reason: "好", metric: "task-completion" },
          ],
        }),
        makeResult({
          testId: "bad-001",
          score: 30,
          pass: false,
          assertions: [
            { type: "llm-rubric", pass: true, score: 70, reason: "一般", metric: "overall-quality" },
            { type: "llm-rubric", pass: false, score: 0, reason: "未完成任务", metric: "task-completion" },
          ],
        }),
      ];

      const summary = summarizeMetricResults(results);

      // The task-completion metric should reflect the low score
      assert.ok(
        summary.metricScores["task-completion"] !== undefined,
        "task-completion metric should be in metricScores"
      );

      // task-completion average = (90 + 0) / 2 = 45
      assert.equal(
        summary.metricScores["task-completion"],
        45,
        "task-completion score should reflect the failure"
      );

      // overall-quality average = (90 + 70) / 2 = 80
      assert.equal(
        summary.metricScores["overall-quality"],
        80,
        "overall-quality should be higher than task-completion"
      );

      // The bad case should be identifiable: its specific assertion reason is preserved
      const badCase = results.find((r) => r.testId === "bad-001");
      assert.ok(badCase, "bad case should exist in results");

      const failedAssertion = badCase!.assertions.find((a) => !a.pass);
      assert.ok(failedAssertion, "should have a failed assertion");
      assert.equal(failedAssertion!.metric, "task-completion");
      assert.equal(failedAssertion!.reason, "未完成任务");
    });

    it("15. all assertion types are tracked in metricScores", () => {
      const results: NormalizedPromptfooResult[] = [
        makeResult({
          testId: "t1",
          assertions: [
            { type: "llm-rubric", pass: true, score: 80, reason: "", metric: "overall-quality" },
            { type: "not-regex", pass: true, score: 100, reason: "", metric: "privacy-no-sensitive-data" },
            { type: "icontains-any", pass: true, score: 100, reason: "", metric: "adversarial-refusal" },
            { type: "llm-rubric", pass: true, score: 75, reason: "", metric: "task-completion" },
          ],
        }),
      ];

      const summary = summarizeMetricResults(results);

      assert.ok(summary.metricScores["overall-quality"] !== undefined);
      assert.ok(summary.metricScores["privacy-no-sensitive-data"] !== undefined);
      assert.ok(summary.metricScores["adversarial-refusal"] !== undefined);
      assert.ok(summary.metricScores["task-completion"] !== undefined);
    });
  });

  describe("isCriticalMetric", () => {
    it("16. identifies critical metrics by keyword", () => {
      assert.ok(isCriticalMetric("privacy-no-sensitive-data"), "privacy is critical");
      assert.ok(isCriticalMetric("adversarial-refusal"), "adversarial is critical");
      assert.ok(isCriticalMetric("hallucination-no-overconfidence"), "hallucination is critical");
      assert.ok(isCriticalMetric("forbidden-output"), "forbidden is critical");
      assert.ok(isCriticalMetric("safety-check"), "safety is critical");
      assert.ok(isCriticalMetric("security-boundary"), "security is critical");
    });

    it("17. does not flag non-critical metrics as critical", () => {
      assert.ok(!isCriticalMetric("overall-quality"), "overall-quality is not critical");
      assert.ok(!isCriticalMetric("task-completion"), "task-completion is not critical");
      assert.ok(!isCriticalMetric("expression-quality"), "expression-quality is not critical");
      assert.ok(!isCriticalMetric("llm-rubric"), "llm-rubric type is not critical");
    });

    it("18. is case-insensitive", () => {
      assert.ok(isCriticalMetric("PRIVACY"), "PRIVACY should be critical");
      assert.ok(isCriticalMetric("Forbidden-Output"), "Forbidden-Output should be critical");
    });
  });

  describe("decideAcceptance with custom criticalMetricNames", () => {
    it("19. summarizeMetricResults respects custom criticalMetricNames", () => {
      const results: NormalizedPromptfooResult[] = [
        makeResult({
          testId: "t1",
          pass: false,
          assertions: [
            { type: "llm-rubric", pass: true, score: 80, reason: "", metric: "overall-quality" },
            { type: "custom-check", pass: false, score: 0, reason: "failed", metric: "custom-business-rule" },
          ],
        }),
      ];

      // Without custom critical metrics: custom-business-rule is NOT critical
      const summaryDefault = summarizeMetricResults(results);
      assert.equal(summaryDefault.criticalFailures, 0, "should not count as critical by default");

      // With custom critical metrics: custom-business-rule IS critical
      const summaryCustom = summarizeMetricResults(results, ["custom-business-rule"]);
      assert.equal(summaryCustom.criticalFailures, 1, "should count as critical with custom list");
    });
  });
});
