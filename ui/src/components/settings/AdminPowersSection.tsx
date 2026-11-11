import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ASSISTANT_BATCH_MAX_RECORDS_DEFAULT,
  ASSISTANT_BATCH_MAX_RECORDS_MAX,
  ASSISTANT_BATCH_MAX_RECORDS_MIN,
  type Company,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { companiesApi } from "../../api/companies";
import { ceilingTemplatesApi } from "../../api/ceilingTemplates";
import { ApiError } from "../../api/client";
import { queryKeys } from "../../lib/queryKeys";
import { useSettingsDraft } from "../../hooks/useSettingsDraft";
import { Field, ToggleField } from "../agent-config-primitives";
import { SettingsSaveBar } from "./SettingsSaveBar";

type AdminPowersForm = {
  adminDirectiveReadEnabled: boolean;
  adminTranscriptReadEnabled: boolean;
  assistantAdminBatchesEnabled: boolean;
  /** The field's text; parsed on save. */
  assistantBatchMaxRecords: string;
  /** "" means no ceiling. */
  defaultCeilingTemplateId: string;
};

type AdminPowersPatch = Partial<Pick<Company,
  "adminDirectiveReadEnabled" | "adminTranscriptReadEnabled" | "assistantAdminBatchesEnabled" | "assistantBatchMaxRecords" | "defaultCeilingTemplateId"
>>;

function toPatch(changes: Partial<AdminPowersForm>): AdminPowersPatch {
  const patch: AdminPowersPatch = {};
  if (changes.adminDirectiveReadEnabled !== undefined) patch.adminDirectiveReadEnabled = changes.adminDirectiveReadEnabled;
  if (changes.adminTranscriptReadEnabled !== undefined) patch.adminTranscriptReadEnabled = changes.adminTranscriptReadEnabled;
  if (changes.assistantAdminBatchesEnabled !== undefined) patch.assistantAdminBatchesEnabled = changes.assistantAdminBatchesEnabled;
  if (changes.assistantBatchMaxRecords !== undefined) {
    patch.assistantBatchMaxRecords = Number.parseInt(changes.assistantBatchMaxRecords, 10);
  }
  if (changes.defaultCeilingTemplateId !== undefined) {
    patch.defaultCeilingTemplateId = changes.defaultCeilingTemplateId || null;
  }
  return patch;
}

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
 *
 * Every control here is a draft until "Save changes", which sends only the
 * changed fields in one request.
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
  const draft = useSettingsDraft<AdminPowersForm>({
    resetKey: company.id,
    saved: {
      adminDirectiveReadEnabled: !!company.adminDirectiveReadEnabled,
      adminTranscriptReadEnabled: !!company.adminTranscriptReadEnabled,
      assistantAdminBatchesEnabled: !!company.assistantAdminBatchesEnabled,
      assistantBatchMaxRecords: String(company.assistantBatchMaxRecords ?? ASSISTANT_BATCH_MAX_RECORDS_DEFAULT),
      defaultCeilingTemplateId: company.defaultCeilingTemplateId ?? "",
    },
    save: (changes) => companiesApi.update(company.id, toPatch(changes)),
    onSaved: () => queryClient.invalidateQueries({ queryKey: queryKeys.companies.all }),
  });
  const form = draft.values;
  const locked = !canManage || draft.isSaving;

  const templates = useQuery({
    queryKey: queryKeys.ceilingTemplates(company.id),
    queryFn: () => ceilingTemplatesApi.list(company.id),
    retry: false,
  });
  const ceilingsUnavailable = templates.error instanceof ApiError && templates.error.status === 404;

  const parsedMax = Number.parseInt(form.assistantBatchMaxRecords, 10);
  const maxValid =
    String(parsedMax) === form.assistantBatchMaxRecords.trim()
    && parsedMax >= ASSISTANT_BATCH_MAX_RECORDS_MIN
    && parsedMax <= ASSISTANT_BATCH_MAX_RECORDS_MAX;

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
          checked={form.adminDirectiveReadEnabled}
          onChange={(value) => draft.set("adminDirectiveReadEnabled", value)}
          toggleTestId="admin-powers-directive-read-toggle"
          disabled={locked}
        />
        <ToggleField
          label="Admins can read run transcripts when document access is on"
          hint="Owners and admins can open the transcript of any agent's run, even when document access limits who reads them. Reads are recorded once per person and run every 10 minutes. Off by default."
          checked={form.adminTranscriptReadEnabled}
          onChange={(value) => draft.set("adminTranscriptReadEnabled", value)}
          toggleTestId="admin-powers-transcript-read-toggle"
          disabled={locked}
        />
        <ToggleField
          label="Allow batch changes from an admin's own Claude"
          hint="An owner or admin can ask their own Claude to prepare a change to many records. Nothing changes until they confirm it in AgentDash, and each record is checked as if they changed it by hand. Off by default."
          checked={form.assistantAdminBatchesEnabled}
          onChange={(value) => draft.set("assistantAdminBatchesEnabled", value)}
          toggleTestId="admin-powers-assistant-batches-toggle"
          disabled={locked}
        />
        <Field
          label="Most records per batch from Claude"
          hint={`From ${ASSISTANT_BATCH_MAX_RECORDS_MIN} to ${ASSISTANT_BATCH_MAX_RECORDS_MAX}. Applies only when batch changes from Claude are allowed.`}
        >
          <div className="flex flex-col gap-1.5">
            <input
              type="number"
              aria-label="Most records per batch from Claude"
              data-testid="admin-powers-assistant-batch-max"
              min={ASSISTANT_BATCH_MAX_RECORDS_MIN}
              max={ASSISTANT_BATCH_MAX_RECORDS_MAX}
              step={1}
              value={form.assistantBatchMaxRecords}
              disabled={locked || !form.assistantAdminBatchesEnabled}
              onChange={(event) => draft.set("assistantBatchMaxRecords", event.target.value)}
              className="w-28 max-sm:min-w-0 max-sm:flex-1 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none disabled:opacity-60"
            />
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
              value={form.defaultCeilingTemplateId}
              disabled={locked || templates.isLoading}
              onChange={(event) => draft.set("defaultCeilingTemplateId", event.target.value)}
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
          <SettingsSaveBar draft={draft} canSave={maxValid} testId="admin-powers" />
        )}
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
      </div>
    </div>
  );
}
