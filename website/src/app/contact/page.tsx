"use client";

import { useState, type FormEvent } from "react";
import { brand } from "@/config/branding";

const interestOptions = [
  "Request a Demo",
  "Start Free Trial",
  "Enterprise Inquiry",
  "General Question",
];

export default function ContactPage() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    interest: "",
    message: "",
  });
  const [submitted, setSubmitted] = useState(false);

  function handleChange(
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  return (
    <>
      {/* ── Header ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-6 pt-28 pb-16 text-center">
        <h1 className="text-4xl font-bold tracking-tight text-text-primary">
          Get in touch
        </h1>
        <p className="mt-4 text-lg text-text-secondary max-w-2xl mx-auto">
          Request a demo, ask a question, or start your free trial.
        </p>
      </section>

      {/* ── Two-column Layout ────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-6 pb-24">
        <div className="grid gap-16 lg:grid-cols-2">
          {/* ── Left: Contact Form ───────────────────────────────── */}
          <div>
            {submitted ? (
              <div className="rounded-xl border border-brand-200 bg-brand-50 p-8 text-center">
                <svg
                  className="mx-auto h-12 w-12 text-brand-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <h3 className="mt-4 text-lg font-semibold text-text-primary">
                  Message sent!
                </h3>
                <p className="mt-2 text-sm text-text-secondary">
                  Thanks for reaching out. We&apos;ll get back to you within one
                  business day.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                {/* Name */}
                <div>
                  <label
                    htmlFor="name"
                    className="block text-sm font-medium text-text-primary"
                  >
                    Name
                  </label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    required
                    value={form.name}
                    onChange={handleChange}
                    className="mt-1.5 block w-full rounded-lg border border-border bg-white px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    placeholder="Your name"
                  />
                </div>

                {/* Email */}
                <div>
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-text-primary"
                  >
                    Email
                  </label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    required
                    value={form.email}
                    onChange={handleChange}
                    className="mt-1.5 block w-full rounded-lg border border-border bg-white px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    placeholder="you@company.com"
                  />
                </div>

                {/* Company */}
                <div>
                  <label
                    htmlFor="company"
                    className="block text-sm font-medium text-text-primary"
                  >
                    Company
                  </label>
                  <input
                    id="company"
                    name="company"
                    type="text"
                    value={form.company}
                    onChange={handleChange}
                    className="mt-1.5 block w-full rounded-lg border border-border bg-white px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    placeholder="Company name"
                  />
                </div>

                {/* Interest */}
                <div>
                  <label
                    htmlFor="interest"
                    className="block text-sm font-medium text-text-primary"
                  >
                    Interest
                  </label>
                  <select
                    id="interest"
                    name="interest"
                    required
                    value={form.interest}
                    onChange={handleChange}
                    className="mt-1.5 block w-full rounded-lg border border-border bg-white px-4 py-2.5 text-sm text-text-primary focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  >
                    <option value="" disabled>
                      Select an option
                    </option>
                    {interestOptions.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Message */}
                <div>
                  <label
                    htmlFor="message"
                    className="block text-sm font-medium text-text-primary"
                  >
                    Message
                  </label>
                  <textarea
                    id="message"
                    name="message"
                    rows={5}
                    value={form.message}
                    onChange={handleChange}
                    className="mt-1.5 block w-full rounded-lg border border-border bg-white px-4 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-none"
                    placeholder="Tell us how we can help..."
                  />
                </div>

                {/* Submit */}
                <button
                  type="submit"
                  className="w-full rounded-lg bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
                >
                  Send Message
                </button>
              </form>
            )}
          </div>

          {/* ── Right: Contact Info ──────────────────────────────── */}
          <div className="space-y-8 lg:pt-2">
            {/* Email */}
            <div>
              <h3 className="text-sm font-semibold text-text-primary">Email us</h3>
              <p className="mt-2 text-sm text-text-secondary">
                Reach our team directly at{" "}
                <a
                  href={`mailto:${brand.email}`}
                  className="font-medium text-brand-600 hover:text-brand-700 transition-colors"
                >
                  {brand.email}
                </a>
              </p>
            </div>

            {/* Schedule a call */}
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                Schedule a call
              </h3>
              <p className="mt-2 text-sm text-text-secondary">
                Prefer a live conversation?{" "}
                <a
                  href="#"
                  className="font-medium text-brand-600 hover:text-brand-700 transition-colors"
                >
                  Book a 30-minute call
                </a>{" "}
                with our team.
              </p>
            </div>

            {/* Community */}
            <div>
              <h3 className="text-sm font-semibold text-text-primary">
                Join our community
              </h3>
              <p className="mt-2 text-sm text-text-secondary">
                Connect with other {brand.name} users and the core team on{" "}
                <a
                  href="#"
                  className="font-medium text-brand-600 hover:text-brand-700 transition-colors"
                >
                  Discord
                </a>
                .
              </p>
            </div>

            {/* Response time */}
            <div className="rounded-xl border border-border bg-surface-secondary p-6">
              <p className="text-sm text-text-secondary">
                We typically respond within one business day. For urgent issues,
                Enterprise customers can reach our dedicated support line for
                guaranteed SLA response times.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
