const SENSITIVE_PATTERN = /api.?key|token|secret|authorization|password/i;

/**
 * Recursively redact sensitive values from an object.
 * Any field whose name matches /api.?key|token|secret|authorization|password/i
 * has its value replaced with "[REDACTED]".
 * apiKeyEnv fields are kept (they contain env var names, not secrets).
 */
export function redactSensitiveConfig(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(redactSensitiveConfig);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_PATTERN.test(key) && key !== "apiKeyEnv") {
      result[key] = "[REDACTED]";
    } else {
      result[key] = redactSensitiveConfig(value);
    }
  }
  return result;
}
