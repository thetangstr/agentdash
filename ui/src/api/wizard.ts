import { api } from "./client";

export interface WizardInput {
  purpose: string;
  name: string;
  tone: "professional" | "friendly" | "direct";
  role: string;
  customRole?: string;
  connectors?: string[];
  schedule?: {
    frequency: "every_30m" | "hourly" | "daily";
    cronExpression?: string;
  };
}

export interface WizardResult {
  agent: { id: string; name: string; [key: string]: unknown };
  routineId: string | null;
}

export const wizardApi = {
  create: (companyId: string, input: WizardInput) =>
    api.post<WizardResult>(
      `/companies/${companyId}/agents/wizard`,
      input,
    ),
};
