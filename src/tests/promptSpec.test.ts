import { test } from "node:test";
import assert from "node:assert/strict";
import { assessPromptSpec } from "../promptspec/assessPromptSpec.js";
import { parsePromptSpec } from "../promptspec/parsePromptSpec.js";

test("structured prompt with all core sections has no missing core section", () => {
  const prompt = [
    "# \u76EE\u6807",
    "Provide customer service answers.",
    "",
    "# \u8F93\u5165\u8303\u56F4",
    "User questions about orders.",
    "",
    "# \u51B3\u7B56\u6D41\u7A0B",
    "Check order status then answer.",
    "",
    "# \u8FB9\u754C",
    "Do not fabricate capabilities.",
    "",
    "# \u8F93\u51FA\u683C\u5F0F",
    "Respond in clear text.",
  ].join("\n");

  const assessment = assessPromptSpec(prompt, "advisory");
  assert.equal(assessment.format, "structured");
  assert.equal(assessment.missingCoreSections.length, 0);
  assert.equal(assessment.duplicateSections.length, 0);
});

test("free-form two-sentence prompt is freeform with advisory notes and no error", () => {
  const prompt = "You are a helpful assistant. Answer user questions clearly.";
  const assessment = assessPromptSpec(prompt, "advisory");
  assert.equal(assessment.format, "freeform");
  assert.ok(assessment.notes.length > 0);
  assert.ok(assessment.missingCoreSections.length > 0);
  // Must not throw
  assert.equal(assessment.schemaVersion, "1.0");
});

test("repeated output format heading is recorded as duplicateSections", () => {
  const prompt = [
    "# \u76EE\u6807",
    "Answer questions.",
    "",
    "# \u8F93\u5165\u8303\u56F4",
    "User input.",
    "",
    "# \u51B3\u7B56\u6D41\u7A0B",
    "Process.",
    "",
    "# \u8FB9\u754C",
    "Limits.",
    "",
    "# \u8F93\u51FA\u683C\u5F0F",
    "Format A.",
    "",
    "# \u8F93\u51FA\u683C\u5F0F",
    "Format B.",
  ].join("\n");

  const assessment = assessPromptSpec(prompt, "advisory");
  assert.ok(assessment.duplicateSections.includes("output_contract"));
});

test("unresolved variable placeholder {{order_id}} is detected when not declared", () => {
  const prompt = [
    "# \u76EE\u6807",
    "Answer about order {{order_id}}.",
    "",
    "# \u8F93\u5165\u8303\u56F4",
    "User asks about orders.",
    "",
    "# \u51B3\u7B56\u6D41\u7A0B",
    "Look up order.",
    "",
    "# \u8FB9\u754C",
    "No fabrication.",
    "",
    "# \u8F93\u51FA\u683C\u5F0F",
    "Text response.",
  ].join("\n");

  const assessment = assessPromptSpec(prompt, "advisory");
  assert.ok(assessment.unresolvedVariables.includes("order_id"));
});

test("declared variable in variables section resolves placeholder", () => {
  const prompt = [
    "# \u76EE\u6807",
    "Answer about order {{order_id}}.",
    "",
    "# \u8F93\u5165\u8303\u56F4",
    "User asks about orders.",
    "",
    "# \u51B3\u7B56\u6D41\u7A0B",
    "Look up order.",
    "",
    "# \u8FB9\u754C",
    "No fabrication.",
    "",
    "# \u8F93\u51FA\u683C\u5F0F",
    "Text response.",
    "",
    "# \u53D8\u91CF",
    "order_id",
  ].join("\n");

  const assessment = assessPromptSpec(prompt, "advisory");
  assert.equal(assessment.unresolvedVariables.length, 0);
});

test("section heading with no body is reported as empty", () => {
  const prompt = [
    "# \u76EE\u6807",
    "Answer questions.",
    "",
    "# \u8F93\u5165\u8303\u56F4",
    "",
    "",
    "# \u51B3\u7B56\u6D41\u7A0B",
    "Process.",
    "",
    "# \u8FB9\u754C",
    "Limits.",
    "",
    "# \u8F93\u51FA\u683C\u5F0F",
    "Format.",
  ].join("\n");

  const assessment = assessPromptSpec(prompt, "advisory");
  assert.ok(assessment.emptySections.includes("scope_and_inputs"));
});

test("off mode returns freeform with no assessment", () => {
  const prompt = "# \u76EE\u6807\nAnswer questions.";
  const assessment = assessPromptSpec(prompt, "off");
  assert.equal(assessment.mode, "off");
  assert.equal(assessment.format, "freeform");
  assert.equal(assessment.detectedSections.length, 0);
  assert.ok(assessment.notes.length > 0);
});
