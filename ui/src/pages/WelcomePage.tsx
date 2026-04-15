"use client";
import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";

export function WelcomePage() {
  const { createCompany } = useCompany();
  const navigate = useNavigate();
  const [companyName, setCompanyName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGetStarted() {
    const name = companyName.trim();
    if (!name) return;
    setLoading(true);
    setError(null);
    try {
      const company = await createCompany({ name });
      navigate(`/${company.issuePrefix}/setup-wizard`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div className="space-y-3">
          <h1 className="text-4xl font-bold tracking-tight">Welcome to AgentDash</h1>
          <p className="text-lg text-muted-foreground">Your AI workforce, ready to deploy.</p>
        </div>

        <div className="rounded-xl border bg-card p-8 space-y-5 text-left">
          <div className="space-y-2">
            <label htmlFor="company-name" className="block text-sm font-medium">
              What's your company name?
            </label>
            <input
              id="company-name"
              type="text"
              placeholder="Acme Corp"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleGetStarted(); }}
              className="w-full rounded-lg border bg-background p-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              autoFocus
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            onClick={handleGetStarted}
            disabled={!companyName.trim() || loading}
            className="w-full px-6 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Setting up..." : "Get Started"}
          </button>
        </div>

        <p className="text-sm text-muted-foreground">
          Migrating an existing instance?{" "}
          <a href="/company/import" className="underline hover:text-foreground">
            Import
          </a>
        </p>
      </div>
    </div>
  );
}
