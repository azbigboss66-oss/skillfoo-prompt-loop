export const GOAL_SECTIONS = {
  businessGoal: ["业务目标", "Business Goal"],
  users: ["用户类型", "Users"],
  allowedCapabilities: ["助手可以做什么", "Allowed Capabilities"],
  forbiddenActions: ["助手不能做什么", "Forbidden Actions"],
  clarificationRules: ["必须先澄清的情况", "Clarification Rules"],
  highRiskScenarios: ["高风险场景", "High Risk Scenarios"],
  goodAnswer: ["高分回答标准", "Good Answer"],
  badAnswer: ["低分或失败标准", "Bad Answer"],
  style: ["输出风格", "Style"],
} as const;

/**
 * Extract the content under a markdown section identified by any of the given titles.
 * Returns the text between the section header and the next header (or end of document).
 */
export function sectionContent(markdown: string, titles: readonly string[]): string {
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    for (const title of titles) {
      if (line === `# ${title}` || line === `## ${title}`) {
        // Collect content until next header or end
        const content: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (nextLine.startsWith("# ") || nextLine.startsWith("## ")) {
            break;
          }
          content.push(lines[j]);
        }
        return content.join("\n").trim();
      }
    }
  }
  return "";
}

/**
 * Count bullet points (lines starting with - or *) in the given text.
 */
export function bulletCount(text: string): number {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("- ") || trimmed.startsWith("* ");
    })
    .length;
}

/**
 * Check if the text contains any of the given words (case-insensitive for ASCII).
 */
export function containsAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}
