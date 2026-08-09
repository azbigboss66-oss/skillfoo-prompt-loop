import { z } from "zod";
import type { BeforeAfterComparison } from "./report/compareResults.js";
import type { PromptChangeAnalysis } from "./report/analyzePromptChange.js";

// 5.1 TestCase
export const TestCaseSchema = z.object({
  id: z.string().min(1),
  category: z.enum([
    "normal",
    "edge",
    "adversarial",
    "hallucination",
    "privacy",
    "format",
    "ambiguity",
  ]),
  userInput: z.string().min(1),
  expectedBehavior: z.string().min(1),
  rubric: z.string().min(1),
  weight: z.number().positive().default(1),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

// 5.2 EvalResult
export const EvalResultSchema = z.object({
  testId: z.string(),
  category: z.string(),
  promptVersion: z.string(),
  userInput: z.string(),
  modelOutput: z.string(),
  pass: z.boolean(),
  score: z.number().min(0).max(100),
  reason: z.string(),
  weight: z.number().positive(),
  error: z.string().optional(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;

// 5.3 Summary
export const SummarySchema = z.object({
  promptVersion: z.string(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  passRate: z.number(),
  weightedAverageScore: z.number(),
  finalScore: z.number(),
});
export type Summary = z.infer<typeof SummarySchema>;

// 5.4 CandidatePrompt
export const CandidatePromptSchema = z.object({
  id: z.string(),
  hypothesis: z.string(),
  prompt: z.string().min(1),
  changeSummary: z.array(z.string()),
});
export type CandidatePrompt = z.infer<typeof CandidatePromptSchema>;

// 5.5 LedgerEntry
export const LedgerEntrySchema = z.object({
  iteration: z.number(),
  promptVersion: z.string(),
  status: z.enum([
    "baseline",
    "keep",
    "rollback",
    "stop_already_passed",
    "stop_max_iters",
    "stop_no_repair_cases",
    "blocked",
  ]),
  score: z.number(),
  passRate: z.number(),
  passed: z.number(),
  failed: z.number(),
  summary: z.string(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const TestAuditIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
  testId: z.string().optional(),
});
export type TestAuditIssue = z.infer<typeof TestAuditIssueSchema>;

export const TestAuditSummarySchema = z.object({
  total: z.number(),
  testQualityScore: z.number(),
  schemaScore: z.number(),
  coverageScore: z.number(),
  highRiskBalanceScore: z.number(),
  uniquenessScore: z.number(),
  leakageScore: z.number(),
  rubricQualityScore: z.number(),
  goalTraceabilityScore: z.number(),
  duplicateRatio: z.number(),
  highRiskRatio: z.number(),
  categoryCounts: z.record(z.number()),
  pass: z.boolean(),
  issues: z.array(TestAuditIssueSchema),
  publicHoldoutNearDuplicateRatio: z.number().optional(),
});
export type TestAuditSummary = z.infer<typeof TestAuditSummarySchema>;

// V4: GoalAuditSummary
export const GoalAuditIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
  section: z.string().optional(),
});
export type GoalAuditIssue = z.infer<typeof GoalAuditIssueSchema>;

export const GoalAuditSummarySchema = z.object({
  goalReadinessScore: z.number(),
  canProceed: z.boolean(),
  missingRequiredSections: z.array(z.string()),
  weakSections: z.array(z.string()),
  detectedCapabilities: z.array(z.string()),
  detectedForbiddenActions: z.array(z.string()),
  detectedRiskTypes: z.array(z.string()),
  issues: z.array(GoalAuditIssueSchema),
});
export type GoalAuditSummary = z.infer<typeof GoalAuditSummarySchema>;

// V5: Optimization Engine — selects between promptfoo-based and legacy evaluator
export const OptimizationEngineSchema = z.enum(["promptfoo", "legacy"]);
export type OptimizationEngine = z.infer<typeof OptimizationEngineSchema>;

// V5: Runtime Config — controls concurrency, caching, retries, and repetition
export const RuntimeConfigSchema = z.object({
  maxConcurrency: z.number().int().positive().default(2),
  cache: z.boolean().default(true),
  retryErrors: z.boolean().default(true),
  repeat: z.number().int().positive().default(1),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// V5: Optimization Config — controls validation split and loop parameters
export const OptimizationConfigSchema = z.object({
  validationSplit: z.number().min(0).max(0.5).default(0.2),
  maxIters: z.number().int().positive().default(2),
  minImprovement: z.number().min(0).default(2),
});
export type OptimizationConfig = z.infer<typeof OptimizationConfigSchema>;


// V6: Public Keep Gate types
export interface PublicKeepGateInput {
  currentScore: number;
  candidateScore: number;
  minImprovement: number;
  currentResults: EvalResult[];
  candidateResults: EvalResult[];
  repairScoreThreshold: number;
  analysis: PromptChangeAnalysis;
}

export interface PublicKeepGateDecision {
  eligible: boolean;
  reasons: string[];
  comparison: BeforeAfterComparison;
  criticalFailuresAfter: number;
}

// V6: Release Gate types
export type ReleaseStatus =
  | "released_public_best"
  | "released_baseline_no_public_keep"
  | "final_holdout_rollback"
  | "unverified_no_holdout";

export interface ReleaseGateInput {
  publicKeepOccurred: boolean;
  publicBestPromptVersion?: string;
  baselineHoldoutResults?: EvalResult[];
  candidateHoldoutResults?: EvalResult[];
  repairScoreThreshold: number;
}

export interface ReleaseDecision {
  status: ReleaseStatus;
  releasedPromptVersion: "baseline" | string;
  reasons: string[];
  holdoutComparison?: BeforeAfterComparison;
  holdoutDelta?: number;
  criticalFailuresAfter?: number;
}

// V6 Compact: Output mode and run log types
export type OutputMode = "compact" | "debug";

export interface RunLogEvent {
  schemaVersion: "1.0";
  seq: number;
  timestamp: string;
  eventType:
    | "run_started"
    | "baseline_evaluated"
    | "baseline_holdout_evaluated"
    | "candidate_generated"
    | "candidate_evaluated"
    | "candidate_decided"
    | "holdout_evaluated"
    | "release_decided"
    | "run_completed"
    | "run_failed";
  runId: string;
  data: Record<string, unknown>;
}
