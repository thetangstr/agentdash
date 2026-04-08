import { eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { pipelineStageExecutions } from "@agentdash/db";
import type { SelfHealEntry } from "@agentdash/shared";

// AgentDash: Self-healing loop for pipeline stage failures
// Uses LLM diagnosis to adjust instruction and retry, rather than blind retry.

interface DiagnoseResult {
  diagnosis: string;
  adjustedInstruction: string;
  shouldRetry: boolean;
}

// Placeholder LLM call — will use the same callLlm from wizard service
// when Anthropic API key is available. Falls back to structured retry guidance.
async function diagnoseStageFailure(
  originalInstruction: string,
  inputData: Record<string, unknown>,
  error: string,
  previousAttempts: SelfHealEntry[],
): Promise<DiagnoseResult> {
  // Build diagnosis prompt
  const attemptHistory = previousAttempts
    .map((a) => `Attempt ${a.attempt}: ${a.diagnosis} → ${a.outcome}`)
    .join("\n");

  const diagnosis = [
    `Stage failed with error: ${error}`,
    `Original instruction: ${originalInstruction}`,
    previousAttempts.length > 0
      ? `Previous ${previousAttempts.length} attempt(s):\n${attemptHistory}`
      : "First failure — no prior attempts.",
    `Input data keys: ${Object.keys(inputData).join(", ")}`,
  ].join("\n");

  // Adjust instruction to be more explicit about error handling
  const adjustedInstruction = [
    originalInstruction,
    "",
    "IMPORTANT: A previous attempt failed with this error:",
    error,
    "Please approach this task more carefully, validating inputs before proceeding.",
    previousAttempts.length > 0
      ? `This is retry attempt ${previousAttempts.length + 1}. Previous adjustments did not resolve the issue.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    diagnosis,
    adjustedInstruction,
    shouldRetry: previousAttempts.length < 3,
  };
}

export function pipelineSelfHealService(db: Db) {
  return {
    async attemptHeal(
      stageExecutionId: string,
      originalInstruction: string,
      inputData: Record<string, unknown>,
      error: string,
      maxRetries: number,
    ): Promise<{ shouldRetry: boolean; adjustedInstruction: string }> {
      // Get current stage execution with its heal log
      const [stageExec] = await db
        .select()
        .from(pipelineStageExecutions)
        .where(eq(pipelineStageExecutions.id, stageExecutionId));

      if (!stageExec) throw new Error("Stage execution not found");

      const currentAttempts = stageExec.selfHealAttempts ?? 0;
      const healLog = (stageExec.selfHealLog ?? []) as SelfHealEntry[];

      if (currentAttempts >= maxRetries) {
        return { shouldRetry: false, adjustedInstruction: originalInstruction };
      }

      const result = await diagnoseStageFailure(
        originalInstruction,
        inputData,
        error,
        healLog,
      );

      // Log the heal attempt
      const newEntry: SelfHealEntry = {
        attempt: currentAttempts + 1,
        diagnosis: result.diagnosis,
        adjustedInstruction: result.adjustedInstruction,
        outcome: result.shouldRetry ? "retried" : "failed",
        timestamp: new Date().toISOString(),
      };

      await db
        .update(pipelineStageExecutions)
        .set({
          selfHealAttempts: currentAttempts + 1,
          selfHealLog: [...healLog, newEntry],
          status: result.shouldRetry ? "pending" : "failed",
        })
        .where(eq(pipelineStageExecutions.id, stageExecutionId));

      return {
        shouldRetry: result.shouldRetry,
        adjustedInstruction: result.adjustedInstruction,
      };
    },
  };
}
