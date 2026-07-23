export default function TextingCEO() {
  return (
    <>
      <h1>Texting Your CEO Agent 📱</h1>
      <p>If iMessage is set up, you can text your CEO agent from your iPhone. It reads your message, takes action in AgentDash, and replies — all through Messages.app.</p>

      <div className="info">
        <strong>How it works:</strong>
        <p>You text → Mac mini receives via Messages.app → the agent CEO agent reads it → calls AgentDash API → replies via iMessage → you see it on your phone.</p>
      </div>

      <h2>What You Can Text</h2>
      <table>
        <thead><tr><th>You text...</th><th>What happens</th></tr></thead>
        <tbody>
          <tr><td><em>"Status"</em></td><td>Full team status report</td></tr>
          <tr><td><em>"Create task: research 5 competitors"</em></td><td>New task created and assigned</td></tr>
          <tr><td><em>"What's the Research Agent working on?"</em></td><td>Specific agent status</td></tr>
          <tr><td><em>"Pause all agents"</em></td><td>All agents stop picking up work</td></tr>
          <tr><td><em>"Resume"</em></td><td>All agents resumed</td></tr>
          <tr><td><em>"How much have we spent?"</em></td><td>Budget and spend report</td></tr>
          <tr><td><em>"Show completed tasks"</em></td><td>List of done tasks from today</td></tr>
          <tr><td><em>"Remind me to call Acme on Friday"</em></td><td>Creates a scheduled reminder</td></tr>
        </tbody>
      </table>

      <h2>Setup Instructions</h2>
      <p>Ask your AgentDash contact to set this up. It requires installing the the agent Agent and imsg on the Mac mini. The full setup guide is in <code>doc/customers/mkthink/04-ceo-agent-imessage.md</code>.</p>

      <h3>Prerequisites</h3>
      <ul>
        <li>Mac mini with Messages.app signed in</li>
        <li>Your iPhone can iMessage the Mac mini's Apple ID</li>
        <li>Full Disk Access granted to Terminal</li>
      </ul>

      <h2>Troubleshooting iMessage</h2>
      <p>If the CEO agent doesn't respond to your text:</p>
      <ol>
        <li>Check the gateway: <code>hermes -p ceo gateway status</code></li>
        <li>Restart: <code>hermes -p ceo gateway restart</code></li>
        <li>Check Messages.app is open and signed in on the Mac mini</li>
        <li>Check Full Disk Access is granted (System Settings → Privacy)</li>
      </ol>
    </>
  );
}
