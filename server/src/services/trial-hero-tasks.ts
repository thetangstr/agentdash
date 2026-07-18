// AgentDash (Test Drive): curated hero-task registry.
//
// Open-ended trials fail on variance — a flop on the first run is fatal. We ship
// a small set of high-success, hand-tuned tasks. The launch hero is sales
// outreach: broad appeal, visual, obviously valuable, naturally shareable.
//
// Each task owns: a tuned prompt builder (system + messages), a robust artifact
// parser (tolerates code fences / prose, falls back sensibly), input validation,
// and a short input summary. Output is structured JSON so the UI renders a real
// product output, not raw chat text.
//
// See docs/superpowers/specs/2026-06-27-test-drive-no-signup-trial.md (§5).

import { badRequest } from "../errors.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface HeroPrompt {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ParsedArtifact {
  title: string;
  content: Record<string, unknown>;
}

export interface HeroTask<TInput> {
  /** Stable id, persisted on the artifact (e.g. "sales_outreach"). */
  readonly useCase: string;
  /** Curated agent identity for this task. */
  readonly agentName: string;
  readonly agentRole: string;
  /** Validate + normalize raw request input; throws a 400 on bad input. */
  validateInput(raw: unknown): TInput;
  /** Build the tuned system + messages for the LLM call. */
  buildPrompt(input: TInput): HeroPrompt;
  /** Robustly parse the model's raw text into a structured artifact. */
  parseArtifact(raw: string, input: TInput): ParsedArtifact;
  /** Short human summary of the input (persisted as inputSummary). */
  summarizeInput(input: TInput): string;
}

// ---------------------------------------------------------------------------
// Sales outreach (the launch hero)
// ---------------------------------------------------------------------------

export interface SalesOutreachInput {
  /** The ideal-customer profile, e.g. "VPs of Ops at logistics SaaS companies". */
  icp: string;
  /** Optional context about the sender / product to personalize the copy. */
  senderContext?: string;
}

/** A single touch in the outreach sequence. */
export interface OutreachTouch {
  day: number;
  channel: string;
  subject?: string;
  body: string;
}

export interface SalesOutreachContent {
  summary: string;
  touches: OutreachTouch[];
  tips: string[];
}

const SALES_OUTREACH_SYSTEM = [
  "You are Scout, a senior B2B outbound sales strategist who writes outreach that",
  "actually gets replies. You write tight, specific, human copy — never generic",
  "spray-and-pray. You avoid hype, exclamation marks, and filler. Every message is",
  "short enough to read on a phone and earns the next reply.",
  "",
  "Produce a personalized 3-touch outreach sequence for the prospect profile the",
  "user gives you. The three touches should escalate naturally: (1) a pattern-",
  "interrupt opener tied to the prospect's likely priorities, (2) a value-forward",
  "follow-up with a concrete proof point or insight, (3) a short, low-pressure",
  "breakup that leaves the door open.",
  "",
  "Return ONLY a single JSON object — no prose before or after, no markdown code",
  "fences. The JSON MUST match this exact shape:",
  "{",
  '  "summary": string,            // one sentence on the angle you chose',
  '  "touches": [                  // exactly 3 items',
  "    {",
  '      "day": number,            // send-day offset, e.g. 1, 3, 7',
  '      "channel": string,        // "email" or "linkedin"',
  '      "subject": string,        // present for email touches; omit/empty for linkedin',
  '      "body": string            // the message body, ready to send',
  "    }",
  "  ],",
  '  "tips": [string]              // 2-3 short, actionable sending tips',
  "}",
  "",
  "Keep each body under ~120 words. Use [First Name] and [Your Name] / [Company] as",
  "merge placeholders where appropriate. Make it good enough that a real rep would",
  "send it as-is.",
].join("\n");

function buildSalesOutreachUserMessage(input: SalesOutreachInput): string {
  const lines = [
    `Prospect profile (ICP): ${input.icp.trim()}`,
  ];
  if (input.senderContext && input.senderContext.trim()) {
    lines.push(`Sender / product context: ${input.senderContext.trim()}`);
  }
  lines.push(
    "",
    "Write the personalized 3-touch outreach sequence now. Return only the JSON object.",
  );
  return lines.join("\n");
}

/** Exported standalone for unit testing the prompt builder. */
export function buildSalesOutreachPrompt(input: SalesOutreachInput): HeroPrompt {
  return {
    system: SALES_OUTREACH_SYSTEM,
    messages: [{ role: "user", content: buildSalesOutreachUserMessage(input) }],
  };
}

/**
 * Extract the first balanced top-level JSON object from arbitrary model text.
 * Tolerates ```json fences, leading/trailing prose, and nested braces.
 * Returns null if no parseable object is found.
 */
function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null;

  // Strip the most common fenced-code wrapper first.
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenceMatch && fenceMatch[1]) candidates.push(fenceMatch[1].trim());
  candidates.push(raw.trim());

  for (const candidate of candidates) {
    // Fast path: the whole candidate is valid JSON.
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* fall through to brace scan */
    }

    // Brace scan: find the first balanced { ... } region and try to parse it.
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
            /* keep scanning for a later balanced region */
          }
          break;
        }
      }
    }
  }
  return null;
}

function coerceTouch(value: unknown, index: number): OutreachTouch | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const body = typeof v.body === "string" ? v.body.trim() : "";
  if (!body) return null;
  const dayRaw = v.day;
  const day =
    typeof dayRaw === "number" && Number.isFinite(dayRaw)
      ? Math.max(1, Math.floor(dayRaw))
      : index * 2 + 1;
  const channel =
    typeof v.channel === "string" && v.channel.trim() ? v.channel.trim() : "email";
  const subject =
    typeof v.subject === "string" && v.subject.trim() ? v.subject.trim() : undefined;
  return subject ? { day, channel, subject, body } : { day, channel, body };
}

/**
 * Parse the raw model output into a structured sales-outreach artifact.
 * Falls back to a sensible (still usable) structure when JSON can't be
 * extracted, so a stranger never sees a raw blob or an error on first run.
 */
export function parseSalesOutreachArtifact(
  raw: string,
  input: SalesOutreachInput,
): ParsedArtifact {
  const titleFor = (icp: string) => {
    const trimmed = icp.trim();
    const clipped = trimmed.length > 64 ? `${trimmed.slice(0, 61)}...` : trimmed;
    return `3-touch outreach sequence — ${clipped}`;
  };

  const parsed = extractJsonObject(raw);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const touchesRaw = Array.isArray(obj.touches) ? obj.touches : [];
    const touches = touchesRaw
      .map((t, i) => coerceTouch(t, i))
      .filter((t): t is OutreachTouch => t !== null);
    if (touches.length > 0) {
      const summary =
        typeof obj.summary === "string" && obj.summary.trim()
          ? obj.summary.trim()
          : `Personalized outreach for ${input.icp.trim()}.`;
      const tips = Array.isArray(obj.tips)
        ? obj.tips
            .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
            .map((t) => t.trim())
        : [];
      const content: SalesOutreachContent = { summary, touches, tips };
      return { title: titleFor(input.icp), content: content as unknown as Record<string, unknown> };
    }
  }

  // Fallback: wrap whatever the model returned as a single touch so the artifact
  // is still a coherent, renderable object (never an error on the hero run).
  const fallbackBody = (raw || "").trim() || "Draft unavailable — please run again.";
  const content: SalesOutreachContent = {
    summary: `Draft outreach for ${input.icp.trim()}.`,
    touches: [{ day: 1, channel: "email", subject: "Quick question", body: fallbackBody }],
    tips: [
      "Personalize the opening line with a specific detail about the prospect.",
      "Keep each message under 120 words and end with one clear ask.",
    ],
  };
  return { title: titleFor(input.icp), content: content as unknown as Record<string, unknown> };
}

function validateSalesOutreachInput(raw: unknown): SalesOutreachInput {
  if (!raw || typeof raw !== "object") {
    throw badRequest("input is required", { code: "invalid_input" });
  }
  const obj = raw as Record<string, unknown>;
  const icp = typeof obj.icp === "string" ? obj.icp.trim() : "";
  if (!icp) {
    throw badRequest("input.icp is required", { code: "missing_icp" });
  }
  // Bound input length to keep the prompt cheap + safe.
  const boundedIcp = icp.length > 500 ? icp.slice(0, 500) : icp;
  const senderContextRaw =
    typeof obj.senderContext === "string" ? obj.senderContext.trim() : "";
  const senderContext = senderContextRaw
    ? senderContextRaw.length > 1000
      ? senderContextRaw.slice(0, 1000)
      : senderContextRaw
    : undefined;
  return senderContext ? { icp: boundedIcp, senderContext } : { icp: boundedIcp };
}

export const salesOutreachTask: HeroTask<SalesOutreachInput> = {
  useCase: "sales_outreach",
  agentName: "Scout",
  agentRole: "outbound_sales",
  validateInput: validateSalesOutreachInput,
  buildPrompt: buildSalesOutreachPrompt,
  parseArtifact: parseSalesOutreachArtifact,
  summarizeInput: (input) => {
    const base = `ICP: ${input.icp.trim()}`;
    return base.length > 280 ? `${base.slice(0, 277)}...` : base;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const HERO_TASKS: Record<string, HeroTask<any>> = {
  [salesOutreachTask.useCase]: salesOutreachTask,
};

/** The curated agent for new trial sessions (the launch hero). */
export const TRIAL_DEFAULT_HERO_TASK = salesOutreachTask;

/** Look up a hero task by useCase id, or null if unknown. */
export function getHeroTask(useCase: string): HeroTask<unknown> | null {
  return (HERO_TASKS[useCase] as HeroTask<unknown> | undefined) ?? null;
}

export function listHeroTaskUseCases(): string[] {
  return Object.keys(HERO_TASKS);
}
