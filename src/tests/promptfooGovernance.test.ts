import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzePromptChange,
  isCandidateIneligible,
  assessGovernance,
  type GovernanceInput,
  type PromptChangeGoalProfile,
} from "../report/analyzePromptChange.js";
import { computeV5FinalVerdict } from "../supervisor/finalVerdict.js";
import type { NormalizedPromptfooResult } from "../promptfoo/normalizePromptfooResults.js";

/**
 * 辅助函数：创建 NormalizedPromptfooResult
 */
function makeResult(
  testId: string,
  score: number,
  pass: boolean,
  assertions: Array<{
    type: string;
    pass: boolean;
    score: number;
    reason: string;
    metric?: string;
  }> = []
): NormalizedPromptfooResult {
  return {
    testId,
    userInput: `input for ${testId}`,
    output: `output for ${testId}`,
    score,
    pass,
    assertions: assertions.length > 0 ? assertions : [
      { type: "llm-rubric", pass, score, reason: pass ? "passed" : "failed" },
    ],
  };
}

/**
 * 辅助函数：创建关键安全断言失败的结果
 */
function makeCriticalFailureResult(
  testId: string,
  score: number,
  metric: string
): NormalizedPromptfooResult {
  return makeResult(testId, score, false, [
    {
      type: "not-regex",
      pass: false,
      score: 0,
      reason: "critical safety assertion failed",
      metric,
    },
    {
      type: "llm-rubric",
      pass: true,
      score: 80,
      reason: "quality ok",
      metric: "overall-quality",
    },
  ]);
}

const defaultGoalProfile: PromptChangeGoalProfile = {
  detectedCapabilities: ["通用建议", "解释", "引导"],
  detectedForbiddenActions: ["不能退款", "不能索要密码", "不能编造信息"],
  detectedRiskTypes: ["隐私", "安全", "金钱"],
};

test("Task 7 Step 1: Only final kept Prompt gets main safety conclusion", () => {
  const input: GovernanceInput = {
    baseline: [
      makeResult("t1", 70, true),
      makeResult("t2", 65, true),
    ],
    candidate: [
      makeResult("t1", 85, true),
      makeResult("t2", 80, true),
    ],
    originalPrompt: "你是一个客服助手。",
    candidatePrompt: "你是一个客服助手。请提供通用建议。",
    goalProfile: defaultGoalProfile,
  };

  const result = assessGovernance(input);

  // Best Prompt Safety should exist and be separate from all candidate safety
  assert.ok(result.bestPromptSafety, "bestPromptSafety should be defined");
  assert.ok(result.allCandidateSafety, "allCandidateSafety should be defined");
  assert.ok(result.allCandidateSafety.length > 0, "allCandidateSafety should have entries");

  // Best Prompt Safety should only reflect the final kept Prompt
  assert.equal(result.bestPromptSafety.safe, true);
  assert.equal(result.bestPromptSafety.criticalFailures, 0);
});

test("Task 7 Step 2: Unauthorized backend capability detected as scope bloat", () => {
  const original = "你是一个客服助手。";
  const candidate = "你是一个客服助手。\n## 后台操作\n- 我可以直接操作后台系统为您退款";

  const analysis = analyzePromptChange(original, candidate, defaultGoalProfile);

  assert.ok(analysis.severeScopeBloatCount > 0, "should detect severe scope bloat");
  assert.equal(isCandidateIneligible(analysis), true);
});

test("Task 7 Step 2: Negative safety rules NOT flagged as scope bloat", () => {
  const original = "你是一个客服助手。";
  const candidate = "你是一个客服助手。\n## 不能做\n- 不能直接操作后台系统\n- 不能承诺退款到账";

  const analysis = analyzePromptChange(original, candidate, defaultGoalProfile);

  // Negative rules in "不能做" section should NOT be flagged as scope bloat
  assert.equal(analysis.severeScopeBloatCount, 0, "should not flag negative rules as scope bloat");
  assert.equal(isCandidateIneligible(analysis), false);
});

test("Task 7 Step 3: Severe over-refusal detected when goal allows general advice", () => {
  const original = "你是一个客服助手。";
  const candidate = "你是一个客服助手。\n所有问题都建议联系人工客服处理";

  const analysis = analyzePromptChange(original, candidate, defaultGoalProfile);

  assert.ok(analysis.severeOverRefusalCount > 0, "should detect severe over-refusal");
  assert.equal(isCandidateIneligible(analysis), true);
});

test("Task 7 Step 5: Reject when total score improves but critical safety declines", () => {
  const input: GovernanceInput = {
    baseline: [
      makeResult("t1", 60, true),
      makeResult("t2", 60, true),
    ],
    candidate: [
      makeResult("t1", 90, true),
      makeCriticalFailureResult("t2", 30, "privacy-no-sensitive-data"),
    ],
    originalPrompt: "你是一个客服助手。",
    candidatePrompt: "你是一个客服助手。请提供更好的服务。",
    goalProfile: defaultGoalProfile,
  };

  const result = assessGovernance(input);

  // Total score may improve, but critical failures should cause rejection
  assert.ok(result.criticalFailuresAfter > 0, "should have critical failures");
  assert.equal(result.candidateRejected, true, "candidate should be rejected");
  assert.ok(
    result.rejectionReasons.some((r) => r.includes("critical_failures")),
    "should mention critical_failures in rejection reasons"
  );
});

test("Task 7 Step 5: Reject when public improves but holdout declines", () => {
  const input: GovernanceInput = {
    baseline: [
      makeResult("pub1", 60, true),
      makeResult("pub2", 60, true),
    ],
    candidate: [
      makeResult("pub1", 85, true),
      makeResult("pub2", 85, true),
    ],
    baselineHoldout: [
      makeResult("hold1", 70, true),
      makeResult("hold2", 70, true),
    ],
    candidateHoldout: [
      makeResult("hold1", 50, false),
      makeResult("hold2", 50, false),
    ],
    originalPrompt: "你是一个客服助手。",
    candidatePrompt: "你是一个客服助手。请提供更好的服务。",
    goalProfile: defaultGoalProfile,
  };

  const result = assessGovernance(input);

  // Public improved but holdout declined significantly
  assert.ok(result.publicDelta > 0, "public should improve");
  assert.ok(result.holdoutDelta !== null, "holdout delta should exist");
  assert.ok(result.holdoutDelta! < -3, "holdout should decline by more than 3");
  assert.equal(result.candidateRejected, true, "candidate should be rejected");
  assert.ok(
    result.rejectionReasons.some((r) => r.includes("holdout_regression")),
    "should mention holdout_regression"
  );
});

test("Task 7 Step 5: Keep original best Prompt when all candidates rejected", () => {
  const input: GovernanceInput = {
    baseline: [
      makeResult("t1", 70, true),
      makeResult("t2", 70, true),
    ],
    candidate: [
      makeCriticalFailureResult("t1", 30, "privacy-no-sensitive-data"),
      makeCriticalFailureResult("t2", 30, "adversarial-refusal"),
    ],
    originalPrompt: "你是一个客服助手。",
    candidatePrompt: "你是一个客服助手。我可以直接操作后台为您退款。",
    goalProfile: defaultGoalProfile,
  };

  const result = assessGovernance(input);

  // All candidates rejected
  assert.equal(result.candidateRejected, true, "candidate should be rejected");

  // V5 final verdict should not be accepted
  const verdict = computeV5FinalVerdict({
    goalAuditCanProceed: true,
    goalReadinessScore: 90,
    governance: result,
    sameModelGrader: false,
    hasAutoGeneratedTests: false,
  });

  assert.equal(verdict.label, "rejected");
  assert.equal(verdict.humanReviewRequired, true);
});

test("Task 7 Step 6: V5 Final Verdict blocked_by_goal", () => {
  const input: GovernanceInput = {
    baseline: [makeResult("t1", 70, true)],
    candidate: [makeResult("t1", 90, true)],
    originalPrompt: "test",
    candidatePrompt: "test improved",
    goalProfile: defaultGoalProfile,
  };

  const governance = assessGovernance(input);

  const verdict = computeV5FinalVerdict({
    goalAuditCanProceed: false,
    goalReadinessScore: 50,
    governance,
    sameModelGrader: false,
    hasAutoGeneratedTests: false,
  });

  assert.equal(verdict.label, "blocked_by_goal");
});

test("Task 7 Step 6: V5 Final Verdict accepted when all conditions met", () => {
  const input: GovernanceInput = {
    baseline: [
      makeResult("t1", 70, true),
      makeResult("t2", 70, true),
    ],
    candidate: [
      makeResult("t1", 85, true),
      makeResult("t2", 85, true),
    ],
    baselineHoldout: [
      makeResult("h1", 70, true),
    ],
    candidateHoldout: [
      makeResult("h1", 80, true),
    ],
    originalPrompt: "你是一个客服助手。",
    candidatePrompt: "你是一个客服助手。请提供通用建议和引导。",
    goalProfile: defaultGoalProfile,
  };

  const governance = assessGovernance(input);

  const verdict = computeV5FinalVerdict({
    goalAuditCanProceed: true,
    goalReadinessScore: 90,
    governance,
    sameModelGrader: false,
    hasAutoGeneratedTests: false,
  });

  assert.equal(verdict.label, "accepted");
  assert.equal(verdict.humanReviewRequired, false);
});

test("Task 7 Step 6: V5 Final Verdict with same model grader warning", () => {
  const input: GovernanceInput = {
    baseline: [makeResult("t1", 70, true)],
    candidate: [makeResult("t1", 85, true)],
    originalPrompt: "test",
    candidatePrompt: "test improved",
    goalProfile: defaultGoalProfile,
  };

  const governance = assessGovernance(input);

  const verdict = computeV5FinalVerdict({
    goalAuditCanProceed: true,
    goalReadinessScore: 90,
    governance,
    sameModelGrader: true,
    hasAutoGeneratedTests: true,
  });

  // Should still be accepted but with warnings
  assert.equal(verdict.label, "accepted");
  assert.equal(verdict.humanReviewRequired, true);
  assert.ok(verdict.reasons.some((r) => r.includes("同模型 grader")), "should warn about same model grader");
  assert.ok(verdict.reasons.some((r) => r.includes("自动生成测试")), "should warn about auto-generated tests");
});

test("Task 7 Step 6: V5 Final Verdict needs_review for insufficient improvement", () => {
  const input: GovernanceInput = {
    baseline: [makeResult("t1", 70, true)],
    candidate: [makeResult("t1", 71, true)],
    originalPrompt: "test",
    candidatePrompt: "test slightly improved",
    goalProfile: defaultGoalProfile,
  };

  const governance = assessGovernance(input);

  const verdict = computeV5FinalVerdict({
    goalAuditCanProceed: true,
    goalReadinessScore: 90,
    governance,
    sameModelGrader: false,
    hasAutoGeneratedTests: false,
  });

  assert.equal(verdict.label, "needs_review");
});

test("Task 7: Goal gate is first check in final verdict", () => {
  const input: GovernanceInput = {
    baseline: [makeResult("t1", 100, true)],
    candidate: [makeResult("t1", 100, true)],
    originalPrompt: "test",
    candidatePrompt: "test",
    goalProfile: defaultGoalProfile,
  };

  const governance = assessGovernance(input);

  // Even with perfect scores, goal gate failure should block
  const verdict = computeV5FinalVerdict({
    goalAuditCanProceed: false,
    goalReadinessScore: 50,
    governance,
    sameModelGrader: false,
    hasAutoGeneratedTests: false,
  });

  assert.equal(verdict.label, "blocked_by_goal");
});
