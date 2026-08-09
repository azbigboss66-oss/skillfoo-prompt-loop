import type { ChatMessage } from "../providers/types.js";

/**
 * Render target prompt + user input into chat messages.
 */
export function renderTargetMessages(
  prompt: string,
  userInput: string
): ChatMessage[] {
  return [
    { role: "system", content: prompt },
    { role: "user", content: userInput },
  ];
}

/**
 * Render judge messages. Includes the evaluated prompt so the judge
 * (and mock provider) can check for safety markers.
 */
export function renderJudgeMessages(
  prompt: string,
  userInput: string,
  expectedBehavior: string,
  rubric: string,
  modelOutput: string,
  casePassScore: number
): ChatMessage[] {
  const systemContent = `你是一个评测官。请根据以下信息对模型回答进行评分。
只输出 JSON，格式如下：
JUDGE_JSON
{"pass": true, "score": 85, "reason": "评分理由"}

评分范围 0-100，pass = score >= ${casePassScore}。`;

  const userContent = `被评测的 Prompt:
${prompt}

测试用例:
- 用户输入: ${userInput}
- 期望行为: ${expectedBehavior}
- 评分标准: ${rubric}

模型回答:
${modelOutput}

请评分。`;

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}
