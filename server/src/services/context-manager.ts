// AgentDash: Context manager types and service stub
export interface PromptSection {
  name: string;
  content: string;
  priority?: number;
  dataFreshnessMs?: number;
}
