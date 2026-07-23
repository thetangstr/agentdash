export default function Troubleshooting() {
  return (
    <>
      <h1>Troubleshooting</h1>
      <p>Common issues and how to fix them without calling support.</p>

      <h2>Dashboard Won't Load</h2>
      <pre><code>{`# Check if server is running
curl http://127.0.0.1:3100/api/health

# Restart if needed
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent
sleep 5
curl http://127.0.0.1:3100/api/health`}</code></pre>
      <p>Also check: you're on the same network as the Mac mini, and the IP hasn't changed.</p>

      <h2>Agents Not Working</h2>
      <ol>
        <li>Dashboard → Agents → click agent → "Test Environment"</li>
        <li>If using Claude Code: <code>echo "hello" | claude --print -</code></li>
        <li>If using API key: check <code>ANTHROPIC_API_KEY</code> is set</li>
        <li>Check agent isn't paused (budget or manual)</li>
        <li>Restart: <code>launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent</code></li>
      </ol>

      <h2>CoS Chat Shows Stub Reply</h2>
      <p>If CoS responds with "Got it. (stub reply...)", the LLM adapter isn't configured:</p>
      <pre><code>{`grep AGENTDASH_DEFAULT_ADAPTER ~/.config/agentdash/agentdash.env
grep ANTHROPIC_API_KEY ~/.config/agentdash/agentdash.env`}</code></pre>
      <p>Fix the config and restart.</p>

      <h2>Costs Showing $0</h2>
      <p>You're using <code>claude_local</code> (subscription). The CLI doesn't report per-call costs. Switch to <code>claude_api</code> with an API key for cost tracking.</p>

      <h2>Mac Mini Went to Sleep</h2>
      <div className="alert">
        <strong>Fix:</strong>
        <p>System Settings → Energy → "Prevent automatic sleeping when display is off" = ON. Or: <code>sudo pmset -a sleep 0 disksleep 0</code></p>
      </div>

      <h2>iMessage Agent Not Responding</h2>
      <ol>
        <li><code>hermes -p ceo gateway status</code></li>
        <li><code>hermes -p ceo gateway restart</code></li>
        <li>Check Messages.app is signed in on Mac mini</li>
        <li>Check Full Disk Access (System Settings → Privacy)</li>
      </ol>

      <h2>Agent Produced Bad Output</h2>
      <p>This is normal. Agents aren't perfect. Comment on the task with specific feedback. The agent will revise on its next cycle.</p>

      <h2>Check Logs</h2>
      <pre><code>{`# Server logs
tail -50 ~/.agentdash/logs/agentdash.log

# Error logs
tail -50 ~/.agentdash/logs/agentdash.err`}</code></pre>

      <h2>When to Contact Support</h2>
      <table>
        <thead><tr><th>Issue</th><th>How</th><th>Response</th></tr></thead>
        <tbody>
          <tr><td>Bug</td><td><a href="https://github.com/thetangstr/agentdash/issues">GitHub issue</a></td><td>&lt; 30 min (business hrs)</td></tr>
          <tr><td>Server down</td><td>Text Eddy</td><td>ASAP</td></tr>
          <tr><td>Question</td><td>GitHub issue "question" label</td><td>&lt; 2 hours</td></tr>
        </tbody>
      </table>
    </>
  );
}
