import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { kpisApi, type Kpi, type KpiCreate, type KpiUpdate } from "../api/kpis";

// AgentDash: Settings page for manual KPIs (AGE-45)

const kpiQueryKey = (companyId: string) => ["kpis", companyId] as const;

function formatNumber(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return value;
}

export function SettingsKPIs() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "KPIs" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  const companyId = selectedCompanyId ?? null;

  const kpisQuery = useQuery({
    queryKey: companyId ? kpiQueryKey(companyId) : ["kpis", "none"],
    queryFn: () => (companyId ? kpisApi.list(companyId) : Promise.resolve([] as Kpi[])),
    enabled: !!companyId,
  });

  const createMutation = useMutation({
    mutationFn: (data: KpiCreate) => {
      if (!companyId) return Promise.reject(new Error("No company selected"));
      return kpisApi.create(companyId, data);
    },
    onSuccess: () => {
      if (companyId) queryClient.invalidateQueries({ queryKey: kpiQueryKey(companyId) });
      pushToast({ title: "KPI created", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to create KPI",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: KpiUpdate }) => {
      if (!companyId) return Promise.reject(new Error("No company selected"));
      return kpisApi.update(companyId, id, data);
    },
    onSuccess: () => {
      if (companyId) queryClient.invalidateQueries({ queryKey: kpiQueryKey(companyId) });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update KPI",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => {
      if (!companyId) return Promise.reject(new Error("No company selected"));
      return kpisApi.remove(companyId, id);
    },
    onSuccess: () => {
      if (companyId) queryClient.invalidateQueries({ queryKey: kpiQueryKey(companyId) });
      pushToast({ title: "KPI deleted", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to delete KPI",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const [newName, setNewName] = useState("");
  const [newUnit, setNewUnit] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [newCurrent, setNewCurrent] = useState("");
  const [newPriority, setNewPriority] = useState("0");

  const canSubmitNew = useMemo(() => {
    const trimmed = newName.trim();
    const target = Number(newTarget);
    return trimmed.length > 0 && Number.isFinite(target);
  }, [newName, newTarget]);

  function handleCreate() {
    if (!canSubmitNew) return;
    const current = newCurrent.trim() === "" ? null : Number(newCurrent);
    createMutation.mutate(
      {
        name: newName.trim(),
        unit: newUnit.trim(),
        targetValue: Number(newTarget),
        currentValue: current,
        priority: Number.isFinite(Number(newPriority)) ? Number(newPriority) : 0,
      },
      {
        onSuccess: () => {
          setNewName("");
          setNewUnit("");
          setNewTarget("");
          setNewCurrent("");
          setNewPriority("0");
        },
      },
    );
  }

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6" data-testid="settings-kpis-page">
      <div className="flex items-center gap-2">
        <Gauge className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">KPIs</h1>
      </div>

      <p className="text-sm text-muted-foreground">
        Define the key performance indicators for your company. Agents can read and update
        KPI values via the <code className="rounded bg-muted px-1 py-0.5 text-xs">update_kpi</code>{" "}
        tool, and your dashboard top-5 rollup pulls from here.
      </p>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Add new KPI
        </div>
        <div
          className="grid grid-cols-1 gap-3 rounded-md border border-border px-4 py-4 sm:grid-cols-6"
          data-testid="kpi-new-row"
        >
          <div className="sm:col-span-2">
            <label className="block text-xs font-medium text-muted-foreground">Name</label>
            <input
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Monthly Recurring Revenue"
              data-testid="kpi-new-name"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Unit</label>
            <input
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={newUnit}
              onChange={(e) => setNewUnit(e.target.value)}
              placeholder="USD"
              data-testid="kpi-new-unit"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Target</label>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              placeholder="10000"
              data-testid="kpi-new-target"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Current</label>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={newCurrent}
              onChange={(e) => setNewCurrent(e.target.value)}
              placeholder="0"
              data-testid="kpi-new-current"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground">Priority</label>
            <input
              type="number"
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value)}
              placeholder="0"
              data-testid="kpi-new-priority"
            />
          </div>
          <div className="sm:col-span-6 flex justify-end">
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!canSubmitNew || createMutation.isPending}
              data-testid="kpi-new-submit"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {createMutation.isPending ? "Adding..." : "Add KPI"}
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Existing KPIs
        </div>
        {kpisQuery.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading KPIs...</div>
        ) : kpisQuery.isError ? (
          <div className="text-sm text-destructive">
            Failed to load KPIs:{" "}
            {kpisQuery.error instanceof Error ? kpisQuery.error.message : "Unknown error"}
          </div>
        ) : !kpisQuery.data || kpisQuery.data.length === 0 ? (
          <div
            className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground"
            data-testid="kpi-empty-state"
          >
            No KPIs yet. Add your first one above.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-sm" data-testid="kpi-table">
              <thead className="bg-muted/30 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Unit</th>
                  <th className="px-3 py-2 text-right font-medium">Target</th>
                  <th className="px-3 py-2 text-right font-medium">Current</th>
                  <th className="px-3 py-2 text-right font-medium">Priority</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {kpisQuery.data.map((kpi) => (
                  <KpiRow
                    key={kpi.id}
                    kpi={kpi}
                    onUpdate={(data) => updateMutation.mutate({ id: kpi.id, data })}
                    onDelete={() => {
                      const ok = window.confirm(
                        `Delete KPI "${kpi.name}"? This cannot be undone.`,
                      );
                      if (ok) deleteMutation.mutate(kpi.id);
                    }}
                    saving={updateMutation.isPending}
                    deleting={deleteMutation.isPending}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

interface KpiRowProps {
  kpi: Kpi;
  onUpdate: (data: KpiUpdate) => void;
  onDelete: () => void;
  saving: boolean;
  deleting: boolean;
}

function KpiRow({ kpi, onUpdate, onDelete, saving, deleting }: KpiRowProps) {
  const [name, setName] = useState(kpi.name);
  const [unit, setUnit] = useState(kpi.unit ?? "");
  const [target, setTarget] = useState(formatNumber(kpi.targetValue));
  const [current, setCurrent] = useState(formatNumber(kpi.currentValue));
  const [priority, setPriority] = useState(String(kpi.priority ?? 0));

  useEffect(() => {
    setName(kpi.name);
    setUnit(kpi.unit ?? "");
    setTarget(formatNumber(kpi.targetValue));
    setCurrent(formatNumber(kpi.currentValue));
    setPriority(String(kpi.priority ?? 0));
  }, [kpi.id, kpi.name, kpi.unit, kpi.targetValue, kpi.currentValue, kpi.priority]);

  const dirty =
    name !== kpi.name ||
    unit !== (kpi.unit ?? "") ||
    target !== formatNumber(kpi.targetValue) ||
    current !== formatNumber(kpi.currentValue) ||
    priority !== String(kpi.priority ?? 0);

  function handleSave() {
    const patch: KpiUpdate = {};
    if (name !== kpi.name) patch.name = name.trim();
    if (unit !== (kpi.unit ?? "")) patch.unit = unit.trim();
    if (target !== formatNumber(kpi.targetValue)) {
      const n = Number(target);
      if (Number.isFinite(n)) patch.targetValue = n;
    }
    if (current !== formatNumber(kpi.currentValue)) {
      if (current.trim() === "") patch.currentValue = null;
      else {
        const n = Number(current);
        if (Number.isFinite(n)) patch.currentValue = n;
      }
    }
    if (priority !== String(kpi.priority ?? 0)) {
      const n = Number(priority);
      if (Number.isFinite(n)) patch.priority = n;
    }
    if (Object.keys(patch).length > 0) onUpdate(patch);
  }

  return (
    <tr className="border-t border-border" data-testid={`kpi-row-${kpi.id}`}>
      <td className="px-3 py-2">
        <input
          className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid={`kpi-name-${kpi.id}`}
        />
      </td>
      <td className="px-3 py-2">
        <input
          className="w-24 rounded-md border border-border bg-transparent px-2 py-1 text-sm outline-none"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          data-testid={`kpi-unit-${kpi.id}`}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <input
          type="number"
          className="w-28 rounded-md border border-border bg-transparent px-2 py-1 text-sm text-right outline-none"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          data-testid={`kpi-target-${kpi.id}`}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <input
          type="number"
          className="w-28 rounded-md border border-border bg-transparent px-2 py-1 text-sm text-right outline-none"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          data-testid={`kpi-current-${kpi.id}`}
        />
      </td>
      <td className="px-3 py-2 text-right">
        <input
          type="number"
          className="w-20 rounded-md border border-border bg-transparent px-2 py-1 text-sm text-right outline-none"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          data-testid={`kpi-priority-${kpi.id}`}
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1.5">
          {dirty && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleSave}
              disabled={saving}
              data-testid={`kpi-save-${kpi.id}`}
            >
              {saving ? "Saving..." : "Save"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onDelete}
            disabled={deleting}
            data-testid={`kpi-delete-${kpi.id}`}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
