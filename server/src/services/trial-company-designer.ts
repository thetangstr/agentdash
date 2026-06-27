// AgentDash (Test Drive): the autonomous-COMPANY designer.
//
// The multi-agent trial shows an entire company assembling itself from a single
// 2-3 field intake. A "Chief of Staff" DESIGNS a tailored team of 3-4 agents —
// each with a name, role, charter, and a concrete first task — then the team is
// provisioned and each agent RUNS its first task to produce a real deliverable.
//
// This module owns ONLY the LLM contract (prompt builders + robust parsers).
// The DB/provisioning/credit orchestration lives in trial.ts. Everything here
// is hand-tuned, tolerant, and NEVER throws on bad model output — a flop on the
// first run of an anonymous trial is fatal, so we always fall back sensibly.
//
// See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md.

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CompanyIntake {
  /** One line on what the user / their company does. */
  whatYouDo: string;
  /** What they want the company to achieve. */
  goal: string;
  /** Optional: the single biggest thing in the way right now. */
  blocker?: string;
}

export interface DesignPrompt {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/** One agent in the designed team (pre-provisioning — no DB id yet). */
export interface DesignedAgent {
  /** Stable slug, e.g. "outbound-gtm". */
  ref: string;
  /** Display name, e.g. "Scout". */
  name: string;
  /** Internal role token, e.g. "outbound_sales". */
  role: string;
  /** Human category line, e.g. "outbound · gtm". */
  category: string;
  /** One sentence: what this agent owns. */
  charter: string;
  /** Title of the agent's concrete first task. */
  firstTaskTitle: string;
  /** A short brief describing what the first task should produce. */
  firstTaskBrief: string;
}

export interface CompanyDesign {
  companyName: string;
  mission: string;
  agents: DesignedAgent[];
}

// ---------------------------------------------------------------------------
// Prompt: Chief of Staff designs the company
// ---------------------------------------------------------------------------

const COMPANY_DESIGN_SYSTEM = [
  "You are the Chief of Staff for a brand-new, AI-run company. The founder has",
  "just told you what they do and what they want. Your job is to DESIGN the",
  "founding team: a tight crew of 3-4 autonomous agents, each with a clear remit",
  "and a concrete first task they can start on today.",
  "",
  "Principles:",
  "- Tailor the team to the founder's actual business and goal. A logistics-SaaS",
  "  founder chasing growth needs different agents than a solo newsletter writer.",
  "- Pick complementary roles that cover the path to the goal — e.g. an",
  "  outbound/GTM agent, a research/market agent, a content agent, an ops agent.",
  "  Choose what genuinely fits; do NOT force a fixed template.",
  "- Every agent gets a real, concrete first task whose output a real operator",
  "  could act on today (a plan, a brief, a draft, a list, an analysis).",
  "- Give each agent a short, human name (one word is great).",
  "",
  "Return ONLY a single JSON object — no prose before or after, no markdown code",
  "fences. The JSON MUST match this exact shape:",
  "{",
  '  "companyName": string,        // a crisp name for the company',
  '  "mission": string,            // one sentence on what the company is here to do',
  '  "agents": [                   // EXACTLY 3 or 4 items',
  "    {",
  '      "ref": string,            // short slug, e.g. "outbound-gtm"',
  '      "name": string,           // display name, e.g. "Scout"',
  '      "role": string,           // role token, e.g. "outbound_sales"',
  '      "category": string,       // human label, e.g. "outbound · gtm"',
  '      "charter": string,        // one sentence: what this agent owns',
  '      "firstTaskTitle": string, // title of their concrete first task',
  '      "firstTaskBrief": string  // 1-2 sentences on what the first task produces',
  "    }",
  "  ]",
  "}",
  "",
  "Make it good enough that the founder reads it and thinks 'yes, that is exactly",
  "the team I need'.",
].join("\n");

function buildCompanyDesignUserMessage(intake: CompanyIntake): string {
  const lines = [`What we do: ${intake.whatYouDo.trim()}`, `Our goal: ${intake.goal.trim()}`];
  if (intake.blocker && intake.blocker.trim()) {
    lines.push(`Biggest blocker right now: ${intake.blocker.trim()}`);
  }
  lines.push(
    "",
    "Design the founding team now. Return only the JSON object with 3 or 4 agents.",
  );
  return lines.join("\n");
}

/** Build the hand-tuned Chief-of-Staff design prompt. */
export function buildCompanyDesignPrompt(intake: CompanyIntake): DesignPrompt {
  return {
    system: COMPANY_DESIGN_SYSTEM,
    messages: [{ role: "user", content: buildCompanyDesignUserMessage(intake) }],
  };
}

// ---------------------------------------------------------------------------
// Tolerant JSON extraction (shared shape with trial-hero-tasks)
// ---------------------------------------------------------------------------

/**
 * Extract the first balanced top-level JSON object from arbitrary model text.
 * Tolerates ```json fences, leading/trailing prose, and nested braces. Returns
 * null if no parseable object is found.
 */
function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null;

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenceMatch && fenceMatch[1]) candidates.push(fenceMatch[1].trim());
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through to brace scan */
    }

    const start = candidate.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const slice = candidate.slice(start, i + 1);
          try {
            const parsed = JSON.parse(slice);
            if (parsed && typeof parsed === "object") return parsed;
          } catch {
            /* keep scanning */
          }
          break;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Design parsing + fallback
// ---------------------------------------------------------------------------

function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bound(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trim()}…` : value;
}

function coerceAgent(value: unknown, index: number, usedRefs: Set<string>): DesignedAgent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const name = asString(v.name) || `Agent ${index + 1}`;
  const role = asString(v.role) || slugify(name, `agent_${index + 1}`).replace(/-/g, "_");
  const charter = asString(v.charter);
  const firstTaskBrief = asString(v.firstTaskBrief);
  // An agent with neither a charter nor a first task is not a usable design.
  if (!charter && !firstTaskBrief) return null;

  let ref = slugify(asString(v.ref) || name, `agent-${index + 1}`);
  while (usedRefs.has(ref)) ref = `${ref}-${index + 1}`;
  usedRefs.add(ref);

  const category = asString(v.category) || "team";
  const firstTaskTitle = asString(v.firstTaskTitle) || `First task for ${name}`;

  return {
    ref,
    name: bound(name, 80),
    role: bound(role, 80),
    category: bound(category, 80),
    charter: bound(charter || `Owns ${category} for the company.`, 280),
    firstTaskTitle: bound(firstTaskTitle, 160),
    firstTaskBrief: bound(
      firstTaskBrief || `Produce a concrete, useful first deliverable for ${category}.`,
      600,
    ),
  };
}

/**
 * Build a sensible default founding team so the trial NEVER errors when the
 * model output can't be parsed (or returns too few agents). Lightly tailored
 * via the intake text so even the fallback feels relevant.
 */
export function fallbackCompanyDesign(intake?: CompanyIntake): CompanyDesign {
  const whatYouDo = intake?.whatYouDo?.trim() || "your business";
  const goal = intake?.goal?.trim() || "grow the business";
  const usedRefs = new Set<string>();
  const make = (a: Omit<DesignedAgent, "ref"> & { ref: string }): DesignedAgent => {
    let ref = a.ref;
    while (usedRefs.has(ref)) ref = `${ref}-x`;
    usedRefs.add(ref);
    return { ...a, ref };
  };
  return {
    companyName: "Your Autonomous Company",
    mission: `Help ${whatYouDo} ${goal}.`,
    agents: [
      make({
        ref: "outbound-gtm",
        name: "Scout",
        role: "outbound_sales",
        category: "outbound · gtm",
        charter: "Owns finding and opening conversations with the right buyers.",
        firstTaskTitle: "Draft a first outbound play",
        firstTaskBrief: `Define the ideal customer for ${whatYouDo} and draft a short, sendable outreach sequence.`,
      }),
      make({
        ref: "market-research",
        name: "Atlas",
        role: "market_research",
        category: "research · market",
        charter: "Owns understanding the market, competitors, and where the wedge is.",
        firstTaskTitle: "Map the market landscape",
        firstTaskBrief: `Produce a concise landscape of the market and 3 angles that help ${goal}.`,
      }),
      make({
        ref: "content",
        name: "Quill",
        role: "content",
        category: "content · brand",
        charter: "Owns the story — turning the work into content people want to read.",
        firstTaskTitle: "Draft a launch narrative",
        firstTaskBrief: `Write a crisp positioning paragraph and 3 content ideas tied to ${goal}.`,
      }),
    ],
  };
}

/**
 * Parse the raw model output into a structured company design. Tolerates fenced
 * JSON / surrounding prose, normalizes every field, and GUARANTEES a usable
 * design with at least 3 agents (falling back as needed) so the trial never
 * errors on the design step.
 */
export function parseCompanyDesign(raw: string, intake?: CompanyIntake): CompanyDesign {
  const parsed = extractJsonObject(raw);
  const fallback = fallbackCompanyDesign(intake);

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const usedRefs = new Set<string>();
    const agentsRaw = Array.isArray(obj.agents) ? obj.agents : [];
    let agents = agentsRaw
      .map((a, i) => coerceAgent(a, i, usedRefs))
      .filter((a): a is DesignedAgent => a !== null)
      // EXACTLY 3-4 agents per the contract.
      .slice(0, 4);

    if (agents.length >= 3) {
      const companyName = bound(asString(obj.companyName) || fallback.companyName, 120);
      const mission = bound(asString(obj.mission) || fallback.mission, 400);
      return { companyName, mission, agents };
    }

    // Too few parseable agents: keep what we got, top up from the fallback team.
    if (agents.length > 0) {
      for (const filler of fallback.agents) {
        if (agents.length >= 3) break;
        let ref = filler.ref;
        while (usedRefs.has(ref)) ref = `${ref}-x`;
        usedRefs.add(ref);
        agents.push({ ...filler, ref });
      }
      const companyName = bound(asString(obj.companyName) || fallback.companyName, 120);
      const mission = bound(asString(obj.mission) || fallback.mission, 400);
      return { companyName, mission, agents };
    }
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Prompt: an agent runs its first task
// ---------------------------------------------------------------------------

export interface AgentArtifact {
  title: string;
  content: { markdown: string };
}

/**
 * Build a generic first-task prompt for one designed agent. Adapter-agnostic and
 * deliverable-agnostic: whatever the charter implies, the agent returns clean,
 * well-structured markdown a real operator could act on today.
 */
export function buildAgentTaskPrompt(
  company: { name: string; mission: string },
  agent: Pick<DesignedAgent, "name" | "role" | "charter" | "firstTaskTitle" | "firstTaskBrief">,
): DesignPrompt {
  const system = [
    `You are ${agent.name}, the ${agent.role} at ${company.name}.`,
    `Company mission: ${company.mission}`,
    `Your charter: ${agent.charter}`,
    "",
    "You are doing your very first task. Produce a concrete, genuinely useful",
    "deliverable a real operator could act on TODAY — not a description of what",
    "you would do, but the actual work product (a plan, brief, draft, list, or",
    "analysis as appropriate).",
    "",
    "Return clean, well-structured Markdown. Start with a single H1 title line.",
    "Use headings, short paragraphs, and lists where they help. Do not wrap the",
    "whole response in a code fence. No preamble, no 'here is' — just the",
    "deliverable itself.",
  ].join("\n");

  const userParts = [`First task: ${agent.firstTaskTitle}`, "", agent.firstTaskBrief];
  return {
    system,
    messages: [{ role: "user", content: userParts.join("\n") }],
  };
}

/**
 * Parse the raw model output into a deliverable artifact. Strips an outer code
 * fence if present, derives a title from the first H1 (falling back to the
 * task title), and never throws — an empty/garbled response yields a sensible
 * placeholder so a stranger never sees a raw error on the first run.
 */
export function parseAgentArtifact(
  raw: string,
  agent: Pick<DesignedAgent, "name" | "firstTaskTitle">,
): AgentArtifact {
  let text = (raw ?? "").trim();

  // Strip a single outer ```/```markdown fence if the whole thing is wrapped.
  const fullFence = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/i);
  if (fullFence && fullFence[1]) {
    text = fullFence[1].trim();
  }

  if (!text) {
    return {
      title: agent.firstTaskTitle,
      content: {
        markdown: `# ${agent.firstTaskTitle}\n\n_${agent.name} could not produce a deliverable this time. Please run again._`,
      },
    };
  }

  // Derive a title from the first markdown H1, else the task title.
  let title = agent.firstTaskTitle;
  const h1 = text.match(/^#\s+(.+?)\s*$/m);
  if (h1 && h1[1]) {
    title = h1[1].trim();
  } else {
    const firstLine = text.split("\n").find((l) => l.trim().length > 0);
    if (firstLine && firstLine.trim().length <= 120) {
      title = firstLine.trim().replace(/^#+\s*/, "");
    }
  }

  return {
    title: bound(title, 200),
    content: { markdown: text },
  };
}
