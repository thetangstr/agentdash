import type { WorkforceTemplate } from './types/workforce.js';
const procedures = [
  'Read the current human-confirmed company brief and the cited company sources before planning. Look up actual available assets and cite their source IDs; never infer private project answers into company facts.',
  'Identify the required facts missing for this job. Ask one focused question on the dependent issue; explain the decision it blocks. Wait for a sufficient answer without inventing business facts.',
  'Follow the objective and declared metrics. Use the supplied assets to produce a tangible draft document or work product that a human can inspect.',
  'Keep research, drafts, approved claims and executed actions distinct. Escalate unsupported claims, unavailable assets and actions requiring approval to the accountable human.',
  'Submit the artifact with source references and criterion-by-criterion evidence for neutral review. Report measured outcomes only when evidence exists; otherwise mark the result unknown.',
];
function skill(key: string, name: string, description: string, steps: string[]) {
  return { key, name, description, content: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nThis procedure grants no permission. Respect company access, budgets, approvals and connector permissions. Drafts are not sent or published unless separately authorized.\n` };
}
export const WORKFORCE_TEMPLATES: readonly WorkforceTemplate[] = [
  {
    id: 'marketing-content', version: 1, name: 'Marketing content', description: 'Create source-backed marketing drafts for a defined audience and offer.',
    responsibilities: ['Research approved offer and audience', 'Draft useful campaign content', 'Check claims and brand voice', 'Prepare artifacts for human review'],
    requiredFactKeys: ['offer', 'audience', 'brandVoice', 'approvedClaims'], procedures,
    skills: [skill('workforce-marketing-content-v1', 'Marketing content preparation', 'Prepare verifiable campaign drafts from approved company assets.', [...procedures, 'Build a campaign brief with audience, problem, approved promise, evidence and call to action. Draft three headline options and one complete content asset.', 'Review every factual claim against approvedClaims. Remove unsupported claims; flag missing approval rather than strengthening language. Provide a source table and a publication checklist.'])],
    qualityChecks: ['Deliver a complete draft artifact with a concrete call to action', 'Trace each factual claim to a confirmed company source', 'Match the approved audience and brand voice', 'Document unresolved decisions and obtain independent review'],
    suggestedMetrics: ['Approved content pieces', 'Qualified inbound responses (unknown until measured)'],
    starterJob: { title: 'Prepare the first marketing content package', description: 'Using the approved company brief and actual source assets, produce a campaign brief, three headlines and one complete draft with a call to action. Cite approved claims and list publication approvals still needed. Ask focused questions for missing facts. Do not publish or claim outcomes without evidence.' },
  },
  {
    id: 'sales-support', version: 1, name: 'Sales support', description: 'Prepare accurate qualification and outreach drafts from approved offer and pricing.',
    responsibilities: ['Understand ideal customers', 'Apply qualification rules', 'Prepare evidence-backed sales materials', 'Escalate pricing and commitment decisions'],
    requiredFactKeys: ['offer', 'pricing', 'idealCustomer', 'qualificationRules'], procedures,
    skills: [skill('workforce-sales-support-v1', 'Sales preparation', 'Prepare qualification and outreach drafts without invented prospect facts.', [...procedures, 'Create a qualification checklist from the approved idealCustomer and qualificationRules. Use actual authorized prospect context where available; mark absent values unknown.', 'Draft an initial outreach message and objection responses using confirmed pricing and offer. Cite sources for promises, separate draft from sent state, and ask a human about exceptions or commitments.'])],
    qualityChecks: ['Deliver a qualification checklist and usable outreach draft', 'Use confirmed pricing and qualification rules', 'Never invent prospect attributes or claim an unsent message was sent', 'Document approval needs and obtain independent review'],
    suggestedMetrics: ['Qualified prospects reviewed', 'Qualified conversations (unknown until measured)'],
    starterJob: { title: 'Prepare the first sales support package', description: 'Create a qualification checklist, an outreach draft and responses to three likely objections using the approved offer, pricing, ideal customer and qualification rules. Use actual authorized assets, cite sources and mark missing prospect context unknown. Do not send messages or make commitments without authorization.' },
  },
];
export function resolveWorkforceTemplate(id: string, version = 1): WorkforceTemplate | null {
  return WORKFORCE_TEMPLATES.find(template => template.id === id && template.version === version) ?? null;
}
