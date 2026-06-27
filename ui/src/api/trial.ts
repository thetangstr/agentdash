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
};
