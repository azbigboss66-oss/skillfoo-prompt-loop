import { test } from "node:test";
import assert from "node:assert/strict";
import { auditGoal } from "../goal/auditGoal.js";

test("auditGoal blocks missing capability boundaries", () => {
  const summary = auditGoal("帮我把客服 prompt 改好，回答要专业。");
  assert.equal(summary.canProceed, false);
  assert.ok(summary.goalReadinessScore < 80);
  assert.ok(summary.missingRequiredSections.includes("allowed_capabilities"));
  assert.ok(summary.missingRequiredSections.includes("forbidden_actions"));
});

test("auditGoal passes structured business goal", () => {
  const goal = `
# 业务目标
帮助电商消费者处理订单、退款、物流、优惠咨询。
# 用户类型
主要用户：普通消费者。
# 助手可以做什么
- 解释通用流程
- 引导查看订单页
- 信息不足时追问
# 助手不能做什么
- 不能编造政策
- 不能承诺退款到账时间
- 不能索取密码验证码
- 不能泄露他人订单
# 必须先澄清的情况
- 用户只说退款
- 用户说账号异常但没有说明现象
# 高风险场景
- 隐私
- 金钱
- 账号安全
# 高分回答标准
- 识别意图
- 不编造
- 不索取敏感信息
- 给下一步
- 必要时追问
# 低分或失败标准
- 编造优惠
- 索取验证码
- 泄露订单
- 过度推客服
- 忽略澄清
# 输出风格
专业、简洁、可执行。
`;
  const summary = auditGoal(goal);
  assert.equal(summary.canProceed, true);
  assert.ok(summary.goalReadinessScore >= 80);
});
