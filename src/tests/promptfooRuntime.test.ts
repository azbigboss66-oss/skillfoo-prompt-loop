/**
 * Promptfoo 运行可靠性选项测试
 *
 * 测试覆盖：
 * 1. parseRuntimeOptions 默认值
 * 2. parseRuntimeOptions 自定义参数解析
 * 3. parseRuntimeOptions 参数验证（非法值抛出错误）
 * 4. parseRuntimeOptions cache/noCache 优先级
 * 5. buildEvaluateOptions 生成正确的配置对象
 * 6. buildEvaluateOptions resume/retryErrors 条件包含
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRuntimeOptions,
  buildEvaluateOptions,
  DEFAULT_RUNTIME_OPTIONS,
  type PromptfooRuntimeOptions,
} from "../promptfoo/runtimeOptions.js";

describe("parseRuntimeOptions", () => {
  it("1. should return default values when no args provided", () => {
    const result = parseRuntimeOptions({});

    assert.equal(result.maxConcurrency, 2, "default maxConcurrency should be 2");
    assert.equal(result.repeat, 1, "default repeat should be 1");
    assert.equal(result.cache, true, "default cache should be true");
    assert.equal(result.resume, false, "default resume should be false");
    assert.equal(result.retryErrors, false, "default retryErrors should be false");
  });

  it("2. should return default values when all fields are undefined", () => {
    const result = parseRuntimeOptions({
      maxConcurrency: undefined,
      repeat: undefined,
      cache: undefined,
      noCache: undefined,
      resume: undefined,
      retryErrors: undefined,
    });

    assert.deepEqual(result, DEFAULT_RUNTIME_OPTIONS, "should match DEFAULT_RUNTIME_OPTIONS");
  });

  it("3. should parse maxConcurrency from string", () => {
    const result = parseRuntimeOptions({ maxConcurrency: "4" });
    assert.equal(result.maxConcurrency, 4, "maxConcurrency should be parsed as 4");
  });

  it("4. should parse repeat from string", () => {
    const result = parseRuntimeOptions({ repeat: "3" });
    assert.equal(result.repeat, 3, "repeat should be parsed as 3");
  });

  it("5. should parse cache=true explicitly", () => {
    const result = parseRuntimeOptions({ cache: true });
    assert.equal(result.cache, true, "cache should be true");
  });

  it("6. should parse noCache=true (overrides default)", () => {
    const result = parseRuntimeOptions({ noCache: true });
    assert.equal(result.cache, false, "cache should be false when noCache is true");
  });

  it("7. should let noCache take precedence over cache=true", () => {
    const result = parseRuntimeOptions({ cache: true, noCache: true });
    assert.equal(result.cache, false, "noCache should take precedence over cache");
  });

  it("8. should parse cache=false explicitly", () => {
    const result = parseRuntimeOptions({ cache: false });
    assert.equal(result.cache, false, "cache should be false");
  });

  it("9. should parse resume=true", () => {
    const result = parseRuntimeOptions({ resume: true });
    assert.equal(result.resume, true, "resume should be true");
  });

  it("10. should parse retryErrors=true", () => {
    const result = parseRuntimeOptions({ retryErrors: true });
    assert.equal(result.retryErrors, true, "retryErrors should be true");
  });

  it("11. should parse all custom values together", () => {
    const result = parseRuntimeOptions({
      maxConcurrency: "8",
      repeat: "5",
      noCache: true,
      resume: true,
      retryErrors: true,
    });

    assert.equal(result.maxConcurrency, 8);
    assert.equal(result.repeat, 5);
    assert.equal(result.cache, false);
    assert.equal(result.resume, true);
    assert.equal(result.retryErrors, true);
  });

  // --- 验证非法值 ---

  it("12. should throw when maxConcurrency is zero", () => {
    assert.throws(
      () => parseRuntimeOptions({ maxConcurrency: "0" }),
      /maxConcurrency must be a positive integer/,
      "should throw for maxConcurrency=0"
    );
  });

  it("13. should throw when maxConcurrency is negative", () => {
    assert.throws(
      () => parseRuntimeOptions({ maxConcurrency: "-1" }),
      /maxConcurrency must be a positive integer/,
      "should throw for negative maxConcurrency"
    );
  });

  it("14. should throw when maxConcurrency is not a number", () => {
    assert.throws(
      () => parseRuntimeOptions({ maxConcurrency: "abc" }),
      /maxConcurrency must be a positive integer/,
      "should throw for non-numeric maxConcurrency"
    );
  });

  it("15. should throw when repeat is zero", () => {
    assert.throws(
      () => parseRuntimeOptions({ repeat: "0" }),
      /repeat must be a positive integer/,
      "should throw for repeat=0"
    );
  });

  it("16. should throw when repeat is negative", () => {
    assert.throws(
      () => parseRuntimeOptions({ repeat: "-3" }),
      /repeat must be a positive integer/,
      "should throw for negative repeat"
    );
  });

  it("17. should throw when repeat is not a number", () => {
    assert.throws(
      () => parseRuntimeOptions({ repeat: "xyz" }),
      /repeat must be a positive integer/,
      "should throw for non-numeric repeat"
    );
  });
});

describe("buildEvaluateOptions", () => {
  it("18. should build options with default runtime values", () => {
    const runtime: PromptfooRuntimeOptions = {
      maxConcurrency: 2,
      repeat: 1,
      cache: true,
      resume: false,
      retryErrors: false,
    };

    const options = buildEvaluateOptions(runtime);

    assert.equal(options.maxConcurrency, 2, "maxConcurrency should be 2");
    assert.equal(options.repeat, 1, "repeat should be 1");
    assert.equal(options.cache, true, "cache should be true");
    assert.equal(options.resume, undefined, "resume should not be included when false");
    assert.equal(options.retryErrors, undefined, "retryErrors should not be included when false");
  });

  it("19. should build options with custom runtime values", () => {
    const runtime: PromptfooRuntimeOptions = {
      maxConcurrency: 4,
      repeat: 3,
      cache: false,
      resume: false,
      retryErrors: false,
    };

    const options = buildEvaluateOptions(runtime);

    assert.equal(options.maxConcurrency, 4, "maxConcurrency should be 4");
    assert.equal(options.repeat, 3, "repeat should be 3");
    assert.equal(options.cache, false, "cache should be false");
  });

  it("20. should include resume when true", () => {
    const runtime: PromptfooRuntimeOptions = {
      maxConcurrency: 2,
      repeat: 1,
      cache: true,
      resume: true,
      retryErrors: false,
    };

    const options = buildEvaluateOptions(runtime);

    assert.equal(options.resume, true, "resume should be included and true");
  });

  it("21. should include retryErrors when true", () => {
    const runtime: PromptfooRuntimeOptions = {
      maxConcurrency: 2,
      repeat: 1,
      cache: true,
      resume: false,
      retryErrors: true,
    };

    const options = buildEvaluateOptions(runtime);

    assert.equal(options.retryErrors, true, "retryErrors should be included and true");
  });

  it("22. should include both resume and retryErrors when both are true", () => {
    const runtime: PromptfooRuntimeOptions = {
      maxConcurrency: 8,
      repeat: 2,
      cache: false,
      resume: true,
      retryErrors: true,
    };

    const options = buildEvaluateOptions(runtime);

    assert.equal(options.maxConcurrency, 8);
    assert.equal(options.repeat, 2);
    assert.equal(options.cache, false);
    assert.equal(options.resume, true);
    assert.equal(options.retryErrors, true);
  });

  it("23. should not include resume or retryErrors when both are false", () => {
    const runtime: PromptfooRuntimeOptions = {
      maxConcurrency: 2,
      repeat: 1,
      cache: true,
      resume: false,
      retryErrors: false,
    };

    const options = buildEvaluateOptions(runtime);

    assert.ok(!("resume" in options), "resume should not be in options");
    assert.ok(!("retryErrors" in options), "retryErrors should not be in options");
  });

  it("24. should return a plain object with correct keys", () => {
    const runtime: PromptfooRuntimeOptions = {
      maxConcurrency: 2,
      repeat: 1,
      cache: true,
      resume: false,
      retryErrors: false,
    };

    const options = buildEvaluateOptions(runtime);

    assert.ok(typeof options === "object" && options !== null, "should be a non-null object");
    // Default case: only maxConcurrency, repeat, cache
    const keys = Object.keys(options).sort();
    assert.deepEqual(
      keys,
      ["cache", "maxConcurrency", "repeat"],
      "should have exactly 3 keys when resume and retryErrors are false"
    );
  });
});
