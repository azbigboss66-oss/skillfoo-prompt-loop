import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, ModelProvider } from "../providers/types.js";
import { extractJson } from "../storage/extractJson.js";

export class JsonCallFailedError extends Error {
  constructor(
    public readonly stage: string,
    public readonly attempts: number,
    public readonly repairAttempts: number
  ) {
    super(`JSON call failed at stage ${stage} after ${attempts} attempts and ${repairAttempts} repair attempts`);
  }
}

export interface JsonCallResult<T> {
  value: T;
  attempts: number;
  repairAttempts: number;
  rawResponses: string[];
  recovered: boolean;
}

export interface CallJsonOptions<T> {
  stage: string;
  runDir: string;
  messages: ChatMessage[];
  validate(value: unknown): T;
  maxAttempts?: number;
}

async function saveRaw(runDir: string, stage: string, name: string, text: string): Promise<void> {
  const dir = join(runDir, "raw-responses", stage);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), text, "utf-8");
}

function repairMessages(text: string): ChatMessage[] {
  return [
    {
      role: "system",
      content: "你是 JSON 修复器。只输出合法 JSON，不要解释，不要 markdown。",
    },
    {
      role: "user",
      content: `请把下面内容修复为合法 JSON。保留原有字段和含义，不要新增业务内容。\n\n${text}`,
    },
  ];
}

export async function callJson<T>(
  provider: ModelProvider,
  options: CallJsonOptions<T>
): Promise<JsonCallResult<T>> {
  const maxAttempts = options.maxAttempts ?? 3;
  const rawResponses: string[] = [];
  let repairAttempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await provider.chat(options.messages);
    rawResponses.push(raw);
    await saveRaw(options.runDir, options.stage, `attempt-${attempt}.txt`, raw);

    const parsed = extractJson(raw);
    if (parsed !== null) {
      try {
        return {
          value: options.validate(parsed),
          attempts: attempt,
          repairAttempts,
          rawResponses,
          recovered: repairAttempts > 0,
        };
      } catch {
        // Validation failed, fall through to repair
      }
    }

    repairAttempts++;
    const repairedRaw = await provider.chat(repairMessages(raw));
    rawResponses.push(repairedRaw);
    await saveRaw(options.runDir, options.stage, `attempt-${attempt}-repair-1.txt`, repairedRaw);

    const repaired = extractJson(repairedRaw);
    if (repaired !== null) {
      try {
        return {
          value: options.validate(repaired),
          attempts: attempt,
          repairAttempts,
          rawResponses,
          recovered: true,
        };
      } catch {
        // Validation failed after repair, continue to next attempt
      }
    }
  }

  throw new JsonCallFailedError(options.stage, maxAttempts, repairAttempts);
}
