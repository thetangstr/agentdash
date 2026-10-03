/**
 * Facts come from user-authored rows — an issue title, agent name or card
 * text is a free-text field anyone with write access controls. Control and
 * format characters are stripped (no injected line breaks, no bidi tricks),
 * each value is capped, and runs of three or more `<` or `>` are collapsed,
 * so a crafted string cannot break out of its line in a prompt, forge a
 * delimiter, or smuggle a directive into one.
 */
export function promptFactText(value: string, max = 120): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/<{3,}/g, "<<")
    .replace(/>{3,}/g, ">>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * A user-authored structure rendered into a prompt (interview goals, a
 * deep-interview spec). Every string leaf AND every object key passes
 * promptFactText so a nested value cannot smuggle control characters, line
 * breaks or delimiter runs into the system prompt; numbers, booleans and
 * null pass through as-is.
 */
export function sanitizePromptData(value: unknown, max = 500): unknown {
  if (typeof value === "string") return promptFactText(value, max);
  if (Array.isArray(value)) return value.map((item) => sanitizePromptData(item, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        promptFactText(key, 60),
        sanitizePromptData(item, max),
      ]),
    );
  }
  return value;
}
