export default function Admin() {
  return (
    <>
      <h1>Admin Reference</h1>
      <p>Technical commands for managing the AgentDash server on the Mac mini.</p>

      <h2>Server Management</h2>
      <pre><code>{`# Health check
curl -fsS http://127.0.0.1:3100/api/health

# Restart
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent

# Stop / Start
launchctl unload ~/Library/LaunchAgents/ai.agentdash.agent.plist
launchctl load ~/Library/LaunchAgents/ai.agentdash.agent.plist`}</code></pre>

      <h2>Logs</h2>
      <pre><code>{`tail -50 ~/.agentdash/logs/agentdash.log
tail -50 ~/.agentdash/logs/agentdash.err
tail -f ~/.agentdash/logs/agentdash.log  # follow`}</code></pre>

      <h2>Configuration</h2>
      <pre><code>{`nano ~/.config/agentdash/agentdash.env

# After changes, restart:
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent`}</code></pre>

      <h3>Key Variables</h3>
      <table>
        <thead><tr><th>Variable</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td><code>AGENTDASH_DEFAULT_ADAPTER</code></td><td>LLM adapter: claude_api, claude_local, openai_compat</td></tr>
          <tr><td><code>ANTHROPIC_API_KEY</code></td><td>Anthropic API key (for claude_api)</td></tr>
          <tr><td><code>PAPERCLIP_PUBLIC_URL</code></td><td>Dashboard URL</td></tr>
          <tr><td><code>BETTER_AUTH_SECRET</code></td><td>Session key (never change after setup)</td></tr>
        </tbody>
      </table>

      <h2>Backup</h2>
      <pre><code>{`cd ~/agentdash
pnpm db:backup`}</code></pre>

      <h2>Update AgentDash</h2>
      <pre><code>{`cd ~/agentdash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent`}</code></pre>

      <h2>Prevent Sleep</h2>
      <pre><code>{`sudo pmset -a sleep 0 disksleep 0`}</code></pre>

      <h2>Find Mac Mini IP</h2>
      <pre><code>{`ipconfig getifaddr en0  # WiFi
ipconfig getifaddr en1  # Ethernet`}</code></pre>

      <h2>Readiness Check</h2>
      <pre><code>{`cd ~/agentdash
scripts/msp-mac-mini-readiness.sh --base-url http://<ip>:3100`}</code></pre>
    </>
  );
}
