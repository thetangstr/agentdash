// AgentDash: Fred is a registered product guide, never authority inferred from a name.
import { z } from "zod";

export const FRED_MANDATE_VERSION = "fred-v1";
export const FRED_ADAPTER_TYPES = ["claude_local", "codex_local", "hermes_local"] as const;
export const FRED_REGISTRATION_STATES = ["materializing", "ready", "repair_needed"] as const;
export type FredRegistrationState = (typeof FRED_REGISTRATION_STATES)[number];

export const fredSetupSchema = z.object({
  adapterType: z.enum(FRED_ADAPTER_TYPES),
  budgetMonthlyCents: z.number().int().positive().max(100_000_000),
  shareWithCompany: z.literal(true),
}).strict();
export type FredSetupInput = z.infer<typeof fredSetupSchema>;

export const fredBriefSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  goal: z.string().trim().min(1).max(4000),
  firstJob: z.string().trim().min(1).max(4000),
  successCriteria: z.array(z.string().trim().min(1).max(2000)).min(1).max(12),
  baseline: z.string().trim().max(4000),
  target: z.string().trim().max(4000),
  outcomeWindow: z.string().trim().max(2000),
  boundaries: z.string().trim().max(8000),
  shareWithCompany: z.literal(true),
}).strict();
export type FredBriefInput = z.infer<typeof fredBriefSchema>;
export type FredBriefContent = Omit<FredBriefInput, "expectedRevision" | "shareWithCompany">;
export interface FredAdoptionBrief extends FredBriefContent {
  revision: number;
  documentRevisionId: string | null;
}

export const fredStartSchema = z.object({
  registrationId: z.guid(),
  expectedRevision: z.number().int().positive(),
}).strict();
export type FredStartInput = z.infer<typeof fredStartSchema>;

export interface FredWorkspace {
  companyId: string;
  registration: {
    id: string;
    agentId: string | null;
    mainIssueId: string | null;
    ownerUserId: string;
    state: FredRegistrationState;
    mandateVersion: string;
    startedAt: string | null;
  } | null;
  agent: {
    id: string;
    name: string;
    status: string;
    adapterType: string;
    budgetMonthlyCents: number;
    spentMonthlyCents: number;
  } | null;
  issue: { id: string; identifier: string | null; title: string; status: string } | null;
  brief: FredAdoptionBrief | null;
  canConfigure: boolean;
  startBlocker: string | null;
  latestRun: { id: string; status: string; error: string | null } | null;
}
