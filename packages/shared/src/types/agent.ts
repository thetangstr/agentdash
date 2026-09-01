import type {
  AgentAdapterType,
  AgentAutonomy,
  ModelProfileKey,
  PauseReason,
  AgentRole,
  AgentStatus,
} from "../constants.js";
import type {
  CompanyMembership,
  PrincipalPermissionGrant,
} from "./access.js";

export interface AgentPermissions {
  canCreateAgents: boolean;
}

export interface AgentModelProfileConfig {
  enabled?: boolean;
  label?: string;
  adapterConfig: Record<string, unknown>;
}

export interface AgentRuntimeConfig extends Record<string, unknown> {
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileConfig>>;
}

export type AgentInstructionsBundleMode = "managed" | "external";

export interface AgentInstructionsFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
}

export interface AgentInstructionsFileDetail extends AgentInstructionsFileSummary {
  content: string;
}

export interface AgentInstructionsBundle {
  agentId: string;
  companyId: string;
  mode: AgentInstructionsBundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
}

export interface AgentAccessState {
  canAssignTasks: boolean;
  taskAssignSource: "explicit_grant" | "agent_creator" | "ceo_role" | "none";
  membership: CompanyMembership | null;
  grants: PrincipalPermissionGrant[];
}

export interface AgentChainOfCommandEntry {
  id: string;
  name: string;
  role: AgentRole;
  title: string | null;
}

/**
 * The person an agent belongs to and is accountable to.
 *
 * `name` and `email` are nullable because `agent_stewardships.user_id` is a
 * durable principal id rather than a foreign key into the auth user table, so a
 * steward can have no auth row at all. Label a steward name -> email -> userId,
 * which is the order the member list already uses.
 */
export interface AgentSteward {
  userId: string;
  name: string | null;
  email: string | null;
  since: Date;
}

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  urlKey: string;
  role: AgentRole;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string | null;
  adapterType: AgentAdapterType;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: AgentRuntimeConfig;
  defaultEnvironmentId?: string | null;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  permissions: AgentPermissions;
  lastHeartbeatAt: Date | null;
  metadata: Record<string, unknown> | null;
  /**
   * The human owner of record (AGE-13). Set from the board actor at creation,
   * backfilled to each company's first admin, and null when an agent was hired
   * by another agent rather than a person. The server has always sent this
   * column (agent reads spread the full row); this types it for the UI.
   */
  createdByUserId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * Optional on the type, always present on the wire from
   * `GET /companies/:companyId/agents` and the agent detail routes. It stays
   * optional here because `Agent` is also the shape of rows built from config
   * revisions and other places that never carried a stewardship.
   */
  steward?: AgentSteward | null;
  /**
   * Whether this agent mirrors one person or runs on its own.
   *
   * Optional on the type and always present on the wire from the agent list and
   * detail routes, for the same reason `steward` is: `Agent` also describes rows
   * rebuilt from config revisions, which never carried either field. Treat a
   * missing value as `stewarded`.
   */
  autonomy?: AgentAutonomy;
  /**
   * The human answerable for this agent's work, or null when nobody is.
   *
   * `via` says where the answer came from — `steward` for a personal agent,
   * `assignment` for an autonomous one — which is what lets a screen explain
   * itself instead of showing a name with no reason attached. Null on a
   * stewarded agent means the pairing was never finished, and the board says so
   * rather than implying the agent is autonomous.
   */
  accountable?: AgentAccountableParty | null;
}

/**
 * Who answers for an agent, and why them.
 *
 * Deliberately not the same shape as `AgentSteward`: a steward is a pairing with
 * a start date, while this is the answer to "who do I take this to?" — which for
 * an autonomous agent is somebody who does not steward it at all.
 */
export interface AgentAccountableParty {
  userId: string;
  name: string | null;
  email: string | null;
  via: "steward" | "assignment";
}

export interface AgentDetail extends Agent {
  chainOfCommand: AgentChainOfCommandEntry[];
  access: AgentAccessState;
}

export interface AgentKeyCreated {
  id: string;
  name: string;
  token: string;
  createdAt: Date;
}

export interface AgentConfigRevision {
  id: string;
  companyId: string;
  agentId: string;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  source: string;
  rolledBackFromRevisionId: string | null;
  changedKeys: string[];
  beforeConfig: Record<string, unknown>;
  afterConfig: Record<string, unknown>;
  createdAt: Date;
}

export type AdapterEnvironmentCheckLevel = "info" | "warn" | "error";
export type AdapterEnvironmentTestStatus = "pass" | "warn" | "fail";

export interface AdapterEnvironmentCheck {
  code: string;
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string | null;
  hint?: string | null;
}

export interface AdapterEnvironmentTestResult {
  adapterType: string;
  status: AdapterEnvironmentTestStatus;
  checks: AdapterEnvironmentCheck[];
  testedAt: string;
}
