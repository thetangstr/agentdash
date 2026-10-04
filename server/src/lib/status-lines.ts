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
 * Only a LEADING run is stripped, and what counts as a status line depends on
 * the adapter:
 *
 * - A lone in-place redraw. `\r\n` is normalised away first — it is a line
 *   ending, not a marker. A `\r` that survives normalisation is a carriage
 *   return without a newline: the runtime redrew over the line, so only the
 *   fragment after the last `\r` is visible. A line whose visible fragment is
 *   empty was pure chatter. This applies on every adapter.
 * - On `hermes_local`, any leading glyph line (⚠, ✓, ✗, →, ℹ, indented or
 *   not) is machine output — Hermes writes its boot/status chatter exactly
 *   like that, and an agent's reply never opens with a checklist of its own
 *   runtime bookkeeping.
 * - On every other adapter only ⚠/ℹ diagnostics count. A run summary that
 *   opens "→ Next: …" or "✓ Fixed X" is ordinary agent prose and is kept —
 *   otherwise the filter would eat real summaries (review-1019).
 *
 * Stripping stops at the first ordinary line, so a real answer that happens
 * to contain a warning further down is left alone.
 */
// Warning/info glyphs mark runtime diagnostics on any adapter.
const DIAGNOSTIC_GLYPH_LINE = /^\s*[⚠ℹ]/u;

// On the Hermes path every leading glyph line is runtime chatter — the old
// stripHermesChatter rule, kept scoped to the adapter that produces it.
const HERMES_GLYPH_LINE = /^\s*[⚠✓✗→ℹ]/u;

export function stripStatusLines(text: string, opts?: { adapterType?: string | null }): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((raw) => {
      const redrawn = raw.includes("\r");
      return {
        redrawn,
        visible: redrawn ? raw.slice(raw.lastIndexOf("\r") + 1) : raw,
      };
    });
  const glyphLine = opts?.adapterType === "hermes_local" ? HERMES_GLYPH_LINE : DIAGNOSTIC_GLYPH_LINE;
  let start = 0;
  while (start < lines.length) {
    const line = lines[start] ?? { redrawn: false, visible: "" };
    const isStatusLine = (line.redrawn && line.visible === "") || glyphLine.test(line.visible);
    if (!isStatusLine) break;
    start += 1;
  }
  return lines
    .slice(start)
    .map((line) => line.visible)
    .join("\n")
    .trim();
}
