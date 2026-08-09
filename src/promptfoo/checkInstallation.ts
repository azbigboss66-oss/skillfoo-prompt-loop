/**
 * Promptfoo 安装检查
 *
 * 检查 promptfoo 是否已安装且 CLI 可用。
 * 官方文档：https://www.promptfoo.dev/docs/usage/command-line/
 */

import { execSync } from "child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PromptfooInstallationResult } from "./types.js";

const promptfooRequire = createRequire(import.meta.url);

function readLocalPromptfooVersion(): string | undefined {
  try {
    const mainPath = promptfooRequire.resolve("promptfoo");
    const packagePath = join(dirname(mainPath), "..", "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      version?: string;
    };
    return packageJson.version;
  } catch {
    return undefined;
  }
}

/**
 * 检查 promptfoo CLI 是否已安装且可用。
 *
 * 使用 npx promptfoo --version 来检查。
 * 不吞掉异常；命令不可用时返回 available=false 并附带错误信息。
 *
 * @returns {Promise<PromptfooInstallationResult>} 安装检查结果
 */
export function checkPromptfooInstallation(): Promise<PromptfooInstallationResult> {
  return new Promise((resolve) => {
    const localVersion = readLocalPromptfooVersion();
    if (localVersion) {
      resolve({ version: localVersion, available: true });
      return;
    }

    try {
      // execSync already runs in a shell by default, which resolves npx on Windows
      const output = execSync("npx promptfoo --version", {
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Newer Promptfoo CLI versions may print an upgrade notice before the
      // actual version. Keep the report machine-readable by extracting the
      // first semver-looking token instead of storing the whole notice.
      const version = output.match(/\b\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?\b/)?.[0]
        ?? output.trim();

      if (version && version.length > 0) {
        resolve({
          version,
          available: true,
        });
      } else {
        resolve({
          version: "unknown",
          available: false,
        });
      }
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : String(err);

      resolve({
        version: `error: ${errorMessage}`,
        available: false,
      });
    }
  });
}
