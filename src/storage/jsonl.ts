import { readFile, writeFile, appendFile } from "node:fs/promises";

/**
 * Write an array of records as JSONL (one JSON object per line).
 */
export async function writeJsonl(
  path: string,
  records: unknown[]
): Promise<void> {
  const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(path, lines, "utf-8");
}

/**
 * Read a JSONL file and return an array of parsed objects.
 * Throws on invalid JSON lines.
 */
export async function readJsonl<T>(path: string): Promise<T[]> {
  const raw = await readFile(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const results: T[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      throw new Error(`Invalid JSON in ${path}: ${line}`);
    }
  }
  return results;
}

/**
 * Append a single record as one JSONL line.
 */
export async function appendJsonl(
  path: string,
  record: unknown
): Promise<void> {
  const line = JSON.stringify(record) + "\n";
  await appendFile(path, line, "utf-8");
}
