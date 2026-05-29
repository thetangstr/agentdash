import type { HeartbeatRunOutcome } from "./heartbeat-stop-metadata.js";

export type AgentRunFailureCategory =
  | "missing_credential"
  | "auth_expired"
  | "rate_limited"
  | "permission_denied"
  | "workspace_unavailable"
  | "adapter_unavailable"
  | "model_unavailable"
  | "network_unreachable"
  | "timeout"
  | "process_crashed"
  | "cancelled"
  | "unknown";

export type AgentRunFailureSeverity =
  | "customer_action_required"
  | "operator_action_required"
  | "transient"
  | "product_bug_unknown";

export type AgentRunRecoveryAction =
  | "retry"
  | "wait_and_retry"
  | "open_credentials"
  | "run_adapter_test"
  | "switch_model_or_adapter"
  | "fix_workspace"
  | "fix_permissions"
  | "escalate_support";

export interface AgentRunFailureClassification {
  category: AgentRunFailureCategory;
  severity: AgentRunFailureSeverity;
  title: string;
  detail: string;
  nextActions: AgentRunRecoveryAction[];
}

interface ClassifierRule {
  category: AgentRunFailureCategory;
  severity: AgentRunFailureSeverity;
  title: string;
  detail: string;
  nextActions: AgentRunRecoveryAction[];
  patterns: RegExp[];
}

export interface AgentRunFailureClassificationInput {
  outcome: HeartbeatRunOutcome;
  adapterType: string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

const RULES: ClassifierRule[] = [
  {
    category: "missing_credential",
    severity: "customer_action_required",
    title: "Credential setup is incomplete",
    detail: "The adapter needs a configured API key or completed CLI login before this agent can run.",
    nextActions: ["open_credentials", "run_adapter_test", "retry"],
    patterns: [
      /\bmissing\b.*\b(api[ _-]?key|credential|token)\b/i,
      /\b(api[ _-]?key|credential|token)\b.*\b(missing|not set|unset|required)\b/i,
      /\bnot logged in\b/i,
      /\blogin required\b/i,
      /\bauthentication required\b/i,
      /\bOPENAI_API_KEY\b/,
      /\bANTHROPIC_API_KEY\b/,
    ],
  },
  {
    category: "auth_expired",
    severity: "customer_action_required",
    title: "Credential was rejected",
    detail: "The provider rejected the configured credential. Rotate the key or complete login again.",
    nextActions: ["open_credentials", "run_adapter_test", "retry"],
    patterns: [
      /\bunauthorized\b/i,
      /\bforbidden\b/i,
      /\b401\b/,
      /\b403\b/,
      /\binvalid\b.*\b(api[ _-]?key|credential|token)\b/i,
      /\b(api[ _-]?key|credential|token)\b.*\b(expired|revoked|invalid)\b/i,
    ],
  },
  {
    category: "rate_limited",
    severity: "transient",
    title: "Provider rate limit reached",
    detail: "The model provider or CLI is temporarily refusing more work for this account or model.",
    nextActions: ["wait_and_retry", "switch_model_or_adapter", "escalate_support"],
    patterns: [
      /\brate[ _-]?limit/i,
      /\btoo many requests\b/i,
      /\b429\b/,
      /\bthrottl/i,
      /\busage limit\b/i,
      /\bout of .*usage\b/i,
      /\bresets?\s+(at|in)\b/i,
    ],
  },
  {
    category: "permission_denied",
    severity: "operator_action_required",
    title: "Runtime permission denied",
    detail: "The agent process could not read, write, execute, or access a required resource.",
    nextActions: ["fix_permissions", "run_adapter_test", "retry"],
    patterns: [
      /\bpermission denied\b/i,
      /\boperation not permitted\b/i,
      /\bEACCES\b/,
      /\bEPERM\b/,
      /\bread-only file system\b/i,
      /\bnot allowed\b/i,
    ],
  },
  {
    category: "workspace_unavailable",
    severity: "operator_action_required",
    title: "Workspace is unavailable",
    detail: "The configured working directory or execution workspace is missing, unreadable, or invalid.",
    nextActions: ["fix_workspace", "run_adapter_test", "retry"],
    patterns: [
      /\bno such file or directory\b/i,
      /\bnot a directory\b/i,
      /\bcwd\b.*\b(invalid|missing|unavailable)\b/i,
      /\bworkspace\b.*\b(missing|unavailable|not found|invalid)\b/i,
      /\bENOENT\b/,
    ],
  },
  {
    category: "adapter_unavailable",
    severity: "operator_action_required",
    title: "Adapter runtime is unavailable",
    detail: "The adapter command, plugin, or runtime dependency is not installed or cannot be launched.",
    nextActions: ["run_adapter_test", "switch_model_or_adapter", "escalate_support"],
    patterns: [
      /\bcommand not found\b/i,
      /\bexecutable file not found\b/i,
      /\badapter\b.*\b(missing|not installed|unavailable|not found)\b/i,
      /\bCannot find module\b/,
      /\bspawn\b.*\bENOENT\b/,
    ],
  },
  {
    category: "model_unavailable",
    severity: "customer_action_required",
    title: "Configured model is unavailable",
    detail: "The selected model was not found, is disabled, or is not available to the current account.",
    nextActions: ["switch_model_or_adapter", "run_adapter_test", "retry"],
    patterns: [
      /\bmodel\b.*\b(not found|unavailable|disabled|deprecated|unknown)\b/i,
      /\bProviderModelNotFoundError\b/,
      /\bunknown model\b/i,
      /\binvalid model\b/i,
    ],
  },
  {
    category: "network_unreachable",
    severity: "transient",
    title: "Network or provider endpoint is unreachable",
    detail: "The host could not reach a required provider, gateway, or network endpoint.",
    nextActions: ["retry", "run_adapter_test", "escalate_support"],
    patterns: [
      /\bENOTFOUND\b/,
      /\bECONNREFUSED\b/,
      /\bECONNRESET\b/,
      /\bnetwork\b.*\b(unreachable|error|failed)\b/i,
      /\bDNS\b.*\b(failed|error)\b/i,
      /\b502\b/,
      /\b503\b/,
      /\b504\b/,
    ],
  },
  {
    category: "process_crashed",
    severity: "operator_action_required",
    title: "Adapter process stopped unexpectedly",
    detail: "The local adapter process exited, crashed, or was detached before the run completed.",
    nextActions: ["retry", "run_adapter_test", "escalate_support"],
    patterns: [
      /\bprocess_(lost|detached)\b/i,
      /\bprocess\b.*\b(crash|lost|killed|exited)\b/i,
      /\bSIG(KILL|TERM|ABRT|SEGV)\b/,
      /\bexit code\b/i,
    ],
  },
];

function evidenceText(input: AgentRunFailureClassificationInput) {
  return [
    input.outcome,
    input.adapterType,
    input.errorCode ?? "",
    input.errorMessage ?? "",
  ].join("\n");
}

export function classifyAgentRunFailure(
  input: AgentRunFailureClassificationInput,
): AgentRunFailureClassification | null {
  if (input.outcome === "succeeded") return null;

  if (input.outcome === "cancelled") {
    return {
      category: "cancelled",
      severity: "operator_action_required",
      title: "Run was cancelled",
      detail: "The run was stopped by an operator, budget guard, pause, or issue state change.",
      nextActions: ["retry"],
    };
  }

  if (input.outcome === "timed_out" || input.errorCode === "timeout") {
    return {
      category: "timeout",
      severity: "transient",
      title: "Run timed out",
      detail: "The adapter did not complete before its configured timeout.",
      nextActions: ["retry", "run_adapter_test", "escalate_support"],
    };
  }

  const text = evidenceText(input);
  const rule = RULES.find((candidate) => candidate.patterns.some((pattern) => pattern.test(text)));
  if (rule) {
    return {
      category: rule.category,
      severity: rule.severity,
      title: rule.title,
      detail: rule.detail,
      nextActions: rule.nextActions,
    };
  }

  return {
    category: "unknown",
    severity: "product_bug_unknown",
    title: "Run failed for an unknown reason",
    detail: "AgentDash could not classify this failure from the adapter error. Support should inspect the run logs.",
    nextActions: ["run_adapter_test", "retry", "escalate_support"],
  };
}
