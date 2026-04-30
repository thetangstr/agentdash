// AgentDash: /solve — public survey for customer-problem intake (AGE-104).
// Public route, no auth. Submission flows through /api/solve-submit which
// writes to durable storage (Vercel Blob → local-fs fallback) and fans out
// notifications (Resend, Slack). The form is a client component because it
// owns interactive state; the surrounding marketing chrome is server-rendered
// in layout.tsx.

"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  COMPANY_SIZES,
  DATA_SOURCES,
  URGENCIES,
  URGENCY_LABELS,
  solveSubmissionSchema,
  type SolveSubmission,
} from "@/lib/solve-schema";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3100";

type FormState = "idle" | "submitting" | "success" | "error";

export default function SolvePage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [companySize, setCompanySize] = useState<(typeof COMPANY_SIZES)[number] | "">("");
  const [problem, setProblem] = useState("");
  const [dataSources, setDataSources] = useState<string[]>([]);
  const [dataSourcesOther, setDataSourcesOther] = useState("");
  const [successSignal, setSuccessSignal] = useState("");
  const [urgency, setUrgency] = useState<(typeof URGENCIES)[number] | "">("");
  const [additionalContext, setAdditionalContext] = useState("");

  const [state, setState] = useState<FormState>("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const canSubmit = useMemo(() => {
    return (
      state !== "submitting" &&
      name.trim() &&
      email.trim() &&
      company.trim() &&
      companySize &&
      problem.trim().length >= 30 &&
      urgency
    );
  }, [state, name, email, company, companySize, problem, urgency]);

  function toggleDataSource(value: string) {
    setDataSources((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});
    setServerError(null);
    setState("submitting");

    const payload: SolveSubmission = {
      name: name.trim(),
      email: email.trim(),
      company: company.trim(),
      role: role.trim() || undefined,
      companySize: (companySize || "1-50") as (typeof COMPANY_SIZES)[number],
      problem: problem.trim(),
      dataSources: dataSources as SolveSubmission["dataSources"],
      dataSourcesOther: dataSourcesOther.trim() || undefined,
      successSignal: successSignal.trim() || undefined,
      urgency: (urgency || "exploring") as (typeof URGENCIES)[number],
      additionalContext: additionalContext.trim() || undefined,
    };

    // Client-side validation (server re-validates).
    const parsed = solveSubmissionSchema.safeParse(payload);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        fieldErrors[issue.path.join(".") || "_root"] = issue.message;
      }
      setErrors(fieldErrors);
      setState("error");
      return;
    }

    try {
      const res = await fetch("/api/solve-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body?.error === "rate_limited") {
          setServerError(
            "Too many submissions from this address. Please wait a few minutes and try again.",
          );
        } else if (body?.error === "validation_failed" && Array.isArray(body.issues)) {
          const fieldErrors: Record<string, string> = {};
          for (const issue of body.issues as Array<{ path: string; message: string }>) {
            fieldErrors[issue.path || "_root"] = issue.message;
          }
          setErrors(fieldErrors);
        } else {
          setServerError(
            "We couldn't save your submission. Please try again, or email us at hello@agentdash.com.",
          );
        }
        setState("error");
        return;
      }
      setState("success");
    } catch (err) {
      console.error(err);
      setServerError(
        "Network error. Please try again or email hello@agentdash.com.",
      );
      setState("error");
    }
  }

  if (state === "success") {
    return (
      <div className="min-h-screen flex flex-col">
        <SolveNav />
        <main className="flex-1 flex items-center justify-center px-6 py-20">
          <div className="max-w-xl text-center">
            <div className="text-5xl mb-6">📨</div>
            <h1 className="text-3xl font-bold mb-4">Thanks — we got it.</h1>
            <p className="text-slate-400 leading-relaxed mb-8">
              We&apos;ll reach out within two business days. A copy of your
              submission has been emailed to <strong>{email}</strong> for your
              records.
            </p>
            <a
              href="/"
              className="inline-block bg-teal-500 hover:bg-teal-400 text-slate-950 font-semibold px-6 py-3 rounded-lg transition-colors"
            >
              Back to home
            </a>
          </div>
        </main>
        <SolveFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <SolveNav />

      <main className="flex-1 max-w-2xl w-full mx-auto px-6 py-12 md:py-20">
        <header className="mb-10">
          <h1 className="text-4xl md:text-5xl font-bold leading-tight mb-4">
            Tell us the <span className="text-teal-400">problem</span>.
          </h1>
          <p className="text-slate-400 text-lg leading-relaxed">
            We&apos;ll match it to the right AI agent recipe — what data it
            needs, how it works, and the guardrails. We respond within 2
            business days. Your problem statement is shared only with the
            AgentDash team.
          </p>
        </header>

        <form onSubmit={onSubmit} className="space-y-10" noValidate>
          {/* Section 1: Identity */}
          <Section title="About you">
            <Field label="Your name" error={errors.name} required>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={inputClass}
                autoComplete="name"
                required
              />
            </Field>

            <Field label="Email" error={errors.email} required>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                autoComplete="email"
                required
              />
            </Field>

            <Field label="Role" error={errors.role} hint="e.g. COO, Head of Ops">
              <input
                type="text"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className={inputClass}
                autoComplete="organization-title"
              />
            </Field>
          </Section>

          {/* Section 2: Company */}
          <Section title="Your company">
            <Field label="Company" error={errors.company} required>
              <input
                type="text"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                className={inputClass}
                autoComplete="organization"
                required
              />
            </Field>

            <Field label="Company size" error={errors.companySize} required>
              <select
                value={companySize}
                onChange={(e) => setCompanySize(e.target.value as typeof companySize)}
                className={inputClass}
                required
              >
                <option value="">Select…</option>
                {COMPANY_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s} people
                  </option>
                ))}
              </select>
            </Field>
          </Section>

          {/* Section 3: Problem */}
          <Section title="The problem">
            <Field
              label="What's the problem you'd like an agent to solve?"
              error={errors.problem}
              hint={`${problem.trim().length}/30 characters minimum — be specific. Example: "Review old SharePoint docs and pick the best ones to give new hires."`}
              required
            >
              <textarea
                value={problem}
                onChange={(e) => setProblem(e.target.value)}
                className={`${inputClass} min-h-32`}
                rows={5}
                required
              />
            </Field>

            <Field
              label="Where does the data live?"
              error={errors.dataSources}
              hint="Pick all that apply"
            >
              <div className="grid grid-cols-2 gap-2">
                {DATA_SOURCES.map((s) => (
                  <label
                    key={s}
                    className="flex items-center gap-2 px-3 py-2 rounded-md border border-slate-800 hover:border-slate-600 cursor-pointer text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={dataSources.includes(s)}
                      onChange={() => toggleDataSource(s)}
                      className="accent-teal-500"
                    />
                    {s}
                  </label>
                ))}
              </div>
              {dataSources.includes("Other") && (
                <input
                  type="text"
                  placeholder="Tell us more…"
                  value={dataSourcesOther}
                  onChange={(e) => setDataSourcesOther(e.target.value)}
                  className={`${inputClass} mt-3`}
                />
              )}
            </Field>

            <Field
              label="What signal would tell you this worked?"
              error={errors.successSignal}
              hint="e.g. '80% of recommended docs accepted by COO', or 'inbox triaged within 1 hour'"
            >
              <textarea
                value={successSignal}
                onChange={(e) => setSuccessSignal(e.target.value)}
                className={`${inputClass} min-h-20`}
                rows={3}
              />
            </Field>

            <Field label="Timeline" error={errors.urgency} required>
              <select
                value={urgency}
                onChange={(e) => setUrgency(e.target.value as typeof urgency)}
                className={inputClass}
                required
              >
                <option value="">Select…</option>
                {URGENCIES.map((u) => (
                  <option key={u} value={u}>
                    {URGENCY_LABELS[u]}
                  </option>
                ))}
              </select>
            </Field>
          </Section>

          {/* Section 4: Context */}
          <Section title="Anything else?">
            <Field
              label="Constraints, prior attempts, or anything else we should know"
              error={errors.additionalContext}
              hint="Optional"
            >
              <textarea
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                className={`${inputClass} min-h-24`}
                rows={4}
              />
            </Field>
          </Section>

          {serverError && (
            <div className="rounded-md border border-red-700 bg-red-950/40 px-4 py-3 text-sm text-red-200">
              {serverError}
            </div>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full md:w-auto bg-teal-500 hover:bg-teal-400 disabled:bg-slate-700 disabled:cursor-not-allowed text-slate-950 disabled:text-slate-500 font-bold px-8 py-3 rounded-lg text-lg transition-colors"
          >
            {state === "submitting" ? "Submitting…" : "Send it over"}
          </button>
        </form>
      </main>

      <SolveFooter />
    </div>
  );
}

// ── Reusable form bits ─────────────────────────────────────────────────────

const inputClass =
  "w-full bg-slate-900 border border-slate-800 focus:border-teal-500 focus:outline-none rounded-md px-3 py-2 text-slate-100 placeholder-slate-600 transition-colors";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold text-teal-400 border-b border-slate-800 pb-2">
        {title}
      </h2>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-slate-200 mb-1.5">
        {label} {required && <span className="text-red-400">*</span>}
      </span>
      {children}
      {hint && !error && (
        <span className="block text-xs text-slate-500 mt-1">{hint}</span>
      )}
      {error && (
        <span className="block text-xs text-red-400 mt-1">{error}</span>
      )}
    </label>
  );
}

function SolveNav() {
  return (
    <nav className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
      <a href="/" className="font-bold text-lg tracking-tight text-teal-400">
        AgentDash
      </a>
      <div className="flex items-center gap-6 text-sm text-slate-400">
        <a href="/pricing" className="hover:text-slate-100 transition-colors">
          Pricing
        </a>
        <a
          href={`${APP_URL}/signup`}
          className="bg-teal-500 hover:bg-teal-400 text-slate-950 font-semibold px-4 py-1.5 rounded-md transition-colors"
        >
          Get started
        </a>
      </div>
    </nav>
  );
}

function SolveFooter() {
  return (
    <footer className="border-t border-slate-800 px-6 py-6 flex items-center justify-between text-sm text-slate-500">
      <span>© {new Date().getFullYear()} AgentDash</span>
      <div className="flex gap-6">
        <a href="/pricing" className="hover:text-slate-300 transition-colors">
          Pricing
        </a>
        <a
          href="mailto:hello@agentdash.com"
          className="hover:text-slate-300 transition-colors"
        >
          Contact
        </a>
      </div>
    </footer>
  );
}
