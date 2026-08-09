import { test } from "node:test";
import assert from "node:assert/strict";
import { writeJsonl, readJsonl } from "../storage/jsonl.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("writeJsonl writes multiple lines and readJsonl reads them back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillfoo-test-"));
  const filePath = join(dir, "test.jsonl");

  const records = [
    { id: 1, name: "a" },
    { id: 2, name: "b" },
    { id: 3, name: "c" },
  ];

  await writeJsonl(filePath, records);
  const read = await readJsonl<(typeof records)[0]>(filePath);

  assert.equal(read.length, 3);
  assert.deepEqual(read, records);

  await rm(dir, { recursive: true, force: true });
});

test("readJsonl throws on invalid JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skillfoo-test-"));
  const filePath = join(dir, "bad.jsonl");

  await writeFile(filePath, '{"valid": true}\nnot valid json\n', "utf-8");

  await assert.rejects(() => readJsonl(filePath), /Invalid JSON/);

  await rm(dir, { recursive: true, force: true });
});
