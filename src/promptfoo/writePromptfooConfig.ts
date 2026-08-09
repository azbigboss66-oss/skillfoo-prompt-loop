/**
 * Promptfoo 配置文件写入器
 *
 * 将构建好的 Promptfoo 配置写入每次 run 的专用目录。
 * 配置只能写入 runs/<project>/<timestamp>/promptfoo/，不能覆盖项目根目录已有的文件。
 *
 * 官方文档：https://www.promptfoo.dev/docs/configuration/
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dump as yamlDump } from "js-yaml";
import {
  buildPromptfooConfig,
  type PromptfooConfigInput,
} from "./buildPromptfooConfig.js";

/**
 * Write a Promptfoo configuration file to a run directory.
 *
 * The config is written to `<runDir>/promptfoo/promptfooconfig.yaml`.
 * This function:
 * 1. Creates the `promptfoo/` subdirectory if it doesn't exist
 * 2. Builds the config from the input (includes validation)
 * 3. Serializes to YAML
 * 4. Writes the file
 *
 * @param runDir - The run directory (e.g., `runs/<project>/<timestamp>/`)
 * @param input - The SkillFoo config input
 * @returns The path to the written config file
 */
export async function writePromptfooConfig(
  runDir: string,
  input: PromptfooConfigInput,
  fileName = "promptfooconfig.yaml",
  header = "",
): Promise<string> {
  if (
    fileName !== "promptfooconfig.yaml" &&
    fileName !== "eval-config.yaml" &&
    fileName !== "optimize-config.yaml"
  ) {
    throw new Error(`Unsupported Promptfoo config artifact name: ${fileName}`);
  }

  // Build the config (includes validation)
  const config = buildPromptfooConfig(input);

  // Create the promptfoo subdirectory
  const promptfooDir = join(runDir, "promptfoo");
  await mkdir(promptfooDir, { recursive: true });

  // Serialize to YAML
  const yamlContent = yamlDump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  // Write the file
  const configPath = join(promptfooDir, fileName);
  await writeFile(configPath, `${header}${yamlContent}`, "utf-8");

  return configPath;
}
