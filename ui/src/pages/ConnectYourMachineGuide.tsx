import { Link } from "react-router-dom";
import { BRIDGE_CLI_BIN } from "../components/agent/ConnectYourMachine";

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
            <span className="font-medium">Create your inbox workspace.</span> One command, below.
            It is where you open the session that reads your inbox.
          </li>
          <li>
            <span className="font-medium">Open a session there.</span> Nothing needs to be left
            running in a terminal. If your machine is enrolled but you have never opened the
            session, the enrolment card shows it as never seen — which is how “set up” is
            distinguishable from “in use”.
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

      <Section id="directing" title="Directing work from the same conversation">
        <p>
          As well as answering what is waiting, you can hand work out — in ordinary words, in the
          same session.
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          <code>Have Casper draft the site visit agenda and Emilia review the figures.</code>
        </pre>
        <p>
          <span className="font-medium">Nothing is sent until you confirm.</span> It first reads
          back what it understood, with the agents it matched:
        </p>
        <div className="rounded-md border border-border bg-muted/30 p-3">
          <p className="text-xs font-medium">You should see</p>
          <pre className="overflow-x-auto rounded-md border border-border bg-background/60 p-3 text-xs leading-relaxed" style={{ marginTop: "0.5rem" }}>
            <code>{`Casper — draft the site visit agenda
Emilia — review the figures

Confirm and I will assign both.`}</code>
          </pre>
        </div>
        <p>
          Say yes and both become real, assigned work, recorded as assigned by you. The
          confirmation is good once: if you ask again, it answers{" "}
          <Code>That confirmation is no longer valid. Ask again.</Code> rather than assigning the
          same thing twice.
        </p>
        <h3 className="mt-2">What it refuses, on purpose</h3>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <span className="font-medium">A name it cannot place.</span> It asks instead of
            guessing, and offers near matches when it has them. A wrong name confidently assigned to
            the wrong agent is worse than a question.
          </li>
          <li>
            <span className="font-medium">More than ten at once.</span> You get{" "}
            <Code>ask for at most 10 at a time</Code>. Long lists are split so a failure partway
            through cannot leave you unsure what landed.
          </li>
          <li>
            <span className="font-medium">Work you are not permitted to assign.</span> Your
            permission is checked at the moment you confirm, not when you asked — so authority that
            changed in between is honoured.
          </li>
          <li>
            <span className="font-medium">A confirmation older than about fifteen minutes,</span> or
            one from a different machine. Ask again and you get a fresh read-back.
          </li>
        </ul>
        <div className="mt-3 rounded-md border border-amber-600/30 bg-amber-500/10 p-3">
          <p className="text-sm font-medium">If only part of a list is assigned</p>
          <p>
            A list is not all-or-nothing. If one item fails, the reply names exactly which landed
            and which did not, so you can ask again for the remainder. It will not tell you
            everything worked when it did not.
          </p>
        </div>
      </Section>

      <Section id="cadence" title="Checking on a schedule — set up in your own tool">
        <p>
          AgentDash does not run a timer. There is no scheduler here, and none is planned — the
          repeating check is a job you create in the tool you already work in, and it calls the same
          connection you set up above. That keeps one dedicated conversation for AgentDash and
          leaves your other work untouched.
        </p>

        <div className="rounded-md border border-amber-600/30 bg-amber-500/10 p-3">
          <p className="text-sm font-medium">
            Read this first: scheduled checking cannot decide anything for you yet.
          </p>
          <p>
            A scheduled check can <span className="font-medium">read</span> your inbox today, using
            the command you already have. <span className="font-medium">Approving or declining</span>{" "}
            from that conversation needs AgentDash&rsquo;s tool add-on, and this instance does not
            currently publish one — the download answers{" "}
            <Code>MCP client package is not built on this instance</Code>. Until an administrator
            builds and publishes it, use the schedule to be told, and decide in AgentDash itself.
          </p>
        </div>

        <h3 className="text-sm font-semibold">Claude Code</h3>
        <p>
          Open your inbox folder, start a session, and leave it open. In that session, ask for a
          repeating check:
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
          <code>Every 30 minutes, run `{BRIDGE_CLI_BIN} bridge inbox --ack --quiet-when-empty` and
show me anything it prints.</code>
        </pre>
        <p className="text-muted-foreground">
          It fires into <span className="font-medium">this same conversation</span> between your
          turns, so there is one thread and no new windows. Four limits worth knowing before you
          rely on it:
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
          <li>
            <span className="font-medium">It lives with the conversation.</span> Start a fresh
            conversation and the schedule is gone. It also expires seven days after you create it,
            so this is a weekly re-arm, not a set-and-forget.
          </li>
          <li>
            <span className="font-medium">Claude has to be running and idle.</span> Nothing fires
            while the app is closed, and a check due while Claude is mid-task is skipped rather than
            run late.
          </li>
          <li>
            <span className="font-medium">Thirty minutes is approximate.</span> Sub-hourly schedules
            are deliberately offset by up to half the interval, so a 30-minute check can arrive
            about fifteen minutes later than you expect. The offset is stable, not adjustable.
          </li>
          <li>
            <span className="font-medium">Sleep and wake are not documented.</span> Whether a check
            missed while your laptop slept fires late, is merged into one, or is dropped is not
            stated anywhere we can point to. Treat the on-open catch-up below as the thing you rely
            on, not the timer.
          </li>
        </ul>
        <p className="text-muted-foreground">
          Two other Claude surfaces schedule work but do not fit this shape, and it is worth knowing
          why so you do not go looking. Desktop scheduled tasks survive restarts and can reach a
          local connection, but each run opens a <span className="font-medium">new</span> session —
          so you get a schedule, not one pinned conversation. Cloud routines run without your laptop
          at all, but they run in a sandbox that cannot see a connection on your own machine, and
          their shortest interval is an hour.
        </p>

        <h3 className="text-sm font-semibold">Codex</h3>
        <p>
          The Codex command line has no scheduling of its own — OpenAI documents that plainly, and
          nothing in AgentDash can add it. Scheduling lives in the ChatGPT app instead, and the two
          places behave very differently:
        </p>
        <ul className="flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
          <li>
            <span className="font-medium">The ChatGPT desktop app</span> runs a task on your own
            machine and can keep it in the same chat, at intervals of minutes. Of everything on this
            page, that is the closest fit to one pinned conversation that checks on a timer.
          </li>
          <li>
            <span className="font-medium">ChatGPT on the web</span> runs the same kind of task in the
            cloud, and it does not read the configuration on your machine — so it cannot reach your
            connection at all. A task set up there will not see your inbox.
          </li>
        </ul>
        <p className="text-muted-foreground">
          Three things about the desktop route we have not been able to confirm, and would rather say
          so than let you find out: whether an unattended task loads the connection settings from
          your Codex configuration, whether its sandbox permits the call at all, and what happens to
          a run missed while the machine slept or the app was closed. None of that is written down.
          Try it with a check you can afford to miss before you depend on it.
        </p>

        <h3 className="text-sm font-semibold">What you can rely on either way</h3>
        <p className="text-muted-foreground">
          Opening or resuming a session in your inbox folder always catches you up — that is the hook
          the setup installed, and it does not depend on any schedule. If you set no timer at all,
          you still see everything waiting the next time you sit down. A check with nothing new
          prints nothing, so an idle schedule stays quiet.
        </p>
        <p className="text-muted-foreground">
          Two things a repeating check will do that are worth expecting. An approval that is still
          open gets mentioned again at every check until it is decided, because each check reports
          what is outstanding rather than only what changed. And a large backlog comes through a page
          at a time, so the first few checks after a long absence may each show you more.
        </p>
        <p className="text-muted-foreground">
          You may also see AgentDash offer to store a checking interval for you. It records the
          number and nothing reads it — the schedule that matters is the one you set up here, in your
          own tool.
        </p>
      </Section>

      <Section id="verify" title="Checking it actually works">
        <p>
          Do this once after setup, and any time something seems off. Each step tells you which
          part is healthy.
        </p>
        <ol className="flex list-decimal flex-col gap-3 pl-5">
          <li>
            <span className="font-medium">The connection.</span> Run the inbox command. Either your
            inbox or <Code>nothing waiting on you</Code> means the machine, its credential and the
            server are all fine.
          </li>
          <li>
            <span className="font-medium">The session.</span> Open a session in the inbox workspace.
            If what is waiting appears at the start, the session hook is wired correctly.
          </li>
          <li>
            <span className="font-medium">The tools.</span> Ask <Code>what is in my inbox?</Code> in
            that session. A reply means the tools are registered; “no such tool” means the
            connection step did not take.
          </li>
          <li>
            <span className="font-medium">The write path.</span> Ask it to assign yourself something
            harmless and confirm. If the read-back appears and the work shows up in AgentDash, the
            whole loop is proven.
          </li>
        </ol>
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
            machine reaches only the bridge's own routes. It can look up the names of agents in
            your company, so a name you type resolves to the right one. It cannot read issues, and
            it decides nothing on its own — a decision you make is authorised by a separate handle
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

      <Section id="troubleshooting" title="If something goes wrong">
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
                <td className="py-2 pr-3"><Code>unknown command 'bridge'</Code></td>
                <td className="py-2 pr-3">You are running a copy from npm, which predates this feature.</td>
                <td className="py-2">Get the tool from your administrator instead.</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3"><Code>AgentDash inbox unavailable: 403</Code></td>
                <td className="py-2 pr-3">The token is missing, wrong, or the enrolment was revoked.</td>
                <td className="py-2">Enrol the machine again from the card in AgentDash.</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3"><Code>AgentDash inbox unreachable</Code></td>
                <td className="py-2 pr-3">The address is wrong, or the server cannot be reached from here.</td>
                <td className="py-2">Check the address you enrolled against, then try again.</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3"><Code>AgentDash inbox: nothing waiting on you.</Code></td>
                <td className="py-2 pr-3">Nothing needs you. This is the normal state, not a fault.</td>
                <td className="py-2">Nothing. Silence means no one is blocked on you.</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3"><Code>This action is no longer valid. Sync again.</Code></td>
                <td className="py-2 pr-3">It was decided elsewhere, or it changed after you read it.</td>
                <td className="py-2">Read the inbox again and decide against the current version.</td>
              </tr>
              <tr className="border-b">
                <td className="py-2 pr-3"><Code>You do not have permission to assign work.</Code></td>
                <td className="py-2 pr-3">Your account cannot assign work in this company.</td>
                <td className="py-2">Ask someone who can, or have your access changed.</td>
              </tr>
              <tr>
                <td className="py-2 pr-3">The session opens but says nothing</td>
                <td className="py-2 pr-3">The session is not in the directory that carries the inbox.</td>
                <td className="py-2">Open it in the directory setup created, not your code project.</td>
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
