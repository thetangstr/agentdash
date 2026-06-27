// AgentDash (Test Drive): client for the PUBLIC, token-based anonymous trial
// API (Slice 1 backend, server/src/routes/trial.ts). No auth — the trial token
// is the only credential. See docs/.../2026-06-27-test-drive-no-signup-trial.md.

import { api } from "./client";

/** A single touch in Scout's outreach sequence. */
export type TrialOutreachTouch = {
  day: number;
  channel: string;
  subject?: string;
  body: string;
};

/** Structured content for the sales_outreach hero task. */
export type TrialOutreachContent = {
  summary: string;
  touches: TrialOutreachTouch[];
  tips: string[];
};

export type TrialArtifact = {
  title: string;
  content: TrialOutreachContent;
};

/** Artifact as persisted + returned by GET /:token. */
export type TrialStoredArtifact = TrialArtifact & {
  id: string;
  useCase: string;
  createdAt: string;
};

export type TrialSessionCreated = {
  token: string;
  expiresAt: string;
  creditCents: number;
};

export type TrialRunResult = {
  artifact: TrialStoredArtifact;
  creditRemainingCents: number;
  spentCents: number;
  creditCents: number;
};

export type TrialSnapshot = {
  session: {
    creditCents: number;
    spentCents: number;
    creditRemainingCents: number;
    expiresAt: string;
  };
  artifacts: TrialStoredArtifact[];
};

export type TrialUseCase = "sales_outreach";

export type TrialRunInput = {
  icp: string;
  senderContext?: string;
};

/** Result of sharing an artifact (Slice 3). */
export type TrialShareResult = {
  shareUrl: string;
  shareToken: string;
};

/** PUBLIC, read-only shared artifact resolved by share token (Slice 3). */
export type TrialSharedArtifact = {
  title: string;
  content: TrialOutreachContent;
  useCase: string;
  createdAt: string;
  agentName?: string;
};

/** Result of claiming a trial on signup (Slice 4). */
export type TrialClaimResult = {
  companyId: string;
  companyPrefix?: string;
};

// ---------------------------------------------------------------------------
// Autonomous company (Test Drive v2) — the CoS designs + staffs a whole team,
// each agent runs its first task and produces a real markdown deliverable.
// ---------------------------------------------------------------------------

/** What the user tells the Chief of Staff during intake. */
export type TrialIntake = {
  whatYouDo: string;
  goal: string;
  blocker?: string;
};

/** Lifecycle status of a designed agent (mirrors the backend agent status). */
export type TrialAgentStatus = string;

/** The company the CoS designs for you. */
export type TrialCompanyMeta = {
  name: string;
  mission: string;
};

/** An agent as returned by POST /design — freshly hired, not yet run. */
export type TrialDesignedAgent = {
  id: string;
  ref: string;
  name: string;
  role: string;
  category: string;
  charter: string;
  firstTaskTitle: string;
  firstTaskBrief?: string;
  status: TrialAgentStatus;
};

/** Result of POST /:token/design. */
export type TrialDesignResult = {
  company: TrialCompanyMeta;
  agents: TrialDesignedAgent[];
  creditRemainingCents: number;
  spentCents: number;
  creditCents: number;
};

/** A markdown deliverable produced by one agent's first task. */
export type TrialAgentArtifact = {
  id: string;
  title: string;
  content: { markdown: string };
};

/** Result of POST /:token/agents/:agentId/run. */
export type TrialAgentRunResult = {
  artifact: TrialAgentArtifact;
  creditRemainingCents: number;
  spentCents: number;
  creditCents: number;
};

/** An agent as returned by GET /:token/company (live status + deliverable flag). */
export type TrialCompanyAgent = {
  id: string;
  ref?: string;
  name: string;
  role: string;
  category: string;
  charter: string;
  firstTaskTitle: string;
  firstTaskBrief?: string;
  status: TrialAgentStatus;
  hasArtifact: boolean;
  artifactId?: string;
};

/** An artifact row as returned by GET /:token/company. */
export type TrialCompanyArtifact = {
  id: string;
  title: string;
  content: { markdown?: string } & Record<string, unknown>;
  agentId?: string | null;
  useCase?: string;
  createdAt?: string;
};

/** Result of GET /:token/company. company is null until /design runs. */
export type TrialCompanySnapshot = {
  company: TrialCompanyMeta | null;
  agents: TrialCompanyAgent[];
  artifacts: TrialCompanyArtifact[];
  session: {
    creditCents: number;
    spentCents: number;
    creditRemainingCents: number;
    expiresAt: string;
  };
};

export const trialApi = {
  createSession: () => api.post<TrialSessionCreated>("/trial/session", {}),

  getSnapshot: (token: string) => api.get<TrialSnapshot>(`/trial/${token}`),

  run: (token: string, useCase: TrialUseCase, input: TrialRunInput) =>
    api.post<TrialRunResult>(`/trial/${token}/run`, { useCase, input }),

  // Slice 3 — share loop.
  share: (token: string, artifactId: string) =>
    api.post<TrialShareResult>(`/trial/${token}/artifacts/${artifactId}/share`, {}),

  getShared: (shareToken: string) =>
    api.get<TrialSharedArtifact>(`/trial/share/${shareToken}`),

  // Slice 4 — claim on signup (authenticated).
  claim: (token: string) => api.post<TrialClaimResult>(`/trial/${token}/claim`, {}),

  // Test Drive v2 — autonomous company.
  design: (token: string, intake: TrialIntake) =>
    api.post<TrialDesignResult>(`/trial/${token}/design`, { intake }),

  runAgent: (token: string, agentId: string) =>
    api.post<TrialAgentRunResult>(`/trial/${token}/agents/${agentId}/run`, {}),

  getCompany: (token: string) => api.get<TrialCompanySnapshot>(`/trial/${token}/company`),
};
