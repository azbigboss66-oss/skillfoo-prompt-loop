import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

/**
 * Format a Date as a filesystem-safe timestamp: 2026-07-30T18-30-00
 */
export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Return the run directory path: runs/<projectName>/<timestamp>
 */
export function getRunDir(projectName: string, timestamp: string): string {
  return join("runs", projectName, timestamp);
}

/**
 * Create the run directory and update LATEST_RUN.txt.
 * On Windows we use a plain text file instead of a symlink.
 */
export async function createRunDir(
  projectName: string,
  timestamp: string
): Promise<string> {
  const runDir = getRunDir(projectName, timestamp);
  await mkdir(runDir, { recursive: true });

  // Update LATEST_RUN.txt with the timestamp directory name
  const projectRunsDir = join("runs", projectName);
  const latestPath = join(projectRunsDir, "LATEST_RUN.txt");
  await writeFile(latestPath, timestamp, "utf-8");

  return runDir;
}

/**
 * Return the path to the LATEST_RUN.txt file for a project.
 */
export function getLatestRunFile(projectName: string): string {
  return join("runs", projectName, "LATEST_RUN.txt");
}
