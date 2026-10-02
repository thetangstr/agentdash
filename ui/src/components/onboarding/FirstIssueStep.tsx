// AgentDash (GH #786): "What should we build first?" One sentence becomes the
// first issue in the connected repo's project; the server assigns it to an
// engineer (hiring one if needed) and the agent starts right away.
import { useState, type FormEvent } from "react";
import { ApiError } from "@/api/client";
import { firstRunApi, type CreateFirstIssueResponse } from "@/api/firstRun";
import { Button } from "@/components/ui/button";

export interface FirstIssueStepProps {
  companyId: string;
  repo: string | null;
  suggestions: string[];
  onCreated: (result: CreateFirstIssueResponse) => void;
}

function errorSentence(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { code?: string; message?: string } | null;
    if (error.status === 402 && body?.code === "agent_cap_exceeded") {
      return `${body.message ?? "Your plan has no room for another agent."} Or remove an agent you do not need.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong. Try again.";
}

export function FirstIssueStep({ companyId, repo, suggestions, onCreated }: FirstIssueStepProps) {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      onCreated(await firstRunApi.createFirstIssue(companyId, text.trim()));
    } catch (err) {
      setError(errorSentence(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="mx-auto flex max-w-lg flex-col gap-5 px-6 py-12" onSubmit={submit} aria-label="First issue">
      <div>
        <h1 className="text-lg font-semibold">What should your team do first?</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One sentence is enough. It becomes your first task{repo ? ` in ${repo}` : ""}; an agent picks it up
          {repo ? ", works on a branch and opens a pull request for you to review." : " and reports back to you."}
        </p>
      </div>

      <div className="flex flex-wrap gap-2" data-testid="first-issue-suggestions">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="rounded-full border px-3 py-1 text-left text-xs hover:bg-muted"
            onClick={() => {
              setText(suggestion);
              setError(null);
            }}
          >
            {suggestion}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Your first task</span>
        <textarea
          name="firstIssue"
          rows={3}
          className="rounded border px-3 py-2"
          placeholder={repo ? "Add a /health endpoint that returns the build version" : "Draft a one-page summary of what we offer"}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </label>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={!text.trim() || saving}>
        {saving ? "Handing it to your team…" : "Start"}
      </Button>
    </form>
  );
}
