import { useState } from "react";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { issueStatusLabel } from "../../lib/issue-status-label";
import { BatchPreviewDialog, type BatchFieldText } from "./BatchPreviewDialog";

/**
 * AgentDash admin powers: the sticky action bar of the Issues list. Every
 * action opens the shared preview dialog; nothing changes until the person
 * applies, and each task then goes through its own update route.
 */

export interface BulkOption {
  id: string;
  name: string;
}

export interface IssuesBulkBarProps {
  companyId: string;
  selectedIds: string[];
  agents: BulkOption[];
  people: BulkOption[];
  projects: BulkOption[];
  labels: BulkOption[];
  currentUserId: string | null;
  onClear: () => void;
  onFinished: () => void;
}

function priorityLabel(priority: string) {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

const NOUN = { one: "task", many: "tasks" };

export function IssuesBulkBar({ companyId, selectedIds, agents, people, projects, labels, currentUserId, onClear, onFinished }: IssuesBulkBarProps) {
  const [change, setChange] = useState<Record<string, unknown> | null>(null);
  const nameOf = (list: BulkOption[], id: unknown) => (typeof id === "string" ? list.find((item) => item.id === id)?.name ?? "Someone you cannot see" : "None");

  function formatField(field: string, value: unknown): BatchFieldText | null {
    switch (field) {
      case "status": return { label: "Status", value: issueStatusLabel(typeof value === "string" ? value : null) };
      case "priority": return { label: "Priority", value: typeof value === "string" ? priorityLabel(value) : "None" };
      case "assigneeAgentId": return { label: "Agent", value: nameOf(agents, value) };
      case "assigneeUserId": return { label: "Person", value: value === currentUserId && value ? "You" : nameOf(people, value) };
      case "projectId": return { label: "Project", value: nameOf(projects, value) };
      case "labelIds": {
        const ids = Array.isArray(value) ? value : [];
        return { label: "Labels", value: ids.length === 0 ? "None" : ids.map((id) => nameOf(labels, id)).join(", ") };
      }
      default: return null;
    }
  }

  const count = selectedIds.length;
  const menuButton = (label: string, testId: string) => (
    <DropdownMenuTrigger asChild>
      <Button size="sm" variant="outline" className="max-sm:min-h-11" data-testid={testId}>{label}</Button>
    </DropdownMenuTrigger>
  );

  return (
    <>
      <div
        className="sticky bottom-0 z-20 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 px-3 py-2 shadow-sm backdrop-blur"
        role="toolbar"
        aria-label="Change selected tasks"
        data-testid="issues-bulk-bar"
      >
        <span className="mr-1 text-sm font-medium" data-testid="issues-bulk-count">{count} selected</span>
        <DropdownMenu>
          {menuButton("Status", "issues-bulk-status")}
          <DropdownMenuContent align="start">
            {ISSUE_STATUSES.map((status) => (
              <DropdownMenuItem key={status} onSelect={() => setChange({ status })}>{issueStatusLabel(status)}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          {menuButton("Assignee", "issues-bulk-assignee")}
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuItem onSelect={() => setChange({ assignee: null })}>No one</DropdownMenuItem>
            {currentUserId ? <DropdownMenuItem onSelect={() => setChange({ assignee: { userId: currentUserId } })}>Me</DropdownMenuItem> : null}
            {agents.length > 0 ? <><DropdownMenuSeparator /><DropdownMenuLabel>Agents</DropdownMenuLabel></> : null}
            {agents.map((agent) => (
              <DropdownMenuItem key={agent.id} onSelect={() => setChange({ assignee: { agentId: agent.id } })}>{agent.name}</DropdownMenuItem>
            ))}
            {people.filter((person) => person.id !== currentUserId).length > 0 ? <><DropdownMenuSeparator /><DropdownMenuLabel>People</DropdownMenuLabel></> : null}
            {people.filter((person) => person.id !== currentUserId).map((person) => (
              <DropdownMenuItem key={person.id} onSelect={() => setChange({ assignee: { userId: person.id } })}>{person.name}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          {menuButton("Labels", "issues-bulk-labels")}
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            {labels.length === 0 ? <DropdownMenuItem disabled>No labels yet</DropdownMenuItem> : null}
            {labels.length > 0 ? <DropdownMenuLabel>Add</DropdownMenuLabel> : null}
            {labels.map((label) => (
              <DropdownMenuItem key={`add-${label.id}`} onSelect={() => setChange({ addLabelIds: [label.id] })}>Add {label.name}</DropdownMenuItem>
            ))}
            {labels.length > 0 ? <><DropdownMenuSeparator /><DropdownMenuLabel>Remove</DropdownMenuLabel></> : null}
            {labels.map((label) => (
              <DropdownMenuItem key={`remove-${label.id}`} onSelect={() => setChange({ removeLabelIds: [label.id] })}>Remove {label.name}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          {menuButton("Project", "issues-bulk-project")}
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuItem onSelect={() => setChange({ projectId: null })}>No project</DropdownMenuItem>
            {projects.map((project) => (
              <DropdownMenuItem key={project.id} onSelect={() => setChange({ projectId: project.id })}>{project.name}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          {menuButton("Priority", "issues-bulk-priority")}
          <DropdownMenuContent align="start">
            {ISSUE_PRIORITIES.map((priority) => (
              <DropdownMenuItem key={priority} onSelect={() => setChange({ priority })}>{priorityLabel(priority)}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" variant="ghost" className="ml-auto max-sm:min-h-11" onClick={onClear} data-testid="issues-bulk-clear">Clear</Button>
      </div>
      {change ? (
        <BatchPreviewDialog
          open
          onOpenChange={(open) => { if (!open) setChange(null); }}
          companyId={companyId}
          title={`Change ${count === 1 ? "1 task" : `${count} tasks`}`}
          kind="issue.update"
          ids={selectedIds}
          change={change}
          noun={NOUN}
          formatField={formatField}
          onFinished={onFinished}
        />
      ) : null}
    </>
  );
}
