import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../components/ui/button";
import {
  BRIDGE_CLI_BIN,
  buildBridgeRunCommand,
  type BridgeEgress,
} from "../components/agent/ConnectYourMachine";

/**
 * AgentDash-MK: the steward-facing explanation of the machine bridge.
 *
 * Why a page rather than more copy on My Agent: the enrollment card there is
 * three steps and a command box, which is right for someone who already knows
 * what they are connecting and why. It is not enough for someone deciding
 * whether to connect at all, and it has no room for the containment trade-off,
 * the prerequisites, or what to do when it does not start.
 *
 * The command is IMPORTED from the enrollment component rather than written
 * again here. A guide that quotes a command by hand is a guide that goes stale
 * the first time the real one changes — and the real one has already been wrong
 * twice, once naming a binary nobody had installed and once omitting a required
 * flag.
 */

const ORIGIN_FALLBACK = "https://your-agentdash-instance";

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="rounded-lg border p-4">
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      <div className="mt-3 flex flex-col gap-3 text-sm">{children}</div>
    </section>
  );
}

function Status({ kind }: { kind: "live" | "pending" }) {
  const live = kind === "live";
  return (
    <span
      className={`ml-2 inline-flex items-center rounded border px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide ${
        live
          ? "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          : "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:text-amber-500"
      }`}
    >
      {live ? "Available now" : "Not yet reachable"}
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border bg-muted/40 px-1 py-0.5 font-mono text-[0.8em]">
      {children}
    </code>
  );
}

export default function ConnectYourMachineGuide() {
  const origin = typeof window !== "undefined" ? window.location.origin : ORIGIN_FALLBACK;
  const [egress, setEgress] = useState<BridgeEgress>("direct");
  const [copied, setCopied] = useState(false);
  const command = buildBridgeRunCommand(origin, egress);

  const copy = async () => {
    try {
      // Matches the enrollment card: no Clipboard API over plain HTTP, so this
      // can legitimately fail and has to say so rather than looking like it
      // worked.
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold">Connect your machine</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          How your agents reach you on the machine you already work on, what that does and does
          not allow, and how to set it up so it starts the first time.
        </p>
      </header>

      <Section id="what-it-does" title="What connecting a machine actually does">
        <p>
          Some questions are not in any system — intent, risk, a decision someone made in a room.
          An agent that hits one of those has to ask a person. Connecting your machine gives it a
          way to reach <em>you</em>, in the terminal you are already sitting in, instead of leaving
          the work parked until you happen to look at the board.
        </p>
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="font-medium">
              An agent asks you a question
              <Status kind="live" />
            </p>
            <p className="mt-1 text-muted-foreground">
              A small program runs on your machine and waits. When one of your agents needs a fact
              only you have, the question arrives locally, you answer it, and the answer goes back
              with your name on it. Nothing listens on a port and nothing connects inward — every
              exchange starts from your side.
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="font-medium">
              Your inbox is delivered to you
              <Status kind="live" />
            </p>
            <p className="mt-1 text-muted-foreground">
              Approvals waiting on you, agents that stopped, work that finished — ordered so the
              urgent thing is first. It is a durable log kept per person, and each of your machines
              has its own position in it, so nothing is lost while a machine is off and nothing is
              shown to you twice. You read it in a session you open for the purpose, and you can
              decide an approval from there.
            </p>
          </div>
        </div>
      </Section>

      <Section id="before-you-start" title="Before you start">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <span className="font-medium">macOS, and Node 20 or newer.</span> The sandbox this runs
            each task in is macOS-only.
          </li>
          <li>
            <span className="font-medium">
              The <Code>{BRIDGE_CLI_BIN}</Code> tool from your administrator.
            </span>{" "}
            It ships with this server. Do not install it from npm — the published copy predates this
            feature and answers <Code>unknown command 'bridge'</Code>, and nothing published under
            the name <Code>agentdash</Code> is ours.
          </li>
          <li>
            <span className="font-medium">An Anthropic API key.</span> Not optional, and the reason
            is worth knowing: the sandbox denies your home directory, so it cannot read a desktop{" "}
            <Code>claude</Code> login. Without a key in the environment the connection succeeds and
            then every question fails, which looks like a broken agent rather than a missing
            credential.
          </li>
        </ul>
      </Section>

      <Section id="steps" title="Setting it up">
        <ol className="flex list-decimal flex-col gap-3 pl-5">
          <li>
            <span className="font-medium">Enrol this machine.</span> On{" "}
            <Link className="underline" to="/my-agent">
              My Agent
            </Link>
            , use “Let my agent ask me here”. That mints a token and shows it once — it is stored
            nowhere anyone can read back, so if you lose it, enrol again.
          </li>
          <li>
            <span className="font-medium">Save the token.</span> The enrolment card gives you the
            exact command; it writes <Code>~/.agentdash/bridge-token</Code> with owner-only
            permissions.
          </li>
          <li>
            <span className="font-medium">Choose what the sandbox may reach.</span> There is no
            default and the tool will not start without it. See below.
          </li>
          <li>
            <span className="font-medium">Leave it running.</span> In a terminal you keep open, or
            wrapped in a login item or a <Code>launchd</Code> agent so it starts when you sign in.
            When it stops, the enrolment card shows your machine as last seen at the moment it went
            quiet — so “enrolled but never started” is distinguishable from “connected”.
          </li>
        </ol>
      </Section>

      <Section id="inbox" title="Reading your inbox in Claude Code">
        <p>
          Your inbox is read in a session you open for it, and nowhere else. Create the workspace
          once:
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          <code>{`${BRIDGE_CLI_BIN} bridge inbox-init ~/agentdash-inbox --server ${origin}`}</code>
        </pre>
        <p>
          Then open a Claude Code session in <Code>~/agentdash-inbox</Code>. What is waiting on you
          appears at the start of the session: decisions first, then agents that stopped, then work
          that finished. Ask in that session to approve or reject something.
        </p>
        <p className="text-muted-foreground">
          <span className="font-medium">It cannot interrupt your other work.</span> The hook that
          fetches your inbox is configured inside that workspace, and a project's settings apply
          only to sessions started in it — so your coding sessions elsewhere are untouched, and
          nothing is ever injected into a conversation you are in the middle of. That is a property
          of where the hook lives, not a check it performs.
        </p>
        <p className="text-muted-foreground">
          You can also read it directly at any time with{" "}
          <Code>{BRIDGE_CLI_BIN} bridge inbox</Code>. If the server is unreachable it says so and
          exits quietly — it will never stop a session from starting.
        </p>
      </Section>

      <Section id="containment" title="The one decision only you can make">
        <p>
          Each question runs in a sandbox. This picks how much of the network that sandbox may
          reach, and the tool deliberately refuses to choose for you.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              {
                value: "direct" as const,
                title: "Allow outbound 443",
                body: "The sandbox reaches the Anthropic API directly and nothing inspects that traffic. Weaker, and works with no extra setup.",
              },
              {
                value: "loopback" as const,
                title: "Deny outbound",
                body: "Localhost only. Stronger, but reaching the Anthropic API then needs an allowlisting proxy already running on your machine — without one, every question fails.",
              },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setEgress(option.value);
                setCopied(false);
              }}
              aria-pressed={egress === option.value}
              className={`rounded-md border px-3 py-2 text-left text-xs ${
                egress === option.value
                  ? "border-foreground bg-muted"
                  : "border-border hover:bg-muted/40"
              }`}
            >
              <span className="font-medium">{option.title}</span>
              <span className="mt-1 block text-muted-foreground">{option.body}</span>
            </button>
          ))}
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold">
              The command for that choice
            </h3>
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <pre className="mt-1.5 overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
            <code>{command}</code>
          </pre>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Replace <Code>sk-ant-…</Code> with a real key. Your administrator can tell you where{" "}
            <Code>{BRIDGE_CLI_BIN}</Code> is installed on this machine.
          </p>
        </div>
      </Section>

      <Section id="limits" title="What it will never do">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <span className="font-medium">It does not take instructions.</span> What travels to your
            machine is a question or a decision to make, never an order. An agent cannot use this to
            grant itself access, change its own configuration, or reach anything outside the stated
            purpose of the task — and a task's own text is framed as untrusted before your local
            agent ever sees it.
          </li>
          <li>
            <span className="font-medium">It carries the ask, not the evidence.</span> Anything
            delivered here becomes context in your AI client and may be logged or summarised, so
            what arrives names what is needed and points at it. If you need a figure or a client
            name to decide, you open AgentDash.
          </li>
          <li>
            <span className="font-medium">The credential is not an API key.</span> The token on your
            machine reaches only the bridge's own routes. It cannot read issues, list agents, or
            decide approvals in general — a decision you make is authorised by a separate handle
            that is good for exactly one approval, at one revision, once.
          </li>
          <li>
            <span className="font-medium">Enrolling is still a real decision.</span> Your owner
            ceiling limits what may be <em>asked</em> of this machine. It cannot limit what the
            machine is able to do, because your local agent has your reach. It is worth the trust
            you place in the people who can file work here.
          </li>
        </ul>
      </Section>

      <Section id="troubleshooting" title="If it does not start">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-3 font-semibold">What you see</th>
                <th className="py-2 pr-3 font-semibold">What it means</th>
                <th className="py-2 font-semibold">What to do</th>
              </tr>
            </thead>
            <tbody className="align-top">
              <tr className="border-b">
                <td className="py-2 pr-3">
                  <Code>unknown command 'bridge'</Code>
                </td>
                <td className="py-2 pr-3">
                  You are running a copy from npm, which predates this feature.
                </td>
                <td className="py-2">Get the tool from your administrator instead.</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3">
                  <Code>Refusing to start: --egress is required</Code>
                </td>
                <td className="py-2 pr-3">No containment posture was chosen.</td>
                <td className="py-2">Use the command above, which includes one.</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3">
                  <Code>403 Bridge endpoint authentication required</Code>
                </td>
                <td className="py-2 pr-3">
                  The token is missing, wrong, or the enrolment was revoked.
                </td>
                <td className="py-2">Check the token file, then enrol the machine again.</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3">Connects, then every question fails</td>
                <td className="py-2 pr-3">
                  No <Code>ANTHROPIC_API_KEY</Code> in the environment.
                </td>
                <td className="py-2">
                  Set a real key. A desktop <Code>claude</Code> login cannot be used.
                </td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3">Every question fails on <Code>loopback</Code></td>
                <td className="py-2 pr-3">
                  Nothing can reach the Anthropic API without a local allowlisting proxy.
                </td>
                <td className="py-2">
                  Run a proxy, or switch to allowing outbound 443.
                </td>
              </tr>
              <tr>
                <td className="py-2 pr-3">Card says “enrolled but never started”</td>
                <td className="py-2 pr-3">
                  The token was minted but the program has never run.
                </td>
                <td className="py-2">Start it, and keep the terminal open.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="codex" title="Codex, and other clients">
        <p>
          The connection above is a program that runs on your machine and talks to this server. It
          is not tied to Claude Code, and nothing about the enrolment is Claude-specific.
        </p>
        <p className="text-muted-foreground">
          Two pieces are Claude-specific today. The worker that answers questions locally runs the{" "}
          <Code>claude</Code> binary, and the inbox workspace above uses a Claude Code session
          hook. <Code>{BRIDGE_CLI_BIN} bridge inbox</Code> itself is not — it is an ordinary
          command that prints what is waiting, so anything able to run a command and read its
          output can show you your inbox.
        </p>
        <p className="text-muted-foreground">
          What we have not built or verified is a Codex equivalent of the session hook, so this page
          will not describe steps for it that nobody has run. If you work in Codex and want this,
          say so and it becomes a real piece of work rather than a guess in a guide.
        </p>
      </Section>
    </div>
  );
}
