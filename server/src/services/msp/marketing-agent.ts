/**
 * MSP Marketing Agent -- Configuration & Draft Templates
 * Issue: AGE-8 | Goal: Marketing agent for MSP lead generation drafts
 *
 * Configures a dedicated marketing agent capable of drafting:
 * 1. MSP service positioning and differentiation statement
 * 2. Website homepage and services page copy
 * 3. Blog post outline on a relevant MSP topic
 * 4. Email outreach template for a first design partner target
 * 5. One-sample local-market campaign idea
 *
 * All outputs are internal drafts for human review only.
 * No external sending, posting, or outreach.
 */

// -- Agent Identity --

export interface MarketingAgentConfig {
  id: string;
  name: string;
  role: "msp_marketing";
  description: string;
  instructions: string;
  defaultTone: "professional" | "conversational" | "technical";
  outputFormat: "markdown" | "html" | "google-docs";
  guardrails: {
    mustIncludeApprovalStep: boolean;
    externalOutreachBlocked: boolean;
    customerContactBlocked: boolean;
    socialPostingBlocked: boolean;
    reviewOwner: string;
  };
  draftTypes: DraftType[];
}

export type DraftType =
  | "positioning_statement"
  | "homepage_copy"
  | "services_page_copy"
  | "blog_post_outline"
  | "email_outreach"
  | "local_campaign";

const MARKETING_AGENT_INSTRUCTIONS = `You are the MSP Marketing Agent. Your role is to produce high-quality marketing and sales enablement drafts for internal human review. You do NOT send emails, post on social media, publish content, contact prospects, or make any external outreach. Every output must include "DRAFT -- NOT FOR EXTERNAL USE" at the top and requires human approval before any external use.

Available draft types: positioning_statement, homepage_copy, services_page_copy, blog_post_outline, email_outreach, local_campaign.

Process: (1) Receive draft request with context, (2) produce draft using the appropriate prompt builder, (3) save to the review folder with DRAFT prefix, (4) notify the review owner.`;

export const MarketingAgentIdentity: MarketingAgentConfig = {
  id: "msp-marketing-agent",
  name: "MSP Marketing Agent",
  role: "msp_marketing",
  description: "Produces MSP-focused marketing and sales enablement drafts for human review.",
  instructions: MARKETING_AGENT_INSTRUCTIONS,
  defaultTone: "professional",
  outputFormat: "markdown",
  guardrails: {
    mustIncludeApprovalStep: true,
    externalOutreachBlocked: true,
    customerContactBlocked: true,
    socialPostingBlocked: true,
    reviewOwner: "Yang Tang",
  },
  draftTypes: [
    "positioning_statement",
    "homepage_copy",
    "services_page_copy",
    "blog_post_outline",
    "email_outreach",
    "local_campaign",
  ],
};

// -- Positioning Context --

export interface PositioningContext {
  companyName: string;
  tagline?: string;
  yearFounded?: number;
  primaryRegion: string;
  serviceStack: string[];
  targetClientSegments: string[];
  keyDifferentiators: string[];
  topCompetitors: string[];
  awardsOrCertifications?: string[];
}

// -- Draft Type Descriptions --

export const DraftTypeDescriptions: Record<DraftType, string> = {
  positioning_statement: "Positioning statement, tagline, one-liner, value proposition, differentiators",
  homepage_copy: "Hero section, value prop blocks, social proof, trust signals, footer CTA",
  services_page_copy: "Service descriptions, benefits, ideal-for profiles, process section, why-us section",
  blog_post_outline: "SEO-optimized title, keyword, audience, full editorial outline with word counts",
  email_outreach: "Subject lines, body copy, signature, personalization notes for design partner outreach",
  local_campaign: "Campaign brief, creative assets, channel mix, budget/timeline, KPIs",
};

// -- Prompt Builders --

export function buildPositioningPrompt(ctx: PositioningContext): string {
  return `You are an MSP marketing copywriter. Write a positioning statement for this managed services provider.

Company: ${ctx.companyName}
Tagline: ${ctx.tagline ?? "none"}
Primary market: ${ctx.primaryRegion}
Service stack: ${ctx.serviceStack.join(", ")}
Client segments: ${ctx.targetClientSegments.join(", ")}
Key differentiators: ${ctx.keyDifferentiators.join(", ")}
Named competitors: ${ctx.topCompetitors.join(", ")}
${ctx.awardsOrCertifications ? "Awards/certs: " + ctx.awardsOrCertifications.join(", ") : ""}

Requirements:
- One-liner: 10 words or fewer, punchy
- Value proposition: 2-3 sentences, end with a question the prospect is asking themselves
- Key differentiators: 3-5 bullet points, specific not generic
- Competitive angle: one paragraph explaining how this MSP stands apart from the named competitors
- CTA: one sentence directing prospects to next step
- Output as clean markdown with headers
- Include "DRAFT -- NOT FOR EXTERNAL USE" at the top

This is an INTERNAL DRAFT for human review.`;
}

export function buildHomepagePrompt(ctx: PositioningContext): string {
  return `You are an MSP website copywriter. Write homepage copy for this managed services provider.

Company: ${ctx.companyName}
Tagline: ${ctx.tagline ?? "none"}
Service stack: ${ctx.serviceStack.join(", ")}
Client segments: ${ctx.targetClientSegments.join(", ")}
Key differentiators: ${ctx.keyDifferentiators.join(", ")}
Primary market: ${ctx.primaryRegion}

Requirements -- produce all of the following sections as markdown:

1. HERO: headline (10 words or fewer), subheadline (25 words or fewer), CTA button text
2. VALUE PROP BLOCK: 3 blocks with heading + 2-sentence body each
3. SOCIAL PROOF: 3 placeholder client testimonials (realistic but fictional, labelled "[FICTIONAL]")
4. TRUST SIGNALS: 4-6 items (certifications, SLAs, client count, years in business)
5. FOOTER CTA: one closing sentence + CTA

Include "DRAFT -- NOT FOR EXTERNAL USE" at the top.`;
}

export function buildServicesPagePrompt(ctx: PositioningContext): string {
  return `You are an MSP website copywriter. Write a services page for this managed services provider.

Company: ${ctx.companyName}
Service stack: ${ctx.serviceStack.join(", ")}
Client segments: ${ctx.targetClientSegments.join(", ")}
Key differentiators: ${ctx.keyDifferentiators.join(", ")}

Requirements -- produce as markdown:

1. Page title and intro paragraph (3-4 sentences)
2. 3-4 SERVICES: for each -- name, headline, 2-paragraph description, 3 bullet benefits, "ideal for" one-liner
3. PROCESS SECTION: 4-5 step names for how work begins and flows
4. WHY US SECTION: 3-4 short paragraphs on what makes this MSP different

Include "DRAFT -- NOT FOR EXTERNAL USE" at the top.`;
}

export function buildBlogPostPrompt(ctx: PositioningContext, topic?: string): string {
  const suggestedTopic = topic ?? (ctx.targetClientSegments.some((s: string) => s.includes("law"))
    ? "Why law firms are top targets for ransomware and what to do about it"
    : ctx.targetClientSegments.some((s: string) => s.includes("medical"))
    ? "HIPAA compliance in the cloud: what medical practices miss"
    : "The true cost of IT downtime for small businesses");

  return `You are an MSP content strategist. Write a blog post outline for this managed services provider.

Company: ${ctx.companyName}
Service stack: ${ctx.serviceStack.join(", ")}
Client segments: ${ctx.targetClientSegments.join(", ")}
Suggested topic: "${suggestedTopic}"

Requirements -- produce a full outline as markdown:

1. Post title (SEO-friendly, 60 characters or fewer)
2. Target keyword and target audience
3. Post goal (lead gen / authority / nurture)
4. Full outline: intro hook, each H2 section with key points (2-4 bullets each), word count estimate per section, optional notes
5. Closing CTA (no direct selling -- offer something useful)
6. Internal notes: what to customize, what sources to cite, what images/visuals to include

Include "DRAFT -- NOT FOR EXTERNAL USE" header.`;
}

export function buildEmailOutreachPrompt(
  ctx: PositioningContext,
  targetPersona: string,
  targetCompany: string,
): string {
  return `You are an MSP sales copywriter. Write an email outreach template for a first design partner outreach.

Your MSP: ${ctx.companyName}
Tagline: ${ctx.tagline ?? "none"}
Service stack: ${ctx.serviceStack.join(", ")}
Key differentiators: ${ctx.keyDifferentiators.join(", ")}
Primary market: ${ctx.primaryRegion}

Target persona: ${targetPersona}
Target company profile: ${targetCompany}

Requirements -- produce as markdown:

1. Subject line (3 options, 50 chars or fewer each)
2. Preview/snippet text (85 chars or fewer)
3. Greeting
4. Opening hook (first 2 sentences -- must feel personal, not broadcast)
5. Body (3-4 short paragraphs -- problem awareness, your approach, social proof, soft ask)
6. Close (one sentence, no pressure)
7. Signature block (name, title, phone -- use realistic placeholder data)
8. Personalization notes: what fields to swap in per-recipient (company name, contact name, specific pain point)
9. Include "DRAFT -- NOT FOR EXTERNAL USE" header and note: "Do not send without human review and approval"

Tone: warm professional, like a trusted advisor, not a vendor.`;
}

export function buildLocalCampaignPrompt(ctx: PositioningContext): string {
  const geo = ctx.primaryRegion;
  return `You are an MSP marketing strategist. Design one local market campaign sample for this managed services provider.

Company: ${ctx.companyName}
Service stack: ${ctx.serviceStack.join(", ")}
Client segments: ${ctx.targetClientSegments.join(", ")}
Primary market: ${geo}
Key differentiators: ${ctx.keyDifferentiators.join(", ")}

Requirements -- produce as markdown:

1. Campaign name and goal (specific, measurable)
2. Target audience description and geo parameters
3. Channel recommendations (pick 1-2 most relevant for ${geo})
4. Creative brief: headline, primary message, secondary message, offer (if any), CTA
5. Estimated budget range (monthly, in USD)
6. Timeline (weeks 1-4 execution outline)
7. KPIs: 3 specific metrics to track
8. Internal notes: what to test, what to avoid, compliance considerations

This is a SAMPLE campaign plan -- internal draft for review only.
Include "DRAFT -- NOT FOR EXTERNAL USE" header.`;
}

// -- Capabilities Summary --

export function getMarketingAgentCapabilities(): {
  config: MarketingAgentConfig;
  draftTypeDescriptions: Record<DraftType, string>;
} {
  return {
    config: MarketingAgentIdentity,
    draftTypeDescriptions: DraftTypeDescriptions,
  };
}
