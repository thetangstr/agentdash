# Claude Code Overlap Audit

Date: 2026-03-31
Audience: AgentDash maintainers evaluating what to absorb from the Claude Code harness family without breaking Paperclip's core engine

## Executive Summary

The leaked Claude Code tree is strongest where it treats orchestration as first-class runtime structure: tools, commands, tasks, teams, skills, permission context, and remote/local execution boundaries are all explicit. That is the part worth learning from.

The part we should not copy is the overall runtime shape. Claude Code is an interactive, terminal-first, REPL-centered harness that owns the model loop directly. Paperclip and AgentDash are company-scoped, server-orchestrated control planes built around companies, issues/comments, heartbeats, adapters, approvals, budgets, and board visibility. If we import the Claude Code architecture naively, we will pull AgentDash toward a chat harness and away from its control-plane product.

Bottom line:

- leverage the metadata model, orchestration primitives, and remote execution intuitions
- translate them into AgentDash objects and server APIs
- do not replace Paperclip's adapter-driven heartbeat engine with a Claude-style monolithic query runtime

## Audit Scope

This audit focused on the overlapping architecture surfaces, not every file in both trees.

### AgentDash / Paperclip surfaces reviewed

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `ARCHITECTURE.md`
- `server/src/services/heartbeat.ts`
- `server/src/services/issues.ts`
- `server/src/services/agents.ts`
- `server/src/services/workspace-runtime.ts`
- `server/src/services/agent-instructions.ts`
- `server/src/services/company-skills.ts`
- `server/src/services/plugin-runtime-sandbox.ts`
- `server/src/routes/company-skills.ts`
- `server/src/routes/skills-registry.ts`
- `server/src/routes/plugins.ts`
- `packages/adapter-utils/src/types.ts`
- `packages/adapters/claude-local/src/index.ts`
- `packages/plugins/sdk/src/types.ts`
- `packages/plugins/sdk/src/define-plugin.ts`
- `packages/shared/src/types/company-skill.ts`
- `packages/shared/src/types/heartbeat.ts`
- `packages/shared/src/types/plugin.ts`

### Claude Code surfaces reviewed

- `src/commands.ts`
- `src/tools.ts`
- `src/Tool.ts`
- `src/Task.ts`
- `src/QueryEngine.ts`
- `src/types/command.ts`
- `src/skills/loadSkillsDir.ts`
- `src/utils/plugins/loadPluginCommands.ts`
- `src/utils/forkedAgent.ts`
- `src/utils/toolSearch.ts`
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tools/SkillTool/SkillTool.ts`
- `src/tools/SendMessageTool/SendMessageTool.ts`
- `src/tools/TaskCreateTool/TaskCreateTool.ts`
- `src/tools/TeamCreateTool/TeamCreateTool.ts`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx`
- `src/utils/swarm/backends/types.ts`
- `src/commands/tasks/tasks.tsx`
- `src/commands/skills/skills.tsx`
- `src/commands/agents/agents.tsx`
- `src/commands/plan/plan.tsx`
- `src/bridge/*` inventory

## What Claude Code Actually Is

The leaked harness is not "just a coding agent."

It is a structured runtime with five major traits:

1. Tool-first execution model
   The model is given a large, explicit tool surface and the runtime is built around tool invocation, permission checks, progress tracking, and context shaping.

2. Command layer as product surface
   Slash commands are not a thin wrapper. They are a real user-facing layer that exposes skills, plans, tasks, teams, plugins, remote setup, review, and workflow state.

3. Orchestration objects are first-class
   Tasks, remote tasks, teammates, teams, mailboxes, worktrees, and plan mode are concrete runtime objects with state transitions and UI.

4. Skills are metadata-driven assets
   Skills carry rich metadata like `allowedTools`, `whenToUse`, `paths`, `context`, `agent`, `effort`, and `userInvocable`, and can be loaded dynamically or conditionally.

5. One monolithic interactive harness owns the loop
   The same runtime owns prompt assembly, tool exposure, permission prompts, task state, background work, subagents, remote sessions, and local terminal UX.

This last point is the key architectural difference from Paperclip.

## What Paperclip / AgentDash Actually Is

Paperclip's inherited core, and AgentDash's product direction on top of it, are different in three important ways:

1. Server control plane, not REPL harness
   The server owns heartbeats, task state, workspaces, cost events, approvals, and activity logs. Adapters execute work externally and report back.

2. Company-scoped work model
   The canonical objects are companies, agents, issues, issue comments, heartbeat runs, approvals, budgets, and projects. This is explicit in `doc/PRODUCT.md` and `doc/SPEC-implementation.md`.

3. Extension boundaries already exist
   AgentDash already has:
   - adapter interfaces
   - execution workspace/runtime services
   - company skill storage and import
   - a versioned skill registry route surface
   - a sandboxed plugin SDK and plugin worker model

That means AgentDash does not need Claude Code's monolithic runtime. It needs a better control-plane representation of the same ideas.

## Overlap Matrix

### Safe To Leverage Directly

#### 1. Skill metadata model

Claude Code's skill frontmatter is materially better than our current minimal company skill shape.

Fields worth adopting into AgentDash:

- `whenToUse`
- `allowedTools`
- `executionContext`
- `agent`
- `effort`
- `paths`
- `userInvocable`
- optional hooks metadata

Why it fits:

- AgentDash already has `company_skills`, project scanning, import/update flows, and a skills registry workflow.
- This is a schema and policy improvement, not a runtime rewrite.

Recommended adaptation:

- extend company skill metadata and validators
- keep runtime installation/sync through adapters
- surface these fields in board UI and skill analytics

#### 2. Conditional skill activation

Claude Code's `paths`-based dynamic activation is a good idea.

Why it fits:

- AgentDash already scans project workspaces for skills
- we already model project workspaces and execution workspaces
- path-triggered skill relevance maps well to project context and execution workspace policy

Recommended adaptation:

- add "activation conditions" to company skills
- evaluate them server-side when building run context for an issue or workspace
- log which skills were activated and why

#### 3. Deferred discovery instead of always-inlining everything

Claude Code's tool search / deferred loading approach is a good pattern for keeping context windows under control.

Why it fits:

- AgentDash will eventually have many company skills, plugin tools, adapter tools, and integration tools
- the problem is real for us even though the current product is not REPL-first

Recommended adaptation:

- add a run-context shaping layer that ranks and exposes only relevant skills/tools
- make this adapter-agnostic
- treat it as context budgeting for heartbeats, not as a REPL tool picker

#### 4. Remote execution bridge intuition

Claude Code's split between local tasks, remote tasks, and bridge/session infrastructure is directionally useful.

Why it fits:

- AgentDash already has heartbeat runs, execution workspaces, runtime services, and adapter-managed sessions
- the future SaaS product will need hosted execution and remote run lifecycle handling

Recommended adaptation:

- grow the existing adapter/runtime service model into a clearer hosted execution bridge
- keep the public contract at the adapter boundary
- do not expose bridge internals as a first-class user interaction model

### Leverage, But Translate Hard

#### 5. Explicit delegation primitives

Claude Code is right that delegation should be explicit.

But the native Claude Code primitives are:

- `AgentTool`
- `TaskCreate/Get/List/Update`
- `TeamCreate`
- `SendMessage`
- teammate mailboxes

These do not fit Paperclip as-is.

Recommended translation for AgentDash:

- keep the canonical work object as `issue` plus `issue_comment`
- add explicit delegation metadata to heartbeat runs or a new delegated-run table
- allow one run to create child runs or child issues with visibility to the board
- show the delegation graph in the UI

Do not translate delegation into an internal mailbox system as the primary work model.

#### 6. Plan mode and approval checkpoints

Claude Code's plan mode is not a product fit directly, but the underlying idea is useful:

- a worker can switch into a plan-producing mode
- execution pauses at a human approval boundary
- the approved plan becomes part of the task context

Recommended translation for AgentDash:

- attach plan artifacts to issues or approvals
- use existing approval objects and board UI instead of REPL permission mode
- model "plan requested", "plan submitted", "plan approved", and "plan rejected" as auditable state

#### 7. Forked skill execution

Claude Code's `fork` execution context for skills is useful as an optimization and isolation primitive.

But in AgentDash, the right mapping is not "spawn a hidden subagent inside the interactive loop."

Recommended translation:

- represent forked skill execution as either:
  - a delegated heartbeat run
  - an adapter-local sub-run
  - a workflow step within an execution workspace

Keep the lifecycle visible in the control plane.

### Do Not Absorb Into Core

#### 8. REPL-centered query engine

Claude Code's `QueryEngine`, prompt cache orchestration, live tool UI wiring, and inline permission UX are excellent for an interactive terminal product.

They conflict with Paperclip's core engine because:

- Paperclip is adapter-driven, not provider-loop-driven
- the server is supposed to orchestrate many runtimes, not become one runtime
- AgentDash must stay provider-agnostic and company-scoped

Recommendation:

- only borrow adapter-local optimizations from this area
- do not move server orchestration into a central Claude-style query engine

#### 9. Teammate mailboxes as the primary communication fabric

Claude Code's `SendMessageTool` and teammate inbox model are a hard conceptual mismatch with the current product.

Paperclip V1 explicitly says communication is tasks plus comments only.

Recommendation:

- do not build free-floating agent mailboxes into core
- if direct agent messaging is ever added, implement it as a secondary, auditable layer attached to issues, projects, or runs

#### 10. tmux / iTerm2 / in-process swarm backends

These are clever power-user ergonomics for a terminal harness, but they conflict with AgentDash's long-term product direction:

- multi-company server operation
- browser-first board UX
- hosted execution
- self-hosted enterprise deployment
- adapter abstraction

Recommendation:

- do not pull pane-based swarm orchestration into core
- if desired, keep it as a developer-only adapter or operator tool outside the central control plane

#### 11. Prompt-defined command surface as the primary extensibility model

Claude Code merges built-ins, skills, plugin commands, bundled commands, and internal commands into one slash-command layer.

AgentDash already has better boundaries available:

- company skill registry
- plugin manifest and SDK
- adapter contracts
- board UI routes

Recommendation:

- do not make slash commands the center of AgentDash extension architecture
- let skills stay declarative and company-scoped
- let plugins stay sandboxed and capability-scoped
- let adapters own runtime-specific capabilities

## Conflicts With Paperclip's Core Engine

These are the most important direct conflicts.

### 1. Runtime ownership conflict

Claude Code owns the model loop directly.
Paperclip owns orchestration and delegates execution to adapters.

If we copy Claude Code too literally, we erase the adapter boundary and bias the platform toward one provider-specific runtime style.

### 2. Communication model conflict

Claude Code is comfortable with ad hoc inter-agent messaging.
Paperclip explicitly chose issues/comments as the canonical collaboration surface.

This is a product-level conflict, not just an implementation detail.

### 3. UX conflict

Claude Code is built around an interactive operator sitting in the loop.
AgentDash is built around a board operator viewing a company and intervening through structured objects.

Importing REPL mental models into core would degrade the board-level product.

### 4. Permission model conflict

Claude Code's permission system is local and runtime-interactive.
AgentDash needs company policy, board approvals, adapter constraints, auditability, and eventually multi-tenant safety.

These are related problems, but not the same problem.

### 5. Execution backend conflict

Claude Code has local backends for terminals, panes, and in-process teammates.
AgentDash needs server-side heartbeats, workspaces, runtime services, and eventually hosted execution fleets.

### 6. Extension conflict

Claude Code's skills and plugins are loaded into the main harness process.
AgentDash already has a stronger long-term direction:

- sandboxed plugin workers
- DB-backed company skills
- explicit company access control
- adapter-managed skill install/sync

We should strengthen that system rather than bypass it.

## What To Build Next

### 1. Upgrade the company skill model

Add the Claude-style metadata we actually want:

- `whenToUse`
- `allowedTools`
- `activationPaths`
- `executionContext`
- `targetAgentType`
- `effort`
- `userInvocable`
- `hooks`

This is the highest-signal improvement with the lowest architecture risk.

### 2. Add explicit delegation graph support

AgentDash should know:

- which run delegated to which child run
- which issue produced which sub-issue
- which agent asked which agent to do what
- what the outcome was

Recommended implementation direction:

- extend heartbeat runs with parent/delegation metadata or add a dedicated run edge table
- render delegation in board UI
- keep comments/issues as the canonical human-readable coordination surface

### 3. Add context shaping for skills and tools

Build a service that decides which skills and plugin tools are relevant to a run based on:

- company
- agent
- project
- issue
- workspace paths
- permissions
- cost/budget policy

This is the AgentDash version of Claude Code's deferred tool discovery.

### 4. Grow the existing execution workspace/runtime layer into a hosted bridge

Do this through:

- adapter runtime service APIs
- remote execution leases
- session identifiers
- board-visible run state

Do not do it by embedding a Claude-style bridge REPL in the server core.

### 5. Add plan artifacts and approval checkpoints to issues

Use the Claude plan-mode intuition, but express it in AgentDash objects:

- issue requests plan
- agent submits plan artifact
- board approves or rejects
- run proceeds or is cancelled

This fits the product and keeps the audit trail intact.

## Recommended Non-Goals

For the next phase, do not:

- build a chat-first multi-agent mailbox layer
- build tmux or iTerm2 swarm backends into core
- replace heartbeat adapters with a central query engine
- center extensibility on slash commands
- copy provider-specific prompt-cache mechanics into server orchestration

## Architecture Principle

Treat Claude Code as a source of patterns, not a source of architecture.

The right question is not:

"How do we add Claude Code into Paperclip?"

The right question is:

"Which Claude Code ideas improve AgentDash's company control plane when translated into our existing objects: companies, agents, issues, comments, heartbeats, skills, plugins, workspaces, budgets, and approvals?"

That translation layer is the difference between a product that stays aligned with Paperclip's core engine and a product that accidentally turns into a terminal harness.
