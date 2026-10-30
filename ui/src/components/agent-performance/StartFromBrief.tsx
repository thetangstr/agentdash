import { useId, useRef, useState, type ChangeEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentBriefResult } from "@paperclipai/shared";
import { agentBriefQueryKeys, agentBriefsApi } from "@/api/agent-briefs";
import { unboundAgentProfileQueryKeys, unboundAgentProfilesApi } from "@/api/agent-profiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "@/lib/router";
import { formatDateTime } from "@/lib/utils";
import { refusalText } from "./profile-shared";
import {
  AGENT_BRIEF_TEMPLATE,
  BRIEF_SAVE_NO_WAKE_TEXT,
  BRIEF_TEMPLATE_NOTE,
  briefIsUnsent,
  suggestBriefTitle,
} from "./brief-shared";

// AgentDash: Agent Performance Management gate 5 (P5.2) — "Start from a
// brief" in the new-agent flow. The owner pastes or uploads a Markdown brief
// (the discovery draft's template is offered, labelled as a template) and
// saves it. Saving creates a planning issue and nothing else: it assigns and
// wakes no one. Sending it to the planner is a separate step on the brief page.

const MAX_BRIEF_BYTES = 524288;

function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export function StartFromBrief({
  companyId,
  onSaved,
}: {
  companyId: string;
  /** Called with the saved brief (the page opens it). Never called for a failed save. */
  onSaved: (result: AgentBriefResult) => void;
}) {
  const uid = useId();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [undo, setUndo] = useState<{ markdown: string; label: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ title?: string; markdown?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ids = {
    title: `${uid}-title`,
    titleError: `${uid}-title-error`,
    markdown: `${uid}-markdown`,
    markdownHint: `${uid}-markdown-hint`,
    markdownError: `${uid}-markdown-error`,
    file: `${uid}-file`,
    template: `${uid}-template-note`,
  };

  const briefs = useQuery({
    queryKey: agentBriefQueryKeys.list(companyId),
    queryFn: () => agentBriefsApi.list(companyId),
    retry: false,
  });
  const drafts = useQuery({
    queryKey: unboundAgentProfileQueryKeys.list(companyId),
    queryFn: () => unboundAgentProfilesApi.list(companyId),
    retry: false,
  });

  /** Replaces the text, keeping what was there so it can be put back. Focus stays where it is. */
  function replaceText(next: string, label: string, message: string) {
    if (markdown.trim() && markdown !== next) setUndo({ markdown, label });
    else setUndo(null);
    setMarkdown(next);
    if (!titleTouched) setTitle(suggestBriefTitle(next));
    setFieldErrors((current) => ({ ...current, markdown: undefined }));
    setNotice(message);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_BRIEF_BYTES) {
      setNotice(`${file.name} is too large (the limit is 512 KB). Nothing was loaded.`);
      return;
    }
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setNotice(`Couldn't read ${file.name}. Nothing was loaded.`);
      return;
    }
    replaceText(text, file.name, `Loaded ${file.name}. Review it, then save. Nothing is saved yet.`);
  }

  const save = useMutation({
    mutationFn: () => agentBriefsApi.create(companyId, { title: title.trim(), markdown }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: agentBriefQueryKeys.list(companyId) });
      onSaved(result);
    },
    onError: (error) => setSaveError(`${refusalText("save the brief", error)} Your text is still here; nothing was saved.`),
  });

  function requestSave() {
    if (save.isPending) return;
    setSaveError(null);
    const errors: { title?: string; markdown?: string } = {};
    if (!title.trim()) errors.title = "Give the brief a title.";
    if (!markdown.trim()) errors.markdown = "Paste or upload the brief first.";
    else if (markdown.trim() === AGENT_BRIEF_TEMPLATE.trim()) {
      errors.markdown = "This is still the blank template. Fill in at least one real scenario, or write “unknown” where you don't know.";
    } else if (new Blob([markdown]).size > MAX_BRIEF_BYTES) errors.markdown = "The brief is too long (the limit is 512 KB).";
    setFieldErrors(errors);
    if (errors.title || errors.markdown) return;
    save.mutate();
  }

  const unsent = (briefs.data ?? []).filter(briefIsUnsent);
  const sent = (briefs.data ?? []).filter((issue) => !briefIsUnsent(issue));
  const openDrafts = (drafts.data ?? []).filter((draft) => !draft.agentId);

  return (
    <div className="max-w-3xl space-y-8" data-testid="start-from-brief">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-text-primary">Start from a brief</h1>
        <p className="text-sm text-text-secondary">
          Describe the work in a Markdown brief. The performance manager plans it scenario by scenario: which existing agent
          takes it, what changes, whether a new role is needed, or whether it stays with a person. Nothing is hired until a
          person approves a hire.
        </p>
      </header>

      <form
        className="space-y-5"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          requestSave();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={ids.title}>Brief title</Label>
          <Input
            id={ids.title}
            value={title}
            maxLength={200}
            aria-invalid={fieldErrors.title ? true : undefined}
            aria-describedby={fieldErrors.title ? ids.titleError : undefined}
            onChange={(event) => {
              setTitle(event.target.value);
              setTitleTouched(true);
              setFieldErrors((current) => ({ ...current, title: undefined }));
            }}
            data-testid="brief-title"
          />
          {fieldErrors.title ? (
            <p id={ids.titleError} className="text-xs text-danger-500">
              {fieldErrors.title}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={ids.markdown}>The brief (Markdown)</Label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-describedby={ids.template}
                onClick={() => replaceText(AGENT_BRIEF_TEMPLATE, "the template", "Inserted the brief template. It's a template: replace each prompt with your facts.")}
                data-testid="brief-use-template"
              >
                Use the brief template
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} data-testid="brief-upload">
                Upload a Markdown file
              </Button>
              <input
                ref={fileInputRef}
                id={ids.file}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="sr-only"
                tabIndex={-1}
                aria-label="Markdown file to load"
                onChange={(event) => void onFile(event)}
                data-testid="brief-file"
              />
            </div>
          </div>
          <p id={ids.template} className="text-xs text-text-secondary">
            Template: {BRIEF_TEMPLATE_NOTE}
          </p>
          <Textarea
            id={ids.markdown}
            value={markdown}
            rows={18}
            spellCheck
            className="font-mono text-xs"
            aria-invalid={fieldErrors.markdown ? true : undefined}
            aria-describedby={[ids.markdownHint, fieldErrors.markdown ? ids.markdownError : null].filter(Boolean).join(" ")}
            onChange={(event) => {
              setMarkdown(event.target.value);
              if (!titleTouched) setTitle(suggestBriefTitle(event.target.value));
              setUndo(null);
              setFieldErrors((current) => ({ ...current, markdown: undefined }));
            }}
            data-testid="brief-markdown"
          />
          <p id={ids.markdownHint} className="text-xs text-text-secondary">
            Paste the brief here, or upload it. Leave facts you don't have as “unknown”; don't guess them.
          </p>
          {fieldErrors.markdown ? (
            <p id={ids.markdownError} className="text-xs text-danger-500">
              {fieldErrors.markdown}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" aria-live="polite" className={notice ? "text-sm text-text-primary" : "sr-only"} data-testid="brief-notice">
              {notice}
            </p>
            {undo ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => {
                  setMarkdown(undo.markdown);
                  setNotice(`Put back the text you had before ${undo.label}.`);
                  setUndo(null);
                }}
                data-testid="brief-undo"
              >
                Put back what I had
              </Button>
            ) : null}
          </div>
        </div>

        {saveError ? (
          <p role="alert" className="text-sm text-danger-500" data-testid="brief-save-error">
            {saveError}
          </p>
        ) : null}

        <div className="space-y-2 border-t border-border-soft pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" aria-disabled={save.isPending} data-testid="brief-save">
              {save.isPending ? "Saving…" : "Save brief"}
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/agents/new">Back to hiring an agent</Link>
            </Button>
          </div>
          <p className="text-xs text-text-secondary" data-testid="brief-save-note">
            {BRIEF_SAVE_NO_WAKE_TEXT} You send it to the planner on the next page.
          </p>
        </div>
      </form>

      {unsent.length > 0 || sent.length > 0 ? (
        <section aria-labelledby={`${uid}-briefs`} className="space-y-2" data-testid="brief-list">
          <h2 id={`${uid}-briefs`} className="text-base font-semibold text-text-primary">
            Your briefs
          </h2>
          <ul className="space-y-1 text-sm">
            {[...unsent, ...sent].map((issue) => (
              <li key={issue.id}>
                <Link to={`/agents/briefs/${issue.id}`} className="underline">
                  {issue.title}
                </Link>{" "}
                <span className="text-text-secondary">
                  — {briefIsUnsent(issue) ? "saved, not sent to the planner" : "with the planner"}
                  {issue.updatedAt ? `, updated ${formatDateTime(issue.updatedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {openDrafts.length > 0 ? (
        <section aria-labelledby={`${uid}-drafts`} className="space-y-2" data-testid="unbound-draft-list">
          <h2 id={`${uid}-drafts`} className="text-base font-semibold text-text-primary">
            Draft profiles for new roles
          </h2>
          <ul className="space-y-1 text-sm">
            {openDrafts.map((draft) => (
              <li key={draft.profileId}>
                <Link to={`/agents/drafts/${draft.profileId}`} className="underline">
                  {draft.name || "Untitled role"}
                </Link>
                {draft.title ? <span className="text-text-secondary"> — {draft.title}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
