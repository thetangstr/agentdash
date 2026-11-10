import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ASSISTANT_BATCH_MAX_RECORDS_DEFAULT,
  ASSISTANT_BATCH_MAX_RECORDS_MAX,
  ASSISTANT_BATCH_MAX_RECORDS_MIN,
  type Company,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { companiesApi } from "../../api/companies";
import { ceilingTemplatesApi } from "../../api/ceilingTemplates";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { Field, ToggleField } from "../agent-config-primitives";

/**
 * AgentDash admin powers: the company switches, in one place in Company
 * Settings. Every company sees the same section (one UX, no product-profile
 * branch). Owners and admins change the switches; everyone else sees them
 * disabled with one plain line. Whether this person may change them is the
 * server's `company:manage` answer, passed in by the page.
 *
 * Each power is off until an admin turns it on. "Ceiling for new agents"
 * picks one of the company's ceiling templates (or none); it applies to
 * agents created from then on. Owners and admins also get the link to the
 * admin audit (part 4), which is on for them by default.
 */
export function AdminPowersSection({
  company,
  canManage,
  showReadOnlyNotice,
}: {
  company: Company;
  canManage: boolean;
  showReadOnlyNotice: boolean;
}) {
  const queryClient = useQueryClient();
  const savedMax = company.assistantBatchMaxRecords ?? ASSISTANT_BATCH_MAX_RECORDS_DEFAULT;
  const [maxRecords, setMaxRecords] = useState(String(savedMax));
  useEffect(() => setMaxRecords(String(savedMax)), [savedMax]);

  const mutation = useMutation({
    mutationFn: (
      data: Partial<Pick<Company,
        "adminDirectiveReadEnabled" | "adminTranscriptReadEnabled" | "assistantAdminBatchesEnabled" | "assistantBatchMaxRecords" | "defaultCeilingTemplateId"
      >>,
    ) => companiesApi.update(company.id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    },
  });

  const templates = useQuery({
    queryKey: queryKeys.ceilingTemplates(company.id),
    queryFn: () => ceilingTemplatesApi.list(company.id),
    retry: false,
  });
  const ceilingsUnavailable = templates.error instanceof ApiError && templates.error.status === 404;

  const assistantBatches = !!company.assistantAdminBatchesEnabled;
  const parsedMax = Number.parseInt(maxRecords, 10);
  const maxValid =
    String(parsedMax) === maxRecords.trim()
    && parsedMax >= ASSISTANT_BATCH_MAX_RECORDS_MIN
    && parsedMax <= ASSISTANT_BATCH_MAX_RECORDS_MAX;
  const maxDirty = maxValid && parsedMax !== savedMax;

  return (
    <div className="space-y-4" data-testid="company-settings-admin-powers-section">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Admin powers
      </div>
      <div className="space-y-4 rounded-md border border-border px-4 py-3">
        {showReadOnlyNotice && (
          <p className="text-xs text-muted-foreground" data-testid="admin-powers-read-only">
            Only owners and admins can change these.
          </p>
        )}
        <ToggleField
          label="Admins can read agent directives"
          hint="Owners and admins can read the directives of any agent in this company, not only the agents they look after. Each read is recorded. Off by default."
          checked={!!company.adminDirectiveReadEnabled}
          onChange={(value) => mutation.mutate({ adminDirectiveReadEnabled: value })}
          toggleTestId="admin-powers-directive-read-toggle"
          disabled={!canManage || mutation.isPending}
        />
        <ToggleField
          label="Admins can read run transcripts when document access is on"
          hint="Owners and admins can open the transcript of any agent's run, even when document access limits who reads them. Reads are recorded once per person and run every 10 minutes. Off by default."
          checked={!!company.adminTranscriptReadEnabled}
          onChange={(value) => mutation.mutate({ adminTranscriptReadEnabled: value })}
          toggleTestId="admin-powers-transcript-read-toggle"
          disabled={!canManage || mutation.isPending}
        />
        <ToggleField
          label="Allow batch changes from an admin's own Claude"
          hint="An owner or admin can ask their own Claude to prepare a change to many records. Nothing changes until they confirm it in AgentDash, and each record is checked as if they changed it by hand. Off by default."
          checked={assistantBatches}
          onChange={(value) => mutation.mutate({ assistantAdminBatchesEnabled: value })}
          toggleTestId="admin-powers-assistant-batches-toggle"
          disabled={!canManage || mutation.isPending}
        />
        <Field
          label="Most records per batch from Claude"
          hint={`From ${ASSISTANT_BATCH_MAX_RECORDS_MIN} to ${ASSISTANT_BATCH_MAX_RECORDS_MAX}. Applies only when batch changes from Claude are allowed.`}
        >
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <input
                type="number"
                aria-label="Most records per batch from Claude"
                data-testid="admin-powers-assistant-batch-max"
                min={ASSISTANT_BATCH_MAX_RECORDS_MIN}
                max={ASSISTANT_BATCH_MAX_RECORDS_MAX}
                step={1}
                value={maxRecords}
                disabled={!canManage || !assistantBatches}
                onChange={(event) => setMaxRecords(event.target.value)}
                className="w-28 max-sm:min-w-0 max-sm:flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none disabled:opacity-60"
              />
              {canManage && assistantBatches && maxDirty && (
                <Button
                  size="sm"
                  onClick={() => mutation.mutate({ assistantBatchMaxRecords: parsedMax })}
                  disabled={mutation.isPending}
                  data-testid="admin-powers-assistant-batch-max-save"
                >
                  {mutation.isPending ? "Saving..." : "Save"}
                </Button>
              )}
            </div>
            {!maxValid && (
              <span className="text-xs text-destructive">
                Enter a whole number from {ASSISTANT_BATCH_MAX_RECORDS_MIN} to {ASSISTANT_BATCH_MAX_RECORDS_MAX}.
              </span>
            )}
          </div>
        </Field>
        <Field
          label="Ceiling for new agents"
          hint="Every agent created from now on starts with this ceiling. Agents that already exist keep theirs."
        >
          {ceilingsUnavailable ? (
            <span className="text-xs text-muted-foreground" data-testid="admin-powers-default-ceiling-unavailable">Agent ceilings are available on request.</span>
          ) : (
            <select
              aria-label="Ceiling for new agents"
              data-testid="admin-powers-default-ceiling"
              className="w-56 max-sm:min-h-11 max-sm:w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none disabled:opacity-60"
              value={company.defaultCeilingTemplateId ?? ""}
              disabled={!canManage || templates.isLoading || mutation.isPending}
              onChange={(event) => mutation.mutate({ defaultCeilingTemplateId: event.target.value || null })}
            >
              <option value="">None</option>
              {(templates.data?.templates ?? []).map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          )}
          {!ceilingsUnavailable ? (
            <p className="mt-1 text-xs text-muted-foreground">Applies to agents created from now on; existing agents keep their ceilings.</p>
          ) : null}
        </Field>
        {canManage && (
          <Field
            label="Admin audit"
            hint="Who did what in this company, filtered by person, action and dates, with a CSV export. On for owners and admins."
          >
            <Link
              to="/company/settings/audit"
              data-testid="admin-powers-audit-link"
              className="text-sm underline underline-offset-2 max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
            >
              Open the admin audit
            </Link>
          </Field>
        )}
        {mutation.isError && (
          <p className="text-xs text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "The change was not saved."}
          </p>
        )}
      </div>
    </div>
  );
}
