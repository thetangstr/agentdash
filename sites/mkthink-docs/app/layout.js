export const metadata = {
  title: "MKThink × AgentDash — Your AI Company",
  description: "Documentation and resources for MKThink's AgentDash deployment",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <style>{`
          :root {
            --bg: #0a0b0f;
            --surface: #13151c;
            --border: #252836;
            --accent: #14b8a6;
            --accent-light: #2dd4bf;
            --text: #e4e4e7;
            --muted: #8b8d98;
          }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
            background: var(--bg);
            color: var(--text);
            line-height: 1.7;
            font-size: 16px;
          }
          a { color: var(--accent-light); text-decoration: none; }
          a:hover { text-decoration: underline; }
          ::selection { background: var(--accent); color: #000; }
          .layout {
            display: flex;
            min-height: 100vh;
          }
          .sidebar {
            width: 280px;
            background: var(--surface);
            border-right: 1px solid var(--border);
            padding: 24px 0;
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
            overflow-y: auto;
          }
          .sidebar-brand {
            padding: 0 24px 24px;
            border-bottom: 1px solid var(--border);
            margin-bottom: 16px;
          }
          .sidebar-brand h1 {
            font-size: 1.2em;
            font-weight: 800;
          }
          .sidebar-brand h1 span { color: var(--accent); }
          .sidebar-brand p {
            font-size: 0.8em;
            color: var(--muted);
            margin-top: 2px;
          }
          .sidebar nav { display: flex; flex-direction: column; gap: 2px; }
          .sidebar nav a {
            padding: 8px 24px;
            color: var(--muted);
            font-size: 0.9em;
            font-weight: 500;
            transition: all 0.15s;
            border-left: 3px solid transparent;
          }
          .sidebar nav a:hover {
            color: var(--text);
            background: rgba(255,255,255,0.03);
            text-decoration: none;
          }
          .sidebar nav a.active {
            color: var(--accent-light);
            border-left-color: var(--accent);
            background: rgba(20,184,166,0.05);
          }
          .sidebar nav .section-label {
            padding: 16px 24px 4px;
            font-size: 0.75em;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--muted);
            font-weight: 700;
          }
          .main {
            flex: 1;
            margin-left: 280px;
            padding: 48px 64px;
            max-width: 820px;
          }
          .main h1 {
            font-size: 2em;
            font-weight: 800;
            margin-bottom: 8px;
            letter-spacing: -0.02em;
          }
          .main h2 {
            font-size: 1.4em;
            font-weight: 700;
            margin: 36px 0 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--border);
          }
          .main h3 {
            font-size: 1.1em;
            font-weight: 600;
            margin: 24px 0 8px;
            color: var(--accent-light);
          }
          .main p { margin-bottom: 12px; }
          .main ul, .main ol { margin: 8px 0 16px 24px; }
          .main li { margin-bottom: 4px; }
          .main code {
            font-family: 'SF Mono', 'Fira Code', monospace;
            font-size: 0.88em;
            background: rgba(255,255,255,0.06);
            padding: 2px 6px;
            border-radius: 4px;
          }
          .main pre {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 16px 20px;
            overflow-x: auto;
            margin: 12px 0;
            font-size: 0.88em;
          }
          .main pre code {
            background: none;
            padding: 0;
          }
          .main table {
            width: 100%;
            border-collapse: collapse;
            margin: 16px 0;
          }
          .main th, .main td {
            text-align: left;
            padding: 10px 14px;
            border-bottom: 1px solid var(--border);
          }
          .main th {
            color: var(--muted);
            font-weight: 600;
            font-size: 0.85em;
            text-transform: uppercase;
          }
          .main blockquote {
            border-left: 3px solid var(--accent);
            padding: 12px 20px;
            margin: 16px 0;
            background: rgba(20,184,166,0.05);
            border-radius: 0 8px 8px 0;
            color: var(--text);
          }
          .main blockquote p { margin: 0; }
          .alert {
            background: rgba(245,158,11,0.08);
            border: 1px solid rgba(245,158,11,0.25);
            border-radius: 10px;
            padding: 16px 20px;
            margin: 16px 0;
          }
          .alert strong { color: #f59e0b; }
          .info {
            background: rgba(20,184,166,0.06);
            border: 1px solid rgba(20,184,166,0.2);
            border-radius: 10px;
            padding: 16px 20px;
            margin: 16px 0;
          }
          .info strong { color: var(--accent-light); }
          .hero {
            background: linear-gradient(135deg, var(--bg) 0%, var(--surface) 50%, #0d2b28 100%);
            border-radius: 16px;
            padding: 40px;
            margin-bottom: 32px;
            border: 1px solid var(--border);
          }
          .hero h1 { font-size: 2.4em; margin-bottom: 12px; }
          .hero p { font-size: 1.15em; color: var(--muted); }
          .hero .cta {
            display: inline-block;
            margin-top: 20px;
            padding: 12px 28px;
            background: var(--accent);
            color: #000;
            font-weight: 700;
            border-radius: 10px;
            text-decoration: none;
          }
          .hero .cta:hover { background: var(--accent-light); text-decoration: none; }
          .card-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
            gap: 14px;
            margin: 16px 0;
          }
          .card {
            background: var(--surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 20px;
            transition: border-color 0.2s;
          }
          .card:hover { border-color: var(--accent); }
          .card h4 { font-size: 1.05em; margin-bottom: 4px; }
          .card p { font-size: 0.9em; color: var(--muted); margin: 0; }
          .card .icon { font-size: 1.8em; margin-bottom: 6px; }
          @media (max-width: 768px) {
            .sidebar { display: none; }
            .main { margin-left: 0; padding: 24px; }
          }
        `}</style>
      </head>
      <body>
        <div className="layout">
          <aside className="sidebar">
            <div className="sidebar-brand">
              <h1>MKThink <span>×</span></h1>
              <p>AgentDash Documentation</p>
            </div>
            <nav>
              <div className="section-label">Getting Started</div>
              <a href="/">Welcome</a>
              <a href="/getting-started">Quick Start</a>
              <a href="/daily-usage">Daily Usage Guide</a>
              <div className="section-label">Guides</div>
              <a href="/texting-ceo">Texting Your CEO Agent</a>
              <a href="/agents">Your Agent Team</a>
              <div className="section-label">Reference</div>
              <a href="/troubleshooting">Troubleshooting</a>
              <a href="/admin">Admin Reference</a>
              <a href="/costs">Costs & Budgets</a>
              <div className="section-label">Support</div>
              <a href="/support">Get Help</a>
            </nav>
          </aside>
          <main className="main">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
