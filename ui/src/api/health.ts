export type DevServerHealthStatus = {
  enabled: true;
  restartRequired: boolean;
  reason: "backend_changes" | "pending_migrations" | "backend_changes_and_pending_migrations" | null;
  lastChangedAt: string | null;
  changedPathCount: number;
  changedPathsSample: string[];
  pendingMigrations: string[];
  autoRestartEnabled: boolean;
  activeRunCount: number;
  waitingForIdle: boolean;
  lastRestartAt: string | null;
};

export type HealthStatus = {
  status: "ok";
  version?: string;
  deploymentMode?: "local_trusted" | "authenticated";
  deploymentExposure?: "private" | "public";
  authReady?: boolean;
  bootstrapStatus?: "ready" | "bootstrap_pending";
  bootstrapInviteActive?: boolean;
  // AgentDash: self-serve-bootstrap — first-user self-serve company creation.
  selfServeBootstrap?: boolean;
  instanceHasCompany?: boolean;
  /** AgentDash (#726): a hosted agentdash.cloud box. GH #786 routes its first run to /setup, not the wizard. */
  hostedBox?: boolean;
  /** The instance's default runtime preset (server: readAdapterStatus().preset). */
  adapterPreset?: string;
  adapterReady?: boolean;
  /**
   * The address the operator configured for this instance, when they set one.
   *
   * Used to generate harness configuration against a stable host instead of
   * `window.location.origin` — see ConnectYourTerminal. Absent when unset.
   */
  publicBaseUrl?: string;
  features?: {
    companyDeletionEnabled?: boolean;
  };
  devServer?: DevServerHealthStatus;
};

export const healthApi = {
  get: async (): Promise<HealthStatus> => {
    const res = await fetch("/api/health", {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error ?? `Failed to load health (${res.status})`);
    }
    return res.json();
  },
};
