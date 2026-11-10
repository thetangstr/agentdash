import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AGENT_DESTRUCTIVE_ACTION_MODES,
  AGENT_MINIMUM_APPROVAL_MODES,
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  type AgentGovernancePolicy,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "../../api/client";
import { agentsApi } from "../../api/agents";
import { ceilingTemplatesApi, type CeilingTemplate } from "../../api/ceilingTemplates";
import { queryKeys } from "../../lib/queryKeys";
import { BatchPreviewDialog } from "../batch/BatchPreviewDialog";
import { describePolicyChange } from "../batch/policy-diff";

/**
 * AgentDash admin powers: ceiling templates in Company Settings. An owner or
 * admin defines a ceiling once and applies it to many agents (the shared
 * preview dialog shows what each agent gains and loses), or makes it the
 * ceiling for new agents in Admin powers. Where the server has no agent
 * ceilings (it answers 404), the card says they are available on request.
 */

const DESTRUCTIVE_WORDS: Record<string, string> = { blocked: "Never", approval_required: "Only with approval", allowed: "Allowed" };
const APPROVAL_WORDS: Record<string, string> = { none: "No approval needed", steward: "Its steward approves" };

interface Draft {
  name: string;
  budget: string;
  permissions: string;
  dataScopes: string;
  providers: string;
  destructiveActions: AgentGovernancePolicy["destructiveActions"];
  minimumApproval: AgentGovernancePolicy["minimumApproval"];
}

const listText = (values: string[]) => values.join(", ");
const parseList = (text: string) => {
  const values = text.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length === 0 ? [] : values;
};

function draftFrom(template?: CeilingTemplate): Draft {
  const c = template?.ceiling;
  return {
    name: template?.name ?? "",
    budget: !c || c.monthlyBudgetCents >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS ? "" : String(c.monthlyBudgetCents / 100),
    permissions: c ? listText(c.permissions) : "*",
    dataScopes: c ? listText(c.dataScopes) : "*",
    providers: c ? listText(c.providers) : "*",
    destructiveActions: c?.destructiveActions ?? "approval_required",
    minimumApproval: c?.minimumApproval ?? "steward",
  };
}

function ceilingFrom(draft: Draft): AgentGovernancePolicy | null {
  const dollars = draft.budget.trim() === "" ? null : Number(draft.budget);
  if (dollars !== null && (!Number.isFinite(dollars) || dollars < 0)) return null;
  return {
    permissions: parseList(draft.permissions),
    monthlyBudgetCents: dollars === null ? AGENT_POLICY_UNLIMITED_BUDGET_CENTS : Math.round(dollars * 100),
    destructiveActions: draft.destructiveActions,
    dataScopes: parseList(draft.dataScopes),
    providers: parseList(draft.providers),
    minimumApproval: draft.minimumApproval,
  };
}

function summary(ceiling: AgentGovernancePolicy) {
  const budget = ceiling.monthlyBudgetCents >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS ? "no budget limit" : `up to $${(ceiling.monthlyBudgetCents / 100).toLocaleString("en-US")} a month`;
  const list = (values: string[]) => (values.includes("*") ? "any" : values.length === 0 ? "none" : values.join(", "));
  return `${budget}; providers: ${list(ceiling.providers)}; permissions: ${list(ceiling.permissions)}; data: ${list(ceiling.dataScopes)}; actions that cannot be undone: ${DESTRUCTIVE_WORDS[ceiling.destructiveActions]?.toLowerCase()}; ${APPROVAL_WORDS[ceiling.minimumApproval]?.toLowerCase()}`;
}

function TemplateForm({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
  const input = "w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none max-sm:min-h-11";
  const field = (label: string, key: keyof Draft, hint?: string) => (
    <label className="block space-y-1 text-xs">
      <span className="font-medium">{label}</span>
      <input className={input} aria-label={label} value={draft[key] as string} onChange={(event) => onChange({ ...draft, [key]: event.target.value })} />
      {hint ? <span className="text-muted-foreground">{hint}</span> : null}
    </label>
  );
  return (
    <div className="space-y-2">
      {field("Name", "name")}
      {field("Monthly budget in dollars", "budget", "Leave empty for no limit.")}
      {field("Providers", "providers", "Comma-separated, or * for any.")}
      {field("Permissions", "permissions", "Comma-separated, or * for any.")}
      {field("Data", "dataScopes", "Comma-separated, or * for any.")}
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Actions that cannot be undone</span>
        <select className={input} aria-label="Actions that cannot be undone" value={draft.destructiveActions} onChange={(event) => onChange({ ...draft, destructiveActions: event.target.value as Draft["destructiveActions"] })}>
          {AGENT_DESTRUCTIVE_ACTION_MODES.map((mode) => <option key={mode} value={mode}>{DESTRUCTIVE_WORDS[mode]}</option>)}
        </select>
      </label>
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Approval</span>
        <select className={input} aria-label="Approval" value={draft.minimumApproval} onChange={(event) => onChange({ ...draft, minimumApproval: event.target.value as Draft["minimumApproval"] })}>
          {AGENT_MINIMUM_APPROVAL_MODES.map((mode) => <option key={mode} value={mode}>{APPROVAL_WORDS[mode]}</option>)}
        </select>
      </label>
    </div>
  );
}

export function CeilingTemplatesCard({ companyId, canManage }: { companyId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const templates = useQuery({
    queryKey: queryKeys.ceilingTemplates(companyId),
    queryFn: () => ceilingTemplatesApi.list(companyId),
    retry: false,
  });
  const [editing, setEditing] = useState<{ template?: CeilingTemplate; draft: Draft } | null>(null);
  const [applying, setApplying] = useState<CeilingTemplate | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!applying,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.ceilingTemplates(companyId) });
  const save = useMutation({
    mutationFn: async () => {
      if (!editing) return;
      const ceiling = ceilingFrom(editing.draft);
      if (!ceiling) throw new Error("Enter the budget as a number of dollars, or leave it empty.");
      if (editing.template) return ceilingTemplatesApi.update(companyId, editing.template.id, { name: editing.draft.name.trim(), ceiling, revision: editing.template.revision });
      return ceilingTemplatesApi.create(companyId, { name: editing.draft.name.trim(), ceiling });
    },
    onSuccess: () => { setEditing(null); void invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (template: CeilingTemplate) => ceilingTemplatesApi.remove(companyId, template.id),
    onSuccess: () => void invalidate(),
  });

  const unavailable = templates.error instanceof ApiError && templates.error.status === 404;
  const rows = templates.data?.templates ?? [];

  return (
    <div className="rounded-md border border-border" data-testid="company-settings-ceiling-templates">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div>
          <div className="text-sm font-medium">Ceiling templates</div>
          <p className="text-xs text-muted-foreground">Define the most an agent may do once, then apply it to many agents.</p>
        </div>
        {canManage && !unavailable ? (
          <Button size="sm" variant="outline" className="max-sm:min-h-11" onClick={() => setEditing({ draft: draftFrom() })} data-testid="ceiling-templates-new">New template</Button>
        ) : null}
      </div>
      {unavailable ? <p className="px-3 pb-3 text-xs text-muted-foreground" data-testid="ceiling-templates-unavailable">Agent ceilings are available on request.</p> : null}
      {templates.isLoading ? <p className="px-3 pb-3 text-xs text-muted-foreground">Loading templates...</p> : null}
      {!unavailable && !templates.isLoading && rows.length === 0 ? <p className="px-3 pb-3 text-xs text-muted-foreground">No templates yet.</p> : null}
      {rows.length > 0 ? (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((template) => (
            <li key={template.id} className="space-y-1 px-3 py-2" data-testid="ceiling-template-row">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{template.name}</span>
                {canManage ? (
                  <span className="ml-auto flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" className="max-sm:min-h-11" onClick={() => { setApplying(template); setPicked([]); }}>Apply to agents…</Button>
                    <Button size="sm" variant="ghost" className="max-sm:min-h-11" onClick={() => setEditing({ template, draft: draftFrom(template) })}>Edit</Button>
                    <Button size="sm" variant="ghost" className="text-destructive max-sm:min-h-11" onClick={() => remove.mutate(template)} aria-label={`Delete ${template.name}`}>Delete</Button>
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{summary(template.ceiling)}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {remove.isError ? <p className="px-3 pb-2 text-xs text-destructive" role="alert">{remove.error instanceof Error ? remove.error.message : "The template was not deleted."}</p> : null}

      <Dialog open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.template ? "Edit template" : "New template"}</DialogTitle>
            <DialogDescription>Applying it never raises an agent above what its steward asked for; it only sets the most it may do.</DialogDescription>
          </DialogHeader>
          {editing ? <TemplateForm draft={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} /> : null}
          {save.isError ? <p className="text-xs text-destructive" role="alert">{save.error instanceof Error ? save.error.message : "The template was not saved."}</p> : null}
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" disabled={!editing?.draft.name.trim() || save.isPending} onClick={() => save.mutate()} data-testid="ceiling-template-save">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!applying && !previewing} onOpenChange={(open) => { if (!open) setApplying(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Apply “{applying?.name}”</DialogTitle>
            <DialogDescription>Pick the agents. The next step shows what each one gains and loses before anything changes.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-md border border-border" data-testid="ceiling-apply-picker">
            {(agents.data ?? []).filter((agent) => agent.status !== "terminated").map((agent) => (
              <li key={agent.id}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm max-sm:min-h-11">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={picked.includes(agent.id)}
                    onChange={(event) => setPicked((current) => (event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id)))}
                  />
                  {agent.name}
                </label>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setApplying(null)}>Cancel</Button>
            <Button size="sm" disabled={picked.length === 0} onClick={() => setPreviewing(true)} data-testid="ceiling-apply-preview">Preview {picked.length || ""}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {applying && previewing ? (
        <BatchPreviewDialog
          open
          onOpenChange={(open) => { if (!open) { setPreviewing(false); setApplying(null); } }}
          companyId={companyId}
          title={`Apply “${applying.name}”`}
          kind="agent.apply_ceiling"
          ids={picked}
          change={{ templateId: applying.id }}
          noun={{ one: "agent", many: "agents" }}
          describeItem={describePolicyChange}
          onFinished={() => void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(companyId) })}
        />
      ) : null}
    </div>
  );
}
