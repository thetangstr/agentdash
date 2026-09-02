import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { bridgeApi, type BridgeEndpoint } from "../../api/bridge";
import { Button } from "../ui/button";
import { copyToClipboard } from "../../lib/clipboard";

/**
 * Enrolling your own machine so your agent can reach you.
 *
 * Every piece of this already worked. The two-step enrolment ceremony
 * (`POST /me/bridge/endpoints` then `.../approve`), the poller
 * (`paperclipai bridge run`), and the escalation path that prefers a live
 * `bridge:read` endpoint were all built and tested. What was missing was any way
 * for the person whose machine it is to find out — enrolment had only ever
 * happened via an operator running a seed script, so the product's most personal
 * promise was, in practice, unavailable to the people it was for.
 *
 * The ceremony stays two steps rather than being collapsed into one: the request
 * creates no usable credential, so a stray click cannot mint a working token.
 * Self-approval is allowed and correct here — the person enrolling their own
 * laptop is exactly the person whose consent matters, and requiring a colleague
 * to click it would add friction without adding a control.
 *
 * The token is shown once because it exists nowhere else. No route will return
 * it again, so the copy has to say that plainly rather than implying it can be
 * found later in a settings page.
 */
/**
 * AgentDash (AGE-12): the command must name a binary that exists.
 *
 * The in-repo CLI package is `paperclipai` (see `cli/package.json` `bin`), and
 * `bridge run` is registered on it in `cli/src/commands/bridge-run.ts`. This
 * page used to print the bare product name in front of `bridge run`: no such
 * binary is installed anywhere, and the bare npm name belongs to a third
 * party, so running it through npx downloads and runs a stranger's package,
 * prints an unrelated help screen, and exits 0 — which looks like success. A
 * test pins this string to the package's real bin name.
 */
export const BRIDGE_CLI_BIN = "paperclipai";

export function buildBridgeRunCommand(origin: string): string {
  return [
    `${BRIDGE_CLI_BIN} bridge run \\`,
    `  --server ${origin} \\`,
    "  --token-file ~/.agentdash/bridge-token",
  ].join("\n");
}

export function ConnectYourMachine({
  companyId,
  agentName,
}: {
  companyId: string;
  agentName: string;
}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const defaultLabel =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform ?? "")
      ? "My Mac"
      : "My laptop";
  const [label, setLabel] = useState(defaultLabel);

  const endpointsQuery = useQuery({
    queryKey: ["bridge", "me", "endpoints", companyId],
    queryFn: () => bridgeApi.listMyEndpoints(companyId),
    enabled: Boolean(companyId),
  });

  const enroll = useMutation({
    mutationFn: async () => {
      const requested = await bridgeApi.requestEnrollment(companyId, label.trim() || defaultLabel);
      // Approve immediately: a pending enrolment is inert, and leaving the
      // person holding one would look like the feature had failed.
      return bridgeApi.approve(companyId, requested.enrollmentId);
    },
    onSuccess: async (approved) => {
      setToken(approved.token);
      await queryClient.invalidateQueries({ queryKey: ["bridge", "me", "endpoints", companyId] });
    },
  });

  const revoke = useMutation({
    mutationFn: (endpointId: string) => bridgeApi.revoke(companyId, endpointId),
    onSuccess: async () => {
      setToken(null);
      await queryClient.invalidateQueries({ queryKey: ["bridge", "me", "endpoints", companyId] });
    },
  });

  const endpoints: BridgeEndpoint[] = endpointsQuery.data?.endpoints ?? [];
  const live = endpoints.filter((endpoint) => endpoint.enrolledAt !== null);

  const command = buildBridgeRunCommand(origin);

  const saveToken = token
    ? `mkdir -p ~/.agentdash && printf %s '${token}' > ~/.agentdash/bridge-token && chmod 600 ~/.agentdash/bridge-token`
    : "";

  const copy = async (what: string, text: string) => {
    // See ConnectYourHarness: no Clipboard API exists over plain HTTP, and a
    // silent failure here leaves someone pasting an empty token.
    const ok = await copyToClipboard(text);
    setCopied(ok ? what : `${what}:failed`);
    window.setTimeout(() => setCopied(null), 2200);
  };

  /**
   * Three states, not two. "Copy" that silently means "did nothing" is how the
   * on-prem clipboard bug went unnoticed.
   */
  const copyLabel = (what: string, idle = "Copy") =>
    copied === what ? "Copied" : copied === `${what}:failed` ? "Copy failed" : idle;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold">Let {agentName} reach you on this machine</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Some questions are not in any system — intent, risk, a decision made in a room. When{" "}
        {agentName} hits one of those, it can ask you directly: the question arrives in your own
        terminal, you answer there, and the answer goes back with your name on it. Until you
        connect a machine, those questions just wait for you in AgentDash instead.
      </p>

      {live.length > 0 ? (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {live.map((endpoint) => (
            <li key={endpoint.id} className="flex items-center gap-3 px-3 py-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{endpoint.label || "Unnamed machine"}</p>
                <p className="text-xs text-muted-foreground">
                  {endpoint.capabilities.join(", ") || "no capabilities"} ·{" "}
                  {endpoint.lastSeenAt
                    ? `last seen ${new Date(endpoint.lastSeenAt).toLocaleString()}`
                    : "never polled — start the command below to bring it online"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(endpoint.id)}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {!token ? (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-xs text-muted-foreground" htmlFor="bridge-label">
              What should we call this machine?
            </label>
            <input
              id="bridge-label"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder={defaultLabel}
            />
          </div>
          <Button size="sm" disabled={enroll.isPending} onClick={() => enroll.mutate()}>
            {/*
              * Named for the direction, not the act.
              *
              * The page also offers connecting a harness TO this agent, and
              * both buttons read "connect ... machine" while pointing opposite
              * ways: one lets you drive the agent, this one lets the agent ask
              * you a question. Two identical-sounding buttons beside each other
              * is how someone ends up enrolling the wrong thing and concluding
              * the product is broken.
              */}
            {enroll.isPending ? "Setting up…" : `Let ${agentName} ask me here`}
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs">
            <span className="font-medium">This is the only time you will see this token.</span> It
            is stored nowhere we can read back. If you lose it, connect the machine again — the old
            one keeps working until you revoke it.
          </div>

          <div>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold">1. Save the token on this machine</h3>
              <Button variant="outline" size="sm" onClick={() => copy("token", saveToken)}>
                {copyLabel("token")}
              </Button>
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
              <code>{saveToken}</code>
            </pre>
          </div>

          <div>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-semibold">2. Leave this running</h3>
              <Button variant="outline" size="sm" onClick={() => copy("command", command)}>
                {copyLabel("command")}
              </Button>
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
              <code>{command}</code>
            </pre>
            <p className="mt-1.5 text-xs text-muted-foreground">
              It waits for questions and does nothing else. This machine can only be{" "}
              <span className="font-medium">asked things</span> — nothing here lets an agent change
              anything on it.
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">
              <span className="font-medium">Where the command comes from.</span> <code>{BRIDGE_CLI_BIN}</code>{" "}
              is the AgentDash CLI that ships with this server (macOS only; it needs Node 20 or newer).
              Your administrator installs it from the same release the server runs — there is no
              separate download, and nothing named <code>agentdash</code> on npm is ours. To keep the
              bridge open, run the command in a terminal you leave open, or wrap it in a login item or
              a <code>launchd</code> agent so it starts when you sign in. When it stops, this page shows
              the machine as last seen at the moment it went quiet.
            </p>
          </div>
        </div>
      )}

      {enroll.error ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {enroll.error instanceof Error ? enroll.error.message : "Could not connect this machine"}
        </p>
      ) : null}
    </section>
  );
}
