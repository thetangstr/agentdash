import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { ADMIN_POWERS_UPDATE as UPDATE, ADMIN_POWERS_SOURCES, isUpdatePublished } from "../content/updates";
import { useDocumentMeta } from "../hooks/useDocumentMeta";
import "./WhatsNew.css";

const changes = [
  ["Change many records, with a preview", "Select tasks, approvals waiting on you, agents, routines or labels and change them together. The preview shows each record's before and after, and nothing changes until you apply it. Each record passes the same permission check as changing it by hand, so a batch never does what you could not do one record at a time. Up to 200 records per batch."],
  ["Honest results, record by record", "Every record ends as changed, changed but not as previewed, not changed with the reason, failed, or unknown. Unknown means it was sent and no answer came back; it is never retried by itself. A record that changed after the preview is left alone."],
  ["An audit page for owners and admins", "See who did what, filtered by person, action and dates, and export up to 50,000 rows as CSV. It shows only what the same person could already see in Activity, and every export is recorded."],
  ["Ceiling templates", "Where agent ceilings are available, name a ceiling once and apply it to many agents, with a preview of what each agent gains and loses. A company can also choose the ceiling every new agent starts with."],
  ["Steward hand-over, routines and labels", "Removing a member now lets you choose who takes over each agent they looked after. Routines can be deleted for good, keeping their past runs and history. Labels can be renamed and recolored in Company Settings."],
  ["Batch changes from your own Claude, off by default", "An owner or admin who turns this on can ask their connected Claude to prepare a batch. Claude can only prepare it: the confirm code appears only on an AgentDash page in the admin's own browser. It has been tested against AgentDash's own test client and reviewed, but it has not yet been tried with Claude.ai itself."],
];

/** AgentDash: /whats-new/admin-powers. Until its release is published, a short not-yet page. */
export function AdminPowersUpdate({ published }: { published?: readonly string[] }) {
  const live = isUpdatePublished(UPDATE, published);
  useDocumentMeta(live ? `${UPDATE.title} · AgentDash` : "Update not published yet · AgentDash", live ? UPDATE.summary : "This AgentDash update appears once its release is published.");
  if (!live) {
    return <MarketingShell><SectionContainer padding="hero"><div className="mkt-updates__intro" data-update-not-published><Eyebrow>Product updates</Eyebrow><h1 className="mkt-display-page">Not published yet.</h1><p className="mkt-body-lg">This update appears here once its release is published.</p><p><a href="/whats-new">All updates <span aria-hidden>→</span></a></p></div></SectionContainer></MarketingShell>;
  }
  return <MarketingShell><article className="mkt-admin-powers-update">
    <SectionContainer padding="hero"><a className="mkt-updates__back" href="/whats-new">← All updates</a><div className="mkt-updates__intro mkt-updates__intro--article"><Eyebrow>Admin powers · November 10, 2026</Eyebrow><h1 className="mkt-display-page">{UPDATE.title}</h1><p className="mkt-body-lg">Owners and admins run the company. This update lets them change many records in one step, see exactly what each step did, and look back at who did what. Since v2026.1110.1, bulk changes are for owners and admins only; everyone else changes records one at a time, as before.</p><p className="mkt-updates__versions">{UPDATE.versions.join(" + ")}</p></div></SectionContainer>
    <SectionContainer background="cream-2" id="what-changed"><div className="mkt-update-notes__intro"><Eyebrow>What changed</Eyebrow><h2 className="mkt-display-section">What is new in v2026.1110.0.</h2></div><div className="mkt-update-notes__grid">{changes.map(([title, text]) => <section key={title}><h3>{title}</h3><p>{text}</p></section>)}</div></SectionContainer>
    <SectionContainer id="availability"><div className="mkt-update-sources"><Eyebrow>Availability</Eyebrow><h2 className="mkt-display-section">Read the guide, then upgrade.</h2><p>Availability depends on the version your operator has installed. Four database migrations run on upgrade, and on a large installation one of them briefly holds up writes; the release notes say how to avoid that. The switches for admin reads and for batch changes from Claude stay off until an owner or admin turns them on.</p><ul>{ADMIN_POWERS_SOURCES.map(source => <li key={source.href}><a href={source.href}>{source.label} <span aria-hidden>→</span></a></li>)}</ul></div></SectionContainer>
  </article></MarketingShell>;
}
