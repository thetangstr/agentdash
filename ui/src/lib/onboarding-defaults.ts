/**
 * AgentDash (scan 2, E6): the onboarding wizard's prefilled answers, kept out
 * of the component so the wording can be tested.
 */

/**
 * The wizard's preselected way to run the first agent, and the one option it
 * marks "Recommended" (every card used to say Recommended, which recommends
 * nothing). Hermes, for the reasons given where the wizard declares
 * `adapterType`: it runs where the server's own default adapter runs, and it
 * does not switch a harness's permission system off.
 */
export const WIZARD_DEFAULT_ADAPTER_TYPE = "hermes_local";

/** Whether an adapter card gets the "Recommended" badge: only the default. */
export function isRecommendedWizardAdapter(adapterType: string): boolean {
  return adapterType === WIZARD_DEFAULT_ADAPTER_TYPE;
}

// Written to the owner's own agent, in the owner's voice ("me"), not about a
// third party called "the operator".
export const DEFAULT_TASK_TITLE = "Get oriented and tell me how to use you";

export const DEFAULT_TASK_DESCRIPTION = `You are the Chief of Staff (CoS). You help me route work, coordinate agents, and keep the company moving forward.

- help me get set up and oriented
- coordinate and delegate tasks to other agents as they are hired
- point out anything that is stuck, and keep track of my priorities`;
