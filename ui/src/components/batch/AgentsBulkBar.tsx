import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { BatchPreviewDialog, type BatchFieldText } from "./BatchPreviewDialog";

/**
 * AgentDash admin powers: the Agents page's action bar (people who can manage
 * agents only; the page decides). Pause, resume, change the model, hand over
 * to another steward; each opens the shared preview dialog.
 */

export interface BulkAgent {
  id: string;
  name: string;
  adapterType: string;
}

export interface BulkPerson {
  id: string;
  name: string;
}

type Pending =
  | { kind: "agent.pause" | "agent.resume"; change: Record<string, never> }
  | { kind: "agent.set_model"; change: { model: string } }
  | { kind: "agent.transfer_steward"; change: { userId: string; transferReason: string } };

const NOUN = { one: "agent", many: "agents" };

export function AgentsBulkBar({
  companyId,
  selected,
  people,
  onClear,
  onFinished,
}: {
  companyId: string;
  selected: BulkAgent[];
  people: BulkPerson[];
  onClear: () => void;
  onFinished: () => void;
}) {
  const [panel, setPanel] = useState<"model" | "steward" | null>(null);
  const [model, setModel] = useState("");
  const [stewardId, setStewardId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);

  // The same per-runtime model lists the agent configuration form offers.
  const adapterTypes = useMemo(() => [...new Set(selected.map((agent) => agent.adapterType))].sort(), [selected]);
  const modelQueries = useQueries({
    queries: adapterTypes.map((type) => ({
      queryKey: queryKeys.agents.adapterModels(companyId, type),
      queryFn: () => agentsApi.adapterModels(companyId, type),
      enabled: panel === "model",
    })),
  });
  const models = useMemo(() => {
    const byId = new Map<string, string>();
    for (const query of modelQueries) for (const option of query.data ?? []) byId.set(option.id, option.label || option.id);
    return [...byId.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [modelQueries]);

  const personName = (id: unknown) => (typeof id === "string" ? people.find((person) => person.id === id)?.name ?? "Someone you cannot see" : "No one");
  function formatField(field: string, value: unknown): BatchFieldText | null {
    if (field === "state") return { label: "State", value: value === "paused" ? "Paused" : "Active" };
    if (field === "model") return { label: "Model", value: typeof value === "string" ? value : "Runtime default" };
    if (field === "stewardUserId") return { label: "Steward", value: personName(value) };
    return null;
  }

  const count = selected.length;
  const inputClass = "min-w-0 rounded-md border border-border bg-transparent px-2 py-1.5 text-sm outline-none max-sm:min-h-11";

  return (
    <>
      <div
        className="sticky bottom-0 z-20 space-y-2 border-t border-border bg-background/95 px-3 py-2 shadow-sm backdrop-blur"
        role="toolbar"
        aria-label="Change selected agents"
        data-testid="agents-bulk-bar"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm font-medium" data-testid="agents-bulk-count">{count} selected</span>
          <Button size="sm" variant="outline" className="max-sm:min-h-11" data-testid="agents-bulk-pause" onClick={() => setPending({ kind: "agent.pause", change: {} })}>Pause</Button>
          <Button size="sm" variant="outline" className="max-sm:min-h-11" data-testid="agents-bulk-resume" onClick={() => setPending({ kind: "agent.resume", change: {} })}>Resume</Button>
          <Button size="sm" variant={panel === "model" ? "default" : "outline"} className="max-sm:min-h-11" data-testid="agents-bulk-model" onClick={() => setPanel(panel === "model" ? null : "model")}>Change model</Button>
          <Button size="sm" variant={panel === "steward" ? "default" : "outline"} className="max-sm:min-h-11" data-testid="agents-bulk-steward" onClick={() => setPanel(panel === "steward" ? null : "steward")}>Transfer steward</Button>
          <Button size="sm" variant="ghost" className="ml-auto max-sm:min-h-11" onClick={onClear}>Clear</Button>
        </div>
        {panel === "model" ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="agents-bulk-model-panel">
            <select className={inputClass} aria-label="New model" value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">Choose a model</option>
              {models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <Button size="sm" className="max-sm:min-h-11" disabled={!model} onClick={() => setPending({ kind: "agent.set_model", change: { model } })}>Preview</Button>
            <span className="text-xs text-muted-foreground">Agents whose runtime does not offer it are left out.</span>
          </div>
        ) : null}
        {panel === "steward" ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="agents-bulk-steward-panel">
            <select className={inputClass} aria-label="New steward" value={stewardId} onChange={(event) => setStewardId(event.target.value)}>
              <option value="">Choose a person</option>
              {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
            <input
              className={`${inputClass} flex-1`}
              aria-label="Why the steward changes"
              placeholder="Why (kept in the agent's history)"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <Button
              size="sm"
              className="max-sm:min-h-11"
              disabled={!stewardId || !reason.trim()}
              onClick={() => setPending({ kind: "agent.transfer_steward", change: { userId: stewardId, transferReason: reason.trim() } })}
            >
              Preview
            </Button>
          </div>
        ) : null}
      </div>
      {pending ? (
        <BatchPreviewDialog
          open
          onOpenChange={(open) => { if (!open) setPending(null); }}
          companyId={companyId}
          title={{
            "agent.pause": "Pause agents",
            "agent.resume": "Resume agents",
            "agent.set_model": "Change the model",
            "agent.transfer_steward": "Hand over to another steward",
          }[pending.kind]}
          kind={pending.kind}
          ids={selected.map((agent) => agent.id)}
          change={pending.change}
          noun={NOUN}
          formatField={formatField}
          summary={pending.kind === "agent.resume"
            ? (n) => `${n === 1 ? "1 agent" : `${n} agents`} will resume and may start work.`
            : pending.kind === "agent.pause"
              ? (n) => `${n === 1 ? "1 agent" : `${n} agents`} will be paused.`
              : undefined}
          onFinished={() => {
            setPanel(null);
            onFinished();
          }}
        />
      ) : null}
    </>
  );
}
