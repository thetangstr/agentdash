import Link from 'next/link';

export default function Home() {
  return (
    <>
      <div className="hero">
        <h1>MKThink <span style={{color:'var(--accent)'}}>×</span> AgentDash</h1>
        <p>Your autonomous AI workforce is live. This is your operations hub — everything you need to manage your agent team, track work, and get results.</p>
        <br/>
        <a href="http://MKTHINK-MAC-MINI-IP:3100/dashboard" className="cta">Open Dashboard →</a>
      </div>

      <h2>Quick Actions</h2>
      <div className="card-grid">
        <a href="http://MKTHINK-MAC-MINI-IP:3100/dashboard" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">📊</div>
            <h4>Dashboard</h4>
            <p>See what your agents are doing right now</p>
          </div>
        </a>
        <a href="http://MKTHINK-MAC-MINI-IP:3100/issues" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">📋</div>
            <h4>Tasks</h4>
            <p>Create, assign, and track work</p>
          </div>
        </a>
        <a href="http://MKTHINK-MAC-MINI-IP:3100/cos" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">💬</div>
            <h4>Chief of Staff</h4>
            <p>Chat to plan and delegate</p>
          </div>
        </a>
        <a href="http://MKTHINK-MAC-MINI-IP:3100/costs" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">💰</div>
            <h4>Costs</h4>
            <p>Token spend and budget tracking</p>
          </div>
        </a>
      </div>

      <h2>What AgentDash Does</h2>
      <p>AgentDash is your company's AI control plane — the operating system for a team of AI agents that work for you 24/7.</p>
      <div className="card-grid">
        <div className="card">
          <div className="icon">🎯</div>
          <h4>You Define the Work</h4>
          <p>Create tasks in the dashboard or text your CEO agent. Describe what needs to be done.</p>
        </div>
        <div className="card">
          <div className="icon">🤖</div>
          <h4>Agents Pick It Up</h4>
          <p>Your AI agents check for new work every 30 minutes and start automatically.</p>
        </div>
        <div className="card">
          <div className="icon">📊</div>
          <h4>You See Everything</h4>
          <p>Real-time status: who's working, what's done, what needs review. Full transparency.</p>
        </div>
        <div className="card">
          <div className="icon">💰</div>
          <h4>You Control Costs</h4>
          <p>Set a monthly budget. Agents auto-pause at the cap. No surprise bills.</p>
        </div>
      </div>

      <h2>What to Expect in Your First Week</h2>
      <div className="card-grid">
        <div className="card">
          <div className="icon">📅</div>
          <h4>Day 1</h4>
          <p>Agent team created. First task assigned and completed. Dashboard bookmarked.</p>
        </div>
        <div className="card">
          <div className="icon">📈</div>
          <h4>Day 2-3</h4>
          <p>Create 3-5 tasks/day. Learn what works. Check dashboard 2-3x/day.</p>
        </div>
        <div className="card">
          <div className="icon">🎯</div>
          <h4>Day 4-5</h4>
          <p>Refine task descriptions. Be specific. Use CoS chat for delegation.</p>
        </div>
        <div className="card">
          <div className="icon">✅</div>
          <h4>Week 2+</h4>
          <p>Routine: morning + evening dashboard check. 15-20 min/day. System runs itself.</p>
        </div>
      </div>

      <h2>Start Here</h2>
      <div className="card-grid">
        <Link href="/getting-started" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">🚀</div>
            <h4>Quick Start Guide</h4>
            <p>Everything you need for day one</p>
          </div>
        </Link>
        <Link href="/daily-usage" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">📖</div>
            <h4>Daily Usage</h4>
            <p>Your 15-minute daily routine</p>
          </div>
        </Link>
        <Link href="/texting-ceo" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">📱</div>
            <h4>Texting Your CEO</h4>
            <p>Manage work from your iPhone</p>
          </div>
        </Link>
        <Link href="/troubleshooting" style={{textDecoration:'none',color:'inherit'}}>
          <div className="card">
            <div className="icon">🔧</div>
            <h4>Troubleshooting</h4>
            <p>Fix common issues yourself</p>
          </div>
        </Link>
      </div>
    </>
  );
}
