import { writeFile } from "node:fs/promises";
import type { RunLogEvent } from "../types.js";

/**
 * RunLogWriter accumulates run-log events in memory and flushes them
 * to a JSONL file on demand. Each event has a monotonically increasing
 * sequence number starting from 1.
 */
export class RunLogWriter {
  private events: RunLogEvent[] = [];
  private seq = 0;

  constructor(private runId: string) {}

  log(
    eventType: RunLogEvent["eventType"],
    data: Record<string, unknown>,
  ): void {
    this.seq++;
    this.events.push({
      schemaVersion: "1.0",
      seq: this.seq,
      timestamp: new Date().toISOString(),
      eventType,
      runId: this.runId,
      data,
    });
  }

  getEvents(): readonly RunLogEvent[] {
    return this.events;
  }

  getEventCount(): number {
    return this.events.length;
  }

  async flush(filePath: string): Promise<void> {
    const lines = this.events.map((e) => JSON.stringify(e));
    const content = lines.length > 0 ? lines.join("\n") + "\n" : "";
    await writeFile(filePath, content, "utf-8");
  }
}
