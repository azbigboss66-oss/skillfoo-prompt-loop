/**
 * Extract and parse JSON from a model response.
 *
 * Handles:
 * 1. Plain JSON
 * 2. JSON wrapped in markdown code blocks (```json ... ``` or ``` ... ```)
 * 3. JSON embedded in surrounding text
 * 4. Truncated JSON arrays/objects (attempts to close incomplete brackets)
 *
 * Returns parsed JSON object/array, or null if parsing fails.
 */
export function extractJson<T = unknown>(text: string): T | null {
  // Step 1: Try direct parse
  try {
    return JSON.parse(text) as T;
  } catch {
    // continue
  }

  // Step 2: Extract from markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as T;
    } catch {
      // continue
    }
  }

  // Step 3: Try to find JSON object or array in the text
  // Look for the first { or [ and match to its closing bracket
  const jsonPatterns = [
    /\{[\s\S]*\}/, // JSON object
    /\[[\s\S]*\]/, // JSON array
  ];

  for (const pattern of jsonPatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        // continue
      }
    }
  }

  // Step 4: Try to repair truncated JSON
  const repaired = repairTruncatedJson(text);
  if (repaired !== null) {
    return repaired as T;
  }

  return null;
}

/**
 * Attempt to repair truncated JSON by closing incomplete brackets.
 * Handles cases where the model output was cut off due to token limits.
 */
function repairTruncatedJson(text: string): unknown | null {
  const trimmed = text.trim();

  // Try to repair a truncated JSON array
  if (trimmed.startsWith("[")) {
    // Find the last complete object in the array
    // Look for the last occurrence of "}\n  }" or just "}" followed by optional whitespace/comma
    let lastCompleteObj = -1;
    let braceDepth = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{") braceDepth++;
      if (ch === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          lastCompleteObj = i;
        }
      }
    }

    if (lastCompleteObj > 0) {
      // Truncate after the last complete object and close the array
      const truncated = trimmed.substring(0, lastCompleteObj + 1) + "\n]";
      try {
        return JSON.parse(truncated);
      } catch {
        // continue
      }
    }
  }

  // Try to repair a truncated JSON object
  if (trimmed.startsWith("{")) {
    // Try closing with }
    const tryClose = trimmed + "}";
    try {
      return JSON.parse(tryClose);
    } catch {
      // continue
    }
  }

  return null;
}
