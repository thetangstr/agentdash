// AgentDash: ProjectStoredCard — list of past project assessments shown
// underneath the mode chooser when any exist.
import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2, RotateCcw } from "lucide-react";
import { assessApi, type ProjectAssessmentSummary } from "../../api/assess";
import { MarkdownBody } from "../../components/MarkdownBody";
import { Button } from "../../marketing/components/Button";
import { Eyebrow } from "../../marketing/components/Eyebrow";

export interface ProjectStoredListProps {
  companyId: string;
  companyName: string;
  projects: ProjectAssessmentSummary[];
  onRunNew: () => void;
}

export function ProjectStoredList({
  companyId,
  companyName,
  projects,
  onRunNew,
}: ProjectStoredListProps) {
  if (projects.length === 0) return null;

  return (
    <div style={{ marginTop: 32 }}>
      <div className="mkt-assess__results-head">
        <div>
          <Eyebrow>Past project assessments — {projects.length}</Eyebrow>
          <h2 className="mkt-display-section" style={{ fontSize: 24, marginTop: 8 }}>
            {companyName} · project library
          </h2>
        </div>
        <div className="mkt-assess__results-actions">
          <Button variant="ghost" onClick={onRunNew}>
            <RotateCcw size={14} strokeWidth={1.75} aria-hidden /> Run another
          </Button>
        </div>
      </div>
      <div style={{ display: "grid", gap: 12 }}>
        {projects.map((p) => (
          <ProjectStoredCard
            key={p.slug}
            companyId={companyId}
            companyName={companyName}
            project={p}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectStoredCard({
  companyId,
  companyName,
  project,
}: {
  companyId: string;
  companyName: string;
  project: ProjectAssessmentSummary;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (markdown !== null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await assessApi.getProject(companyId, project.slug);
      setMarkdown(res.markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load project");
    } finally {
      setLoading(false);
    }
  };

  const downloadDocx = async () => {
    if (!markdown) {
      // Force-load before download
      try {
        const res = await assessApi.getProject(companyId, project.slug);
        setMarkdown(res.markdown);
        await fetchDocxAndSave(companyId, project.projectName, companyName, res.markdown);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load project");
      }
      return;
    }
    try {
      await fetchDocxAndSave(companyId, project.projectName, companyName, markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Docx download failed");
    }
  };

  return (
    <div className="mkt-assess__card" style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={toggle}
          style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            background: "transparent", border: "none", cursor: "pointer",
            fontFamily: "var(--mkt-font-serif)", fontSize: 18, color: "var(--mkt-ink)",
            textAlign: "left", padding: 0,
          }}
        >
          {expanded
            ? <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
            : <ChevronRight size={16} strokeWidth={1.75} aria-hidden />}
          <span>{project.projectName}</span>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: "var(--mkt-font-mono)", fontSize: 11, color: "var(--mkt-ink-soft)" }}>
            {new Date(project.createdAt).toLocaleDateString()}
          </span>
          <Button variant="link" onClick={toggle}>
            {expanded ? "Hide" : "View"}
          </Button>
          <Button variant="link" onClick={downloadDocx}>
            Download .docx
          </Button>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 16 }}>
          {loading && (
            <div className="mkt-assess__loading">
              <Loader2 size={14} className="mkt-assess__spin" />
              <span>Loading…</span>
            </div>
          )}
          {error && <div className="mkt-assess__error">{error}</div>}
          {markdown && (
            <div className="mkt-assess__report">
              <MarkdownBody>{markdown}</MarkdownBody>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function fetchDocxAndSave(
  companyId: string,
  projectName: string,
  companyName: string,
  markdown: string,
): Promise<void> {
  const { blob, filename } = await assessApi.downloadProjectDocx(companyId, {
    markdown, projectName, companyName,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
