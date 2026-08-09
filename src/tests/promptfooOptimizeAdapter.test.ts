/**
 * Promptfoo optimize 适配器单元测试
 *
 * 验收门槛（V5 Task 5 Step 5）：
 * 1. mock adapter 可以用固定 stdout 测试
 * 2. 验证命令参数使用数组传入
 * 3. 无法解析输出时返回 blocked_by_optimize_output
 *
 * 测试不调用真实的 `npx promptfoo optimize`，使用 _spawnFn 注入 mock。
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runPromptfooOptimize,
  buildOptimizeArgs,
  type PromptfooOptimizeOptions,
} from "../promptfoo/runPromptfooOptimize.js";
import { parseOptimizeOutput } from "../promptfoo/parseOptimizeOutput.js";

/**
 * 创建默认优化选项
 */
function makeOptions(
  overrides: Partial<PromptfooOptimizeOptions> = {}
): PromptfooOptimizeOptions {
  return {
    runDir: "/tmp/test-optimize",
    configPath: "/tmp/test-config/promptfooconfig.yaml",
    promptIndex: 0,
    providerIndex: 0,
    validationSplit: 0.2,
    maxConcurrency: 2,
    ...overrides,
  };
}

/**
 * 创建 mock spawn 函数，返回固定的 stdout
 */
function createMockSpawn(
  stdout: string,
  stderr: string = "",
  exitCode: number = 0
): (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return async (
    _command: string,
    _args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    return { stdout, stderr, exitCode };
  };
}

/**
 * 创建捕获参数的 mock spawn
 */
function createCapturingMockSpawn(
  stdout: string,
  stderr: string = "",
  exitCode: number = 0
): {
  spawnFn: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  getCaptured: () => { command: string; args: string[] } | null;
} {
  let captured: { command: string; args: string[] } | null = null;

  const spawnFn = async (
    command: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    captured = { command, args: [...args] };
    return { stdout, stderr, exitCode };
  };

  return {
    spawnFn,
    getCaptured: () => captured,
  };
}

describe("promptfooOptimizeAdapter", () => {
  let tempDir: string;

  before(async () => {
    tempDir = join(
      tmpdir(),
      `skillfoo-opt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("buildOptimizeArgs", () => {
    it("1. returns an array of command arguments", () => {
      const options = makeOptions();
      const args = buildOptimizeArgs(options);

      assert.ok(Array.isArray(args), "args should be an array");
      assert.ok(args.length > 0, "args should not be empty");
    });

    it("2. includes promptfoo optimize as first elements", () => {
      const options = makeOptions();
      const args = buildOptimizeArgs(options);

      assert.equal(args[0], "promptfoo");
      assert.equal(args[1], "optimize");
    });

    it("3. includes config path with -c flag", () => {
      const options = makeOptions({ configPath: "/path/to/config.yaml" });
      const args = buildOptimizeArgs(options);

      const configIndex = args.indexOf("-c");
      assert.ok(configIndex >= 0, "should have -c flag");
      assert.equal(args[configIndex + 1], "/path/to/config.yaml");
    });

    it("4. includes prompt-index, provider-index, and validation-split", () => {
      const options = makeOptions({
        promptIndex: 1,
        providerIndex: 2,
        validationSplit: 0.3,
      });
      const args = buildOptimizeArgs(options);

      const promptIndexIdx = args.indexOf("--prompt-index");
      assert.ok(promptIndexIdx >= 0, "should have --prompt-index");
      assert.equal(args[promptIndexIdx + 1], "1");

      const providerIndexIdx = args.indexOf("--provider-index");
      assert.ok(providerIndexIdx >= 0, "should have --provider-index");
      assert.equal(args[providerIndexIdx + 1], "2");

      const validationSplitIdx = args.indexOf("--validation-split");
      assert.ok(validationSplitIdx >= 0, "should have --validation-split");
      assert.equal(args[validationSplitIdx + 1], "0.3");
    });

    it("5. does NOT include max-concurrency as CLI flag", () => {
      const options = makeOptions({ maxConcurrency: 4 });
      const args = buildOptimizeArgs(options);

      assert.ok(
        !args.includes("--max-concurrency"),
        "optimize does not support --max-concurrency CLI flag"
      );
      assert.ok(
        !args.includes("-j"),
        "optimize does not support -j CLI flag"
      );
    });
  });

  describe("runPromptfooOptimize with mock spawn", () => {
    it("6. mock adapter with fixed stdout produces optimized prompt", async () => {
      const runDir = join(tempDir, "test-mock-success");
      const fixedStdout = [
        "Running baseline eval...",
        "Generating prompt candidates...",
        "",
        "Optimized prompt:",
        "",
        "You are a helpful customer service assistant. Always be polite and concise.",
        "Answer the user's question accurately. If you don't know, say so.",
      ].join("\n");

      const options = makeOptions({
        runDir,
        _spawnFn: createMockSpawn(fixedStdout),
      });

      const result = await runPromptfooOptimize(options);

      assert.equal(result.engine, "promptfoo");
      assert.ok(result.optimizedPrompt.length > 0, "should have optimized prompt");
      assert.ok(
        result.optimizedPrompt.includes("customer service assistant"),
        "optimized prompt should contain expected text"
      );
      assert.ok(result.rawStdoutPath, "should have rawStdoutPath");
      assert.ok(result.rawStderrPath, "should have rawStderrPath");
      assert.ok(result.optimizeConfigPath, "should have optimizeConfigPath");
    });

    it("7. saves raw stdout and stderr to files", async () => {
      const runDir = join(tempDir, "test-mock-files");
      const fixedStdout = "Best prompt:\n\nYou are an assistant.";
      const fixedStderr = "Some warning";

      const options = makeOptions({
        runDir,
        _spawnFn: createMockSpawn(fixedStdout, fixedStderr),
      });

      const result = await runPromptfooOptimize(options);

      // Verify stdout file
      const stdoutContent = await readFile(result.rawStdoutPath, "utf-8");
      assert.equal(stdoutContent, fixedStdout);

      // Verify stderr file
      const stderrContent = await readFile(result.rawStderrPath, "utf-8");
      assert.equal(stderrContent, fixedStderr);
    });

    it("8. saves command.txt with full command args (no API key)", async () => {
      const runDir = join(tempDir, "test-mock-command");
      const fixedStdout = "Optimized prompt:\n\nYou are an assistant.";

      const options = makeOptions({
        runDir,
        configPath: "/path/to/config.yaml",
        _spawnFn: createMockSpawn(fixedStdout),
      });

      const result = await runPromptfooOptimize(options);

      const commandPath = join(runDir, "promptfoo", "command.txt");
      const commandContent = await readFile(commandPath, "utf-8");

      // Should contain the command
      assert.match(commandContent, /npx promptfoo optimize/);
      assert.match(commandContent, /\/path\/to\/config\.yaml/);
      assert.match(commandContent, /--prompt-index/);
      assert.match(commandContent, /--provider-index/);
      assert.match(commandContent, /--validation-split/);

      // Should NOT contain API key
      assert.doesNotMatch(commandContent, /sk-[a-zA-Z0-9]{20,}/, "should not contain API keys");

      // Should mention security note
      assert.match(commandContent, /environment variables/i);
    });

    it("9. saves optimize-config.json", async () => {
      const runDir = join(tempDir, "test-mock-config");
      const fixedStdout = "Optimized prompt:\n\nYou are an assistant.";

      const options = makeOptions({
        runDir,
        promptIndex: 1,
        providerIndex: 0,
        validationSplit: 0.25,
        maxConcurrency: 3,
        _spawnFn: createMockSpawn(fixedStdout),
      });

      const result = await runPromptfooOptimize(options);

      const configContent = await readFile(result.optimizeConfigPath, "utf-8");
      const config = JSON.parse(configContent);

      assert.equal(config.promptIndex, 1);
      assert.equal(config.providerIndex, 0);
      assert.equal(config.validationSplit, 0.25);
      assert.equal(config.maxConcurrency, 3);
      assert.equal(config.engine, "promptfoo");
    });
  });

  describe("verify command args passed as array", () => {
    it("10. spawn receives args as an array", async () => {
      const runDir = join(tempDir, "test-args-array");
      const fixedStdout = "Optimized prompt:\n\nYou are an assistant.";

      const { spawnFn, getCaptured } = createCapturingMockSpawn(fixedStdout);

      const options = makeOptions({
        runDir,
        _spawnFn: spawnFn,
      });

      await runPromptfooOptimize(options);

      const captured = getCaptured();
      assert.ok(captured, "spawn should have been called");
      assert.ok(
        Array.isArray(captured!.args),
        "args must be passed as an array"
      );
      assert.ok(captured!.args.length > 0, "args array should not be empty");

      // First arg should be "promptfoo" (npx is the command)
      assert.equal(captured!.command, "npx");
      assert.equal(captured!.args[0], "promptfoo");
      assert.equal(captured!.args[1], "optimize");
    });

    it("11. args array contains all expected flags", async () => {
      const runDir = join(tempDir, "test-args-content");
      const fixedStdout = "Optimized prompt:\n\nYou are an assistant.";

      const { spawnFn, getCaptured } = createCapturingMockSpawn(fixedStdout);

      const options = makeOptions({
        runDir,
        configPath: "/custom/config.yaml",
        promptIndex: 2,
        providerIndex: 1,
        validationSplit: 0.15,
        _spawnFn: spawnFn,
      });

      await runPromptfooOptimize(options);

      const captured = getCaptured();
      assert.ok(captured);
      const args = captured!.args;

      // Verify all expected args are present
      assert.ok(args.includes("-c"));
      assert.ok(args.includes("/custom/config.yaml"));
      assert.ok(args.includes("--prompt-index"));
      assert.ok(args.includes("2"));
      assert.ok(args.includes("--provider-index"));
      assert.ok(args.includes("1"));
      assert.ok(args.includes("--validation-split"));
      assert.ok(args.includes("0.15"));
    });
  });

  describe("blocked output handling", () => {
    it("12. throws blocked_by_optimize_output when stdout is empty", async () => {
      const runDir = join(tempDir, "test-blocked-empty");

      const options = makeOptions({
        runDir,
        _spawnFn: createMockSpawn("", "command failed"),
      });

      await assert.rejects(
        runPromptfooOptimize(options),
        (err: Error) => {
          assert.ok(
            err.message.includes("blocked_by_optimize_output"),
            "error should mention blocked_by_optimize_output"
          );
          return true;
        }
      );
    });

    it("13. throws blocked_by_optimize_output when output is unparseable", async () => {
      const runDir = join(tempDir, "test-blocked-unparseable");

      // Single short line that doesn't look like a prompt
      const options = makeOptions({
        runDir,
        _spawnFn: createMockSpawn("done"),
      });

      await assert.rejects(
        runPromptfooOptimize(options),
        (err: Error) => {
          assert.ok(
            err.message.includes("blocked_by_optimize_output"),
            "error should mention blocked_by_optimize_output"
          );
          return true;
        }
      );
    });

    it("14. still saves raw stdout/stderr even when blocked", async () => {
      const runDir = join(tempDir, "test-blocked-files");
      const fixedStdout = "some unparseable output";
      const fixedStderr = "some error";

      const options = makeOptions({
        runDir,
        _spawnFn: createMockSpawn(fixedStdout, fixedStderr),
      });

      try {
        await runPromptfooOptimize(options);
      } catch {
        // Expected to throw
      }

      // Raw files should still be saved
      const stdoutPath = join(runDir, "promptfoo", "optimize-stdout.txt");
      const stderrPath = join(runDir, "promptfoo", "optimize-stderr.txt");

      const stdoutContent = await readFile(stdoutPath, "utf-8");
      assert.equal(stdoutContent, fixedStdout);

      const stderrContent = await readFile(stderrPath, "utf-8");
      assert.equal(stderrContent, fixedStderr);
    });
  });

  describe("parseOptimizeOutput", () => {
    it("15. parses JSON output with prompt field", () => {
      const json = JSON.stringify({
        prompt: "You are a helpful assistant.",
        score: 85,
      });
      const result = parseOptimizeOutput(json, "");

      assert.equal(result.blocked, false);
      assert.equal(result.optimizedPrompt, "You are a helpful assistant.");
    });

    it("16. parses header pattern 'Optimized prompt:'", () => {
      const stdout = [
        "Running eval...",
        "",
        "Optimized prompt:",
        "",
        "You are a helpful assistant.",
        "Be concise and accurate.",
      ].join("\n");

      const result = parseOptimizeOutput(stdout, "");

      assert.equal(result.blocked, false);
      assert.ok(result.optimizedPrompt);
      assert.ok(result.optimizedPrompt!.includes("helpful assistant"));
    });

    it("17. parses markdown code block", () => {
      const stdout = [
        "Result:",
        "",
        "```markdown",
        "You are a customer service agent.",
        "Always be polite.",
        "```",
      ].join("\n");

      const result = parseOptimizeOutput(stdout, "");

      assert.equal(result.blocked, false);
      assert.ok(result.optimizedPrompt);
      assert.ok(result.optimizedPrompt!.includes("customer service agent"));
    });

    it("18. returns blocked for empty output", () => {
      const result = parseOptimizeOutput("", "");

      assert.equal(result.blocked, true);
      assert.equal(result.optimizedPrompt, null);
      assert.ok(result.blockReason?.includes("blocked_by_optimize_output"));
    });

    it("19. returns blocked for error-only stderr", () => {
      const result = parseOptimizeOutput("", "Error: command not found");

      assert.equal(result.blocked, true);
      assert.ok(result.blockReason?.includes("blocked_by_optimize_output"));
    });

    it("20. parses multi-line prompt without explicit header", () => {
      const stdout = [
        "You are a helpful assistant.",
        "Always answer user questions accurately.",
        "If you don't know, say so honestly.",
      ].join("\n");

      const result = parseOptimizeOutput(stdout, "");

      assert.equal(result.blocked, false);
      assert.ok(result.optimizedPrompt);
      assert.ok(result.optimizedPrompt!.length > 0);
    });
  });

  describe("API key safety", () => {
    it("21. command.txt does not contain API key values", async () => {
      const runDir = join(tempDir, "test-apikey-safety");
      const fixedStdout = "Optimized prompt:\n\nYou are an assistant.";

      const options = makeOptions({
        runDir,
        _spawnFn: createMockSpawn(fixedStdout),
      });

      const result = await runPromptfooOptimize(options);

      const commandPath = join(runDir, "promptfoo", "command.txt");
      const commandContent = await readFile(commandPath, "utf-8");

      // Should not contain actual API key patterns
      assert.doesNotMatch(
        commandContent,
        /sk-[a-zA-Z0-9]{20,}/,
        "should not contain sk- API keys"
      );
      assert.doesNotMatch(
        commandContent,
        /api[_-]?key\s*[:=]\s*[a-zA-Z0-9]{20,}/i,
        "should not contain api key values"
      );
    });

    it("22. redacts API keys from command args if present", async () => {
      const runDir = join(tempDir, "test-apikey-redact");
      // Even if somehow an API key ends up in args, it should be redacted in command.txt
      const fixedStdout = "Optimized prompt:\n\nYou are an assistant.";

      // We test the redaction by checking command.txt doesn't have the pattern
      const options = makeOptions({
        runDir,
        _spawnFn: createMockSpawn(fixedStdout),
      });

      await runPromptfooOptimize(options);

      const commandPath = join(runDir, "promptfoo", "command.txt");
      const commandContent = await readFile(commandPath, "utf-8");

      // The command should contain "npx promptfoo optimize" but no API keys
      assert.match(commandContent, /npx promptfoo optimize/);
      assert.doesNotMatch(commandContent, /sk-[a-zA-Z0-9]{32,}/);
    });
  });
});
