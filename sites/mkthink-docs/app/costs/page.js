export default function Costs() {
  return (
    <>
      <h1>Costs &amp; Budgets</h1>
      <p>Your pilot is free for 6 months. You provide the AI tokens.</p>

      <h2>How Token Billing Works</h2>
      <p>Every time an agent runs, it consumes tokens from your LLM provider. The cost depends on the model and adapter:</p>

      <table>
        <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Best for</th></tr></thead>
        <tbody>
          <tr><td>Sonnet 5 (through Aug 31)</td><td>$2/M tokens</td><td>$10/M tokens</td><td>Best quality, great value</td></tr>
          <tr><td>Sonnet 5 (from Sep 1)</td><td>$3/M tokens</td><td>$15/M tokens</td><td>Standard pricing</td></tr>
          <tr><td>Haiku 4.5</td><td>$1/M tokens</td><td>$5/M tokens</td><td>Budget option</td></tr>
          <tr><td>Claude Code subscription</td><td>Included</td><td>Included</td><td>Subject to plan limits</td></tr>
          <tr><td>Gemini free tier</td><td>Free</td><td>Free</td><td>1,000 req/day cap</td></tr>
        </tbody>
      </table>

      <h2>Estimated Monthly Cost</h2>
      <p>For 4 agents, 30-minute heartbeat, moderate use:</p>
      <table>
        <thead><tr><th>Setup</th><th>Monthly cost</th><th>Budget control</th></tr></thead>
        <tbody>
          <tr><td>Claude API (Sonnet 5)</td><td>~$50-150</td><td>Full hard-stop in AgentDash</td></tr>
          <tr><td>Claude Code subscription</td><td>$0 extra</td><td>Claude plan limits only</td></tr>
          <tr><td>Gemini free tier</td><td>$0</td><td>1,000 requests/day cap</td></tr>
          <tr><td>Local model (Ollama)</td><td>$0</td><td>Hardware-limited</td></tr>
        </tbody>
      </table>

      <h2>Setting a Budget Cap</h2>
      <p>Prevents surprise bills. Agents auto-pause when the cap is hit.</p>
      <pre><code>{`# Company budget: $100/month
curl -X PATCH http://127.0.0.1:3100/api/companies/:companyId/budgets \\
  -H "Content-Type: application/json" \\
  -d '{"budgetMonthlyCents": 10000}'

# Per-agent budget: $30/month
curl -X PATCH http://127.0.0.1:3100/api/agents/:agentId/budgets \\
  -H "Content-Type: application/json" \\
  -d '{"budgetMonthlyCents": 3000}'`}</code></pre>

      <div className="alert">
        <strong>Note:</strong>
        <p>Budget enforcement only works with API billing (<code>claude_api</code>). Claude Code subscription (<code>claude_local</code>) doesn't report per-call costs, so AgentDash can't enforce budgets.</p>
      </div>
    </>
  );
}
