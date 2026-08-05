export default function Install() {
  const prompt = `You are installing AgentDash on this Mac mini for my company. Work through
this end to end. STOP and ask me whenever you need something only I can give
you. Never invent an email address, an API key, an invite code, or a licence key.

WHAT I WILL GIVE YOU WHEN YOU ASK
- my email address, and my teammates' email addresses
- an invite code AND a workspace code (two different codes, both required)
- a licence key and a licence public key
- optionally an API key, if I don't want to use this Mac's Claude subscription

1. PREREQUISITES
Check node (20+), pnpm (9+), git, and the claude CLI; install anything missing.
Confirm Claude is signed in with: echo "Respond with hello" | claude --print -
If that fails, tell me to run \`claude\` and log in.

2. INSTALL
git clone https://github.com/thetangstr/agentdash.git ~/agentdash
cd ~/agentdash && pnpm install --frozen-lockfile && pnpm build

3. CONFIGURE
Find the LAN IP (ipconfig getifaddr en0 || ipconfig getifaddr en1).
Generate two secrets with: openssl rand -hex 32
Ask me for the licence key, licence public key, and the workspace code.
Write ~/.config/agentdash/agentdash.env with:
  PAPERCLIP_DEPLOYMENT_MODE=authenticated
  NODE_ENV=production
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private
  PAPERCLIP_BIND=lan
  PAPERCLIP_ALLOWED_HOSTNAMES=<LAN_IP>
  PAPERCLIP_PUBLIC_URL=http://<LAN_IP>:3100
  PAPERCLIP_API_URL=http://127.0.0.1:3100
  PAPERCLIP_AUTH_BASE_URL_MODE=explicit
  PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://<LAN_IP>:3100
  PAPERCLIP_MIGRATION_AUTO_APPLY=true
  BETTER_AUTH_SECRET=<generated>
  PAPERCLIP_AGENT_JWT_SECRET=<generated>
  AGENTDASH_DEPLOYMENT_KIND=on_prem
  AGENTDASH_ENFORCE_LICENSE=true
  AGENTDASH_LICENSE_KEY=<the licence key I give you>
  AGENTDASH_LICENSE_PUBLIC_KEY=<the licence public key I give you>
  AGENTDASH_DEFAULT_ADAPTER=claude_local
  AGENTDASH_MK_INVITE_CODES=<workspace code from me>
  AGENTDASH_SELF_SERVE_BOOTSTRAP=true
  DISABLE_AUTOUPDATER=1
Keep claude_local unless I gave you an API key; if I did, use
AGENTDASH_DEFAULT_ADAPTER=claude_api plus ANTHROPIC_API_KEY.

4. RUN IT AS A SERVICE
Run ~/agentdash/docker/launchd/install.sh, then
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
Stop the Mac sleeping: sudo pmset -a sleep 0 disksleep 0
Wait for http://127.0.0.1:3100/api/health to return ok. If it doesn't, read
~/.agentdash/logs/agentdash.err and tell me what it says.

5. CLAIM THE INSTALL
Ask me for my email and the invite code, create the admin account, and give me
back the one-time password link so I can open the dashboard.

6. CREATE THE WORKSPACE
Create the company with productProfile "agentdash_mk" AND the workspace code as
inviteCode, in the same request — both together, or the workforce features will
be missing. Then confirm this returns 200 and not 404:
  GET /api/companies/<id>/connector-send-executions?status=outcome_unknown
A 404 means it landed on the wrong profile: recreate the company now.

7. ADD MY TEAM
Ask me for my teammates' emails and invite them with auto-approve on, so
accepting makes them members immediately. Membership is required before the
next step — pairing someone who hasn't accepted is refused. Give me each
invite link so I can pass them on.

8. PAIR EACH PERSON WITH AN AGENT
Create one agent per teammate plus one for me, and pair exactly one person with
each agent (one person, one agent). Confirm each person's My Agent page finds
their agent.

9. SET THE GUARDRAILS
Show me the actions that will need my approval, and ask if I want to add any.
Then set each agent's limits accordingly.

10. PROVE IT
Have my agent ask a teammate's agent for something, confirm it reaches that
person, have them answer, and show me the answer coming back with their name on
it. Then report: the dashboard address, which model you used, who looks after
which agent, and anything you couldn't finish.`;

  return (
    <>
      <h1>Install on a New Mac Mini</h1>
      <p>
        One prompt sets up the whole thing. You need a Mac mini with{" "}
        <a href="https://claude.com/claude-code">Claude Code</a> installed and signed in.
        Paste the prompt below into it and answer its questions.
      </p>

      <div className="info">
        <strong>Already installed?</strong>
        <p>
          This page is for standing up a brand-new machine. If your Mac mini is already
          running, start with the <a href="/getting-started">Quick Start</a> instead.
        </p>
      </div>

      <h2>Before you paste</h2>
      <p>
        Three sources of input, and only one of them is you. Nothing here is
        optional-but-secretly-required — if a value is missing, the install stops and says
        so rather than guessing.
      </p>

      <h3>We send you four things</h3>
      <ul>
        <li>
          <strong>Invite code</strong> — opens signup. If our validator can&apos;t be
          reached the install stops rather than half-finishing.
        </li>
        <li>
          <strong>Workspace code</strong> — a different code, also required. It turns on
          the workforce features: My Agent, approval limits, and the bridge to your laptop.
        </li>
        <li>
          <strong>Licence key</strong> and <strong>licence public key</strong> — two
          values that record your on-prem entitlement. Paste them as given; they are kept
          on the machine and never sent anywhere.
        </li>
      </ul>

      <h3>You type three, when asked</h3>
      <ul>
        <li>
          <strong>Your email</strong> — becomes the admin account. You get a one-time link
          to set a password; no email delivery is involved.
        </li>
        <li>
          <strong>Your teammates&apos; emails</strong> — one per person who will look after
          an agent.
        </li>
        <li>
          <strong>A model, only if you want one.</strong> Leave it and agents run on this
          Mac&apos;s own Claude subscription — no API key, no per-token cost. Paste a key
          only if you&apos;d rather they didn&apos;t.
        </li>
      </ul>

      <h3>The machine handles the rest</h3>
      <ul>
        <li>
          <strong>The database</strong> ships inside the server. Nothing to install, no
          connection string, no Docker.
        </li>
        <li>
          <strong>Secrets</strong> are generated on the machine and never leave it.
        </li>
        <li>
          <strong>Network address, service, sleep</strong> — it finds its own address,
          installs itself as a login service, and stops the Mac sleeping.
        </li>
      </ul>

      <h2>The prompt</h2>
      <p>Paste this once, in any folder.</p>
      <pre>
        <code>{prompt}</code>
      </pre>

      <h2>Two things that stall installs</h2>
      <p>Both are already handled by the prompt above. They&apos;re here so the error makes sense if you meet it.</p>
      <ol>
        <li>
          <strong>Pairing someone who hasn&apos;t accepted their invite is refused.</strong>{" "}
          You&apos;ll see <code>Steward user must be an active company member</code>. There&apos;s
          no way to add someone directly — they have to accept first, which is why the
          prompt invites with auto-approve before pairing.
        </li>
        <li>
          <strong>Not asking for the workspace is quieter than asking wrongly.</strong> Ask
          for it without the code and you&apos;re told plainly to get one. The quiet case is
          not asking at all: the workspace is created, nothing complains, and the features
          you were promised simply aren&apos;t there when you go looking.
        </li>
      </ol>

      <h2>When it&apos;s done</h2>
      <ul>
        <li>
          <code>http://{"<your-mac>"}:3100</code> — the dashboard opens from any machine on
          your network.
        </li>
        <li><strong>My Agent</strong> — shows the agent that belongs to you.</li>
        <li><strong>Company Settings</strong> — the limits editor, with all six controls.</li>
        <li><strong>Approvals</strong> — where anything needing your say-so waits.</li>
      </ul>

      <div className="info">
        <strong>Something the prompt didn&apos;t handle?</strong>
        <p>
          Send us the last thing it printed along with{" "}
          <code>~/.agentdash/logs/agentdash.err</code>. That pair is almost always enough
          to explain what happened.
        </p>
      </div>
    </>
  );
}
