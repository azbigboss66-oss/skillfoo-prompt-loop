export type PromptSpecSection =
  | "objective"
  | "scope_and_inputs"
  | "decision_rules"
  | "boundaries"
  | "output_contract"
  | "examples"
  | "variables";

export type PromptSpecMode = "off" | "advisory";

export interface PromptSpecAssessment {
  schemaVersion: "1.0";
  mode: PromptSpecMode;
  format: "structured" | "freeform";
  detectedSections: PromptSpecSection[];
  missingCoreSections: PromptSpecSection[];
  duplicateSections: PromptSpecSection[];
  unresolvedVariables: string[];
  emptySections: PromptSpecSection[];
  notes: string[];
}

export const CORE_SECTIONS: PromptSpecSection[] = [
  "objective",
  "scope_and_inputs",
  "decision_rules",
  "boundaries",
  "output_contract",
];

export const OPTIONAL_SECTIONS: PromptSpecSection[] = [
  "examples",
  "variables",
];

export const ALL_SECTIONS: PromptSpecSection[] = [
  ...CORE_SECTIONS,
  ...OPTIONAL_SECTIONS,
];

export const HEADING_SYNONYMS: Record<PromptSpecSection, string[]> = {
  objective: ["\u76EE\u6807", "\u4EFB\u52A1\u76EE\u6807", "objective", "task"],
  scope_and_inputs: ["\u8F93\u5165\u8303\u56F4", "\u9002\u7528\u8303\u56F4", "\u4E0A\u4E0B\u6587", "scope", "context"],
  decision_rules: ["\u51B3\u7B56\u6D41\u7A0B", "\u5904\u7406\u6D41\u7A0B", "\u89C4\u5219", "decision rules"],
  boundaries: ["\u8FB9\u754C", "\u9650\u5236", "\u7981\u6B62", "\u5B89\u5168\u8FB9\u754C", "constraints"],
  output_contract: ["\u8F93\u51FA\u683C\u5F0F", "\u8F93\u51FA\u8981\u6C42", "\u683C\u5F0F", "output format"],
  examples: ["\u793A\u4F8B", "examples"],
  variables: ["\u53D8\u91CF", "variables"],
};
