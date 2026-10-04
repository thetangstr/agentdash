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
 * signature: a trailing carriage return (Hermes redraws these in place) or a
 * leading status glyph. Stripping stops at the first ordinary line, so a real
 * answer that happens to contain "⚠" further down is left alone.
 */
export function stripStatusLines(text: string): string {
  const lines = text.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start] ?? "";
    const isStatusLine = line.endsWith("\r") || /^\s*[⚠✓✗→ℹ]/u.test(line);
    if (!isStatusLine) break;
    start += 1;
  }
  return lines.slice(start).join("\n").trim();
}
