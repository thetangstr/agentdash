import { z } from "zod";

function unescapeLineBreaks(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n");
}

function isWholeJsonDocument(value: string): boolean {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Agents often send markdown with JSON-escaped line breaks (a literal `\n`
 * from a shell heredoc); turn those into real line breaks.
 *
 * AgentDash (PR #1059 review): code is literal, so two things are left alone:
 *   - the lines inside a closed fenced code block (``` or ~~~). JSON in a
 *     ```json fence writes newlines inside strings as `\n`; unescaping them
 *     made the JSON unparseable (the run Business view's milestone timeline
 *     document is exactly that). Fences are found on real line breaks only,
 *     so a body escaped end to end (fences included) is unescaped as before;
 *   - a body that is itself one valid JSON document.
 */
export function normalizeEscapedLineBreaks(value: string): string {
  if (!value.includes("\\n") && !value.includes("\\r")) return value;
  if (isWholeJsonDocument(value)) return value;

  const lines = value.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length > 0) out.push(unescapeLineBreaks(prose.join("\n")));
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const open = lines[i]!.match(FENCE_OPEN);
    if (open) {
      const marker = open[1]!;
      const fenceChar = marker[0]!;
      let close = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j]!.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (candidate && candidate[1]![0] === fenceChar && candidate[1]!.length >= marker.length) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        flushProse();
        out.push(lines.slice(i, close + 1).join("\n"));
        i = close + 1;
        continue;
      }
      // An unclosed fence runs to the end (CommonMark), so no later opener can
      // close either: treat the rest as prose and stop. Scanning again from
      // every later opener made this quadratic (512 KiB of openers ≈ 66 s).
      prose = prose.concat(lines.slice(i));
      break;
    }
    prose.push(lines[i]!);
    i += 1;
  }
  flushProse();
  return out.join("\n");
}

export const multilineTextSchema = z.string().transform(normalizeEscapedLineBreaks);
