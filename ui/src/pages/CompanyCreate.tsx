import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "@/lib/router";
import { companiesApi } from "../api/companies";
import { ApiError } from "../api/client";
import { refreshAccessQueries } from "../lib/access-refresh";
import { Button } from "@/components/ui/button";
import { useCompany } from "../context/CompanyContext";
import { Building2 } from "lucide-react";
import { AgentDashMark } from "@/components/brand/AgentDashMark";

// AgentDash (Phase E): standalone /company-create page for the post-signup
// redirect chain. Lifted out of OnboardingWizard.tsx step 1 so the wizard's
// later steps (agent + task + launch) stay available for returning users.
//
// AgentDash (GH #785, UX-4; GH #786, UX-5): fresh signups go straight from this
// page to the first run (/setup: model key, GitHub, first issue). The readiness
// assessment is optional: it stays at /assess, linked from Settings. Same chain
// for every company (one UX); whether the first run applies is the server's
// call, and /setup sends a company it does not apply to on to /cos.
//
// On submit we POST /api/companies. If the user already has a membership the
// server returns 409 (companies.ts guard); we treat that as "go straight to
// CoS" so an invitee who navigates back from /cos doesn't double-create.
/** Where a new workspace goes next. The assessment is no longer an onboarding step. */
export function postCreateDestination(company: { id?: string }): string {
  return company.id ? `/setup?companyId=${encodeURIComponent(company.id)}` : "/setup";
}

export function CompanyCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setSelectedCompanyId } = useCompany();
  const [searchParams] = useSearchParams();
  // AgentDash (one onboarding path): "New Company" (NEW_COMPANY_PATH) comes
  // here with ?another=1. That person already has a workspace on purpose, so
  // the post-signup duplicate guard below must not send them to /cos.
  const another = searchParams.get("another") === "1";
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      // fromSignup=1 opts into the server-side 409 guard so an invitee who
      // already has a workspace gets redirected to /cos instead of
      // accidentally creating a duplicate workspace.
      return companiesApi.create(
        { name: companyName.trim() },
        another ? undefined : { fromSignup: true },
      );
    },
    onSuccess: async (company) => {
      setSelectedCompanyId(company.id);
      // AgentDash: the server just made this user a member (and, on a fresh
      // box, the instance admin). Refetch what CloudAccessGate decides on so
      // it does not show "No company access" from the pre-company cache.
      await refreshAccessQueries(queryClient);
      navigate(postCreateDestination(company), { replace: true });
    },
    onError: async (err) => {
      // 409 means the user already has a workspace (invite path or duplicate
      // submission). Route them to /cos rather than dead-ending on an error.
      if (!another && err instanceof ApiError && err.status === 409) {
        await refreshAccessQueries(queryClient);
        navigate("/cos", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to create workspace");
    },
  });

  const canSubmit = companyName.trim().length > 0 && !mutation.isPending;

  return (
    <div className="fixed inset-0 flex bg-surface-page">
      <div className="w-full max-w-md mx-auto my-auto px-8 py-12">
        <div className="flex items-center gap-2 mb-8">
          {/* AgentDash (Scan 3, lane J): the brand mark, same as /auth. */}
          <AgentDashMark size={20} />
          <span className="text-sm font-medium text-text-primary">AgentDash</span>
        </div>

        <div className="flex items-center gap-3 mb-4">
          <div className="bg-muted/50 p-2 rounded-md">
            <Building2 className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Name your workspace</h1>
            <p className="mt-1 text-sm text-text-secondary">
              This is the organization your agents will work for.
            </p>
          </div>
        </div>

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit) {
              setError("Please enter a workspace name.");
              return;
            }
            mutation.mutate();
          }}
        >
          <div>
            <label
              htmlFor="company-name"
              className="text-xs text-text-secondary mb-1 block font-medium"
            >
              Workspace name
            </label>
            <input
              id="company-name"
              name="name"
              className="w-full rounded-md border border-border-soft bg-surface-raised px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent-500 focus:ring-2 focus:ring-accent-200 transition-[color,box-shadow]"
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder="Acme Corp"
              autoFocus
              autoComplete="organization"
            />
          </div>
          {error && <p className="text-xs text-danger-500">{error}</p>}
          <Button
            type="submit"
            disabled={mutation.isPending}
            aria-disabled={!canSubmit}
            className={`w-full ${!canSubmit ? "opacity-50" : ""}`}
          >
            {mutation.isPending ? "Creating…" : "Continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}
