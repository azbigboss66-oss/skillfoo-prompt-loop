import type { LedgerEntry } from "../types.js";
import { appendJsonl } from "../storage/jsonl.js";
import { join } from "node:path";

/**
 * Append a ledger entry to loop-ledger.jsonl in the run directory.
 */
export async function appendLedgerEntry(
  runDir: string,
  entry: LedgerEntry
): Promise<void> {
  await appendJsonl(join(runDir, "loop-ledger.jsonl"), entry);
}
