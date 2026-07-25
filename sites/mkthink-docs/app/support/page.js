export default function Support() {
  return (
    <>
      <h1>Get Help</h1>
      <p>We're here to make sure your AI workforce runs smoothly.</p>

      <h2>Report a Bug or Issue</h2>
      <div className="card-grid">
        <a href="https://github.com/thetangstr/agentdash/issues" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">🐛</div>
            <h4>File on GitHub</h4>
            <p>Fastest way to get help. Monitored every 30 min during business hours.</p>
          </div>
        </a>
      </div>

      <h2>Emergency Support</h2>
      <div className="card-grid">
        <div className="card">
          <div className="icon">📞</div>
          <h4>Server Down / Data Loss</h4>
          <p>Text Eddy directly. We'll respond immediately.</p>
        </div>
      </div>

      <h2>Response Times</h2>
      <table>
        <thead><tr><th>Issue type</th><th>How to report</th><th>Response time</th></tr></thead>
        <tbody>
          <tr><td>Bug</td><td>GitHub issue</td><td>&lt; 30 min (business hours)</td></tr>
          <tr><td>Server down</td><td>Text Eddy</td><td>ASAP</td></tr>
          <tr><td>Question</td><td>GitHub issue "question" label</td><td>&lt; 2 hours</td></tr>
          <tr><td>Feature request</td><td>GitHub issue "enhancement" label</td><td>Next sprint</td></tr>
        </tbody>
      </table>

      <p style={{marginTop:'24px',color:'var(--muted)'}}>Business hours: 9 AM - 6 PM Pacific, Monday-Friday</p>
    </>
  );
}
