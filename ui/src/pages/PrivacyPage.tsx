// AgentDash — PUBLIC Privacy Policy (/privacy). No auth, no sidebar, no company
// context. Mounted OUTSIDE CloudAccessGate in ui/src/App.tsx, the same public
// tier as /trial, /pricing, and /investors. Static (no scroll-reveal); built on
// the shared Porcelain legal layout in legal-shared.tsx.
//
// This is TEMPLATE content: a comprehensive, good-faith draft that reflects
// AgentDash's actual stack (Railway-hosted Postgres, Resend email, Stripe
// billing when enabled, third-party LLM inference providers, optional Sentry).
// It must be reviewed with legal counsel before anyone relies on it, and it
// carries a clearly-marked placeholder for the legal entity + registered
// address.

import {
  LegalPageShell,
  LegalSection,
  List,
  P,
  Placeholder,
  LEGAL_CONTACT_EMAIL,
} from "./legal-shared";

const CLAY = "var(--accent-500)";

// The subprocessor table — kept as data so it stays easy to maintain. Providers
// may change; this list is the current, maintained source of truth.
const SUBPROCESSORS: { name: string; purpose: string; location: string }[] = [
  {
    name: "Railway",
    purpose: "Cloud application hosting and managed PostgreSQL database",
    location: "United States",
  },
  {
    name: "Resend",
    purpose: "Transactional email (sign-in, invites, notifications)",
    location: "United States",
  },
  {
    name: "Stripe",
    purpose: "Payment processing and subscription billing (when billing is enabled)",
    location: "United States",
  },
  {
    name: "LLM inference providers (e.g. MiniMax, Google (Gemini), and/or OpenRouter / Fireworks)",
    purpose:
      "Power the Chief of Staff and agents — your prompts and submitted content are processed by the selected model provider to generate responses",
    location: "United States / global, depending on provider",
  },
  {
    name: "Sentry (if enabled)",
    purpose: "Error monitoring and application diagnostics",
    location: "United States",
  },
];

export function PrivacyPage() {
  return (
    <LegalPageShell
      eyebrow="Legal"
      title="Privacy Policy"
      intro={
        <>
          This Privacy Policy explains what information AgentDash collects, how we
          use it, who we share it with, and the choices you have. It applies to
          the AgentDash product and website.
        </>
      }
    >
      <LegalSection title="1. Who we are">
        <P>
          AgentDash is a CoS-led, multi-human AI workspace where autonomous AI
          agents perform real work. The legal entity responsible for your
          information is{" "}
          <Placeholder>[Legal entity &amp; registered address — to be completed]</Placeholder>.
          References to &ldquo;AgentDash,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; and
          &ldquo;our&rdquo; mean that entity.
        </P>
        <P>
          This policy covers the information we process when you create an
          account, use the product, or interact with our public website.
        </P>
      </LegalSection>

      <LegalSection title="2. Data we collect">
        <P>We collect the following categories of information:</P>
        <List
          items={[
            <>
              <strong className="text-foreground">Account data</strong> — your name,
              email address, and a securely hashed password handled by our
              authentication system (we never store your password in plain text).
            </>,
            <>
              <strong className="text-foreground">Workspace and company content</strong>{" "}
              — the companies, workspaces, projects, tasks, documents, and other
              content you create in the product.
            </>,
            <>
              <strong className="text-foreground">Agent conversations and task data</strong>{" "}
              — the messages you exchange with the Chief of Staff and agents, and the
              inputs and outputs of the tasks agents perform on your behalf.
            </>,
            <>
              <strong className="text-foreground">Subscription and billing data</strong>{" "}
              — plan, seat count, and billing records, processed through our payment
              provider when billing is enabled.
            </>,
            <>
              <strong className="text-foreground">Technical and log data</strong> — IP
              address, device and browser information, and usage and diagnostic logs
              generated as you use the service.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection title="3. How we use your information">
        <P>We use the information we collect to:</P>
        <List
          items={[
            "Provide, operate, and maintain the service;",
            "Run the AI agents and produce the work you ask them to perform;",
            "Process subscriptions, billing, and payments (when billing is enabled);",
            "Secure the service, prevent abuse, and protect our users;",
            "Provide customer support and respond to your requests;",
            "Improve and develop our products and features.",
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Subprocessors">
        <P>
          We rely on a small set of trusted third-party providers (subprocessors)
          to operate the service. Providers may change over time; the current list
          is maintained here.
        </P>
        <div
          className="overflow-x-auto rounded-2xl border border-border bg-card"
          style={{ marginTop: 16 }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Provider", "Purpose", "Location"].map((h) => (
                  <th
                    key={h}
                    className="text-muted-foreground"
                    style={{
                      textAlign: "left",
                      fontSize: 11.5,
                      fontWeight: 800,
                      padding: "12px 16px",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSORS.map((s, idx) => (
                <tr
                  key={s.name}
                  style={{
                    borderTop: idx === 0 ? undefined : "1px solid var(--border)",
                    background:
                      idx % 2 === 1
                        ? "color-mix(in oklab, var(--secondary) 40%, transparent)"
                        : undefined,
                  }}
                >
                  <td className="text-foreground" style={{ fontSize: 13, fontWeight: 600, padding: "12px 16px", verticalAlign: "top" }}>
                    {s.name}
                  </td>
                  <td className="text-muted-foreground" style={{ fontSize: 13, lineHeight: 1.5, padding: "12px 16px", verticalAlign: "top" }}>
                    {s.purpose}
                  </td>
                  <td className="text-muted-foreground" style={{ fontSize: 13, padding: "12px 16px", verticalAlign: "top" }}>
                    {s.location}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LegalSection>

      <LegalSection title="5. AI processing of your content">
        <P>
          AgentDash is an AI product. Content you submit — your prompts, messages,
          documents, and task inputs — is sent to third-party large language model
          (LLM) providers so the Chief of Staff and agents can generate output. By
          using the service you direct us to send that content to the selected
          model provider for processing.
        </P>
        <P>
          Please do not submit anything you are not permitted to share with those
          processors. You are responsible for ensuring you have the right to
          provide the content you submit.
        </P>
      </LegalSection>

      <LegalSection title="6. Cookies">
        <P>
          We use essential authentication and session cookies only — they keep you
          signed in and the product working. We do not use third-party advertising
          or cross-site ad-tracking cookies.
        </P>
      </LegalSection>

      <LegalSection title="7. How we share information">
        <P>
          We do not sell your personal data. We share information only with the
          subprocessors listed above to operate the service, where required by law
          or legal process, or in connection with a corporate transaction (such as
          a merger or acquisition) subject to this policy.
        </P>
      </LegalSection>

      <LegalSection title="8. Data retention">
        <P>
          We keep your information for as long as your account is active and as
          needed to provide the service. We may retain certain records longer where
          required for legal, tax, accounting, or billing purposes, or to resolve
          disputes and enforce our agreements.
        </P>
      </LegalSection>

      <LegalSection title="9. Your rights">
        <P>
          Depending on where you live, you may have the right to access, correct,
          delete, or export your personal data, and to object to or restrict
          certain processing. To exercise any of these rights, contact us at{" "}
          <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: CLAY, fontWeight: 600 }}>
            {LEGAL_CONTACT_EMAIL}
          </a>
          . We will respond consistent with applicable law.
        </P>
      </LegalSection>

      <LegalSection title="10. Security">
        <P>
          We protect your data in transit using TLS encryption and host the
          service on managed, reputable cloud infrastructure. No system is
          perfectly secure, but we take reasonable technical and organizational
          measures to protect your information.
        </P>
      </LegalSection>

      <LegalSection title="11. International users and US hosting">
        <P>
          AgentDash is hosted in the United States. If you access the service from
          outside the United States, you understand that your information will be
          transferred to, stored, and processed in the United States and other
          countries where our subprocessors operate.
        </P>
      </LegalSection>

      <LegalSection title="12. Children">
        <P>
          AgentDash is not directed to children. The service is intended for users
          who are at least 18 years old, and we do not knowingly collect personal
          information from anyone under 18.
        </P>
      </LegalSection>

      <LegalSection title="13. Changes to this policy">
        <P>
          We may update this Privacy Policy from time to time. When we make
          material changes, we will update the &ldquo;Last updated&rdquo; date above
          and, where appropriate, notify you. Your continued use of the service
          after an update means you accept the revised policy.
        </P>
      </LegalSection>

      <LegalSection title="14. Contact us">
        <P>
          If you have questions about this Privacy Policy or how we handle your
          data, contact us at{" "}
          <a href={`mailto:${LEGAL_CONTACT_EMAIL}`} style={{ color: CLAY, fontWeight: 600 }}>
            {LEGAL_CONTACT_EMAIL}
          </a>
          .
        </P>
      </LegalSection>
    </LegalPageShell>
  );
}

export default PrivacyPage;
