// AgentDash (GH #786): how to connect an assistant (Meta Muse) to this box.
// A small in-app panel until Settings › Connections (#793) exists. Muse takes
// a host plus a pre-issued client id; the person then signs in and approves on
// this box's consent screen (/oauth/consent).
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

export const MUSE_CLIENT_ID = "muse";

export function assistantMcpUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/api/mcp/assistant`;
}

function CopyField({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded border bg-muted/40 px-3 py-2 text-sm" data-testid={testId}>
          {value}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export function ConnectAssistant() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([{ label: "Home", href: "/dashboard" }, { label: "Connect your assistant" }]);
  }, [setBreadcrumbs]);
  const { data: health, isLoading } = useQuery({ queryKey: queryKeys.health, queryFn: () => healthApi.get(), retry: false });
  const base = health?.publicBaseUrl || window.location.origin;

  return (
    <div className="mx-auto w-full max-w-xl space-y-5 px-1 py-6 sm:px-4" data-testid="connect-assistant">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Connect your assistant</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          With Muse connected you can ask for work, check what is running and hear what shipped from your phone. Your
          assistant only sees this workspace, and you approve the connection here.
        </p>
      </div>
      {isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading…
        </p>
      ) : (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <CopyField label="Server URL" value={assistantMcpUrl(base)} testId="assistant-mcp-url" />
          <CopyField label="Client ID" value={MUSE_CLIENT_ID} testId="assistant-client-id" />
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>In Muse, add a custom connector.</li>
            <li>Paste the server URL and the client ID above.</li>
            <li>Muse opens this workspace: sign in if asked, then approve the connection.</li>
          </ol>
        </div>
      )}
      <Link to="/dashboard" className="text-sm underline">
        Back to Home
      </Link>
    </div>
  );
}
