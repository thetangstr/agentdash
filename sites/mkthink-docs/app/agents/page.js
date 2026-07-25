export default function Agents() {
  return (
    <>
      <h1>Your Agent Team</h1>
      <p>Based on MKThink's work as a strategy and innovation consultancy, your team includes:</p>

      <h2>Chief of Staff</h2>
      <div className="card">
        <h4>Role: Chief of Staff</h4>
        <p>The CoS routes work, proposes plans, answers questions about the company, and coordinates the agent team. Talk to it via <code>/cos</code> or the dashboard.</p>
      </div>

      <h2>Scout — Research Analyst</h2>
      <div className="card">
        <h4>Role: Research</h4>
        <p>Competitive analysis, market research, data gathering, industry trend reports. Assign tasks that require finding and synthesizing information.</p>
      </div>

      <h2>Quill — Content Strategist</h2>
      <div className="card">
        <h4>Role: Content</h4>
        <p>Drafts proposals, reports, client communications, blog posts, marketing copy. Best for any task that produces written deliverables.</p>
      </div>

      <h2>Ops — Operations Manager</h2>
      <div className="card">
        <h4>Role: Operations</h4>
        <p>Project tracking, status reports, process documentation, deadline monitoring. Keeps things organized.</p>
      </div>

      <h2>Adding More Agents</h2>
      <p>Talk to your Chief of Staff: "I need a coding agent" or "Add a social media agent." The CoS will propose a new hire, which you can approve. You can also create agents manually from the Agents page.</p>

      <h2>Agent Adapters</h2>
      <p>Each agent runs via an LLM adapter. The adapter determines which AI model powers the agent:</p>
      <table>
        <thead><tr><th>Adapter</th><th>Powered by</th><th>Cost</th></tr></thead>
        <tbody>
          <tr><td><code>claude_local</code></td><td>Claude Code CLI (subscription)</td><td>Included in plan</td></tr>
          <tr><td><code>claude_api</code></td><td>Anthropic API</td><td>~$2-3/M input, $10-15/M output</td></tr>
          <tr><td><code>openai_compat</code></td><td>Ollama / OpenRouter / etc.</td><td>Varies</td></tr>
        </tbody>
      </table>
    </>
  );
}
