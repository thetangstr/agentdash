/**
 * Kestrel Bay Architects — the UAT scenario.
 *
 * A whole fictional practice, in enough detail that walking it exercises what a
 * real first week does rather than what a smoke test does. The earlier plan
 * said "enter a company name" and moved on, which skipped the part that
 * actually matters: the description, the goals, the mandate, and the interview
 * answers are the content the product reasons over. A workspace created from
 * three words tells you nothing about whether the Chief of Staff can produce a
 * useful plan.
 *
 * Everything here is invented. Emails use `.test` (RFC 2606), which cannot be
 * routed, so no message can ever reach a real person — deliberate, because this
 * scenario gets typed into a system that sends invites. Nothing here overlaps
 * with MKThink's real staff or clients.
 */

export interface Person {
  name: string;
  email: string;
  password: string;
  title: string;
  /** What this person actually owns, in their own words. */
  owns: string;
}

export const OWNER: Person = {
  name: "Dana Whitfield",
  email: "dana.whitfield@kestrelbay.test",
  password: "Kestrel-UAT-2026!",
  title: "Managing Principal",
  owns:
    "Runs the practice. Signs fee proposals, owns client relationships, and is the "
    + "last stop on anything that changes scope, programme or money.",
};

export const TEAM: Person[] = [
  {
    name: "Marcus Oyelaran",
    email: "marcus.oyelaran@kestrelbay.test",
    password: "Kestrel-UAT-2026!",
    title: "Associate — Delivery",
    owns:
      "Live project delivery across seven active jobs. Knows which drawings are late, "
      + "which consultants are holding things up, and which milestones are at risk.",
  },
  {
    name: "Sofia Reyes-Lindqvist",
    email: "sofia.reyes@kestrelbay.test",
    password: "Kestrel-UAT-2026!",
    title: "Associate — Technical & Systems",
    owns:
      "The technical estate: the CDE, drawing standards, model federation, and the "
      + "consultant coordination log. Also the only person who knows where anything is filed.",
  },
  {
    name: "Tomás Bergström",
    email: "tomas.bergstrom@kestrelbay.test",
    password: "Kestrel-UAT-2026!",
    title: "Practice Manager — People & Resourcing",
    owns:
      "Hiring, resourcing and utilisation. Tracks who is available against what is "
      + "coming in, and where the practice is about to be short.",
  },
];

export const COMPANY = {
  name: "Kestrel Bay Architects",
  /**
   * Typed into the company description field. Long on purpose: this is the text
   * the Chief of Staff has to reason from, and a one-liner would not tell us
   * whether it can.
   */
  description:
    "Kestrel Bay Architects is a 34-person architecture and planning practice working "
    + "on civic, education and mixed-use projects. Seven jobs are live, ranging from a "
    + "£2.4m primary school refurbishment to an 180-unit residential masterplan at "
    + "outline planning. Work is delivered with external structural, MEP and landscape "
    + "consultants, so most delays originate outside the practice and are discovered "
    + "late. The partners currently learn about slippage in the Monday meeting, by which "
    + "point a week has usually been lost.",
} as const;

/**
 * The three goals the practice would actually set, with the descriptions that
 * make them answerable. Each is a recurring, multi-person deliverable — the
 * shape the product exists for — rather than a single tidy task.
 */
export const GOALS = [
  {
    title: "Monday project health review, assembled before the meeting rather than in it",
    description:
      "Every Monday at 09:00 Dana should already have: each live job's status, any "
      + "milestone at risk with the reason, and every item waiting on an external "
      + "consultant with how long it has been waiting. Sourced and attributed, so that "
      + "the meeting is spent deciding rather than collecting. Today this takes Marcus "
      + "most of Friday afternoon and is still incomplete by Monday.",
    tasks: [
      "Assemble the Monday project health review",
      "Collect delivery status and any milestone at risk across the seven live jobs",
      "Collect outstanding items with external consultants and how long each has waited",
      "Collect resourcing pressure for the next four weeks",
    ],
  },
  {
    title: "No RFI or submittal stalls silently",
    description:
      "An RFI that has sat with a consultant for eleven days should surface itself, "
      + "with who owes the answer and what it is blocking. Sofia currently finds these "
      + "by scrolling the coordination log. Nothing should be chased by memory.",
    tasks: [
      "Produce the weekly stalled-items review",
      "List every open RFI with age, owner and what it blocks",
      "List submittals awaiting review past their agreed turnaround",
    ],
  },
  {
    title: "Scope changes are known when they happen, not at invoicing",
    description:
      "When a client asks for something outside the agreed scope, it should be captured "
      + "as a possible variation the same week, with the fee implication estimated and "
      + "flagged to Dana. Twice this year a change was only noticed when the invoice was "
      + "queried. No agent commits us to a fee — it prepares, Dana decides.",
    tasks: [
      "Compile this month's possible variations for Dana to review",
      "Flag any instruction received that looks outside the agreed scope",
    ],
  },
] as const;

/**
 * Answers for the eight mandate questions, in order, including the free-text
 * box added at Q8. Chosen to be narrower than the defaults in the places a real
 * practice would narrow them — an agent that can email a client is the thing
 * Dana would refuse first.
 */
export const MANDATE_ANSWERS = {
  job: "Chief of Staff — keeps the whole company moving",
  autonomousKeep: [
    "Read our documents, files, and systems",
    "Research and summarise",
    "Write drafts — documents, decks, emails, code",
    "Open tasks and keep them updated",
    "Ask other people's agents for things it does not own",
    "Raise a risk or a problem unprompted",
  ],
  neverAdd: [
    "Contact a client or customer directly",
    "Commit us to a date, a price, or a scope",
    "Move money, pay anything, or commit us to spend",
    "Delete anything, anywhere",
  ],
  tieBreak: "When two people want different things, Dana decides.",
  whenUnsure: "Ask Dana before acting.",
  numbers: "Never state a number it cannot source.",
  /** Q8 — the free-text box. Practice-specific knowledge no checkbox covers. */
  additional:
    "Never contact anyone at Harrowfield Trust directly — that relationship goes "
    + "through Dana, without exception, including their project team. "
    + "The Monday review is the one deadline that does not move: if something is "
    + "missing at 09:00, say so in the review rather than delaying it. "
    + "Marcus is the tie-break on anything about programme; Sofia on anything about "
    + "the model or the CDE. "
    + "Treat any fee or variation figure as draft until Dana has said otherwise in writing.",
} as const;

/**
 * Interview answers, in the order the Chief of Staff asks. Written the way a
 * principal actually answers — specific, slightly rambling, with real nouns —
 * because a proposal generated from crisp bullet points proves nothing about a
 * proposal generated from how people talk.
 */
export const INTERVIEW_ANSWERS: string[] = [
  "We're a 34-person architecture practice — civic, education and some mixed-use. "
    + "Seven live jobs at the moment, biggest is an 180-unit masterplan at outline "
    + "planning, smallest is a school refurb that should have finished in March.",
  "Chasing people. Most of my week is finding out where things are. The consultants "
    + "are the worst of it — I'll discover on Monday that structures have been sitting "
    + "on an RFI since the Tuesday before, and by then we've lost a week we can't get back.",
  "In ninety days I want the Monday review to already exist when I sit down. Status "
    + "per job, what's at risk and why, and what's waiting on someone outside the "
    + "practice with a number of days attached. If something couldn't be sourced I want "
    + "that said plainly rather than a gap.",
  "Marcus runs delivery and knows the programme. Sofia owns the technical side and the "
    + "coordination log. Tomás does resourcing and hiring. Those three plus me.",
  "Start with the Monday review. The RFI chasing falls out of it, and the scope "
    + "changes can wait until that's working — though it's the one that costs us money.",
  "Yes, that's right. Go ahead and propose the team.",
];

/** Tasks created by hand during the walkthrough, to test assignment and execution. */
export const MANUAL_TASKS = [
  {
    title: "Summarise what you can see about this practice and what you cannot",
    body:
      "Report what you actually have access to in this workspace: agents, goals, tasks, "
      + "people. Then state plainly what you would need in order to assemble the Monday "
      + "review, and which of those things are missing today. Do not invent project data.",
  },
] as const;

/** A unique suffix so repeated runs don't collide on workspace or email. */
export function runSuffix(stamp: number): string {
  return String(stamp).slice(-6);
}
