/**
 * Drop an agent runtime's own chatter from the front of its output.
 *
 * Hermes writes status lines to STDOUT rather than stderr, even under `-Q`.
 * Observed for real: a CoS reply reached a colleague's thread reading
 * "⚠ tirith security scanner enabled but not available — command scanning will
 * use pattern matching only\r\nPut weekly revenue versus plan on the board
 * deck…". The answer was correct; it just arrived wearing a security warning,
 * because the adapter treats all of stdout as the agent's words.
 *
 * The specific warning is now off in Hermes config, which is the real fix. This
 * is the backstop, because the failure mode — arbitrary diagnostics posted as an
 * agent's answer — is one bad release away from returning, and the reader of a
 * board pack cannot tell our noise from the model's. The same leak reaches the
 * run summary when the adapter picks `cleaned` stdout as the response, so
 * `mergeHeartbeatRunResultJson` applies this too.
 *
 * Only a LEADING run is stripped, and only lines that carry a terminal-status
 * signature:
 *
 * - A CRLF line in an otherwise-LF document. The runtime writes its own
 *   status lines with `\r\n` ("Loading MCP servers…\r\n", "✗ mcp server …
 *   failed\r\n") while the agent's answer uses plain `\n`, so the mixed
 *   ending is the subprocess signature even when the line carries no glyph.
 *   A document that is uniformly CRLF was authored that way — those endings
 *   are just normalised, never treated as chatter.
 * - A lone in-place redraw. A `\r` that is not part of a line ending is a
 *   carriage return: the runtime redrew over the line, so only the fragment
 *   after the last `\r` is visible. A line whose visible fragment is empty
 *   was pure chatter.
 * - A leading warning glyph (⚠) or a known Hermes status line ("✓ session
 *   resumed", "✓ loading tools"). Those are machine output — an agent's own
 *   "✓ Fixed X" checklist or a "→ Next:" pointer is prose and is kept. An
 *   info glyph is ambiguous — "ℹ Note: …" is a common way to open real
 *   prose — so ℹ only counts as chatter when the line already carries a
 *   machine signature above.
 *
 * Stripping stops at the first ordinary line, so a real answer that happens
 * to contain a warning further down is left alone.
 */
// A warning glyph marks a runtime diagnostic, never the start of a summary an
// agent would write itself. ℹ is deliberately absent: "ℹ Note: …" is prose,
// so an info line is only stripped via the machine signatures above.
const DIAGNOSTIC_GLYPH_LINE = /^\s*⚠/u;

// Hermes prints boot/status chatter with a check glyph. Only the observed
// status words are matched — a "✓ Fixed X" checklist line stays.
const HERMES_STATUS_LINE = /^\s*✓\s+(session resumed|resuming|loading|loaded)\b/iu;

export function stripStatusLines(text: string): string {
  // Split on \n first so a "\r\n" line ending survives as a trailing "\r" —
  // the evidence the mixed-ending rule below reads.
  const rawLines = text.split("\n");
  // A trailing empty element is the document tail after a final "\n", not a
  // line — it must not make an otherwise uniform-CRLF document look mixed.
  const lineCount = rawLines.length > 0 && rawLines[rawLines.length - 1] === ""
    ? rawLines.length - 1
    : rawLines.length;
  let crlfCount = 0;
  for (let i = 0; i < lineCount; i++) if (rawLines[i]!.endsWith("\r")) crlfCount++;
  const mixedEndings = crlfCount > 0 && crlfCount < lineCount;

  const lines = rawLines.slice(0, lineCount).map((raw) => {
    const crlfEnded = raw.endsWith("\r");
    const body = crlfEnded ? raw.slice(0, -1) : raw;
    const redrawn = body.includes("\r");
    return {
      crlfEnded,
      redrawn,
      visible: redrawn ? body.slice(body.lastIndexOf("\r") + 1) : body,
    };
  });
  let start = 0;
  while (start < lines.length) {
    const line = lines[start] ?? { crlfEnded: false, redrawn: false, visible: "" };
    const isStatusLine =
      (line.redrawn && line.visible === "") ||
      (line.crlfEnded && mixedEndings) ||
      DIAGNOSTIC_GLYPH_LINE.test(line.visible) ||
      HERMES_STATUS_LINE.test(line.visible);
    if (!isStatusLine) break;
    start += 1;
  }
  return lines
    .slice(start)
    .map((line) => line.visible)
    .join("\n")
    .trim();
}
