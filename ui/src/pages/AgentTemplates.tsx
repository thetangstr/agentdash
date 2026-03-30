import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const ROLES = ["engineer", "researcher", "qa", "general", "cto"] as const;
const ADAPTERS = ["claude_local", "opencode_local", "cursor_local"] as const;

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function AgentTemplates() {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id;
  const queryClient = useQueryClient();

  const [spawnTemplate, setSpawnTemplate] = useState<any>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ["agent-templates", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/agent-templates`);
      return res.json();
    },
    enabled: !!companyId,
  });

  if (!companyId) return <div className="p-6 text-muted-foreground">Select a company</div>;
  if (isLoading) return <div className="p-6 text-muted-foreground">Loading templates...</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agent Templates</h1>
          <p className="text-sm text-muted-foreground mt-1">Role-based blueprints for spawning agents</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>Create Template</Button>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <p className="text-muted-foreground">No templates yet. Create your first agent template to start spawning agents.</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t: any) => (
            <div key={t.id} className="rounded-xl border bg-card p-5 space-y-3 hover:border-foreground/20 transition-colors">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">{t.name}</h3>
                <span className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium">{t.role}</span>
              </div>
              {t.description && <p className="text-sm text-muted-foreground line-clamp-2">{t.description}</p>}
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-2 py-0.5">{t.authorityLevel}</span>
                <span className="rounded-md bg-muted px-2 py-0.5">{t.taskClassification}</span>
                <span className="rounded-md bg-muted px-2 py-0.5">{t.adapterType}</span>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
                <span>${(t.budgetMonthlyCents / 100).toFixed(0)}/mo</span>
                <span>{t.skillKeys?.length ?? 0} skills</span>
                <span>{t.okrs?.length ?? 0} OKRs</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setSpawnTemplate(t)}
              >
                Spawn
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Spawn Dialog */}
      {spawnTemplate && (
        <SpawnDialog
          companyId={companyId}
          template={spawnTemplate}
          onClose={() => setSpawnTemplate(null)}
          queryClient={queryClient}
        />
      )}

      {/* Create Template Dialog */}
      {createOpen && (
        <CreateTemplateDialog
          companyId={companyId}
          onClose={() => setCreateOpen(false)}
          queryClient={queryClient}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spawn from Template Dialog
// ---------------------------------------------------------------------------

function SpawnDialog({
  companyId,
  template,
  onClose,
  queryClient,
}: {
  companyId: string;
  template: any;
  onClose: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");
  const [projectId, setProjectId] = useState("");

  const { data: projects = [] } = useQuery({
    queryKey: ["projects", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/projects`);
      return res.json();
    },
    enabled: !!companyId,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        templateId: template.id,
        quantity,
        reason,
      };
      if (projectId) body.projectId = projectId;
      const res = await fetch(`/api/companies/${companyId}/spawn-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Spawn failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-templates", companyId] });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md p-0 gap-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">Spawn from &ldquo;{template.name}&rdquo;</span>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onClose}>
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="p-6 space-y-4">
          {mutation.isSuccess ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-sm font-medium text-emerald-800">Spawn request created</p>
                <p className="text-xs text-emerald-600 mt-1">
                  {quantity} agent{quantity > 1 ? "s" : ""} will be created once the approval is granted.
                </p>
              </div>
              <Button className="w-full" onClick={onClose}>Done</Button>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium mb-1">Quantity</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.min(10, Math.max(1, Number(e.target.value))))}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Reason</label>
                <textarea
                  rows={2}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why are these agents needed?"
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm resize-none"
                />
              </div>

              {projects.length > 0 && (
                <div>
                  <label className="block text-sm font-medium mb-1">Project (optional)</label>
                  <select
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
                  >
                    <option value="">None</option>
                    {projects.map((p: any) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {mutation.isError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-sm text-red-700">{(mutation.error as Error).message}</p>
                </div>
              )}

              <Button
                className="w-full"
                onClick={() => mutation.mutate()}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Submitting..." : `Spawn ${quantity} Agent${quantity > 1 ? "s" : ""}`}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create Template Dialog
// ---------------------------------------------------------------------------

function CreateTemplateDialog({
  companyId,
  onClose,
  queryClient,
}: {
  companyId: string;
  onClose: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [role, setRole] = useState<string>("engineer");
  const [adapterType, setAdapterType] = useState<string>("claude_local");
  const [budgetDollars, setBudgetDollars] = useState(100);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/agent-templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          slug: slug || slugify(name),
          role,
          adapterType,
          budgetMonthlyCents: Math.round(budgetDollars * 100),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to create template");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-templates", companyId] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent showCloseButton={false} className="sm:max-w-md p-0 gap-0 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">Create Agent Template</span>
          <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={onClose}>
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slug || slug === slugify(name)) setSlug(slugify(e.target.value));
              }}
              placeholder="Frontend Engineer"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Slug</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="frontend-engineer"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Adapter Type</label>
            <select
              value={adapterType}
              onChange={(e) => setAdapterType(e.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            >
              {ADAPTERS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Monthly Budget ($)</label>
            <input
              type="number"
              min={0}
              value={budgetDollars}
              onChange={(e) => setBudgetDollars(Number(e.target.value))}
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
            />
          </div>

          {mutation.isError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-700">{(mutation.error as Error).message}</p>
            </div>
          )}

          <Button
            className="w-full"
            onClick={() => mutation.mutate()}
            disabled={!name || mutation.isPending}
          >
            {mutation.isPending ? "Creating..." : "Create Template"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
