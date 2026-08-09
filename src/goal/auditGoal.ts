import type { GoalAuditSummary, GoalAuditIssue } from "../types.js";
import { GOAL_SECTIONS, sectionContent, bulletCount, containsAny } from "./goalProfile.js";

const RISK_KEYWORDS = ["隐私", "安全", "金钱", "密码", "验证码", "退款", "支付", "订单", "账号", "个人信息", "fact", "编造", "幻觉"];

/**
 * Deterministic goal audit.
 *
 * Checks for required sections, bullet counts, and risk keyword coverage.
 * Returns a GoalAuditSummary with score, canProceed flag, and issues list.
 */
export function auditGoal(goalMarkdown: string): GoalAuditSummary {
  let score = 100;
  const issues: GoalAuditIssue[] = [];
  const missingRequiredSections: string[] = [];
  const weakSections: string[] = [];
  const detectedCapabilities: string[] = [];
  const detectedForbiddenActions: string[] = [];
  const detectedRiskTypes: string[] = [];

  // Check businessGoal (required)
  const businessGoalContent = sectionContent(goalMarkdown, GOAL_SECTIONS.businessGoal);
  if (!businessGoalContent || businessGoalContent.length < 5) {
    score -= 20;
    missingRequiredSections.push("business_goal");
    issues.push({
      severity: "error",
      code: "missing_business_goal",
      message: "缺少业务目标（business_goal）部分或内容过短。",
      section: "业务目标",
    });
  }

  // Check users (required)
  const usersContent = sectionContent(goalMarkdown, GOAL_SECTIONS.users);
  if (!usersContent || usersContent.length < 3) {
    score -= 15;
    missingRequiredSections.push("users");
    issues.push({
      severity: "error",
      code: "missing_users",
      message: "缺少用户类型（users）部分或内容过短。",
      section: "用户类型",
    });
  }

  // Check allowedCapabilities (required, at least 3 bullets)
  const capabilitiesContent = sectionContent(goalMarkdown, GOAL_SECTIONS.allowedCapabilities);
  const capabilitiesBullets = bulletCount(capabilitiesContent);
  if (capabilitiesBullets < 3) {
    score -= 20;
    missingRequiredSections.push("allowed_capabilities");
    issues.push({
      severity: "error",
      code: "insufficient_capabilities",
      message: `助手可以做什么部分不足（需要至少 3 条，当前 ${capabilitiesBullets} 条）。`,
      section: "助手可以做什么",
    });
  } else {
    // Extract detected capabilities
    capabilitiesContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        detectedCapabilities.push(trimmed.slice(2).trim());
      }
    });
  }

  // Check forbiddenActions (required, at least 4 bullets)
  const forbiddenContent = sectionContent(goalMarkdown, GOAL_SECTIONS.forbiddenActions);
  const forbiddenBullets = bulletCount(forbiddenContent);
  if (forbiddenBullets < 4) {
    score -= 20;
    missingRequiredSections.push("forbidden_actions");
    issues.push({
      severity: "error",
      code: "insufficient_forbidden_actions",
      message: `助手不能做什么部分不足（需要至少 4 条，当前 ${forbiddenBullets} 条）。`,
      section: "助手不能做什么",
    });
  } else {
    // Extract detected forbidden actions
    forbiddenContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        detectedForbiddenActions.push(trimmed.slice(2).trim());
      }
    });

    // Check for risk keywords in forbidden actions
    const hasRiskKeywords = containsAny(forbiddenContent, RISK_KEYWORDS);
    if (!hasRiskKeywords) {
      score -= 10;
      issues.push({
        severity: "error",
        code: "no_risk_keywords_in_forbidden",
        message: "助手不能做什么部分缺少隐私/安全/金钱/事实边界等风险关键词。",
        section: "助手不能做什么",
      });
    }
  }

  // Check clarificationRules (warning, at least 2 bullets)
  const clarificationContent = sectionContent(goalMarkdown, GOAL_SECTIONS.clarificationRules);
  if (bulletCount(clarificationContent) < 2) {
    score -= 10;
    weakSections.push("clarification_rules");
    issues.push({
      severity: "warning",
      code: "weak_clarification_rules",
      message: "必须先澄清的情况部分不足（建议至少 2 条）。",
      section: "必须先澄清的情况",
    });
  }

  // Check highRiskScenarios (warning, at least 2 bullets)
  const riskContent = sectionContent(goalMarkdown, GOAL_SECTIONS.highRiskScenarios);
  const riskBullets = bulletCount(riskContent);
  if (riskBullets < 2) {
    score -= 10;
    weakSections.push("high_risk_scenarios");
    issues.push({
      severity: "warning",
      code: "weak_high_risk_scenarios",
      message: "高风险场景部分不足（建议至少 2 条）。",
      section: "高风险场景",
    });
  } else {
    // Extract detected risk types
    riskContent.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        detectedRiskTypes.push(trimmed.slice(2).trim());
      }
    });
  }

  // Check goodAnswer (warning, at least 5 bullets)
  const goodAnswerContent = sectionContent(goalMarkdown, GOAL_SECTIONS.goodAnswer);
  if (bulletCount(goodAnswerContent) < 5) {
    score -= 10;
    weakSections.push("good_answer");
    issues.push({
      severity: "warning",
      code: "weak_good_answer",
      message: "高分回答标准部分不足（建议至少 5 条）。",
      section: "高分回答标准",
    });
  }

  // Check badAnswer (warning, at least 5 bullets)
  const badAnswerContent = sectionContent(goalMarkdown, GOAL_SECTIONS.badAnswer);
  if (bulletCount(badAnswerContent) < 5) {
    score -= 10;
    weakSections.push("bad_answer");
    issues.push({
      severity: "warning",
      code: "weak_bad_answer",
      message: "低分或失败标准部分不足（建议至少 5 条）。",
      section: "低分或失败标准",
    });
  }

  // Check style (warning, content length >= 8)
  const styleContent = sectionContent(goalMarkdown, GOAL_SECTIONS.style);
  if (styleContent.length < 8) {
    score -= 5;
    weakSections.push("style");
    issues.push({
      severity: "warning",
      code: "weak_style",
      message: "输出风格部分内容过短。",
      section: "输出风格",
    });
  }

  // Score floor
  score = Math.max(0, score);

  // canProceed requires score >= 80 and no error issues
  const hasErrors = issues.some((i) => i.severity === "error");
  const canProceed = score >= 80 && !hasErrors;

  return {
    goalReadinessScore: score,
    canProceed,
    missingRequiredSections,
    weakSections,
    detectedCapabilities,
    detectedForbiddenActions,
    detectedRiskTypes,
    issues,
  };
}
