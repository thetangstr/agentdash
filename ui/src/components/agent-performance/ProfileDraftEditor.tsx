import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AGENT_PROFILE_DRAFT_CONFLICT,
  AGENT_PROFILE_KNOWLEDGE_KINDS,
  AGENT_PROFILE_OBLIGATION_KINDS,
  AGENT_PROFILE_REVISION_STATE_CONFLICT,
  agentAccessPolicySchema,
  agentOperatingProfileV1Schema,
  agentProfileResponsibilitySchema,
  canonicalProfileJson,
  diffProfiles,
  responsibilityContractSchema,
  type AgentOperatingProfileV1,
  type AgentProfileDraftConflictBody,
  type AgentProfileObligationKind,
  type AgentProfileProvenanceMap,
  type AgentProfileResponsibility,
  type AgentProfileRevisionDto,
  type UpdateAgentProfileDraft,
} from "@paperclipai/shared";
import { agentProfilesApi, type ProposeAgentProfileResult } from "@/api/agent-profiles";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatDateTime } from "@/lib/utils";
import { Section } from "./shared";
import {
  ProfileDiffList,
  StoredProvenanceLabel,
  apiErrorCode,
  apiErrorIssues,
  pointerLabel,
  refusalText,
} from "./profile-shared";

// AgentDash: Agent Performance Management gate 2 — the draft editor. For an
// existing agent the DESIGN.md steps are sections, in the overview LLD §6
// order: work it owns, how it works, what it knows, style, runtime (advanced;
// admin-decided fields marked). Saving writes the draft and nothing else:
// no approval, no application, no change to the agent. Saves carry the body
// hash the editor loaded (`If-Match`); a stale one shows both versions side
// by side and overwrites nothing until the person chooses.
// Gate 5: the editing state (`useProfileDraftEditing`) and the sections are
// exported so UnboundDraftEditor composes the same fields as DESIGN.md's
// four steps for a role not hired yet.

export const DRAFT_SAVED_TEXT = "Draft saved";
export const DRAFT_NOTHING_CHANGES_TEXT =
  "Saving a draft changes nothing for the agent. It changes only after a revision is approved and applied.";

export type Path = ReadonlyArray<string | number>;

export function toPointer(path: Path): string {
  if (path.length === 0) return "";
  return `/${path.map((token) => String(token).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

/** Immutable set; `undefined` removes an object member (optional fields stay absent, not empty). */
function setIn(value: unknown, path: Path, next: unknown): unknown {
  if (path.length === 0) return next;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = value.slice();
    copy[head as number] = setIn(copy[head as number], rest, next);
    return copy;
  }
  const record = { ...((value as Record<string, unknown> | null) ?? {}) };
  const child = setIn(record[head as string], rest, next);
  if (child === undefined) delete record[head as string];
  else record[head as string] = child;
  return record;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** An edited field is confirmed by the person who typed it, or `missing` when cleared. Descendant labels are superseded. */
function markEdited(map: AgentProfileProvenanceMap, pointer: string, empty: boolean): AgentProfileProvenanceMap {
  const next: AgentProfileProvenanceMap = {};
  for (const [key, entry] of Object.entries(map)) {
    if (key !== pointer && !key.startsWith(`${pointer}/`)) next[key] = entry;
  }
  next[pointer] = empty ? { state: "missing" } : { state: "owner_confirmed", at: new Date().toISOString() };
  return next;
}

/** Drop `arrayPointer/index…` labels and shift later members down by one. */
function removeIndexedProvenance(map: AgentProfileProvenanceMap, arrayPointer: string, index: number): AgentProfileProvenanceMap {
  const prefix = `${arrayPointer}/`;
  const next: AgentProfileProvenanceMap = {};
  for (const [key, entry] of Object.entries(map)) {
    if (!key.startsWith(prefix)) {
      next[key] = entry;
      continue;
    }
    const match = /^(\d+)(\/.*)?$/.exec(key.slice(prefix.length));
    if (!match) {
      next[key] = entry;
      continue;
    }
    const member = Number(match[1]);
    if (member === index) continue;
    next[member > index ? `${prefix}${member - 1}${match[2] ?? ""}` : key] = entry;
  }
  return next;
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const EMPTY_PERFORMANCE: AgentProfileResponsibility["performance"] = {
  criteria: [],
  coverage: [],
  outcomeLinks: [],
  expectedHumanSteps: [],
  judges: { automated: [] },
};

function newResponsibility(existing: AgentOperatingProfileV1["responsibilities"]): AgentProfileResponsibility {
  const keys = new Set(existing.map((item) => item.key));
  let n = existing.length + 1;
  while (keys.has(`responsibility-${n}`)) n++;
  return {
    key: `responsibility-${n}`,
    title: "",
    outcome: "",
    stakeholders: [],
    obligation: { kind: "assigned" },
    deliverable: { what: "", destination: "" },
    escalation: { when: "" },
    performance: EMPTY_PERFORMANCE,
  };
}

const OBLIGATION_TEXT: Record<AgentProfileObligationKind, string> = {
  assigned: "Arrives as assigned work",
  routine: "A routine trigger (bound, not created)",
  deliverable: "A deliverable (bound, not created)",
  goal: "A goal",
};

const OBLIGATION_ID_FIELD = { routine: "routineTriggerId", deliverable: "deliverableId", goal: "goalId", assigned: null } as const;

const KNOWLEDGE_KIND_TEXT: Record<(typeof AGENT_PROFILE_KNOWLEDGE_KINDS)[number], string> = {
  company_fact: "Company fact",
  document: "Document",
  connection: "Connection",
  other: "Other",
};

export const SELECT_CLASS =
  "h-9 w-full rounded-md border border-border-soft bg-surface-raised px-3 text-sm text-text-primary shadow-sm outline-none focus-visible:border-accent-500 focus-visible:ring-2 focus-visible:ring-accent-200 max-sm:h-11";

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

interface FieldBase {
  label: string;
  pointer: string;
  provenance: AgentProfileProvenanceMap;
  hint?: ReactNode;
  adminDecides?: boolean;
}

function useFieldIds(pointer: string) {
  const base = useId();
  const slug = pointer.replace(/[^a-zA-Z0-9]+/g, "-");
  return { id: `${base}${slug}`, provenanceId: `${base}${slug}-provenance`, hintId: `${base}${slug}-hint`, errorId: `${base}${slug}-error` };
}

function FieldShell({
  label,
  pointer,
  provenance,
  hint,
  adminDecides,
  error,
  children,
}: FieldBase & { error?: string | null; children: (ids: { id: string; describedBy: string }) => ReactNode }) {
  const ids = useFieldIds(pointer);
  const describedBy = [ids.provenanceId, hint ? ids.hintId : null, error ? ids.errorId : null].filter(Boolean).join(" ");
  return (
    <div className="space-y-1.5" data-testid="agent-profile-field" data-pointer={pointer}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={ids.id}>
          {label}
          {adminDecides ? <span className="font-normal text-text-secondary">(a company admin decides)</span> : null}
        </Label>
        <StoredProvenanceLabel id={ids.provenanceId} map={provenance} pointer={pointer} />
      </div>
      {children({ id: ids.id, describedBy })}
      {hint ? (
        <p id={ids.hintId} className="text-xs text-text-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={ids.errorId} className="text-xs text-danger-500">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function TextField({
  value,
  onChange,
  multiline = false,
  ...base
}: FieldBase & { value: string; onChange: (value: string) => void; multiline?: boolean }) {
  return (
    <FieldShell {...base}>
      {({ id, describedBy }) =>
        multiline ? (
          <Textarea id={id} aria-describedby={describedBy} value={value} onChange={(event) => onChange(event.target.value)} rows={3} />
        ) : (
          <Input id={id} aria-describedby={describedBy} value={value} onChange={(event) => onChange(event.target.value)} />
        )
      }
    </FieldShell>
  );
}

interface ParseSchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}

/** Structured fields without a form yet (criteria, stakeholders, the access request), edited as validated JSON. */
function JsonField<T>({
  value,
  schema,
  onChange,
  onValidity,
  ...base
}: FieldBase & {
  value: T;
  schema: ParseSchema<T>;
  onChange: (value: T) => void;
  onValidity: (valid: boolean) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <FieldShell {...base} error={error}>
      {({ id, describedBy }) => (
        <Textarea
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className="font-mono text-xs"
          rows={6}
          spellCheck={false}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            let parsed: unknown;
            try {
              parsed = JSON.parse(next);
            } catch {
              setError("This is not valid JSON yet; the last valid value is kept.");
              onValidity(false);
              return;
            }
            const result = schema.safeParse(parsed);
            if (!result.success) {
              setError(
                result.error.issues
                  .slice(0, 3)
                  .map((issue) => `${issue.path.map(String).join(".") || "(top level)"}: ${issue.message}`)
                  .join("; "),
              );
              onValidity(false);
              return;
            }
            setError(null);
            onValidity(true);
            onChange(result.data);
          }}
        />
      )}
    </FieldShell>
  );
}

// ---------------------------------------------------------------------------
// Editing state — shared by the agent's draft editor and, for a role not
// hired yet, the unbound draft editor (APM gate 5). Only the save call
// differs; the If-Match, the 409 comparison and the validation are the same.
// ---------------------------------------------------------------------------

interface EditorSnapshot {
  body: AgentOperatingProfileV1;
  provenance: AgentProfileProvenanceMap;
  rowIds: string[];
}

let rowCounter = 0;
function nextRowId(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

function snapshotFrom(revision: Pick<AgentProfileRevisionDto, "body" | "provenance">): EditorSnapshot {
  return {
    body: revision.body,
    provenance: revision.provenance ?? {},
    rowIds: revision.body.responsibilities.map(() => nextRowId()),
  };
}

function conflictCurrent(error: unknown): AgentProfileRevisionDto | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  if (apiErrorCode(error) !== AGENT_PROFILE_DRAFT_CONFLICT) return null;
  const current = (error.body as Partial<AgentProfileDraftConflictBody> | null)?.current;
  return current && typeof current === "object" && current.body ? current : null;
}

export interface ProfileDraftProblem {
  text: string;
  issues: string[];
  stale?: boolean;
}

export interface ProfileDraftEditing {
  draft: AgentProfileRevisionDto;
  body: AgentOperatingProfileV1;
  provenance: AgentProfileProvenanceMap;
  rowIds: string[];
  /** Bumped when the saved version is adopted, so uncontrolled fields re-read it. */
  formKey: number;
  /** The body hash the editor's saves are based on (`If-Match`). */
  baseHash: string;
  savedAt: string;
  dirty: boolean;
  jsonBlocked: boolean;
  announcement: string;
  setAnnouncement: (text: string) => void;
  problem: ProfileDraftProblem | null;
  setProblem: (problem: ProfileDraftProblem | null) => void;
  conflict: AgentProfileRevisionDto | null;
  savePending: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  update: (path: Path, value: unknown) => void;
  setJsonValidity: (key: string, valid: boolean) => void;
  addResponsibility: () => void;
  removeResponsibility: (index: number) => void;
  addKnowledge: () => void;
  removeKnowledge: (index: number) => void;
  localIssues: () => string[];
  requestSave: (ifMatch: string) => void;
  adoptSavedVersion: (current: AgentProfileRevisionDto) => void;
}

export function useProfileDraftEditing({
  draft,
  saveDraft,
  onSaved,
}: {
  /** The open draft. Read once; later prop changes never reset the person's edits. */
  draft: AgentProfileRevisionDto;
  saveDraft: (ifMatch: string, input: UpdateAgentProfileDraft) => Promise<AgentProfileRevisionDto>;
  onSaved: (saved: AgentProfileRevisionDto) => void;
}): ProfileDraftEditing {
  const [snapshot, setSnapshot] = useState<EditorSnapshot>(() => snapshotFrom(draft));
  const [baseHash, setBaseHash] = useState(draft.bodyHash);
  const [savedJson, setSavedJson] = useState(() => canonicalProfileJson(draft.body));
  const [savedAt, setSavedAt] = useState<string>(draft.updatedAt);
  const [formKey, setFormKey] = useState(0);
  const [invalidJson, setInvalidJson] = useState<Record<string, true>>({});
  const [announcement, setAnnouncement] = useState("");
  const [problem, setProblem] = useState<ProfileDraftProblem | null>(null);
  const [conflict, setConflict] = useState<AgentProfileRevisionDto | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const { body, provenance, rowIds } = snapshot;
  const dirty = useMemo(() => canonicalProfileJson(body) !== savedJson, [body, savedJson]);
  const jsonBlocked = Object.keys(invalidJson).length > 0;

  function update(path: Path, value: unknown) {
    const pointer = toPointer(path);
    setSnapshot((current) => ({
      ...current,
      body: setIn(current.body, path, value) as AgentOperatingProfileV1,
      provenance: markEdited(current.provenance, pointer, isEmptyValue(value)),
    }));
    setAnnouncement("");
  }

  function setJsonValidity(key: string, valid: boolean) {
    setInvalidJson((current) => {
      if (valid === !current[key]) return current;
      const next = { ...current };
      if (valid) delete next[key];
      else next[key] = true;
      return next;
    });
  }

  function addResponsibility() {
    setSnapshot((current) => {
      const index = current.body.responsibilities.length;
      const responsibilities = [...current.body.responsibilities, newResponsibility(current.body.responsibilities)];
      return {
        body: { ...current.body, responsibilities },
        provenance: markEdited(current.provenance, `/responsibilities/${index}`, false),
        rowIds: [...current.rowIds, nextRowId()],
      };
    });
  }

  function removeResponsibility(index: number) {
    const rowId = rowIds[index];
    setSnapshot((current) => ({
      body: { ...current.body, responsibilities: current.body.responsibilities.filter((_, i) => i !== index) },
      provenance: removeIndexedProvenance(current.provenance, "/responsibilities", index),
      rowIds: current.rowIds.filter((_, i) => i !== index),
    }));
    setInvalidJson((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${rowId}:`))));
  }

  function addKnowledge() {
    update(["knowledge", body.knowledge.length], { source: "", kind: "document" });
  }

  function removeKnowledge(index: number) {
    setSnapshot((current) => ({
      ...current,
      body: { ...current.body, knowledge: current.body.knowledge.filter((_, i) => i !== index) },
      provenance: removeIndexedProvenance(current.provenance, "/knowledge", index),
    }));
  }

  function localIssues(): string[] {
    const parsed = agentOperatingProfileV1Schema.safeParse(body);
    if (parsed.success) return [];
    return parsed.error.issues.slice(0, 20).map((issue) => {
      const label = pointerLabel(toPointer(issue.path as Array<string | number>), body);
      return `${label}: ${issue.message}`;
    });
  }

  const save = useMutation({
    mutationFn: (ifMatch: string) => saveDraft(ifMatch, { body, provenance }),
    onSuccess: (saved) => {
      setBaseHash(saved.bodyHash);
      setSavedJson(canonicalProfileJson(saved.body));
      setSavedAt(saved.updatedAt);
      setConflict(null);
      setProblem(null);
      setAnnouncement(DRAFT_SAVED_TEXT);
      onSaved(saved);
    },
    onError: (error) => {
      setAnnouncement("");
      const current = conflictCurrent(error);
      if (current) {
        setConflict(current);
        setProblem(null);
        return;
      }
      const stale = error instanceof ApiError && error.status === 409 && apiErrorCode(error) === AGENT_PROFILE_REVISION_STATE_CONFLICT;
      setProblem({
        text: `${refusalText("save the draft", error)} Your changes are still here and nothing was saved.`,
        issues: apiErrorIssues(error).map((issue) => `${issue.path || "(top level)"}: ${issue.message}`),
        stale,
      });
    },
  });

  function requestSave(ifMatch: string) {
    if (save.isPending) return;
    const issues = localIssues();
    if (issues.length > 0) {
      setAnnouncement("");
      setProblem({ text: "The draft can't be saved yet. Fix these fields; nothing was saved.", issues });
      return;
    }
    if (jsonBlocked) {
      setAnnouncement("");
      setProblem({ text: "One of the structured fields isn't valid yet. Fix it; nothing was saved.", issues: [] });
      return;
    }
    save.mutate(ifMatch);
  }

  function adoptSavedVersion(current: AgentProfileRevisionDto) {
    setSnapshot(snapshotFrom(current));
    setBaseHash(current.bodyHash);
    setSavedJson(canonicalProfileJson(current.body));
    setSavedAt(current.updatedAt);
    setInvalidJson({});
    setConflict(null);
    setFormKey((key) => key + 1);
    setAnnouncement("Loaded the saved draft. Your unsaved changes were discarded.");
    headingRef.current?.focus();
  }

  return {
    draft,
    body,
    provenance,
    rowIds,
    formKey,
    baseHash,
    savedAt,
    dirty,
    jsonBlocked,
    announcement,
    setAnnouncement,
    problem,
    setProblem,
    conflict,
    savePending: save.isPending,
    headingRef,
    update,
    setJsonValidity,
    addResponsibility,
    removeResponsibility,
    addKnowledge,
    removeKnowledge,
    localIssues,
    requestSave,
    adoptSavedVersion,
  };
}

// ---------------------------------------------------------------------------
// Sections — composed as the agent's sections here and as DESIGN.md's four
// steps in UnboundDraftEditor. Each takes the shared editing state.
// ---------------------------------------------------------------------------

export function ProfileIdentityFields({ editing }: { editing: ProfileDraftEditing }) {
  const { body, provenance, update } = editing;
  const identity = body.identity;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" pointer="/identity/name" provenance={provenance} value={identity.name} onChange={(v) => update(["identity", "name"], v)} />
        <TextField label="Title" pointer="/identity/title" provenance={provenance} value={identity.title} onChange={(v) => update(["identity", "title"], v)} />
      </div>
      <TextField label="Summary" pointer="/identity/summary" provenance={provenance} value={identity.summary} multiline onChange={(v) => update(["identity", "summary"], v)} />
      <TextField label="Who it serves" pointer="/identity/audience" provenance={provenance} value={identity.audience} multiline onChange={(v) => update(["identity", "audience"], v)} />
    </>
  );
}

type ResponsibilityPart =
  | "titleKey"
  | "outcome"
  | "notOwned"
  | "obligation"
  | "deliverable"
  | "whenToAsk"
  | "askWho"
  | "stakeholders"
  | "performance";

/** `all`: one card per responsibility (the agent's editor). `work` / `boundaries`: the unbound editor's steps 1 and 3. */
export type ResponsibilityFieldsMode = "all" | "work" | "boundaries";

const RESPONSIBILITY_PARTS: Record<ResponsibilityFieldsMode, ResponsibilityPart[]> = {
  all: ["titleKey", "outcome", "notOwned", "obligation", "deliverable", "whenToAsk", "askWho", "stakeholders", "performance"],
  work: ["titleKey", "outcome", "obligation", "deliverable", "stakeholders"],
  boundaries: ["notOwned", "whenToAsk", "askWho", "performance"],
};

function ResponsibilityPartFields({
  editing,
  index,
  part,
  obligationHint,
}: {
  editing: ProfileDraftEditing;
  index: number;
  part: ResponsibilityPart;
  obligationHint?: string;
}) {
  const { body, provenance, rowIds, update, setJsonValidity } = editing;
  const item = body.responsibilities[index]!;
  const rowId = rowIds[index] ?? `index-${index}`;
  const base = ["responsibilities", index] as const;
  const ptr = `/responsibilities/${index}`;
  switch (part) {
    case "titleKey":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Title" pointer={`${ptr}/title`} provenance={provenance} value={item.title} onChange={(v) => update([...base, "title"], v)} />
          <TextField
            label="Key"
            pointer={`${ptr}/key`}
            provenance={provenance}
            value={item.key}
            hint="Stable id for mapping work: lowercase letters, digits, - and _."
            onChange={(v) => update([...base, "key"], v)}
          />
        </div>
      );
    case "outcome":
      return <TextField label="Outcome" pointer={`${ptr}/outcome`} provenance={provenance} value={item.outcome} multiline onChange={(v) => update([...base, "outcome"], v)} />;
    case "notOwned":
      return (
        <TextField
          label="Not owned (one per line)"
          pointer={`${ptr}/notOwned`}
          provenance={provenance}
          value={(item.notOwned ?? []).join("\n")}
          multiline
          onChange={(v) => update([...base, "notOwned"], lines(v).length > 0 ? lines(v) : undefined)}
        />
      );
    case "obligation": {
      const idField = OBLIGATION_ID_FIELD[item.obligation.kind];
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldShell
            label="Where the work comes from"
            pointer={`${ptr}/obligation`}
            provenance={provenance}
            hint={obligationHint ?? "Binds an existing record; schedules are made in Routines."}
          >
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy}
                className={SELECT_CLASS}
                value={item.obligation.kind}
                onChange={(event) => update([...base, "obligation"], { kind: event.target.value as AgentProfileObligationKind })}
              >
                {AGENT_PROFILE_OBLIGATION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {OBLIGATION_TEXT[kind]}
                  </option>
                ))}
              </select>
            )}
          </FieldShell>
          {idField ? (
            <TextField
              label={idField === "routineTriggerId" ? "Routine trigger id" : idField === "deliverableId" ? "Deliverable id" : "Goal id"}
              pointer={`${ptr}/obligation/${idField}`}
              provenance={provenance}
              value={(item.obligation as Record<string, string | undefined>)[idField] ?? ""}
              onChange={(v) => update([...base, "obligation", idField], v.trim() ? v.trim() : undefined)}
            />
          ) : null}
        </div>
      );
    }
    case "deliverable":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Deliverable" pointer={`${ptr}/deliverable/what`} provenance={provenance} value={item.deliverable.what} onChange={(v) => update([...base, "deliverable", "what"], v)} />
          <TextField label="Where it goes" pointer={`${ptr}/deliverable/destination`} provenance={provenance} value={item.deliverable.destination} onChange={(v) => update([...base, "deliverable", "destination"], v)} />
        </div>
      );
    case "whenToAsk":
      return <TextField label="When to ask" pointer={`${ptr}/escalation/when`} provenance={provenance} value={item.escalation.when} multiline onChange={(v) => update([...base, "escalation", "when"], v)} />;
    case "askWho":
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Ask this person (user id)"
            pointer={`${ptr}/escalation/toUserId`}
            provenance={provenance}
            value={item.escalation.toUserId ?? ""}
            onChange={(v) => update([...base, "escalation", "toUserId"], v.trim() ? v.trim() : undefined)}
          />
          <TextField
            label="Or this agent (agent id)"
            pointer={`${ptr}/escalation/toAgentId`}
            provenance={provenance}
            value={item.escalation.toAgentId ?? ""}
            onChange={(v) => update([...base, "escalation", "toAgentId"], v.trim() ? v.trim() : undefined)}
          />
        </div>
      );
    case "stakeholders":
      return (
        <JsonField
          label="Stakeholders (structured)"
          pointer={`${ptr}/stakeholders`}
          provenance={provenance}
          value={item.stakeholders}
          schema={agentProfileResponsibilitySchema.shape.stakeholders}
          hint='A list of { "userId" or "agentId", "need" }.'
          onChange={(v) => update([...base, "stakeholders"], v)}
          onValidity={(valid) => setJsonValidity(`${rowId}:stakeholders`, valid)}
        />
      );
    case "performance":
      return (
        <JsonField
          label="How we will judge the work (structured)"
          pointer={`${ptr}/performance`}
          provenance={provenance}
          value={item.performance}
          schema={responsibilityContractSchema}
          hint="Criteria, coverage, judges and thresholds a person agrees to. Feedback is not acceptance."
          onChange={(v) => update([...base, "performance"], v)}
          onValidity={(valid) => setJsonValidity(`${rowId}:performance`, valid)}
        />
      );
  }
}

export function ProfileResponsibilityFields({
  editing,
  mode = "all",
  obligationHint,
}: {
  editing: ProfileDraftEditing;
  mode?: ResponsibilityFieldsMode;
  /** Replaces the "where the work comes from" hint (a new hire has no routines yet). */
  obligationHint?: string;
}) {
  const { body, rowIds, addResponsibility, removeResponsibility } = editing;
  const editsList = mode !== "boundaries";
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-text-primary">Responsibilities</h4>
      {body.responsibilities.length === 0 ? (
        <p className="text-sm text-text-secondary">
          {editsList ? "No responsibilities yet. Add the work this agent owns." : "No responsibilities yet. Add the work it owns first."}
        </p>
      ) : null}
      <ol className="space-y-4">
        {body.responsibilities.map((item, index) => {
          const rowId = rowIds[index] ?? `index-${index}`;
          return (
            <li
              key={rowId}
              className="space-y-3 rounded-md border border-border-soft px-3 py-3"
              aria-label={`Responsibility ${index + 1}${item.title ? `: ${item.title}` : ""}`}
              data-testid="agent-profile-edit-responsibility"
            >
              {mode === "boundaries" ? (
                <p className="text-sm font-medium text-text-primary">{item.title || `Responsibility ${index + 1}`}</p>
              ) : null}
              {RESPONSIBILITY_PARTS[mode].map((part) => (
                <ResponsibilityPartFields key={part} editing={editing} index={index} part={part} obligationHint={obligationHint} />
              ))}
              {editsList ? (
                <div className="flex justify-end">
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeResponsibility(index)}>
                    Remove responsibility {item.title ? `“${item.title}”` : index + 1}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {editsList ? (
        <Button type="button" variant="outline" size="sm" onClick={addResponsibility}>
          Add responsibility
        </Button>
      ) : null}
    </div>
  );
}

export function ProfileRhythmFields({ editing }: { editing: ProfileDraftEditing }) {
  const { body, provenance, update } = editing;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField label="Time zone" pointer="/rhythm/timezone" provenance={provenance} value={body.rhythm.timezone} onChange={(v) => update(["rhythm", "timezone"], v)} />
      <TextField
        label="Quiet hours"
        pointer="/rhythm/quietHours"
        provenance={provenance}
        value={body.rhythm.quietHours ?? ""}
        onChange={(v) => update(["rhythm", "quietHours"], v.trim() ? v : undefined)}
      />
      <TextField
        label="Reports to a person (user id)"
        pointer="/rhythm/reportTo/userId"
        provenance={provenance}
        value={body.rhythm.reportTo.userId ?? ""}
        onChange={(v) => update(["rhythm", "reportTo", "userId"], v.trim() ? v.trim() : undefined)}
      />
      <TextField
        label="Or to an agent (agent id)"
        pointer="/rhythm/reportTo/agentId"
        provenance={provenance}
        value={body.rhythm.reportTo.agentId ?? ""}
        onChange={(v) => update(["rhythm", "reportTo", "agentId"], v.trim() ? v.trim() : undefined)}
      />
      <TextField
        label="Report cadence"
        pointer="/rhythm/reportCadence"
        provenance={provenance}
        value={body.rhythm.reportCadence ?? ""}
        onChange={(v) => update(["rhythm", "reportCadence"], v.trim() ? v : undefined)}
      />
    </div>
  );
}

export function ProfileAccessField({ editing }: { editing: ProfileDraftEditing }) {
  const { body, provenance, update, setJsonValidity } = editing;
  return (
    <JsonField
      label="What it may do (requested access, structured)"
      pointer="/access"
      provenance={provenance}
      value={body.access}
      schema={agentAccessPolicySchema}
      hint="This is a request. An admin's ceiling still limits it, and asking for more than the ceiling needs an admin to decide."
      onChange={(v) => update(["access"], v)}
      onValidity={(valid) => setJsonValidity("access", valid)}
    />
  );
}

export function ProfileKnowledgeFields({ editing }: { editing: ProfileDraftEditing }) {
  const { body, provenance, update, addKnowledge, removeKnowledge } = editing;
  return (
    <>
      <div className="space-y-3">
        {body.knowledge.length === 0 ? <p className="text-sm text-text-secondary">No sources yet.</p> : null}
        <ol className="space-y-3">
          {body.knowledge.map((source, index) => (
            <li key={`knowledge-${index}`} className="grid gap-3 rounded-md border border-border-soft px-3 py-3 sm:grid-cols-2" aria-label={`Source ${index + 1}`}>
              <TextField label="Source" pointer={`/knowledge/${index}/source`} provenance={provenance} value={source.source} onChange={(v) => update(["knowledge", index, "source"], v)} />
              <FieldShell label="Kind" pointer={`/knowledge/${index}/kind`} provenance={provenance}>
                {({ id, describedBy }) => (
                  <select
                    id={id}
                    aria-describedby={describedBy}
                    className={SELECT_CLASS}
                    value={source.kind}
                    onChange={(event) => update(["knowledge", index, "kind"], event.target.value)}
                  >
                    {AGENT_PROFILE_KNOWLEDGE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KNOWLEDGE_KIND_TEXT[kind]}
                      </option>
                    ))}
                  </select>
                )}
              </FieldShell>
              <TextField
                label="Reference"
                pointer={`/knowledge/${index}/ref`}
                provenance={provenance}
                value={source.ref ?? ""}
                onChange={(v) => update(["knowledge", index, "ref"], v.trim() ? v : undefined)}
              />
              <TextField
                label="Freshness"
                pointer={`/knowledge/${index}/freshness`}
                provenance={provenance}
                value={source.freshness ?? ""}
                onChange={(v) => update(["knowledge", index, "freshness"], v.trim() ? v : undefined)}
              />
              <div className="sm:col-span-2 flex justify-end">
                <Button type="button" variant="ghost" size="sm" onClick={() => removeKnowledge(index)}>
                  Remove source {index + 1}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <Button type="button" variant="outline" size="sm" onClick={addKnowledge}>
          Add source
        </Button>
      </div>
      <TextField
        label="Skills (one per line)"
        pointer="/skills"
        provenance={provenance}
        value={body.skills.join("\n")}
        multiline
        hint="Knowing a skill is not permission to use it; the access request decides that."
        onChange={(v) => update(["skills"], lines(v))}
      />
    </>
  );
}

export function ProfileStyleFields({ editing }: { editing: ProfileDraftEditing }) {
  const { body, provenance, update } = editing;
  const identity = body.identity;
  return (
    <>
      <TextField label="Tone" pointer="/identity/style/tone" provenance={provenance} value={identity.style.tone} multiline onChange={(v) => update(["identity", "style", "tone"], v)} />
      <TextField
        label="When it is unsure"
        pointer="/identity/style/uncertaintyRule"
        provenance={provenance}
        value={identity.style.uncertaintyRule}
        multiline
        onChange={(v) => update(["identity", "style", "uncertaintyRule"], v)}
      />
      <TextField
        label="Example"
        pointer="/identity/style/example"
        provenance={provenance}
        value={identity.style.example ?? ""}
        multiline
        onChange={(v) => update(["identity", "style", "example"], v.trim() ? v : undefined)}
      />
    </>
  );
}

export interface ProfileAdapterOption {
  value: string;
  label: string;
}

/**
 * Runtime (advanced, collapsed). For an existing agent the adapter is read
 * here only (it changes on the agent's settings). For a role not hired yet
 * pass `adapterOptions`: the hire is filed with the adapter chosen here.
 */
export function ProfileRuntimeFields({
  editing,
  adapterOptions,
  intro = "These run on the host. A steward may draft them, but approving any change here needs a company admin.",
  defaultOpen = false,
}: {
  editing: ProfileDraftEditing;
  adapterOptions?: ProfileAdapterOption[];
  intro?: string;
  defaultOpen?: boolean;
}) {
  const { body, provenance, update } = editing;
  const runtime = body.runtime ?? {};
  const currentAdapter = runtime.adapterType ?? "";
  const options =
    adapterOptions && currentAdapter && !adapterOptions.some((option) => option.value === currentAdapter)
      ? [...adapterOptions, { value: currentAdapter, label: currentAdapter }]
      : adapterOptions;
  return (
    <details className="group space-y-4" data-testid="agent-profile-edit-runtime" open={defaultOpen || undefined}>
      <summary className="flex min-h-11 cursor-pointer select-none items-center text-base font-semibold text-text-primary">
        Runtime (advanced)
      </summary>
      <p className="text-sm text-text-secondary">{intro}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {options ? (
          <FieldShell
            label="Adapter"
            pointer="/runtime/adapterType"
            provenance={provenance}
            adminDecides
            hint="What the new agent runs on. A hire request needs one."
          >
            {({ id, describedBy }) => (
              <select
                id={id}
                aria-describedby={describedBy}
                className={SELECT_CLASS}
                value={currentAdapter}
                onChange={(event) => update(["runtime", "adapterType"], event.target.value || undefined)}
              >
                <option value="">Not chosen yet</option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
          </FieldShell>
        ) : (
          <FieldShell label="Adapter" pointer="/runtime/adapterType" provenance={provenance} adminDecides hint="Change the adapter on the agent's settings; a profile can't change it yet.">
            {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} value={currentAdapter} readOnly />}
          </FieldShell>
        )}
        <TextField
          label="Model"
          pointer="/runtime/model"
          provenance={provenance}
          adminDecides
          value={runtime.model ?? ""}
          onChange={(v) => update(["runtime", "model"], v.trim() ? v.trim() : undefined)}
        />
        <TextField
          label="Execution environment id"
          pointer="/runtime/environmentId"
          provenance={provenance}
          adminDecides
          value={runtime.environmentId ?? ""}
          onChange={(v) => update(["runtime", "environmentId"], v.trim() ? v.trim() : undefined)}
        />
        <FieldShell label="Heartbeat interval (seconds)" pointer="/runtime/heartbeat/intervalSec" provenance={provenance} adminDecides>
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              inputMode="numeric"
              value={runtime.heartbeat?.intervalSec != null ? String(runtime.heartbeat.intervalSec) : ""}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const parsed = Number.parseInt(raw, 10);
                update(["runtime", "heartbeat", "intervalSec"], raw === "" || Number.isNaN(parsed) ? undefined : parsed);
              }}
            />
          )}
        </FieldShell>
        <FieldShell label="Wakes on demand" pointer="/runtime/heartbeat/wakeOnDemand" provenance={provenance} adminDecides>
          {({ id, describedBy }) => (
            <select
              id={id}
              aria-describedby={describedBy}
              className={SELECT_CLASS}
              value={runtime.heartbeat?.wakeOnDemand == null ? "" : runtime.heartbeat.wakeOnDemand ? "yes" : "no"}
              onChange={(event) =>
                update(["runtime", "heartbeat", "wakeOnDemand"], event.target.value === "" ? undefined : event.target.value === "yes")
              }
            >
              <option value="">Not set</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          )}
        </FieldShell>
      </div>
    </details>
  );
}

/** A 409 save conflict: both versions side by side; nothing is overwritten until the person chooses. */
export function ProfileDraftConflictPanel({ editing }: { editing: ProfileDraftEditing }) {
  const { conflict, body, requestSave, adoptSavedVersion, savePending } = editing;
  if (!conflict) return null;
  return (
    <div role="alert" className="space-y-3 rounded-md border border-warn-500/40 px-3 py-3 text-sm" data-testid="agent-profile-conflict">
      <p className="font-medium text-text-primary">This draft changed since you opened it.</p>
      <p className="text-text-secondary">
        Someone saved a different version at {formatDateTime(conflict.updatedAt)}. Nothing was overwritten. Compare the two,
        then keep yours or use the saved one.
      </p>
      <ProfileDiffList
        diff={diffProfiles(conflict.body, body)}
        body={body}
        beforeLabel="Saved draft"
        afterLabel="Yours"
        emptyText="The two versions have the same content."
        testId="agent-profile-conflict-diff"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => requestSave(conflict.bodyHash)} aria-disabled={savePending}>
          Save my version over it
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => adoptSavedVersion(conflict)}>
          Use the saved draft
        </Button>
      </div>
    </div>
  );
}

export function ProfileDraftProblemPanel({ editing, onStale }: { editing: ProfileDraftEditing; onStale: () => void }) {
  const { problem } = editing;
  if (!problem) return null;
  return (
    <div role="alert" className="space-y-2 rounded-md border border-danger-500/30 px-3 py-2 text-sm" data-testid="agent-profile-editor-error">
      <p className="text-text-primary">{problem.text}</p>
      {problem.issues.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-5 text-text-secondary">
          {problem.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {problem.stale ? (
        <Button type="button" size="sm" variant="outline" onClick={onStale}>
          Reload the profile
        </Button>
      ) : null}
    </div>
  );
}

/** The polite live region a save announces into ("Draft saved"). */
export function ProfileDraftStatus({ editing }: { editing: ProfileDraftEditing }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn("text-sm", editing.announcement ? "text-text-primary" : "sr-only")}
      data-testid="agent-profile-draft-status"
    >
      {editing.announcement}
    </p>
  );
}

// ---------------------------------------------------------------------------
// The agent's draft editor
// ---------------------------------------------------------------------------

export function ProfileDraftEditor({
  companyId,
  agentId,
  draft,
  mayPropose,
  onSaved,
  onProposed,
  onStale,
}: {
  companyId: string;
  agentId: string;
  /** The open draft. The editor initialises from it once; later prop changes never reset the person's edits. */
  draft: AgentProfileRevisionDto;
  /** The view's `viewer.canPropose`: false hides Request approval (the server would refuse it). */
  mayPropose: boolean;
  onSaved: (saved: AgentProfileRevisionDto) => void;
  onProposed: (result: ProposeAgentProfileResult) => void;
  /** The draft is no longer editable (proposed elsewhere, or the active profile moved). */
  onStale: () => void;
}) {
  const editing = useProfileDraftEditing({
    draft,
    saveDraft: (ifMatch, input) => agentProfilesApi.saveDraft(companyId, agentId, draft.id, ifMatch, input),
    onSaved,
  });
  const [proposing, setProposing] = useState(false);
  const [reason, setReason] = useState("");
  const [expectedBenefit, setExpectedBenefit] = useState("");
  const [risks, setRisks] = useState("");
  const { dirty, jsonBlocked, conflict, savedAt, baseHash, formKey, headingRef, requestSave, setProblem } = editing;

  const propose = useMutation({
    mutationFn: () =>
      agentProfilesApi.propose(companyId, agentId, draft.id, {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(expectedBenefit.trim() ? { expectedBenefit: expectedBenefit.trim() } : {}),
        ...(risks.trim() ? { risks: risks.trim() } : {}),
      }),
    onSuccess: (result) => onProposed(result),
    onError: (error) => {
      const stale = error instanceof ApiError && error.status === 409;
      setProblem({ text: refusalText("ask for approval", error), issues: [], stale });
    },
  });

  const canPropose = !dirty && !jsonBlocked && !conflict;

  return (
    <section aria-labelledby="agent-profile-editor-heading" className="space-y-6" data-testid="agent-profile-editor">
      <div className="space-y-1">
        <h3
          id="agent-profile-editor-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-base font-semibold text-text-primary focus-visible:outline-none"
        >
          Draft revision {draft.revisionNumber}
        </h3>
        <p className="text-sm text-text-secondary">{DRAFT_NOTHING_CHANGES_TEXT}</p>
        <p className="text-xs text-text-secondary">
          Last saved {formatDateTime(savedAt)}. {dirty ? "You have unsaved changes." : "No unsaved changes."}
        </p>
      </div>

      <form
        key={formKey}
        className="space-y-8"
        onSubmit={(event) => {
          event.preventDefault();
          requestSave(baseHash);
        }}
      >
        <Section id="agent-profile-edit-work" title="Work it owns" description="What this agent is for, and the duties it owns.">
          <ProfileIdentityFields editing={editing} />
          <ProfileResponsibilityFields editing={editing} />
        </Section>

        <Section id="agent-profile-edit-rhythm" title="How it works" description="Its rhythm, who it reports to, and what it may do.">
          <ProfileRhythmFields editing={editing} />
          <ProfileAccessField editing={editing} />
        </Section>

        <Section id="agent-profile-edit-knows" title="What it knows" description="Sources it should use, and the skills it knows how to use.">
          <ProfileKnowledgeFields editing={editing} />
        </Section>

        <Section id="agent-profile-edit-style" title="Style" description="How it communicates.">
          <ProfileStyleFields editing={editing} />
        </Section>

        <ProfileRuntimeFields editing={editing} />

        <ProfileDraftConflictPanel editing={editing} />
        <ProfileDraftProblemPanel editing={editing} onStale={onStale} />

        <div className="sticky bottom-0 z-10 space-y-2 border-t border-border-soft bg-surface-page py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" aria-disabled={editing.savePending} data-testid="agent-profile-save">
              {editing.savePending ? "Saving…" : "Save draft"}
            </Button>
            {mayPropose ? (
              <Button
                type="button"
                variant="outline"
                aria-disabled={!canPropose}
                aria-describedby={!canPropose ? "agent-profile-propose-hint" : undefined}
                onClick={() => {
                  if (!canPropose) return;
                  setProposing(true);
                }}
                data-testid="agent-profile-request-approval"
              >
                Request approval
              </Button>
            ) : null}
            <Button variant="ghost" asChild>
              <a href={agentProfilesApi.exportMarkdownUrl(companyId, agentId, draft.id)} download={`profile-revision-${draft.revisionNumber}.md`}>
                Export Markdown (saved draft)
              </a>
            </Button>
          </div>
          {mayPropose && !canPropose ? (
            <p id="agent-profile-propose-hint" className="text-xs text-text-secondary">
              Save the draft first: approval is asked for what was saved.
            </p>
          ) : null}
          <ProfileDraftStatus editing={editing} />
        </div>
      </form>

      {proposing && mayPropose ? (
        <div className="space-y-3 rounded-md border border-border-soft px-3 py-3" data-testid="agent-profile-propose-form">
          <h4 className="text-sm font-medium text-text-primary">Ask for approval of revision {draft.revisionNumber}</h4>
          <p className="text-sm text-text-secondary">
            The saved draft is frozen and sent to the people who can decide. Nothing changes for the agent until it is approved
            and applied.
          </p>
          <TextAreaPlain label="Why this change" value={reason} onChange={setReason} />
          <TextAreaPlain label="What it should improve" value={expectedBenefit} onChange={setExpectedBenefit} />
          <TextAreaPlain label="Risks" value={risks} onChange={setRisks} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => !propose.isPending && propose.mutate()} aria-disabled={propose.isPending} data-testid="agent-profile-send-for-approval">
              {propose.isPending ? "Sending…" : "Send for approval"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setProposing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function TextAreaPlain({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label} (optional)</Label>
      <Textarea id={id} value={value} rows={2} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
