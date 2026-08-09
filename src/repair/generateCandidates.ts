import type { ModelProvider } from "../providers/types.js";
import type { EvalResult, CandidatePrompt } from "../types.js";
import { CandidatePromptSchema } from "../types.js";
import { extractJson } from "../storage/extractJson.js";
import { callJson } from "../model/callJson.js";

/**
 * Generate candidate prompts based on the current prompt, goal,
 * and failed test results.
 *
 * Calls the provider with REPAIR_PROMPT_JSON marker and parses
 * the returned JSON array of candidates.
 */
export async function generateCandidates(
  provider: ModelProvider,
  currentPrompt: string,
  goal: string,
  repairCases: EvalResult[],
  candidateCount: number,
  runDir?: string,
  iteration?: number
): Promise<CandidatePrompt[]> {
  const repairSummary = repairCases
    .map(
      (r) =>
        `- 测试 ${r.testId} [${r.category}]: 用户输入="${r.userInput}", 模型回答="${r.modelOutput}", 问题原因="${r.reason}", 得分=${r.score}, pass=${r.pass}`
    )
    .join("\n");

  const systemContent = `你是一个 prompt 优化专家。请根据以下信息生成 ${candidateCount} 个改进后的 prompt 候选。

输出格式：只输出 JSON 数组，格式如下：
REPAIR_PROMPT_JSON
[
  {
    "id": "candidate-1",
    "hypothesis": "改进假设说明",
    "prompt": "完整的新版 prompt",
    "changeSummary": ["改动1", "改动2"]
  }
]

硬约束：
1. 必须输出完整 prompt，不是 diff。
2. 不能删除原 prompt 的核心任务。
3. 只能改 prompt，不能改 tests。
4. 不能为了某一道题写死答案。
5. 不能引用测试题编号。
6. 不能输出空 prompt。
7. 候选数量必须等于 ${candidateCount}。
8. 不能新增 goal.md 没有要求的身份、权威、工具、后台能力、业务流程或承诺。
9. 不能把可提供的通用建议全部推给人工客服。
10. 必须保留原始 prompt 的核心任务。
11. 必须根据 badcase 抽象规则，不能写死测试题。
12. 格式要求不能覆盖安全、隐私、事实边界和必要澄清。
13. 不能声称已为用户执行退款、操作后台、查询内部系统等 goal 未授权的能力。
14. 不能使用"任何问题都联系客服"、"一律拒绝"等一刀切拒绝表述。
15. 优先把可复用规则写进"决策流程"或"边界"，不要为了单一测试题增加特例。
16. 如果原 prompt 已有清晰结构，保留其结构；如果原 prompt 是自由文本，不要为了标题数量而改变业务含义。`;

  const userContent = `当前 prompt:
${currentPrompt}

目标:
${goal}

需要修复或增强的测试用例:
${repairSummary}

请生成 ${candidateCount} 个改进的 prompt 候选。`;

  const messages = [
    { role: "system" as const, content: systemContent },
    { role: "user" as const, content: userContent },
  ];

  function validateCandidates(value: unknown): CandidatePrompt[] {
    // Handle object-wrapped arrays (e.g., {"candidates": [...]})
    if (!Array.isArray(value)) {
      if (typeof value === "object" && value !== null) {
        const obj = value as Record<string, unknown>;
        if (Array.isArray(obj.candidates)) {
          value = obj.candidates;
        } else if (Array.isArray(obj.prompts)) {
          value = obj.prompts;
        } else if (Array.isArray(obj.data)) {
          value = obj.data;
        }
      }
    }
    if (!Array.isArray(value)) {
      throw new Error("repair candidates did not return a JSON array");
    }
    const candidates = value
      .map((c) => {
        try {
          return CandidatePromptSchema.parse(c);
        } catch {
          return null;
        }
      })
      .filter((c): c is CandidatePrompt => c !== null)
      .filter((c) => c.prompt.trim().length > 0);
    if (candidates.length === 0) {
      throw new Error("Failed to generate any valid candidate prompts");
    }
    return candidates;
  }

  if (runDir) {
    const stage = iteration !== undefined
      ? `repair-candidates-iter-${iteration}`
      : "repair-candidates";
    const result = await callJson<CandidatePrompt[]>(provider, {
      stage,
      runDir,
      messages,
      validate: validateCandidates,
    });
    return result.value;
  }

  // Legacy path without runDir
  const response = await provider.chat(messages);
  const parsed = extractJson<unknown[]>(response);
  if (parsed && Array.isArray(parsed)) {
    return validateCandidates(parsed);
  }
  throw new Error("Failed to generate any valid candidate prompts");
}
