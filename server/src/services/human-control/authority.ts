// AgentDash: finite foundation/native workforce authority on the actual Request.
// Receipts are factual positive rows. This module owns no domain policy grants.
import type { Request } from 'express';
import { and, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { agents, agentStewardships, authUsers, companies, companyContext, companyMemberships,
  companySkills, documents, goals, issues, issueDocuments, issueThreadInteractions,
  issueWorkProducts, principalPermissionGrants, projects, projectAccess, verdicts,
  workforceEnrollments, type Db } from '@paperclipai/db';
import { type AskUserQuestionsInteraction, type CreateIssueThreadInteraction, resolveWorkforceTemplate } from '@paperclipai/shared';
import { badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { actorHumanRole, assertCompanyAccess, assertCanSetCompanyDirection } from '../../routes/authz.js';
import { assertProjectVisible } from '../../routes/visibility.js';
import { currentBoardIdentity, type BoardIdentityWitness } from '../current-board-identity.js';
import { hydrateInteraction, resolveQuestionCreateInput } from '../issue-thread-interactions.js';
import { agentAccountabilityService } from '../agent-accountability.js';
import { getDefaultCompanyGoal } from '../goals.js';
import { workforceService, type WorkforceSkillStages } from '../workforce.js';
import { boardAuthService } from '../board-auth.js';
import { waitingOnYouService } from '../waiting-on-you.js';
import type { WorkforceQuestionDependency } from '../workforce-inputs.js';

type Reader = Pick<Db, 'select'>;
export type FoundationSelection = {
  companyId: string;
  operationId: string;
  input: Record<string, unknown>;
  native?: boolean;
  recovery?: boolean;
  skillKeys?: readonly string[];
  /** Read-only operations hold the company row FOR KEY SHARE; writers take the company mutex. */
  readOnly?: boolean;
};
type Collection = { witnesses: Map<string, BoardIdentityWitness>; sealed: boolean };
const rowLock = (table: SQLWrapper, id: string) => sql`select id from ${table} where id = ${id} for share`;
function record(state: Collection, key: string, lock: SQL) {
  if (state.sealed && !state.witnesses.has(key)) throw conflict('Current authority changed during acceptance');
  if (!state.sealed) state.witnesses.set(key, { key, lock });
}
function row(state: Collection, kind: string, table: SQLWrapper, id: string) { record(state, `${kind}:${id}`, rowLock(table, id)); }
export function questionReplacement(q: AskUserQuestionsInteraction): CreateIssueThreadInteraction {
  const { answerOwnerUserId: _owner, ...payload } = q.payload;
  return { kind: 'ask_user_questions', continuationPolicy: q.continuationPolicy, title: q.title,
    summary: q.summary, sourceCommentId: q.sourceCommentId, sourceRunId: q.sourceRunId,
    payload: { ...payload, replacesInteractionId: q.id } };
}

export function foundationAuthority(req: Request) {
  // Capture before the first await, once across initial acceptance and skill stages.
  const identity = currentBoardIdentity(req);
  const original = { ...req.actor };
  async function principal(reader: Reader, companyId: string, state: Collection) {
    const facts = await identity.read(reader, companyId);
    for (const witness of facts.witnesses) record(state, witness.key, witness.lock);
    if (facts.actorRefresh) req.actor = { ...original, ...facts.actorRefresh,
      memberships: facts.actorRefresh.memberships.map(member => ({ ...member })),
      companyIds: [...facts.actorRefresh.companyIds] };
    return facts;
  }
  function sources(reader: Reader, selection: FoundationSelection, state: Collection) {
    const companyId = selection.companyId;
    async function member(userId: string | null | undefined, required = true) {
      if (!userId) { if (required) throw notFound('Question not found'); return null; }
      const [value] = await reader.select().from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'),
        eq(companyMemberships.principalId, userId), eq(companyMemberships.status, 'active')));
      if (!value) { if (required) throw notFound('Question not found'); return null; }
      row(state, '09:membership', companyMemberships, value.id);
      return value;
    }
    async function agent(agentId: string) {
      const [value] = await reader.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
      if (!value) throw notFound('Agent not found');
      row(state, '02:agent', agents, value.id);
      return value;
    }
    async function enrollmentRow(agentId: string) {
      await agent(agentId);
      const [value] = await reader.select().from(workforceEnrollments).where(and(eq(workforceEnrollments.companyId, companyId), eq(workforceEnrollments.agentId, agentId)));
      if (value) row(state, '14:enrollment', workforceEnrollments, value.id);
      return value;
    }
    async function enrollment(agentId: string, references = true) {
      const value = await enrollmentRow(agentId);
      if (value) {
        if (value.goalId) await goal(value.goalId);
        if (references && value.firstJobIssueId) await issue(value.firstJobIssueId);
      }
      return value;
    }
    async function goal(id: string) {
      const [value] = await reader.select().from(goals).where(and(eq(goals.companyId, companyId), eq(goals.id, id)));
      if (!value) throw notFound('Company goal not found');
      row(state, '03:goal', goals, value.id);
    }
    async function issue(id: string) {
      const [value] = await reader.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, id)));
      if (!value || value.hiddenAt) throw notFound('Issue not found');
      row(state, '20:issue', issues, value.id);
      if (value.projectId) {
        const [project] = await reader.select().from(projects).where(and(eq(projects.id, value.projectId), eq(projects.companyId, companyId)));
        if (!project) throw notFound('Project not found');
        await assertProjectVisible(reader, req, project);
        row(state, '04:project', projects, project.id);
        if (req.actor.userId) {
          const access = await reader.select().from(projectAccess).where(and(eq(projectAccess.projectId, project.id), eq(projectAccess.principalType, 'user'), eq(projectAccess.principalId, req.actor.userId)));
          for (const value of access) record(state, `12:project_access:${value.projectId}:user:${value.principalId}`,
            sql`select project_id from ${projectAccess} where project_id = ${value.projectId} and principal_type = 'user' and principal_id = ${value.principalId} for share`);
        }
      }
      return value;
    }
    async function ownerFacts(agentId: string) {
      await agent(agentId);
      const stewards = await reader.select().from(agentStewardships).where(and(eq(agentStewardships.companyId, companyId), eq(agentStewardships.agentId, agentId), isNull(agentStewardships.endedAt)));
      for (const value of stewards) row(state, '15:stewardship', agentStewardships, value.id);
      const owner = await agentAccountabilityService(reader).escalationUserId(companyId, agentId);
      if (owner) {
        await member(owner, false);
        const [profile] = await reader.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, owner));
        if (profile) row(state, '00:user', authUsers, profile.id);
      }
      return owner;
    }
    async function creation(issueId: string, input: CreateIssueThreadInteraction) {
      const job = await issue(issueId);
      if (job.assigneeAgentId) await enrollment(job.assigneeAgentId, false);
      if (input.kind === 'ask_user_questions' && input.payload.replacesInteractionId) {
        const [prior] = await reader.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, input.payload.replacesInteractionId), eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, job.id)));
        if (!prior) throw notFound('Question not found');
        row(state, '24:interaction', issueThreadInteractions, prior.id);
      }
      const resolved = await resolveQuestionCreateInput(reader, job, input, { userId: req.actor.userId });
      if (resolved.kind === 'ask_user_questions') {
        if (resolved.payload.workforceAgentId) await ownerFacts(resolved.payload.workforceAgentId);
        if (resolved.payload.answerOwnerUserId) await member(resolved.payload.answerOwnerUserId);
      }
      return resolved;
    }
    async function question(id: string, issueId?: string, structural = false, ordinary = false) {
      const [stored] = await reader.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, companyId)));
      if (!stored || stored.kind !== 'ask_user_questions' || (issueId && stored.issueId !== issueId)) throw notFound('Question not found');
      const job = await issue(stored.issueId);
      const q = hydrateInteraction(stored) as AskUserQuestionsInteraction;
      row(state, '24:interaction', issueThreadInteractions, q.id);
      const privateQuestion = Boolean(q.payload.answerOwnerUserId || q.payload.workforceAgentId || q.payload.workforceEnrollmentId || q.payload.workforceTemplateId || q.payload.questions.some(value => value.companyFactKey));
      if (ordinary && !privateQuestion) return { issue: job, q };
      await member(req.actor.userId);
      // AgentDash: recovery grants structural cancellation only, never the old
      // owner's private question/answer. Witness inactive membership too: its
      // reactivation must serialize against confirmation, not race a negative read.
      if (selection.operationId.startsWith('human_questions.recovery.')) {
        if (!job.assigneeAgentId || q.payload.workforceAgentId !== job.assigneeAgentId
          || !q.payload.answerOwnerUserId || !q.payload.questions.some(value => value.required) || !['pending', 'cancelled'].includes(q.status)) throw notFound('Recoverable question not found');
        const owner = await ownerFacts(job.assigneeAgentId);
        if (owner !== req.actor.userId) throw forbidden('Only the current accountable human may recover this question');
        const priorMembers = await reader.select().from(companyMemberships).where(and(
          eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'),
          eq(companyMemberships.principalId, q.payload.answerOwnerUserId)));
        for (const value of priorMembers) row(state, '09:membership', companyMemberships, value.id);
        if (priorMembers.some(value => value.status === 'active')) throw conflict('The original question owner is active');
        return { issue: job, q };
      }
      if (q.payload.answerOwnerUserId === req.actor.userId) return { issue: job, q };
      if (structural && q.status === 'cancelled') {
        const resolved = await creation(job.id, questionReplacement(q));
        if (resolved.kind === 'ask_user_questions' && resolved.payload.answerOwnerUserId === req.actor.userId) return { issue: job, q };
      }
      // #882 review P2: readiness reports pending question ids, never answer
      // content, so a company admin may still read it for a job that has a
      // private question owned by someone else.
      if (selection.operationId === 'workforce.readiness.read'
        && (req.actor.isInstanceAdmin || req.actor.source === 'local_implicit' || actorHumanRole(req, companyId) === 'admin')) return { issue: job, q };
      if (selection.operationId === 'workforce.readiness.read' || selection.operationId === 'native.question.list') throw notFound('Question not found');
      throw forbidden('Only the named human answer owner may access this question');
    }
    async function recoveryQuestions(issueId: string) {
      await issue(issueId);
      await member(req.actor.userId);
      const values = await reader.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
        eq(issueThreadInteractions.kind, 'ask_user_questions')));
      const replaced = new Set(values.map(value => (value.payload as { replacesInteractionId?: string }).replacesInteractionId));
      const result: AskUserQuestionsInteraction[] = [];
      for (const value of values) {
        if (replaced.has(value.id) || !['pending', 'cancelled'].includes(value.status)) continue;
        try { result.push((await question(value.id, issueId)).q); }
        catch (error) { if (![403,404,409].includes((error as { status?: number }).status ?? 0)) throw error; }
      }
      return result;
    }
    async function brief() {
      const values = await reader.select().from(companyContext).where(and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, 'workforce_brief'), eq(companyContext.key, 'current')));
      for (const value of values) row(state, '13:context', companyContext, value.id);
    }
    return { member, agent, enrollment, enrollmentRow, goal, issue, ownerFacts, creation, question, recoveryQuestions, brief };
  }
  async function collect(executor: Db, selection: FoundationSelection, state: Collection) {
    const { companyId, operationId: op, input } = selection;
    const facts = await principal(executor, companyId, state);
    const stewardship = op === 'human_questions.stewardship.assign' || op === 'human_questions.stewardship.transfer';
    if (!((stewardship || op === 'discover') && facts.adminRoleIds.length)) assertCompanyAccess(req, companyId);
    const source = sources(executor, selection, state);
    if (op.startsWith('human_questions.owner.') || op.startsWith('human_questions.stewardship.') || op === 'discover') {
      if (facts.userId) {
        const grants = await executor.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalType, 'user'), eq(principalPermissionGrants.principalId, facts.userId), eq(principalPermissionGrants.permissionKey, 'agents:create')));
        for (const value of grants) row(state, '10:permission', principalPermissionGrants, value.id);
      }
      if (op !== 'discover') {
        const target = await source.agent(input.agentId as string);
        await source.ownerFacts(target.id);
        await source.member((input.userId ?? input.accountableUserId) as string);
        if (typeof input.userId === 'string') {
          const stewards = await executor.select().from(agentStewardships).where(and(eq(agentStewardships.companyId, companyId), eq(agentStewardships.userId, input.userId), isNull(agentStewardships.endedAt)));
          for (const value of stewards) row(state, '15:stewardship', agentStewardships, value.id);
        }
      }
    } else if (op.startsWith('workforce.')) {
      if (op !== 'workforce.templates.list') await source.brief();
      if (op.startsWith('workforce.proposals.')) {
        const proposals = await executor.select().from(companyContext).where(and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, 'workforce_fact_proposal')));
        for (const value of proposals) row(state, '13:context', companyContext, value.id);
      }
      if (typeof input.goalId === 'string') await source.goal(input.goalId);
      if (typeof input.agentId === 'string') {
        const enrolled = await source.enrollment(input.agentId);
        if (enrolled && ['workforce.enrollment.create', 'workforce.skills.retry'].includes(op)) {
          const template = resolveWorkforceTemplate(enrolled.templateId, enrolled.templateVersion);
          const keys = template?.skills.map(value => `company/${companyId}/${value.key}`) ?? [];
          const skills = keys.length ? await executor.select().from(companySkills).where(and(eq(companySkills.companyId, companyId), inArray(companySkills.key, keys))) : [];
          for (const value of skills) row(state, '26:company_skill', companySkills, value.id);
        }
        if (op === 'workforce.first_job.start' && !enrolled?.firstJobIssueId) {
          const goal = await getDefaultCompanyGoal(executor, companyId);
          if (goal) row(state, '03:goal', goals, goal.id);
        }
        if (op === 'workforce.readiness.read') {
          let footprint: WorkforceQuestionDependency[] = [];
          let evidence: { documentIds: string[]; workProductIds: string[]; verdictId: string | null } = { documentIds: [], workProductIds: [], verdictId: null };
          await workforceService(executor).getReadiness(companyId, input.agentId, {
            observeSources: value => { footprint = value; }, observeEvidence: value => { evidence = value; },
          });
          for (const value of footprint) {
            if (value.kind === 'missing_replacement') continue;
            const structural = !value.roles.some(role => ['required_question', 'sufficient_answer', 'task_fact'].includes(role));
            await source.question(value.interactionId, value.issueId, structural);
          }
          if (enrolled?.firstJobIssueId) {
            const job = await source.issue(enrolled.firstJobIssueId);
            if (job.assigneeAgentId === input.agentId) {
              const links = await executor.select({ link: issueDocuments, document: documents }).from(issueDocuments).innerJoin(documents, eq(issueDocuments.documentId, documents.id)).where(eq(issueDocuments.issueId, job.id));
              for (const value of links.filter(value => evidence.documentIds.includes(value.document.id))) {
                if (value.document.companyId !== companyId || value.link.companyId !== companyId) throw notFound('First-job artifact not found');
                row(state, '21:document', documents, value.document.id); row(state, '22:issue_document', issueDocuments, value.link.id);
              }
              const products = await executor.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, job.id));
              for (const value of products.filter(value => evidence.workProductIds.includes(value.id))) row(state, '23:work_product', issueWorkProducts, value.id);
              const history = await executor.select().from(verdicts).where(and(eq(verdicts.companyId, companyId), eq(verdicts.entityType, 'issue'), eq(verdicts.issueId, job.id)));
              for (const value of history.filter(value => value.id === evidence.verdictId)) row(state, '25:verdict', verdicts, value.id);
            }
          }
        }
      }
    } else if (op === 'task_recovery.exhausted.read' || op === 'task_recovery.remediate') {
      // AgentDash: task recovery requires a live named member with current
      // issue visibility, plus the pinned assignee's current owner chain.
      const [membership] = await executor.select().from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, 'user'),
        eq(companyMemberships.principalId, req.actor.userId ?? ''), eq(companyMemberships.status, 'active')));
      if (!membership) throw forbidden('Active named company membership required');
      row(state, '09:membership', companyMemberships, membership.id);
      if (typeof input.issueId !== 'string') throw badRequest('Task recovery operations require issueId');
      const selected = await source.issue(input.issueId);
      if (selected.assigneeAgentId) await source.ownerFacts(selected.assigneeAgentId);
      // AgentDash (GH #891, F4): remediation needs agent-management authority;
      // witness the agents:create grant it may rest on (the agent row and its
      // stewardships are witnessed by ownerFacts above).
      if (op === 'task_recovery.remediate' && facts.userId) {
        const grants = await executor.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalType, 'user'), eq(principalPermissionGrants.principalId, facts.userId), eq(principalPermissionGrants.permissionKey, 'agents:create')));
        for (const value of grants) row(state, '10:permission', principalPermissionGrants, value.id);
      }
    } else if (op === 'human_questions.recovery.list') {
      await source.recoveryQuestions(input.issueId as string);
    } else if (op === 'human_questions.pending.list') {
      const pending = await waitingOnYouService(executor).pendingQuestions(companyId, req.actor, { limit: 2147483647 }, req);
      for (const value of pending.items) await source.question(value.interactionId, value.issueId);
    } else if (op === 'native.question.create') {
      const body = input.body as CreateIssueThreadInteraction;
      if (body.kind === 'ask_user_questions' && body.payload.replacesInteractionId) {
        // Eligibility is separate from factual creation, so structural resolution never recurses.
        await source.question(body.payload.replacesInteractionId, input.issueId as string, true, true);
      }
      await source.creation(input.issueId as string, body);
    } else if (op === 'native.question.list') {
      const values = await executor.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, input.issueId as string), eq(issueThreadInteractions.kind, 'ask_user_questions')));
      for (const value of values) {
        try { await source.question(value.id, value.issueId, false, true); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      }
    } else if (op.startsWith('human_questions.')) {
      const selected = await source.question(input.interactionId as string, input.issueId as string, op === 'human_questions.replace' && !selection.recovery, selection.native);
      if (op === 'human_questions.replace' && !selection.recovery) await source.creation(selected.issue.id, questionReplacement(selected.q));
      if (op === 'human_questions.respond' && !selection.recovery && input.shareWithCompany === true
        && !selected.issue.projectId && selected.q.payload.workforceAgentId) {
        // Canonical sharing consumes this current enrollment/template, not its goal or first job.
        await source.enrollmentRow(selected.q.payload.workforceAgentId);
      }
      if (!selection.recovery && ['human_questions.respond', 'human_questions.cancel', 'human_questions.replace'].includes(op)) await source.brief();
    }
    if (selection.skillKeys?.length) {
      const skills = await executor.select().from(companySkills).where(and(eq(companySkills.companyId, companyId), inArray(companySkills.key, [...selection.skillKeys])));
      for (const value of skills) row(state, '26:company_skill', companySkills, value.id);
    }
    identity.checkTime();
  }
  const authority = {
    identity,
    skillStages(db: Db, accepted: typeof workforceEnrollments.$inferSelect): WorkforceSkillStages {
      const pinned = { companyId: accepted.companyId, agentId: accepted.agentId, id: accepted.id, templateId: accepted.templateId, templateVersion: accepted.templateVersion };
      const template = resolveWorkforceTemplate(pinned.templateId, pinned.templateVersion);
      if (!template) throw conflict('Pinned workforce template is unavailable');
      const skillKeys = template.skills.map(value => `company/${pinned.companyId}/${value.key}`);
      async function stage(executor: Db) {
        const guard = await authority.stage(executor, { companyId: pinned.companyId, operationId: 'workforce.skills.retry', input: { agentId: pinned.agentId }, native: true, skillKeys });
        assertCanSetCompanyDirection(req, pinned.companyId);
        const current = await workforceService(executor).getEnrollment(pinned.companyId, pinned.agentId);
        if (!current || current.id !== pinned.id || current.templateId !== pinned.templateId || current.templateVersion !== pinned.templateVersion) throw conflict('Pinned workforce enrollment changed');
        await guard.seal();
        return guard.checkTime;
      }
      return {
        async beforeMaterialize() {
          let completed = false;
          try {
            const beforeWrite = await db.transaction(async tx => { const guard = await stage(tx as unknown as Db); completed = true; return guard; });
            return beforeWrite;
          } catch (error) {
            if (completed) throw conflict('Materialization approval is uncertain; inspect current state before retrying', { persistenceOutcome: 'unknown' });
            throw error;
          }
        },
        async stageCatalog(executor) {
          const checkTime = await stage(executor);
          for (const curated of template!.skills) {
            const [stored] = await executor.select().from(companySkills).where(and(eq(companySkills.companyId, pinned.companyId), eq(companySkills.key, `company/${pinned.companyId}/${curated.key}`)));
            if (stored && stored.markdown !== curated.content) throw conflict('Pinned workforce skill content differs; restore the curated version before retrying');
          }
          return checkTime;
        },
        async stageAssignment(executor) {
          const checkTime = await stage(executor);
          for (const curated of template!.skills) {
            const [stored] = await executor.select().from(companySkills).where(and(eq(companySkills.companyId, pinned.companyId), eq(companySkills.key, `company/${pinned.companyId}/${curated.key}`)));
            if (!stored || stored.markdown !== curated.content) throw conflict('Pinned workforce skill catalog is incomplete');
          }
          return checkTime;
        },
        stageFailure: stage,
      };
    },
    async global(executor: Db, selectedCompanyId?: string) {
      const state: Collection = { witnesses: new Map(), sealed: false };
      const companyIds = new Set<string>();
      async function read() {
        const facts = await identity.readPrincipal(executor);
        if (!facts.userId || facts.source !== 'board_key') throw forbidden('Named board-key human authentication required');
        for (const value of facts.witnesses) record(state, value.key, value.lock);
        if (selectedCompanyId) {
          const grants = await executor.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, selectedCompanyId), eq(principalPermissionGrants.principalType, 'user'), eq(principalPermissionGrants.principalId, facts.userId), eq(principalPermissionGrants.permissionKey, 'agents:create')));
          for (const value of grants) row(state, '10:permission', principalPermissionGrants, value.id);
        }
        const access = await boardAuthService(executor).resolveBoardAccess(facts.userId);
        if (!access.user) throw forbidden('Human connection is no longer authorized');
        const members = await executor.select().from(companyMemberships).where(and(eq(companyMemberships.principalType, 'user'), eq(companyMemberships.principalId, facts.userId), eq(companyMemberships.status, 'active')));
        for (const value of members) row(state, '09:membership', companyMemberships, value.id);
        const query = executor.select({ id: companies.id, name: companies.name }).from(companies);
        const choices = access.isInstanceAdmin ? await query : access.companyIds.length ? await query.where(inArray(companies.id, access.companyIds)) : [];
        if (state.sealed && choices.some(value => !companyIds.has(value.id))) throw conflict('Current authority changed during acceptance');
        req.actor = { ...original, companyIds: access.companyIds, memberships: access.memberships, isInstanceAdmin: access.isInstanceAdmin };
        return { companies: choices, source: 'board_key', user: access.user, isInstanceAdmin: access.isInstanceAdmin,
          memberships: access.memberships, targets: [{ kind: 'self' }, { kind: 'instance' }, { kind: 'public' }, ...choices.map(value => ({ kind: 'company', companyId: value.id }))] };
      }
      const preliminary = await read();
      // Review P1 (#859): never lock every company. Identity/discover run on
      // every human MCP call; an instance admin would otherwise take a row lock
      // on each company and serialize against spend and heartbeat writers. The
      // choice set is pinned by the sealed re-read below (a newly visible
      // company is a conflict). Only a selected company is held, with FOR KEY
      // SHARE, which blocks its deletion but not ordinary company updates.
      for (const value of preliminary.companies) companyIds.add(value.id);
      if (selectedCompanyId && companyIds.has(selectedCompanyId)) {
        await executor.select({ id: companies.id }).from(companies).where(eq(companies.id, selectedCompanyId)).for('key share');
      }
      await read();
      for (const value of [...state.witnesses.values()].sort((a,b) => a.key.localeCompare(b.key))) await executor.execute(value.lock);
      state.sealed = true;
      const value = await read();
      identity.checkTime();
      return { value, async seal() { const value = await read(); identity.checkTime(); return value; } };
    },
    async stage(executor: Db, selection: FoundationSelection) {
      // Review P1 (#859): never FOR UPDATE. A read (readiness polling,
      // question lists, readback) holds the company row FOR KEY SHARE, which
      // only keeps it present and does not conflict with spend/heartbeat
      // writers. A write takes the same company mutex as every acceptance
      // writer (FOR NO KEY UPDATE, #881) BEFORE any witness row lock, so it
      // cannot deadlock against a writer that holds the mutex and then
      // updates a witnessed row (e.g. an enrollment update during sharing).
      // #883 review: refuse a company the caller cannot reach BEFORE any
      // company lock, so a foreign company id cannot hold another company's
      // write mutex even briefly. Instance administrators keep the canonical
      // stewardship/discover exception (re-checked under witnesses below).
      if (!req.actor.isInstanceAdmin) assertCompanyAccess(req, selection.companyId);
      const [company] = await executor.select({ id: companies.id }).from(companies).where(eq(companies.id, selection.companyId))
        .for(selection.readOnly ? 'key share' : 'no key update');
      if (!company) throw notFound('Company not found');
      const state: Collection = { witnesses: new Map(), sealed: false };
      await collect(executor, selection, state);
      for (const value of [...state.witnesses.values()].sort((a, b) => a.key.localeCompare(b.key))) await executor.execute(value.lock);
      state.sealed = true;
      await collect(executor, selection, state);
      return {
        checkTime: identity.checkTime,
        async assertSource(supplied: Db, issue: { id: string; companyId: string }) {
          if (supplied !== executor || issue.companyId !== selection.companyId) throw conflict('Current authority executor changed');
          await sources(executor, selection, state).issue(issue.id);
        },
        async seal() { await collect(executor, selection, state); identity.checkTime(); },
        async recoveryQuestions(issueId: string) {
          return sources(executor, selection, state).recoveryQuestions(issueId);
        },
        async visibleQuestion(id: string, issueId: string) {
          return sources(executor, selection, state).question(id, issueId, false, selection.native);
        },
      };
    },
  };
  return authority;
}
