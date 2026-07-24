export default function GettingStarted() {
  return (
    <>
      <h1>Quick Start Guide</h1>
      <p>Everything you need for your first day with AgentDash.</p>

      <h2>Step 1: Log In</h2>
      <p>Open <code>http://{'<mac-mini-ip>'}:3100</code> in your browser and sign up with your work email.</p>

      <h2>Step 2: Complete Onboarding</h2>
      <p>Navigate to <code>/cos</code> to chat with your Chief of Staff. Tell it about MKThink:</p>
      <blockquote><p>"MKThink is a strategy, design, and innovation consultancy. We help organizations solve complex problems."</p></blockquote>
      <p>The CoS will propose a team of agents. Review and approve — the agents get created automatically.</p>

      <h2>Step 3: Create Your First Task</h2>
      <ol>
        <li>Click "New Issue" in the sidebar</li>
        <li>Write a specific task description (see below)</li>
        <li>Assign it to an agent</li>
        <li>Set priority to "medium"</li>
      </ol>

      <h3>Good task description</h3>
      <blockquote><p>"Research our top 5 competitors in the strategy consulting space. For each: key services, notable clients, pricing model. Create a 2-page summary with comparison table."</p></blockquote>

      <h3>Bad task description</h3>
      <blockquote><p>"Research competitors"</p></blockquote>

      <h2>Step 4: Watch It Work</h2>
      <p>Within 30 minutes, the agent will pick up the task. Check the dashboard:</p>
      <ul>
        <li>Agent status changes from <code>idle</code> → <code>running</code></li>
        <li>Open the agent to see the live run transcript</li>
        <li>When done, the task shows <code>done</code> with a completion comment</li>
      </ul>

      <h2>Step 5: Review and Repeat</h2>
      <p>Open the completed task. Read the agent's output. If it needs work, comment on the task — the agent will pick up the feedback on its next cycle.</p>
      <p>Create 3-5 more tasks for the day. Let the agents work. Check back in a few hours.</p>

      <div className="info">
        <strong>💡 Pro tip:</strong>
        <p>The more specific your task descriptions, the better the results. Include scope, format, context, and expected output.</p>
      </div>
    </>
  );
}
