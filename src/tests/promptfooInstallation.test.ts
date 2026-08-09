/**
 * Promptfoo 安装检查测试
 *
 * 测试覆盖：
 * 1. 命令可用、版本可读取
 * 2. 命令不可用时返回明确错误
 * 3. 不吞掉异常
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPromptfooInstallation } from "../promptfoo/checkInstallation.js";

describe("promptfooInstallation", () => {
  it("checkPromptfooInstallation returns available=true and reads version", async () => {
    const result = await checkPromptfooInstallation();

    assert.ok(result.available, "promptfoo should be available");
    assert.ok(
      result.version.length > 0,
      "version should be a non-empty string"
    );
    assert.ok(
      result.version !== "unknown",
      "version should not be 'unknown' when available"
    );
    // Version should look like a semver or numeric version
    assert.match(
      result.version,
      /^\d+\.\d+/,
      "version should start with a number"
    );
  });

  it("checkPromptfooInstallation returns structured result with version and available fields", async () => {
    const result = await checkPromptfooInstallation();

    assert.ok(
      typeof result.version === "string",
      "version should be a string"
    );
    assert.ok(
      typeof result.available === "boolean",
      "available should be a boolean"
    );
  });

  it("checkPromptfooInstallation does not swallow exceptions silently", async () => {
    // When promptfoo is available, the function should return available=true.
    // When it's not available, the function should return available=false
    // with an error message in the version field, not throw or return undefined.
    const result = await checkPromptfooInstallation();

    // The function must always return a result, never throw
    assert.ok(result !== undefined, "result should not be undefined");
    assert.ok(result !== null, "result should not be null");

    if (!result.available) {
      // When not available, version should contain error info
      assert.ok(
        result.version.length > 0,
        "error message should be in version field when not available"
      );
    }
  });
});
