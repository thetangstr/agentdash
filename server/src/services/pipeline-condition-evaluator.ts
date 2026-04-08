// AgentDash: Safe expression evaluator for pipeline edge conditions
// Evaluates simple conditions against a state envelope's data field.
// Only allows property access, comparison operators, and boolean logic.
// Does NOT use eval() — uses manual parsing for safety.

const FORBIDDEN_PATTERNS = [
  /\b(eval|Function|require|import|process|global|window|document)\b/,
  /\b(constructor|__proto__|prototype)\b/,
  /[;{}[\]]/,
  /\.\s*\(/,
];

type ComparisonOp = "===" | "!==" | ">=" | "<=" | ">" | "<";
const COMPARISON_OPS: ComparisonOp[] = ["===", "!==", ">=", "<=", ">", "<"];

function resolveProperty(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function parseLiteral(token: string): unknown {
  const trimmed = token.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (trimmed === "undefined") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const strMatch = trimmed.match(/^["'](.*)["']$/);
  if (strMatch) return strMatch[1];
  return undefined;
}

function resolveValue(token: string, data: Record<string, unknown>): unknown {
  const trimmed = token.trim();
  if (trimmed.startsWith("data.")) {
    return resolveProperty({ data }, trimmed);
  }
  return parseLiteral(trimmed);
}

function evaluateComparison(
  expr: string,
  data: Record<string, unknown>,
): boolean {
  for (const op of COMPARISON_OPS) {
    const idx = expr.indexOf(op);
    if (idx === -1) continue;
    const left = resolveValue(expr.slice(0, idx), data);
    const right = resolveValue(expr.slice(idx + op.length), data);
    switch (op) {
      case "===": return left === right;
      case "!==": return left !== right;
      case ">":   return (left as number) > (right as number);
      case ">=":  return (left as number) >= (right as number);
      case "<":   return (left as number) < (right as number);
      case "<=":  return (left as number) <= (right as number);
    }
  }
  // No operator found — treat as truthy check on data property
  const val = resolveValue(expr, data);
  return Boolean(val);
}

function evaluateBooleanExpr(
  expr: string,
  data: Record<string, unknown>,
): boolean {
  // Split on || first (lower precedence)
  const orParts = expr.split("||");
  if (orParts.length > 1) {
    return orParts.some((part) => evaluateBooleanExpr(part.trim(), data));
  }
  // Then split on &&
  const andParts = expr.split("&&");
  if (andParts.length > 1) {
    return andParts.every((part) => evaluateComparison(part.trim(), data));
  }
  return evaluateComparison(expr.trim(), data);
}

export function evaluateCondition(
  condition: string | undefined | null,
  data: Record<string, unknown>,
): boolean {
  if (!condition || condition.trim() === "") return true;

  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(condition)) {
      throw new Error(`Unsafe condition expression: ${condition}`);
    }
  }

  try {
    return evaluateBooleanExpr(condition, data);
  } catch {
    return false;
  }
}
