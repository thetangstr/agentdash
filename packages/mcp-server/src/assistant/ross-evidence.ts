import { PaperclipApiError, type PaperclipApiClient } from '../client.js';
import { redactAssistantValue } from './redact.js';
import type { IssueRow } from './resolve.js';

const keys = ['lead-report', 'ross-commitments', 'ross-outcome-checks', 'ross-review', 'ross-context'] as const;
// Only these keys mark an issue as part of a Ross loop. A bare `lead-report`
// is too generic to justify extra reads on every customer's task.
const rossSpecificKeys = new Set<string>(['ross-commitments', 'ross-outcome-checks', 'ross-review', 'ross-context']);
// Fixed refusal reasons thrown below; anything else is reported generically.
const knownReasons = new Set(['scoped source issue required', 'scoped project required', 'scoped document required', 'source visibility changed', 'source revision changed', 'source lead changed']);
const bodyLimit = 6000;
interface Summary { key: string; latestRevisionId?: string | null }
interface SourceIssue extends IssueRow { documentSummaries?: Summary[] }
interface Project { id: string; companyId: string; leadAgentId?: string | null }
interface Document {
  id: string; companyId: string; issueId: string; key: string; body: string;
  latestRevisionId: string; latestRevisionNumber: number;
  updatedByAgentId: string | null; updatedByUserId: string | null; updatedAt: string;
}
function age(at: string, observed: number) {
  const timestamp = Date.parse(at);
  if (!Number.isFinite(timestamp)) return { state: 'unknown', ageMinutes: null };
  const minutes = (observed - timestamp) / 60_000;
  return { state: minutes < 0 ? 'future' : minutes > 60 ? 'stale' : 'current', ageMinutes: Math.max(0, Math.floor(minutes)) };
}
function bodyForAssistant(body: string) {
  // Typed documents stay source content. Redact nested forbidden keys as well
  // as secret-shaped strings; never adopt JSON claims as our own verification.
  try { return JSON.stringify(redactAssistantValue(JSON.parse(body))); }
  catch { return redactAssistantValue(body); }
}
function sameIssue(row: SourceIssue, issue: SourceIssue, companyId: string) {
  return row?.id === issue.id && row.companyId === companyId && row.projectId === issue.projectId;
}

export function hasRossSources(issue: SourceIssue) {
  return (issue.documentSummaries ?? []).some(summary => rossSpecificKeys.has(summary.key));
}

// AgentDash: get_work_item must keep working for every customer. Ross source
// reads run only on Ross-marked issues, and a Ross scope/revision failure is
// reported as unavailable evidence (never partial source content) instead of
// refusing the whole task read.
export async function collectRossEvidenceForWorkItem(client: PaperclipApiClient, companyId: string, issue: SourceIssue) {
  if (!hasRossSources(issue)) return null;
  try { return { status: 'ok' as const, ...(await collectRossEvidence(client, companyId, issue)) }; }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason = knownReasons.has(message) ? message : error instanceof PaperclipApiError ? `source read failed (${error.status})` : 'source read failed';
    return { status: 'unavailable' as const, reason, documents: [], truncated: false, independentlyRechecked: false, businessOutcomeVerified: false };
  }
}

// AgentDash: reusable read projection for any personal assistant. Authority is
// the existing MCP client's consenting user, company pin and project visibility.
export async function collectRossEvidence(client: PaperclipApiClient, companyId: string, issue: SourceIssue) {
  if (!sameIssue(issue, issue, companyId)) throw Error('scoped source issue required');
  const observedAt = new Date().toISOString();
  const summaries = issue.documentSummaries ?? [];
  const selected = keys.filter(key => summaries.some(summary => summary.key === key));
  const documents = [], missing: string[] = [];
  const projectPath = issue.projectId ? `/projects/${encodeURIComponent(issue.projectId)}` : null;
  const project = selected.length && projectPath ? await client.requestJson<Project>('GET', projectPath) : null;
  if (project && (project.id !== issue.projectId || project.companyId !== companyId)) throw Error('scoped project required');
  for (const key of selected) {
    const path = `/issues/${encodeURIComponent(issue.id)}/documents/${key}`;
    let document: Document;
    try { document = await client.requestJson<Document>('GET', path); }
    catch (error) {
      if (error instanceof PaperclipApiError && error.status === 404) { missing.push(key); continue; }
      throw error;
    }
    if (!document || document.companyId !== companyId || document.issueId !== issue.id || document.key !== key || typeof document.body !== 'string' || typeof document.latestRevisionId !== 'string' || !document.latestRevisionId || !Number.isInteger(document.latestRevisionNumber) || document.latestRevisionNumber < 1) throw Error('scoped document required');
    const body = bodyForAssistant(document.body), truncated = body.length > bodyLimit;
    const freshness = age(document.updatedAt, Date.parse(observedAt));
    const designatedLeadAuthored = !!project?.leadAgentId && document.updatedByAgentId === project.leadAgentId && document.updatedByUserId === null;
    documents.push({
      key, documentId: document.id, revisionId: document.latestRevisionId, revisionNumber: document.latestRevisionNumber,
      body: body.slice(0, bodyLimit), truncated, bodyPresentation: 'redacted-source-text',
      authorAgentId: document.updatedByAgentId, authorUserId: document.updatedByUserId, recordedAt: document.updatedAt, freshness,
      designatedLeadAuthored, usableAsCurrentLeadReport: key === 'lead-report' && designatedLeadAuthored && freshness.state === 'current' && !truncated,
      operatorAuthored: document.updatedByAgentId === null && typeof document.updatedByUserId === 'string' && !!document.updatedByUserId.trim(),
      sourceKind: 'untrusted-source-content', sourceUrl: `${client.appBaseUrl}/api${path}`,
    });
  }
  // Subordinate document routes are company-only today. Recheck the project-
  // visible parent before returning any source. These reads are not atomic.
  if (selected.length) {
    const current = await client.requestJson<SourceIssue>('GET', `/issues/${encodeURIComponent(issue.id)}`);
    if (!sameIssue(current, issue, companyId)) throw Error('source visibility changed');
    for (const document of documents) {
      const latest = current.documentSummaries?.find(summary => summary.key === document.key);
      if (!latest || (latest.latestRevisionId && latest.latestRevisionId !== document.revisionId)) throw Error('source revision changed');
    }
    if (projectPath) {
      const currentProject = await client.requestJson<Project>('GET', projectPath);
      if (currentProject.id !== project?.id || currentProject.companyId !== companyId || currentProject.leadAgentId !== project?.leadAgentId) throw Error('source lead changed');
    }
  }
  return { observedAt, documents, missing, coverage: selected.length ? 'advertised-ross-sources-only' : 'no-ross-sources-advertised',
    truncated: documents.some(document => document.truncated), independentlyRechecked: false, businessOutcomeVerified: false,
    consistency: 'sequential-reads-with-parent-and-lead-recheck',
    qualification: 'Reports, commitments, operator checks, Ross reviews and operating context are attributed source content. This read does not independently verify their claims, approve artifacts, close tasks, grant permissions, infer model or role authority from document bodies, or expose private Ross memory.' };
}
