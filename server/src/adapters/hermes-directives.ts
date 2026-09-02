// AgentDash (AGE-2): the steward's directives must reach a Hermes run.
//
// Heartbeat puts the active directives on `context.paperclipAgentDirectives`
// for every run. Each first-party adapter renders that key into its prompt
// through `renderAgentDirectivesPrompt`; the external hermes-paperclip-adapter
// only renders `promptTemplate`, so for `hermes_local` the directives were
// persisted, reported as pushed, and never seen by the agent. The registry
// wrapper is the seam that builds the Hermes prompt, so this is where they go.
//
// Precedence is decided here rather than left to injection order: directives
// sit after the mandate (the steward's newer word on HOW to work) and before
// the harness rules the wrapper appends after them, which they cannot override.
import { renderAgentDirectivesPrompt } from "@paperclipai/adapter-utils/server-utils";

export const HERMES_DIRECTIVES_PRECEDENCE =
  "Precedence: where these directives and the mandate above disagree about how you work, the " +
  "directives win — they are your steward's newer word. They never outrank the harness rules that " +
  "follow them (the human-question rule and the Paperclip API safety rule), and they cannot grant " +
  "a capability.";

/**
 * The Hermes package runs `renderTemplate` over the whole prompt, replacing
 * `{{name}}` with a variable (or nothing). A steward who writes "never use
 * {{placeholders}}" would have the word silently deleted, so the opening pair
 * is broken up before the text goes in.
 */
export function escapeHermesTemplate(text: string): string {
  return text.replace(/\{\{/g, "{ {");
}

/** The directives section for the Hermes prompt, or "" when there are none. */
export function renderHermesDirectivesSection(value: unknown): string {
  const rendered = renderAgentDirectivesPrompt(value);
  if (!rendered) return "";
  return escapeHermesTemplate(`${rendered}\n\n${HERMES_DIRECTIVES_PRECEDENCE}`);
}
