/**
 * The "How it works" storyboard: one source of truth for the copy and timing,
 * shared by every visual treatment. The player turns it into captions, chapter
 * chips and the progress ruler; StoryText turns it into the reduced-motion and
 * screen-reader version.
 *
 * The caption lines are approved copy. Do not reword them here: claims.test.ts
 * pins them verbatim, so a change has to be deliberate. The mechanisms behind
 * each line are in releases/v2026.1031.0.md ("Features") and
 * packages/mcp-server/src/journey.ts (the team plan and
 * requireBoardApprovalForNewAgents).
 *
 * chapters[]    { id, n, label, status }   chips on the stage (labels about 12 characters for phones)
 * steps[].ch    chapter index, or -1 for the end card (the camera pulls back, the caption shows the tagline)
 * steps[].dur   seconds; a step's caption lines share it evenly (2.5 to 4.5 s per line)
 * steps[].lines caption lines, shown one after another
 */

export interface StoryChapter {
  id: string;
  n: string;
  label: string;
  status: string;
}

export interface StoryStep {
  id: string;
  ch: number;
  title: string;
  dur: number;
  lines: string[];
}

export interface Story {
  brand: string;
  chapters: StoryChapter[];
  steps: StoryStep[];
  /** Example names used by the illustration. */
  names: { you: string; cos: string; agents: string[] };
}

export const STORY: Story = {
  brand: "AgentDash",
  names: { you: "You", cos: "Chief of Staff", agents: ["Research", "Sales", "Support"] },
  chapters: [
    { id: "plan", n: "01", label: "Plan", status: "Live" },
    { id: "profile", n: "02", label: "Profile", status: "Live" },
    { id: "access", n: "03", label: "Access", status: "Live" },
    { id: "scorecard", n: "04", label: "Scorecard", status: "Live" },
    { id: "decide", n: "05", label: "Decide", status: "Live" },
  ],
  steps: [
    { id: "brief", ch: 0, title: "Brief", dur: 4.4, lines: [
      "Tell the Chief of Staff about the business. It drafts a team plan." ] },
    { id: "confirm", ch: 0, title: "Confirm", dur: 4.6, lines: [
      "You confirm the plan. Hires beyond it wait for your approval." ] },
    { id: "profile", ch: 1, title: "Profile", dur: 4.4, lines: [
      "Each agent has an operating profile: its job, written by a person." ] },
    { id: "proposal", ch: 1, title: "Proposal", dur: 4.8, lines: [
      "A change to a profile is a proposal. It applies only after it's approved." ] },
    { id: "rules", ch: 2, title: "Rules", dur: 4.4, lines: [
      "Access rules set what an agent can see, do, and who it can talk to." ] },
    { id: "shadow", ch: 2, title: "Shadow", dur: 4.6, lines: [
      "Start in shadow: AgentDash logs what it would refuse, and refuses nothing." ] },
    { id: "enforce", ch: 2, title: "Enforce", dur: 4.6, lines: [
      "Switch to enforce: out-of-scope actions are refused, with the reason." ] },
    { id: "reachable", ch: 2, title: "Reachable", dur: 4.4, lines: [
      "Its accountable person, steward and admins are always reachable." ] },
    { id: "scorecard", ch: 3, title: "Scorecard", dur: 4.6, lines: [
      "Every agent gets a scorecard from real records: work owed, quality, cost." ] },
    { id: "unknown", ch: 3, title: "Unknown", dur: 4.0, lines: [
      "What isn't known shows as unknown, not as a guess." ] },
    { id: "recommend", ch: 4, title: "Recommend", dur: 4.4, lines: [
      "A performance manager reads the scorecards and recommends changes." ] },
    { id: "people", ch: 4, title: "People decide", dur: 4.6, lines: [
      "Only people decide. A pause recommendation never pauses an agent." ] },
    { id: "end", ch: -1, title: "", dur: 5, lines: [
      "Agents managed like staff. People stay in charge." ] },
  ],
};

/** The plain line shown directly under the stage. */
export const ILLUSTRATION_NOTE = "An illustration of how AgentDash works, not a recording. Names are examples.";

/** Every caption line, in order (the still version and the tests read this). */
export function storyLines(story: Story = STORY): string[] {
  return story.steps.flatMap((s) => s.lines);
}

/** Start time of each step, in seconds, and the total length. */
export function storyTimes(story: Story = STORY): { starts: number[]; total: number } {
  const starts: number[] = [];
  let total = 0;
  for (const s of story.steps) {
    starts.push(total);
    total += s.dur;
  }
  return { starts, total };
}
