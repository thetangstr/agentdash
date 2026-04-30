// AgentDash: /solve survey — shared validation schema (server + client)
// AGE-104. Runs in both the route handler (Node) and the form (browser).
import { z } from "zod";

export const COMPANY_SIZES = ["1-50", "51-200", "201-1,000", "1,001+"] as const;
export const URGENCIES = [
  "this-month",
  "this-quarter",
  "exploring",
] as const;
export const DATA_SOURCES = [
  "SharePoint",
  "Google Drive",
  "Confluence",
  "Slack",
  "Email",
  "CRM",
  "Database",
  "Other",
] as const;

export const URGENCY_LABELS: Record<(typeof URGENCIES)[number], string> = {
  "this-month": "This month",
  "this-quarter": "This quarter",
  exploring: "Just exploring",
};

export const solveSubmissionSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: z
    .string()
    .trim()
    .min(1, "Email is required")
    .email("Enter a valid email")
    .max(320),
  company: z.string().trim().min(1, "Company is required").max(200),
  role: z.string().trim().max(200).optional().or(z.literal("")),
  companySize: z.enum(COMPANY_SIZES, {
    errorMap: () => ({ message: "Pick a company size" }),
  }),
  problem: z
    .string()
    .trim()
    .min(30, "Tell us a bit more — at least 30 characters")
    .max(5000),
  dataSources: z.array(z.enum(DATA_SOURCES)).default([]),
  dataSourcesOther: z.string().trim().max(500).optional().or(z.literal("")),
  successSignal: z.string().trim().max(2000).optional().or(z.literal("")),
  urgency: z.enum(URGENCIES, {
    errorMap: () => ({ message: "Pick a timeline" }),
  }),
  additionalContext: z.string().trim().max(2000).optional().or(z.literal("")),
});

export type SolveSubmission = z.infer<typeof solveSubmissionSchema>;

// Server-side: input shape with metadata stamped at submission time
export type SolveSubmissionRecord = SolveSubmission & {
  id: string;
  createdAt: string; // ISO
  ipAddress: string | null;
  userAgent: string | null;
};
