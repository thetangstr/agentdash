import { useParams } from "@/lib/router";
import { MarketingShell } from "../MarketingShell";
import { SectionContainer } from "../components/SectionContainer";
import { Eyebrow } from "../components/Eyebrow";
import { Button } from "../components/Button";
import {
  RELEASES_PATH,
  findPublishedReleaseNote,
  formatReleaseDate,
  githubReleaseUrl,
  listPublishedReleaseNotes,
  releaseSummary,
} from "../content/releases";
import { useDocumentMeta } from "../hooks/useDocumentMeta";
import type { ReleaseNote } from "@/lib/release-notes";
import "./WhatsNew.css";
import "./Releases.css";

function describe(note: ReleaseNote | null): [string, string] {
  if (!note) return ["Release not found · AgentDash", "This AgentDash release has no published notes."];
  const date = note.releasedAt ? formatReleaseDate(note.releasedAt) : null;
  return [
    `${note.version} release notes · AgentDash`,
    `What changed in AgentDash ${note.version}${date ? `, released ${date}` : ""}: the public release notes and a link to the GitHub Release.`,
  ];
}

/**
 * AgentDash: /releases/:version. An unknown version, or one whose GitHub
 * Release is not published, gets the marketing not-found page.
 */
export function Release({ version, notes = listPublishedReleaseNotes() }: { version?: string; notes?: readonly ReleaseNote[] }) {
  const note = findPublishedReleaseNote(version, notes);
  const [title, description] = describe(note);
  useDocumentMeta(title, description);
  if (!note) return <ReleaseNotFound />;

  const date = note.releasedAt ? formatReleaseDate(note.releasedAt) : null;
  const summary = releaseSummary(note);
  const github = githubReleaseUrl(note.version);
  return (
    <MarketingShell>
      <article className="mkt-release" data-release={note.version}>
        <SectionContainer padding="hero">
          <a className="mkt-updates__back" href={RELEASES_PATH}>← All release notes</a>
          <div className="mkt-updates__intro mkt-updates__intro--article">
            <Eyebrow>{date ? `Release notes · ${date}` : "Release notes"}</Eyebrow>
            <h1 className="mkt-display-page">{note.version}</h1>
            {summary ? <p className="mkt-body-lg">{summary}</p> : null}
            <p className="mkt-release__github">
              <a href={github} target="_blank" rel="noreferrer">
                {note.version} on GitHub <span aria-hidden>↗</span>
              </a>
            </p>
          </div>
        </SectionContainer>
        <SectionContainer id="notes">
          {note.sections.length > 0 ? (
            <div className="mkt-release__sections">
              {note.sections.map((section, sectionIndex) => (
                <section key={`${sectionIndex}-${section.title}`} className="mkt-release__section">
                  <h2>{section.title}</h2>
                  <ul>
                    {section.items.map((item, index) => (
                      <li key={`${index}-${item}`}>{item}</li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="mkt-release__empty">
              This release has no public summary here. Its full notes are on the{" "}
              <a href={github} target="_blank" rel="noreferrer">GitHub Release</a>.
            </p>
          )}
        </SectionContainer>
        <SectionContainer background="cream-2">
          <div className="mkt-update-sources">
            <Eyebrow>Availability</Eyebrow>
            <p>
              Availability depends on the version your operator has installed. Publication does not upgrade every
              instance. These notes leave out internal detail; the GitHub Release carries the complete notes and the
              release assets.
            </p>
            <div className="mkt-update-sources__cta">
              <Button href={github}>View the GitHub Release</Button>
              <Button href={RELEASES_PATH} variant="ghost">All release notes</Button>
            </div>
          </div>
        </SectionContainer>
      </article>
    </MarketingShell>
  );
}

function ReleaseNotFound() {
  return (
    <MarketingShell>
      <SectionContainer padding="hero">
        <div className="mkt-updates__intro" data-release-not-found>
          <Eyebrow>Release notes</Eyebrow>
          <h1 className="mkt-display-page">Release not found.</h1>
          <p className="mkt-body-lg">
            There are no published notes at this address. A release appears here once its GitHub Release is published.
          </p>
          <p><a href={RELEASES_PATH}>All release notes <span aria-hidden>→</span></a></p>
        </div>
      </SectionContainer>
    </MarketingShell>
  );
}

/** The route element: reads the version from the URL. */
export function ReleaseRoute() {
  const { version } = useParams<{ version: string }>();
  return <Release version={version} />;
}
