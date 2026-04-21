export default function DocsPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 text-center">
      <h1 className="text-3xl font-bold mb-4">Documentation coming soon</h1>
      <p className="text-slate-400 mb-8 max-w-md">
        Full documentation is on the way. In the meantime, check out the
        AgentDash dashboard to explore the platform directly.
      </p>
      <a
        href="/"
        className="text-teal-400 hover:text-teal-300 transition-colors underline underline-offset-4"
      >
        Back to home
      </a>
    </div>
  );
}
