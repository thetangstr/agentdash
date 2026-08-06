/**
 * The owner's first goal, and the collection work underneath it.
 *
 * A goal is the unit the Chief of Staff actually drives, and an owner meeting
 * AgentDash for the first time has no way to know what one should look like —
 * so this offers a worked example they can accept, edit, or replace. The example
 * is deliberately a recurring, dreaded, multi-person deliverable rather than a
 * tidy one-liner: a goal with exactly one obvious task teaches nothing about why
 * an agent workforce exists, whereas "assemble this from four people's answers"
 * is the shape the whole product is for.
 *
 * The tasks matter as much as the title. One assembly task on the Chief plus one
 * collection task per contributor is the structure the handoff brief later
 * reassigns to the agents it creates — so the goal set here is what the coding
 * agent picks up, rather than something it has to invent.
 */

export interface FirstGoalDraft {
  title: string;
  description: string;
  /** The first entry is the assembly task; the rest are collection tasks. */
  tasks: string[];
}

export interface FirstGoalExample extends FirstGoalDraft {
  key: string;
  /** What the owner picks from. */
  label: string;
}

const boardPack = (owner: string): FirstGoalExample => ({
  key: "board_pack",
  label: "A recurring pack or report that takes days of chasing",
  title: "Weekly board pack, assembled without a fire drill",
  description:
    `${owner} should be able to ask once and get a board-ready pack: delivery status, ` +
    `systems and platform risk, and hiring — each contribution attributed to whoever ` +
    `produced it, and every number sourced. Today this takes days of chasing people.`,
  tasks: [
    "Assemble this week's pack",
    "Collect delivery status and any commitment at risk",
    "Collect systems and platform risk, and what changed this week",
    "Collect hiring pipeline and anything blocking delivery",
  ],
});

const cleanup = (owner: string): FirstGoalExample => ({
  key: "cleanup",
  label: "Clean up files or repositories nobody has audited",
  title: "Know what is stale, and delete nothing without a human saying so",
  description:
    `Inventory what has gone stale across our documents and repositories, then put a ` +
    `deletion proposal in front of a person. No agent deletes anything. ${owner} wants ` +
    `the list and the reasoning, not a fait accompli.`,
  tasks: [
    "Produce the deletion proposal for a human to approve",
    "Inventory stale documents and who last touched them",
    "Inventory stale repositories and branches",
    "Flag anything that looks risky to remove, and why",
  ],
});

const waiting = (owner: string): FirstGoalExample => ({
  key: "waiting",
  label: "Stop people quietly waiting on us",
  title: "Nobody waits on us without someone knowing",
  description:
    `Every week, surface who is waiting on a reply from us — clients, candidates, ` +
    `partners — how long they have waited, and who owes them the answer. ${owner} should ` +
    `find out from this, not from an unhappy email.`,
  tasks: [
    "Assemble the weekly who-is-waiting review",
    "Collect clients waiting on a reply or a decision",
    "Collect candidates waiting on us, and for how long",
    "Name the owner for each item and what unblocks it",
  ],
});

/**
 * The examples, in the order they are offered. `board_pack` is first because it
 * is the one almost every company recognises immediately.
 */
export function firstGoalExamples(owner: string): FirstGoalExample[] {
  const who = owner.trim() || "You";
  return [boardPack(who), cleanup(who), waiting(who)];
}

export function defaultFirstGoal(owner: string): FirstGoalDraft {
  const [first] = firstGoalExamples(owner);
  return { title: first.title, description: first.description, tasks: [...first.tasks] };
}

/**
 * The payload for each task under the goal.
 *
 * Every task is linked to the goal with `goalId` and assigned to the Chief of
 * Staff for now. Both matter: the scripted version of this flow created the same
 * four tasks with no `goalId`, so they were never actually under the goal even
 * though the output said they were — a goal that looks populated and is empty is
 * worse than an obviously empty one, because nobody goes looking.
 */
export function buildFirstGoalTaskPayloads(input: {
  goalId: string;
  assigneeAgentId: string;
  tasks: string[];
}) {
  return input.tasks
    .map((title) => title.trim())
    .filter((title) => title.length > 0)
    .map((title) => ({
      title,
      goalId: input.goalId,
      assigneeAgentId: input.assigneeAgentId,
      status: "todo" as const,
    }));
}

/** The goal itself: company level, active, and owned by the Chief of Staff. */
export function buildFirstGoalPayload(input: {
  title: string;
  description: string;
  ownerAgentId: string;
}) {
  const description = input.description.trim();
  return {
    title: input.title.trim(),
    ...(description ? { description } : {}),
    level: "company" as const,
    status: "active" as const,
    ownerAgentId: input.ownerAgentId,
  };
}
