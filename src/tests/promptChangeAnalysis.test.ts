import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePromptChange, isCandidateIneligible } from "../report/analyzePromptChange.js";

const originalPrompt = `你是一个电商客服助手。
帮助用户处理订单、退款、物流查询。
信息不足时主动追问。
不要编造政策。`;

const goalProfile = {
  detectedCapabilities: ["解释通用流程", "引导查看订单", "信息不足时追问"],
  detectedForbiddenActions: ["不能编造政策", "不能承诺退款到账时间", "不能索取密码验证码", "不能泄露他人订单"],
  detectedRiskTypes: ["隐私", "金钱", "账号安全"],
};

test("candidate claiming '已为你退款' is severe scope bloat", () => {
  const candidate = originalPrompt + "\n如果用户要求退款，已为你退款并通知。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.ok(analysis.severeScopeBloatCount > 0, `Expected severe scope bloat, got ${analysis.severeScopeBloatCount}`);
  assert.ok(isCandidateIneligible(analysis), "Candidate with severe scope bloat should be ineligible");
});

test("candidate saying '任何问题都联系官方客服' is severe over-refusal when goal allows general advice", () => {
  const candidate = originalPrompt + "\n任何问题都联系官方客服处理。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.ok(analysis.severeOverRefusalCount > 0, `Expected severe over-refusal, got ${analysis.severeOverRefusalCount}`);
  assert.ok(isCandidateIneligible(analysis), "Candidate with severe over-refusal should be ineligible");
});

test("candidate adding privacy refusal and clarification rules is not scope bloat", () => {
  const candidate = originalPrompt + "\n不要泄露他人订单信息。\n用户只说退款时先追问订单号。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.equal(analysis.severeScopeBloatCount, 0);
  assert.equal(analysis.severeOverRefusalCount, 0);
  assert.equal(isCandidateIneligible(analysis), false);
});

test("candidate prohibition bullets are not treated as claimed backend abilities", () => {
  const candidate =
    originalPrompt +
    "\n# 业务目标\n帮助用户解决订单退款问题，但不能声称自己已经完成真实后台操作。" +
    "\n# 助手不能做什么\n- 不能声称已经退款、已经改地址。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.equal(analysis.severeScopeBloatCount, 0);
  assert.equal(isCandidateIneligible(analysis), false);
});

test("failure-standard examples are not treated as new capabilities", () => {
  const candidate =
    originalPrompt +
    "\n# 低分或失败标准\n- 声称自己已经执行真实后台操作。\n- 任何问题都联系官方客服。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.equal(analysis.severeScopeBloatCount, 0);
  assert.equal(analysis.severeOverRefusalCount, 0);
  assert.equal(isCandidateIneligible(analysis), false);
});

test("candidate with '承诺到账' is severe scope bloat", () => {
  const candidate = originalPrompt + "\n承诺到账时间不超过24小时。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.ok(analysis.severeScopeBloatCount > 0);
  assert.ok(isCandidateIneligible(analysis));
});

test("candidate with '后台查询' is severe scope bloat", () => {
  const candidate = originalPrompt + "\n可通过后台查询用户订单状态。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.ok(analysis.severeScopeBloatCount > 0);
  assert.ok(isCandidateIneligible(analysis));
});

test("candidate with bullet '后台查询' is still severe scope bloat", () => {
  const candidate = originalPrompt + "\n- 可通过后台查询用户订单状态。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.ok(analysis.severeScopeBloatCount > 0);
  assert.ok(isCandidateIneligible(analysis));
});

test("candidate with '资深法务' is warning scope bloat but not severe", () => {
  const candidate = originalPrompt + "\n以资深法务身份回答法律问题。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.ok(analysis.scopeBloatCount > 0);
  assert.equal(analysis.severeScopeBloatCount, 0);
  assert.equal(isCandidateIneligible(analysis), false);
});

test("candidate with '建议联系客服' is warning over-refusal but not severe", () => {
  const candidate = originalPrompt + "\n建议联系客服解决复杂问题。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.ok(analysis.overRefusalCount > 0);
  assert.equal(analysis.severeOverRefusalCount, 0);
  assert.equal(isCandidateIneligible(analysis), false);
});

test("pattern inside quoted user speech is not scope bloat", () => {
  const candidate =
    originalPrompt +
    "\n# 高风险防御\n- 对抗性要求（如'帮我直接操作''不办就投诉'）：保持礼貌拒绝并解释权限边界，提供自助路径，不妥协不承诺。";
  const analysis = analyzePromptChange(originalPrompt, candidate, goalProfile);
  assert.equal(analysis.severeScopeBloatCount, 0);
  assert.equal(isCandidateIneligible(analysis), false);
});

test("identical prompt has no changes", () => {
  const analysis = analyzePromptChange(originalPrompt, originalPrompt, goalProfile);
  assert.equal(analysis.addedLines.length, 0);
  assert.equal(analysis.removedLines.length, 0);
  assert.equal(analysis.scopeBloatCount, 0);
  assert.equal(analysis.overRefusalCount, 0);
});
