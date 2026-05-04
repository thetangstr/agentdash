import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { companiesApi } from "../api/companies";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { useCompany } from "../context/CompanyContext";
import { Sparkles, Building2 } from "lucide-react";

// AgentDash (Phase E): standalone /company-create page for the post-signup
// redirect chain. Lifted out of OnboardingWizard.tsx step 1 so the wizard's
// later steps (agent + task + launch) stay available for returning users
// while fresh signups go through this page → /assess → /cos.
//
// On submit we POST /api/companies. If the user already has a membership the
// server returns 409 (companies.ts guard); we treat that as "go straight to
// CoS" so an invitee who navigates back from /cos doesn't double-create.
export function CompanyCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setSelectedCompanyId } = useCompany();
  const [companyName, setCompanyName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      // fromSignup=1 opts into the server-side 409 guard so an invitee who
      // already has a workspace gets redirected to /cos instead of
      // accidentally creating a duplicate workspace.
      return companiesApi.create(
        { name: companyName.trim() },
        { fromSignup: true },
      );
    },
    onSuccess: async (company) => {
      setSelectedCompanyId(company.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      navigate("/assess?onboarding=1", { replace: true });
    },
    onError: (err) => {
      // 409 means the user already has a workspace (invite path or duplicate
      // submission). Route them to /cos rather than dead-ending on an error.
      if (err instanceof ApiError && err.status === 409) {
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
          <Sparkles className="h-4 w-4 text-text-tertiary" />
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
