// AgentDash (#725): the Hermes provider step of hosted onboarding.
//
// On a hosted box Hermes is the only runtime and has no model provider until
// the founder adds one. This step shows the four supported providers, takes a
// key (and optionally a model), and the server checks it with one small model
// call before saving it. The key is only ever held in this form's state; the
// server never sends it back.
import { useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import {
  onboardingApi,
  type HermesProviderId,
  type HermesProviderOption,
  type SetupHermesProviderResponse,
} from "@/api/onboarding";
import { Button } from "@/components/ui/button";

export interface HermesProviderStepProps {
  companyId: string;
  options: HermesProviderOption[];
  canConfigure: boolean;
  onConfigured: (result: SetupHermesProviderResponse) => void;
}

function errorSentence(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong while saving the key. Try again.";
}

export function HermesProviderStep({ companyId, options, canConfigure, onConfigured }: HermesProviderStepProps) {
  const [provider, setProvider] = useState<HermesProviderId>(options[0]?.provider ?? "zai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = options.find((option) => option.provider === provider) ?? options[0];

  if (!canConfigure) {
    return (
      <div className="mx-auto max-w-lg px-6 py-12 text-sm" data-testid="hermes-provider-waiting">
        <h1 className="mb-2 text-lg font-semibold">Waiting for a model provider</h1>
        <p className="text-muted-foreground">
          This workspace needs an AI model provider before the Chief of Staff can reply. Ask the person who set up
          the workspace to add a provider key.
        </p>
      </div>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!apiKey.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await onboardingApi.setupHermesProvider({
        companyId,
        provider,
        apiKey: apiKey.trim(),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      setApiKey("");
      onConfigured(result);
    } catch (err) {
      setError(errorSentence(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mx-auto flex max-w-lg flex-col gap-5 px-6 py-12" onSubmit={submit} aria-label="Model provider">
      <div>
        <h1 className="text-lg font-semibold">Connect a model provider</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your agents and your Chief of Staff run on this provider. The key is checked with one small request, then
          stored encrypted on this workspace. It is never shown again.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Provider</legend>
        {options.map((option) => (
          <label key={option.provider} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="hermes-provider"
              value={option.provider}
              checked={provider === option.provider}
              onChange={() => {
                setProvider(option.provider);
                setError(null);
              }}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="rounded border px-3 py-2"
          placeholder={selected?.keyHint}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Model (optional)</span>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          className="rounded border px-3 py-2"
          placeholder={selected?.defaultModel}
          value={model}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={!apiKey.trim() || saving}>
        {saving ? "Checking the key…" : "Save and continue"}
      </Button>
    </form>
  );
}
