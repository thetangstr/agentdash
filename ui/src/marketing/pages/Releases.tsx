import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import {
  countReleaseItems,
  formatReleaseDate,
  listPublishedReleaseNotes,
  releasePath,
  releaseSummary,
} from "../content/releases";
import { useDocumentMeta } from "../hooks/useDocumentMeta";
import type { ReleaseNote } from "@/lib/release-notes";
import "./WhatsNew.css";
import "./Releases.css";

/** AgentDash: /releases, every published release, newest first. */
export function Releases({ notes = listPublishedReleaseNotes() }: { notes?: readonly ReleaseNote[] }) {
  useDocumentMeta(
    "Release notes · AgentDash",
    "Every published AgentDash release, newest first: what changed, what administrators need to know, and how to upgrade.",
  );
  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="mkt-updates__intro">
          <Eyebrow>Release notes</Eyebrow>
          <h1 className="mkt-display-page">Release notes.</h1>
          <p className="mkt-body-lg">
            Every published AgentDash release, newest first. Each page is the public part of the notes behind that
            release on GitHub.
          </p>
          <p className="mkt-releases__aside">
            The bigger changes, explained: <a href="/whats-new">What’s new</a>. Availability on your instance depends on
            the version your operator has installed.
          </p>
        </div>
        {notes.length === 0 ? (
          <p className="mkt-releases__empty">No published releases yet.</p>
        ) : (
          <ol className="mkt-releases__list" aria-label="Published releases">
            {notes.map((note) => {
              const summary = releaseSummary(note);
              const count = countReleaseItems(note);
              return (
                <li key={note.version} className="mkt-update-entry mkt-release-entry" data-release={note.version}>
                  <div className="mkt-update-entry__date">
                    {note.releasedAt ? <time dateTime={note.releasedAt}>{formatReleaseDate(note.releasedAt)}</time> : null}
                    <span>{count === 0 ? "Notes on GitHub" : `${count} ${count === 1 ? "change" : "changes"}`}</span>
                  </div>
                  <div className="mkt-update-entry__body">
                    <h2 className="mkt-release-entry__title">
                      <a href={releasePath(note.version)}>{note.version}</a>
                    </h2>
                    {summary ? (
                      <p className="mkt-release-entry__summary">{summary}</p>
                    ) : (
                      <p className="mkt-release-entry__summary">No public summary for this release.</p>
                    )}
                    {note.sections.length > 0 ? (
                      <p className="mkt-updates__versions">{note.sections.map((section) => section.title).join(" · ")}</p>
                    ) : null}
                    <a className="mkt-update-entry__link" href={releasePath(note.version)}>
                      Read the notes <span aria-hidden>→</span>
                    </a>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </SectionContainer>
    </MarketingShell>
  );
}
