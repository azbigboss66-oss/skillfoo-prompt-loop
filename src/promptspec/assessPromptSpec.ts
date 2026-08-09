import {
  type PromptSpecAssessment,
  type PromptSpecMode,
  type PromptSpecSection,
  CORE_SECTIONS,
} from "./schema.js";
import { parsePromptSpec } from "./parsePromptSpec.js";

/**
 * Assess a prompt's structure using PromptSpec v1.
 *
 * This is advisory only — it never increases a candidate's behavioral score
 * and never rejects a free-form prompt simply because it lacks headings.
 */
export function assessPromptSpec(
  prompt: string,
  mode: PromptSpecMode,
): PromptSpecAssessment {
  if (mode === "off") {
    return {
      schemaVersion: "1.0",
      mode: "off",
      format: "freeform",
      detectedSections: [],
      missingCoreSections: [],
      duplicateSections: [],
      unresolvedVariables: [],
      emptySections: [],
      notes: ["PromptSpec is off; no structural assessment performed."],
    };
  }

  const parsed = parsePromptSpec(prompt);
  const detectedSections: PromptSpecSection[] = parsed.sections.map((s) => s.section);

  // Compute missing core sections
  const missingCoreSections = CORE_SECTIONS.filter(
    (section) => !detectedSections.includes(section),
  );

  // Determine format
  const format: "structured" | "freeform" =
    parsed.hasStructuredHeadings && missingCoreSections.length === 0
      ? "structured"
      : "freeform";

  // Build advisory notes
  const notes: string[] = [];

  if (format === "structured") {
    notes.push("Prompt has all core PromptSpec v1 sections detected.");
  } else if (parsed.hasStructuredHeadings) {
    notes.push(
      `Prompt has some structured headings but is missing core sections: ${missingCoreSections.join(", ")}.`,
    );
  } else {
    notes.push("Prompt is free-form without recognizable PromptSpec v1 headings. This is acceptable in advisory mode.");
  }

  if (parsed.duplicateSections.length > 0) {
    notes.push(
      `Duplicate sections detected: ${parsed.duplicateSections.join(", ")}.`,
    );
  }

  if (parsed.emptySections.length > 0) {
    notes.push(
      `Empty sections detected: ${parsed.emptySections.join(", ")}.`,
    );
  }

  if (parsed.unresolvedVariables.length > 0) {
    notes.push(
      `Unresolved variable placeholders: ${parsed.unresolvedVariables.join(", ")}.`,
    );
  }

  return {
    schemaVersion: "1.0",
    mode,
    format,
    detectedSections,
    missingCoreSections,
    duplicateSections: parsed.duplicateSections,
    unresolvedVariables: parsed.unresolvedVariables,
    emptySections: parsed.emptySections,
    notes,
  };
}
