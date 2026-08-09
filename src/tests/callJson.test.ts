import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callJson, JsonCallFailedError } from "../model/callJson.js";
import type { ModelProvider } from "../providers/types.js";

test("callJson parses valid JSON on first attempt", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "skillfoo-json-"));
  const provider: ModelProvider = {
    name: "test",
    async chat() {
      return JSON.stringify([{ id: "x" }]);
    },
  };

  const result = await callJson<unknown[]>(provider, {
    stage: "unit",
    runDir,
    messages: [{ role: "user", content: "return json" }],
    validate(value) {
      assert.ok(Array.isArray(value));
      return value;
    },
  });

  assert.equal(result.attempts, 1);
  assert.equal(result.repairAttempts, 0);
  assert.equal(result.recovered, false);
  await rm(runDir, { recursive: true, force: true });
});

test("callJson repairs JSON after non-json response", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "skillfoo-json-"));
  let calls = 0;
  const provider: ModelProvider = {
    name: "test",
    async chat() {
      calls++;
      if (calls === 1) return "这里是说明文字，不是 JSON";
      return JSON.stringify([{ id: "fixed" }]);
    },
  };

  const result = await callJson<unknown[]>(provider, {
    stage: "unit",
    runDir,
    messages: [{ role: "user", content: "return json" }],
    validate(value) {
      assert.ok(Array.isArray(value));
      return value;
    },
  });

  assert.equal(result.attempts, 1);
  assert.equal(result.repairAttempts, 1);
  assert.equal(result.recovered, true);

  const raw = await readFile(join(runDir, "raw-responses", "unit", "attempt-1.txt"), "utf-8");
  assert.match(raw, /不是 JSON/);
  await rm(runDir, { recursive: true, force: true });
});

test("callJson throws JsonCallFailedError after all attempts fail", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "skillfoo-json-"));
  const provider: ModelProvider = {
    name: "test",
    async chat() {
      return "not json";
    },
  };

  await assert.rejects(
    () => callJson<unknown[]>(provider, {
      stage: "unit",
      runDir,
      maxAttempts: 2,
      messages: [{ role: "user", content: "return json" }],
      validate(value) {
        assert.ok(Array.isArray(value));
        return value;
      },
    }),
    JsonCallFailedError
  );

  await rm(runDir, { recursive: true, force: true });
});
