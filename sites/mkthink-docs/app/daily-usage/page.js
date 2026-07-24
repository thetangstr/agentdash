export default function DailyUsage() {
  return (
    <>
      <h1>Daily Usage Guide</h1>
      <p>Your complete routine for operating AgentDash day-to-day. Total daily commitment: <strong>15-20 minutes</strong>.</p>

      <h2>Your Daily Rhythm</h2>

      <h3>Morning (5-10 min)</h3>
      <ol>
        <li><strong>Open the dashboard</strong> → check agent fleet status</li>
        <li><strong>Review overnight results</strong> → Issues → filter by "done"</li>
        <li><strong>Create tasks for today</strong> → what do you want agents working on?</li>
        <li><strong>Check pending approvals</strong> → anything in "needs your call"?</li>
      </ol>

      <h3>Midday (2-3 min, optional)</h3>
      <ol>
        <li>Quick dashboard check</li>
        <li>Any tasks stuck in "in_progress" for hours?</li>
        <li>Text your CEO agent for quick requests</li>
      </ol>

      <h3>Evening (5-10 min)</h3>
      <ol>
        <li>Review completed work</li>
        <li>Provide feedback on agent output (comment on tasks)</li>
        <li>Check costs page</li>
        <li>Create tasks for tomorrow</li>
      </ol>

      <h2>Creating Effective Tasks</h2>
      <table>
        <thead><tr><th>Element</th><th>Include</th></tr></thead>
        <tbody>
          <tr><td><strong>What</strong></td><td>Research, write, analyze, summarize</td></tr>
          <tr><td><strong>Scope</strong></td><td>How many items, how long, what format</td></tr>
          <tr><td><strong>Context</strong></td><td>Links, references, examples</td></tr>
          <tr><td><strong>Output</strong></td><td>Document, table, bullet list, email draft</td></tr>
        </tbody>
      </table>

      <h2>Managing Agents</h2>

      <h3>Agent Statuses</h3>
      <table>
        <thead><tr><th>Status</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>idle</code></td><td>Ready for work, waiting for tasks</td></tr>
          <tr><td><code>running</code></td><td>Currently working on a task</td></tr>
          <tr><td><code>paused</code></td><td>Stopped (manually or budget limit)</td></tr>
          <tr><td><code>error</code></td><td>Something went wrong — check transcript</td></tr>
        </tbody>
      </table>

      <h3>Pause / Resume</h3>
      <p>Agents page → click agent → "Pause" or "Resume". Useful for stopping overnight work or pausing when you've hit budget.</p>

      <h2>Using the CoS Chat</h2>
      <p>The Chief of Staff (<code>/cos</code>) is your AI operations manager:</p>
      <ul>
        <li><strong>Planning:</strong> "I need to prepare for a client pitch. What should our agents work on?"</li>
        <li><strong>Delegation:</strong> "Have the Research Agent compile a competitive landscape."</li>
        <li><strong>Status:</strong> "What's everyone working on?"</li>
      </ul>

      <h2>Reviewing Agent Output</h2>
      <ol>
        <li>Go to Issues → find the completed task</li>
        <li>Read the completion comment</li>
        <li>Check any attached documents</li>
        <li>If wrong: comment on the task with specific feedback</li>
      </ol>

      <h2>Cost Control</h2>
      <p>Set a monthly budget cap. Agents auto-pause when spending hits the limit.</p>
      <pre><code>{`# Set $100/month company budget
curl -X PATCH http://127.0.0.1:3100/api/companies/:companyId/budgets \\
  -H "Content-Type: application/json" \\
  -d '{"budgetMonthlyCents": 10000}'`}</code></pre>
    </>
  );
}
