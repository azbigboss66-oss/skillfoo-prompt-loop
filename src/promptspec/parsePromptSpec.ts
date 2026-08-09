import {
  type PromptSpecSection,
  HEADING_SYNONYMS,
  ALL_SECTIONS,
} from "./schema.js";

export interface ParsedSection {
  section: PromptSpecSection;
  heading: string;
  body: string;
  line: number;
}

export interface ParsedPromptSpec {
  sections: ParsedSection[];
  unknownHeadings: string[];
  duplicateSections: PromptSpecSection[];
  emptySections: PromptSpecSection[];
  unresolvedVariables: string[];
  declaredVariables: string[];
  hasStructuredHeadings: boolean;
}

/**
 * Parse a prompt into structured sections using a fixed synonym map.
 * This is a deterministic parser — no LLM calls, no inference.
 */
export function parsePromptSpec(prompt: string): ParsedPromptSpec {
  const lines = prompt.split("\n");
  const sections: ParsedSection[] = [];
  const unknownHeadings: string[] = [];
  const sectionCounts = new Map<PromptSpecSection, number>();
  const emptySections: PromptSpecSection[] = [];
  const declaredVariables: string[] = [];

  let currentSection: ParsedSection | null = null;
  let currentBody: string[] = [];

  function flushSection(): void {
    if (currentSection) {
      const bodyText = currentBody.join("\n").trim();
      currentSection.body = bodyText;
      if (bodyText === "") {
        if (!emptySections.includes(currentSection.section)) {
          emptySections.push(currentSection.section);
        }
      }
      // Collect declared variables from the variables section
      if (currentSection.section === "variables" && bodyText) {
        const varMatches = bodyText.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g);
        if (varMatches) {
          for (const v of varMatches) {
            if (!declaredVariables.includes(v)) {
              declaredVariables.push(v);
            }
          }
        }
      }
      sections.push(currentSection);
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);

    if (headingMatch) {
      // Flush previous section
      flushSection();

      const headingText = headingMatch[1].trim().toLowerCase();
      const matchedSection = matchHeading(headingText);

      if (matchedSection) {
        const count = sectionCounts.get(matchedSection) ?? 0;
        sectionCounts.set(matchedSection, count + 1);

        currentSection = {
          section: matchedSection,
          heading: headingMatch[1].trim(),
          body: "",
          line: i + 1,
        };
        currentBody = [];
      } else {
        // Unknown heading — start collecting body but don't assign to a section
        currentSection = null;
        currentBody = [];
        if (!unknownHeadings.includes(headingMatch[1].trim())) {
          unknownHeadings.push(headingMatch[1].trim());
        }
      }
    } else {
      currentBody.push(line);
    }
  }
  flushSection();

  // Detect duplicates
  const duplicateSections: PromptSpecSection[] = [];
  for (const [section, count] of sectionCounts) {
    if (count > 1) {
      duplicateSections.push(section);
    }
  }

  // Detect unresolved variables
  const unresolvedVariables = detectUnresolvedVariables(prompt, declaredVariables);

  // Determine if the prompt has structured headings
  const hasStructuredHeadings = sections.length > 0;

  return {
    sections,
    unknownHeadings,
    duplicateSections,
    emptySections,
    unresolvedVariables,
    declaredVariables,
    hasStructuredHeadings,
  };
}

function matchHeading(heading: string): PromptSpecSection | null {
  for (const section of ALL_SECTIONS) {
    const synonyms = HEADING_SYNONYMS[section];
    for (const synonym of synonyms) {
      if (heading === synonym.toLowerCase()) {
        return section;
      }
    }
  }
  return null;
}

function detectUnresolvedVariables(prompt: string, declaredVariables: string[]): string[] {
  const unresolved: string[] = [];
  const placeholderRegex = /\{\{(\w+)\}\}/g;
  let match: RegExpExecArray | null;

  while ((match = placeholderRegex.exec(prompt)) !== null) {
    const varName = match[1];
    if (!declaredVariables.includes(varName) && !unresolved.includes(varName)) {
      unresolved.push(varName);
    }
  }

  return unresolved;
}
