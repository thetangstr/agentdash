// AgentDash (one onboarding path): the runtime step of the first run on an
// install that is not a hosted box.
//
// A hosted box has one runtime (Hermes) and asks for a model key instead
// (HermesProviderStep). A self-hosted install runs its agents on a CLI that is
// already on the machine, so this step shows which runtime the instance uses,
// lets the founder check Claude Code, Codex or Hermes with the existing adapter
// environment test, and switch the instance default to one of them with the
// existing setup-adapter presets. Then the founder goes on to the Chief of
// Staff, the same as on a hosted box.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isBlockingPreflightResult, type AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import { onboardingApi, type LocalRuntimePreset } from "@/api/onboarding";
import { Button } from "@/components/ui/button";

export const ADAPTER_STATUS_QUERY_KEY = ["onboarding-adapter-status"] as const;

export const LOCAL_RUNTIMES: Array<{
  adapterType: string;
  preset: LocalRuntimePreset;
  label: string;
  description: string;
}> = [
  {
    adapterType: "claude_local",
    preset: "claude_code",
    label: "Claude Code",
    description: "Claude Code on this computer, signed in to your Anthropic account.",
  },
  {
    adapterType: "codex_local",
    preset: "codex",
    label: "Codex",
    description: "Codex on this computer, signed in to your OpenAI account.",
  },
  {
    adapterType: "hermes_local",
    preset: "hermes",
    label: "Hermes",
    description: "Hermes on this computer, set up with its own AI provider key.",
  },
];

export function runtimeLabel(adapter: string): string {
  const known = LOCAL_RUNTIMES.find((runtime) => runtime.adapterType === adapter);
  if (known) return known.label;
  if (adapter === "stub") return "Placeholder replies (no model connected)";
  return adapter;
}

type CheckState = { loading: boolean; result?: AdapterEnvironmentTestResult; error?: string };

function errorSentence(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}

function checkSummary(result: AdapterEnvironmentTestResult): string {
  if (result.status === "pass") return "Ready";
  const problem = result.checks.find((check) => check.level === "error") ?? result.checks.find((check) => check.level === "warn");
  // A blocking warn (auth required, probe cannot run) is not an advisory — it
  // reads "Not ready" the same as a fail, matching the create/launch gates.
  const prefix = result.status === "warn" && !isBlockingPreflightResult(result) ? "Ready with a warning" : "Not ready";
  return problem ? `${prefix}: ${problem.message}` : prefix;
}

export interface RuntimeStepProps {
  companyId: string;
  onContinue: () => void;
}

export function RuntimeStep({ companyId, onContinue }: RuntimeStepProps) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ADAPTER_STATUS_QUERY_KEY,
    queryFn: () => onboardingApi.adapterStatus(),
    retry: false,
  });
  const [checks, setChecks] = useState<Record<string, CheckState>>({});
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (statusQuery.isLoading) {
    return <div role="status" className="p-8 text-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (statusQuery.error || !statusQuery.data) {
    return (
      <div role="alert" className="p-8 text-center text-sm text-destructive">
        {statusQuery.error instanceof Error ? statusQuery.error.message : "Could not check your AI assistant."}
      </div>
    );
  }

  const current = statusQuery.data.status;
  // The setup route lets only the instance admin change the runtime; the
  // adapter-status response already carries that answer.
  const canConfigure = statusQuery.data.hermesProvider?.canConfigure === true;

  async function check(adapterType: string): Promise<AdapterEnvironmentTestResult | null> {
    setChecks((prev) => ({ ...prev, [adapterType]: { loading: true } }));
    try {
      const result = await agentsApi.testEnvironment(companyId, adapterType, { adapterConfig: {} });
      setChecks((prev) => ({ ...prev, [adapterType]: { loading: false, result } }));
      return result;
    } catch (err) {
      setChecks((prev) => ({ ...prev, [adapterType]: { loading: false, error: errorSentence(err) } }));
      return null;
    }
  }

  async function use(runtime: (typeof LOCAL_RUNTIMES)[number]) {
    setError(null);
    setApplying(runtime.adapterType);
    try {
      const result = await check(runtime.adapterType);
      if (!result || isBlockingPreflightResult(result)) {
        setError(`${runtime.label} is not ready on this computer yet. Fix the check above, or pick another assistant.`);
        return;
      }
      await onboardingApi.setupAdapter(runtime.preset);
      await queryClient.invalidateQueries({ queryKey: ADAPTER_STATUS_QUERY_KEY });
    } catch (err) {
      // The server lets only the instance admin switch to these runtimes.
      if (err instanceof ApiError && err.status === 403) {
        setError("Ask the person who set up AgentDash to change the assistant.");
        return;
      }
      setError(errorSentence(err));
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5 px-6 py-12" data-testid="first-run-runtime">
      <div>
        <h1 className="text-lg font-semibold">Choose where your agents run</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your Chief of Staff and the agents it hires run on an AI assistant program installed on this computer.
          Check the one you use, then talk to your Chief of Staff.
        </p>
      </div>

      <div className="rounded-lg border p-4 text-sm" data-testid="first-run-runtime-current">
        <p>
          Your workspace uses <span className="font-medium">{runtimeLabel(current.adapter)}</span>.{" "}
          {current.ready ? "It is ready." : `It is not ready: ${current.reason ?? "unknown reason"}.`}
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {LOCAL_RUNTIMES.map((runtime) => {
          const state = checks[runtime.adapterType];
          const isCurrent = current.adapter === runtime.adapterType;
          return (
            <li
              key={runtime.adapterType}
              className="rounded-lg border p-4 text-sm"
              data-testid={`first-run-runtime-${runtime.adapterType}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {runtime.label}
                    {isCurrent ? <span className="ml-2 text-xs text-muted-foreground">In use</span> : null}
                  </p>
                  <p className="text-muted-foreground">{runtime.description}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={state?.loading || applying !== null}
                    onClick={() => void check(runtime.adapterType)}
                  >
                    {state?.loading && applying !== runtime.adapterType ? "Checking…" : "Check"}
                  </Button>
                  {canConfigure && !isCurrent ? (
                    // Secondary: the step has one primary action, "Continue".
                    <Button variant="outline" size="sm" disabled={applying !== null} onClick={() => void use(runtime)}>
                      {applying === runtime.adapterType ? "Switching…" : `Use ${runtime.label}`}
                    </Button>
                  ) : null}
                </div>
              </div>
              {state?.result ? (
                <p className={`mt-2 ${isBlockingPreflightResult(state.result) ? "text-destructive" : "text-muted-foreground"}`}>
                  {checkSummary(state.result)}
                </p>
              ) : null}
              {state?.error ? <p className="mt-2 text-destructive">{state.error}</p> : null}
            </li>
          );
        })}
      </ul>

      {!canConfigure ? (
        <p className="text-sm text-muted-foreground">Only the person who set up AgentDash can change the assistant.</p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button onClick={onContinue} disabled={applying !== null}>
        Continue to your Chief of Staff
      </Button>
    </div>
  );
}
