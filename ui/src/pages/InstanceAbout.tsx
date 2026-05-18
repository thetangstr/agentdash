import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";

function ValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-3 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium text-foreground">{value}</span>
    </div>
  );
}

function boolLabel(value: boolean | undefined) {
  if (value === undefined) return "unknown";
  return value ? "yes" : "no";
}

export function InstanceAbout() {
  const { data: health, isLoading, error } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });

  const version = health?.version ? `v${health.version}` : isLoading ? "loading..." : "unknown";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-foreground">About AgentDash</h1>
          <Badge variant="secondary">{version}</Badge>
        </div>
      </div>

      {error ? (
        <Card>
          <CardContent className="text-sm text-destructive">
            Unable to load instance health metadata.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Instance</CardTitle>
          </CardHeader>
          <CardContent>
            <ValueRow label="App version" value={version} />
            <ValueRow label="Source repository" value="github.com/thetangstr/agentdash" />
            <ValueRow label="Health status" value={health?.status ?? (isLoading ? "loading..." : "unknown")} />
            <ValueRow label="Deployment mode" value={health?.deploymentMode ?? "unknown"} />
            <ValueRow label="Deployment exposure" value={health?.deploymentExposure ?? "unknown"} />
            <ValueRow label="Auth ready" value={boolLabel(health?.authReady)} />
            <ValueRow label="Bootstrap status" value={health?.bootstrapStatus ?? "unknown"} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Release Notes</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <a
              href="/instance/settings/changelog"
              className="inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
            >
              Open changelog
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
