/**
 * LLM-powered diagnosis for the run healer.
 *
 * Builds the prompt for the LLM and parses the response.
 */

export type DiagnosisCategory =
  | "AUTH_EXPIRED"
  | "AUTH_MISSING"
  | "RATE_LIMIT"
  | "MODEL_UNAVAILABLE"
  | "ADAPTER_CONFIG"
  | "PROCESS_CRASHED"
  | "NETWORK_UNREACHABLE"
  | "TIMEOUT"
  | "UNKNOWN";

export type DiagnosisConfidence = "high" | "medium" | "low";

export type HealDiagnosis = {
  category: DiagnosisCategory;
  confidence: DiagnosisConfidence;
  diagnosis: string;
  suggestedFix: string;
  fixType: "retry" | "adapter_switch" | "config_update" | "manual_required";
};

export type DiagnosisInput = {
  runId: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  errorCode: string | null;
  errorMessage: string | null;
  status: string;
  outputTail: string;
  recentHealAttempts: Array<{
    category: DiagnosisCategory;
    fixType: string;
    succeeded: boolean | null;
  }>;
};

export function buildHealDiagnosisPrompt(input: DiagnosisInput): string {
  const errorContext = input.errorCode
    ? `Error code: \`${input.errorCode}\`\n`
    : "";
  const errorMsgContext = input.errorMessage
    ? `Error message: ${input.errorMessage}\n`
    : "";
  const outputContext = input.outputTail
    ? `\nRecent run output (last 4KB, redacted):\n${input.outputTail}\n`
    : "\nNo run output available.\n";
  const previousAttempts = input.recentHealAttempts.length
    ? `\nPrevious heal attempts on this run:\n${input.recentHealAttempts.map((a) => `  - ${a.category} (${a.fixType}), succeeded: ${a.succeeded ?? "unknown"}`).join("\n")}\n`
    : "\nNo previous heal attempts on this run.\n";

  return `You are diagnosing why an agent run failed. Given the run context and error details, identify the root cause category and recommend a fix.

Run context:
  Run ID: ${input.runId}
  Agent: ${input.agentName} (${input.agentId})
  Adapter type: ${input.adapterType}
  Status: ${input.status}
${errorContext}${errorMsgContext}${outputContext}${previousAttempts}

Root cause categories:
- AUTH_EXPIRED: API key / token / credentials have expired
- AUTH_MISSING: Required credentials not configured (no API key set, etc)
- RATE_LIMIT: Upstream API rate limiting (429 errors, throttling)
- MODEL_UNAVAILABLE: Model down, not responding, or deprecated
- ADAPTER_CONFIG: Adapter misconfigured (wrong parameters, bad env vars)
- PROCESS_CRASHED: Local adapter process crashed or was killed
- NETWORK_UNREACHABLE: Cannot reach upstream API (DNS, firewall, connection refused)
- TIMEOUT: Operation timed out (may be transient)
- UNKNOWN: Cannot determine from available data

Respond with JSON only (no other text):
{
  "category": "AUTH_EXPIRED" | "MODEL_UNAVAILABLE" | etc,
  "confidence": "high" | "medium" | "low",
  "diagnosis": "Brief explanation of what went wrong (1-2 sentences max)",
  "suggestedFix": "Specific action to take (e.g., 'Switch to claude_api from claude_local', 'Clear session and retry', 'Set ANTHROPIC_API_KEY')",
  "fixType": "retry" | "adapter_switch" | "config_update" | "manual_required"
}

Rules:
- If you cannot determine with reasonable confidence, set category to UNKNOWN and confidence to low
- If a previous heal attempt of the same category already failed, set confidence to low
- fixType "manual_required" means the issue cannot be automatically fixed (e.g., needs user to rotate an API key)
- fixType "adapter_switch" is for switching to a fallback adapter
- fixType "config_update" is for clearing sessions, updating env, etc
- fixType "retry" is for transient issues that may succeed on retry`;
}

export function parseHealDiagnosis(raw: string): HealDiagnosis | null {
  try {
    // Strip any markdown code blocks
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const parsed = JSON.parse(cleaned);

    // Validate shape
    if (
      typeof parsed.category !== "string" ||
      !["AUTH_EXPIRED", "AUTH_MISSING", "RATE_LIMIT", "MODEL_UNAVAILABLE", "ADAPTER_CONFIG", "PROCESS_CRASHED", "NETWORK_UNREACHABLE", "TIMEOUT", "UNKNOWN"].includes(parsed.category)
    ) {
      return null;
    }
    if (!["high", "medium", "low"].includes(parsed.confidence)) {
      return null;
    }
    if (!["retry", "adapter_switch", "config_update", "manual_required"].includes(parsed.fixType)) {
      return null;
    }

    return {
      category: parsed.category,
      confidence: parsed.confidence,
      diagnosis: String(parsed.diagnosis ?? ""),
      suggestedFix: String(parsed.suggestedFix ?? ""),
      fixType: parsed.fixType,
    };
  } catch {
    return null;
  }
}
