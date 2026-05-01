// AgentDash: Shared assessment wizard constants for company- and project-mode.
// Extracted from AssessPage.tsx so both wizards reference the same source of truth.

export const INDUSTRIES = [
  "Public Sector", "E-Commerce", "Insurance", "Healthcare", "Logistics",
  "Financial Services", "Manufacturing", "Real Estate", "Legal", "Education",
  "Tech/SaaS", "Retail", "Energy/Utilities", "Telecom",
  "Media/Entertainment", "Construction", "Hospitality", "Agriculture",
] as const;

export const EMPLOYEE_RANGES = ["1-50", "51-200", "201-1,000", "1,001-5,000", "5,000+"] as const;
export const REVENUE_RANGES = ["< $5M", "$5–25M", "$25–100M", "$100M–1B", "> $1B"] as const;
export const AUTOMATION_LEVELS = [
  { value: "manual", label: "Mostly manual", desc: "Spreadsheets, email, phone" },
  { value: "basic", label: "Basic automation", desc: "Some RPA, simple scripts, Zapier" },
  { value: "advanced", label: "Advanced but hitting ceiling", desc: "Mature RPA/rules but breaks on edge cases" },
] as const;
export const GOALS = ["Revenue growth", "Cost reduction", "Both"] as const;
export const TIMELINES = ["Immediate need", "3-6 months", "Just exploring"] as const;
export const BUDGETS = ["< $50K", "$50–150K", "$150–500K", "> $500K", "Not sure yet"] as const;

export const FUNCTION_CATEGORIES = [
  {
    key: "sales", name: "Sales", subs: [
      { key: "business-development", name: "Business Development" },
      { key: "account-management", name: "Account Management" },
      { key: "revenue-operations", name: "Revenue Operations" },
    ],
  },
  {
    key: "customer-support", name: "Customer Support", subs: [
      { key: "contact-center", name: "Contact Center" },
      { key: "field-service", name: "Field Service" },
      { key: "customer-success", name: "Success & Retention" },
    ],
  },
  {
    key: "hr", name: "HR", subs: [
      { key: "talent-acquisition", name: "Talent Acquisition" },
      { key: "workforce-management", name: "Workforce Management" },
      { key: "hr-compliance", name: "Compliance & Benefits" },
    ],
  },
  {
    key: "finance", name: "Finance", subs: [
      { key: "accounting-arap", name: "Accounting & AR/AP" },
      { key: "fpa-reporting", name: "FP&A & Reporting" },
      { key: "risk-compliance", name: "Risk & Compliance" },
      { key: "procurement", name: "Procurement" },
    ],
  },
  {
    key: "it-engineering", name: "IT / Engineering", subs: [
      { key: "cybersecurity", name: "Cybersecurity / SOC" },
      { key: "devops-sre", name: "DevOps / SRE" },
      { key: "data-engineering", name: "Data Engineering" },
      { key: "software-dev", name: "Software Development" },
    ],
  },
  {
    key: "operations", name: "Operations", subs: [
      { key: "supply-chain", name: "Supply Chain" },
      { key: "facilities", name: "Facilities & Maintenance" },
      { key: "quality-regulatory", name: "Quality / Regulatory" },
      { key: "program-management", name: "Program Management" },
    ],
  },
];

export const SOFTWARE_SUITES = [
  { category: "CRM & Sales", tools: ["Salesforce", "HubSpot", "Dynamics 365", "Pipedrive", "Zoho CRM"] },
  { category: "ERP", tools: ["SAP", "Oracle", "NetSuite", "Sage", "Odoo"] },
  { category: "IT & Support", tools: ["ServiceNow", "Jira", "Zendesk", "Freshdesk", "PagerDuty"] },
  { category: "Healthcare", tools: ["Epic", "Cerner", "Athenahealth", "MEDITECH"] },
  { category: "Cloud & Infra", tools: ["AWS", "Azure", "GCP", "IBM Cloud"] },
  { category: "Collaboration", tools: ["Slack", "Microsoft Teams", "Google Workspace", "Zoom"] },
  { category: "Finance & HR", tools: ["Workday", "QuickBooks", "Xero", "ADP", "BambooHR", "Gusto"] },
  { category: "Engineering", tools: ["GitHub", "GitLab", "Jenkins", "Datadog", "Splunk"] },
  { category: "Project & Ops", tools: ["Asana", "Monday.com", "Smartsheet", "Procore", "Airtable"] },
  { category: "Data & Analytics", tools: ["Snowflake", "Databricks", "Tableau", "Power BI", "Looker"] },
] as const;

export function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
