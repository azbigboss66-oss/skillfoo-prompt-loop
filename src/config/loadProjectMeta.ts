import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectConfig, EvaluationPolicy } from "./loadProject.js";

export interface ProjectMeta {
  projectDir: string;
  prompt: string;
  goal: string;
  config: ProjectConfig;
  evaluationPolicy: EvaluationPolicy;
}

export function buildEvaluationPolicy(config: ProjectConfig): EvaluationPolicy {
  const casePassScore = Number(config.casePassScore ?? 80);
  const repairScoreThreshold = Number(config.repairScoreThreshold ?? 85);

  if (!Number.isFinite(casePassScore) || casePassScore < 0 || casePassScore > 100) {
    throw new Error("casePassScore must be a number between 0 and 100");
  }

  if (
    !Number.isFinite(repairScoreThreshold) ||
    repairScoreThreshold < 0 ||
    repairScoreThreshold > 100
  ) {
    throw new Error("repairScoreThreshold must be a number between 0 and 100");
  }

  return { casePassScore, repairScoreThreshold };
}

export async function loadProjectMeta(projectDir: string): Promise<ProjectMeta> {
  const promptPath = join(projectDir, "prompt.md");
  const goalPath = join(projectDir, "goal.md");
  const configPath = join(projectDir, "skillfoo.config.json");

  const prompt = (await readFile(promptPath, "utf-8")).trim();
  const goal = (await readFile(goalPath, "utf-8")).trim();
  const configRaw = await readFile(configPath, "utf-8");
  const config = JSON.parse(configRaw) as ProjectConfig;

  return {
    projectDir,
    prompt,
    goal,
    config,
    evaluationPolicy: buildEvaluationPolicy(config),
  };
}
