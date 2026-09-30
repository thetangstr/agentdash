// AgentDash: approved company knowledge and pinned workforce enrollment.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { agents, companies, companyContext, goals, issues, workforceEnrollments, type Db } from '@paperclipai/db';
import { supportsWorkforcePrompt, resolveWorkforceTemplate, updateWorkforceBriefSchema, proposeWorkforceFactsSchema, enrollWorkforceSchema, reviewWorkforceProposalSchema, updateWorkforceEnrollmentSchema, type WorkforceFactProposal, type WorkforceBrief, type WorkforceReadiness, type WorkforceRuntimeContext } from '@paperclipai/shared';
import { readPaperclipSkillSyncPreference, writePaperclipSkillSyncPreference } from '@paperclipai/adapter-utils/server-utils';
import { isUniqueViolation } from '../lib/pg-error.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { issueService } from './issues.js';
import { documentService } from './documents.js';
import { verdictsService } from './verdicts.js';
import { workProductService } from './work-products.js';
import { workforceIssueInputs, type WorkforceInputObservation, type WorkforceQuestionSource, type WorkforceQuestionDependency, type WorkforceSourceRole } from './workforce-inputs.js';
import { companySkillService, type CuratedSkillStages } from './company-skills.js';
import { insertActivity, publishActivity, type ActivityPublication } from './activity-log.js';

// AgentDash: private caller-owned acceptance; never infer a transaction from a DB object.
export interface ActivityAcceptance { executor: Db; publications: ActivityPublication[] }
export function assertActivityAcceptance(acceptance: ActivityAcceptance): void {
  if (!acceptance?.executor || typeof acceptance.executor.select !== 'function'
    || typeof acceptance.executor.insert !== 'function' || typeof acceptance.executor.update !== 'function'
    || !Array.isArray(acceptance.publications)) throw new Error('An executor and publication collector are required');
}

// AgentDash: every later DB acceptance is separate from the initial enrollment intent.
export interface WorkforceSkillStages extends CuratedSkillStages {
  stageAssignment(executor: Db): Promise<() => void>;
  stageFailure(executor: Db): Promise<() => void>;
}

type Actor = { userId?: string | null; agentId?: string | null };
type Enrollment = typeof workforceEnrollments.$inferSelect;
const emptyBrief = (): WorkforceBrief => ({ revision: 0, sources: [], facts: [], confirmedByUserId: null, updatedAt: null });

export function workforceService(db: Db) {
  async function accept<T>(supplied: ActivityAcceptance | undefined, work: (executor: Db, publications: ActivityPublication[]) => Promise<T>): Promise<T> {
    if (supplied !== undefined) {
      assertActivityAcceptance(supplied);
      return work(supplied.executor, supplied.publications);
    }
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(tx => work(tx as unknown as Db, publications));
    for (const publication of publications) publishActivity(publication);
    return result;
  }
  async function company(companyId: string, connection = db, lock = false) {
    const query = connection.select().from(companies).where(eq(companies.id, companyId));
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw notFound('Company not found');
    return row;
  }
  async function agent(companyId: string, agentId: string, connection = db) {
    const [row] = await connection.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    if (!row) throw notFound('Agent not found');
    return row;
  }
  function requireHuman(actor: Actor) {
    if (!actor.userId || actor.agentId) {
      throw forbidden('Human direction authority required');
    }
  }
  function requireSelfOrHuman(actor: Actor, agentId: string) {
    const isAuthorizedActor = actor.agentId ? actor.agentId === agentId : Boolean(actor.userId);
    if (!isAuthorizedActor) {
      throw forbidden('Only the enrolled agent or an authorized human may acknowledge learning');
    }
  }
  async function audit(connection: Db, companyId: string, entityId: string, action: string, actor: Actor, publications: ActivityPublication[]) {
    publications.push(await insertActivity(connection, { companyId, entityType: 'workforce', entityId, action, actorType: actor.agentId ? 'agent' : actor.userId ? 'user' : 'system', actorId: actor.agentId ?? actor.userId ?? 'workforce', agentId: actor.agentId }));
  }
  async function readBrief(companyId: string, connection = db): Promise<WorkforceBrief> {
    const [row] = await connection.select().from(companyContext).where(and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, 'workforce_brief'), eq(companyContext.key, 'current')));
    return row ? JSON.parse(row.value) as WorkforceBrief : emptyBrief();
  }
  async function getBrief(companyId: string) { await company(companyId); return readBrief(companyId); }
  async function getEnrollment(companyId: string, agentId: string, connection = db): Promise<Enrollment | null> {
    await agent(companyId, agentId, connection);
    const [row] = await connection.select().from(workforceEnrollments).where(and(eq(workforceEnrollments.companyId, companyId), eq(workforceEnrollments.agentId, agentId)));
    return row ?? null;
  }
  async function requiredEnrollment(companyId: string, agentId: string, connection = db) {
    const enrollment = await getEnrollment(companyId, agentId, connection);
    if (!enrollment) throw notFound('Workforce enrollment not found');
    const template = resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
    if (!template) throw conflict('Pinned workforce template is unavailable');
    return { enrollment, template };
  }
  async function updateBrief(companyId: string, input: z.infer<typeof updateWorkforceBriefSchema>, actor: { userId: string }, acceptance?: ActivityAcceptance, beforeWrite?: () => void) {
    requireHuman(actor);
    const parsed = updateWorkforceBriefSchema.parse(input);
    return accept(acceptance, async (tx, publications) => {
      const connection = tx;
      await company(companyId, connection, true);
      const prior = await readBrief(companyId, connection);
      if (prior.revision !== parsed.expectedRevision) throw conflict('Company brief revision changed');
      return publishBrief(connection, companyId, prior.revision, { sources: parsed.sources, facts: parsed.facts }, actor, publications, beforeWrite);
    });
  }
  async function publishBrief(connection: Db, companyId: string, revision: number, input: Pick<WorkforceBrief, 'sources' | 'facts'>, actor: { userId: string }, publications: ActivityPublication[], beforeWrite?: () => void) {
    const brief: WorkforceBrief = { revision: revision + 1, ...input, confirmedByUserId: actor.userId, updatedAt: new Date().toISOString() };
    const values = { companyId, value: JSON.stringify(brief), confidence: '1.00', verifiedByUserId: actor.userId };
    beforeWrite?.();
    await connection.insert(companyContext).values({ ...values, contextType: 'workforce_brief_revision', key: String(brief.revision) });
    await connection.insert(companyContext).values({ ...values, contextType: 'workforce_brief', key: 'current' }).onConflictDoUpdate({ target: [companyContext.companyId, companyContext.contextType, companyContext.key], set: { value: values.value, verifiedByUserId: actor.userId, updatedAt: new Date() } });
    await audit(connection, companyId, companyId, 'workforce.brief_updated', actor, publications);
    return brief;
  }
  async function listProposals(companyId: string, actor: Actor): Promise<WorkforceFactProposal[]> {
    requireHuman(actor); await company(companyId);
    const rows = await db.select().from(companyContext).where(and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, 'workforce_fact_proposal')));
    return rows.map(row => JSON.parse(row.value) as WorkforceFactProposal);
  }
  async function reviewProposal(companyId: string, proposalId: string, input: z.infer<typeof reviewWorkforceProposalSchema>, actor: Actor, acceptance?: ActivityAcceptance, beforeWrite?: () => void) {
    requireHuman(actor);
    const parsed = reviewWorkforceProposalSchema.parse(input);
    return accept(acceptance, async (tx, publications) => {
      const connection = tx;
      await company(companyId, connection, true);
      const [row] = await tx.select().from(companyContext).where(and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, 'workforce_fact_proposal'), eq(companyContext.key, proposalId)));
      if (!row) throw notFound('Company proposal not found');
      const proposal = JSON.parse(row.value) as WorkforceFactProposal;
      if (proposal.status !== 'proposed') throw conflict('Proposal has already been reviewed');
      if (parsed.decision === 'approve') {
        const brief = await readBrief(companyId, connection);
        if (brief.revision !== parsed.expectedRevision || brief.revision !== proposal.briefRevision) throw conflict('Company sources changed; request a new proposal before approval');
        const validated = proposeWorkforceFactsSchema.parse({ facts: proposal.facts, sourceReferences: proposal.sourceReferences });
        const sources = brief.sources.filter(source => validated.sourceReferences.includes(source.id));
        if (validated.sourceReferences.some(id => !sources.some(source => source.id === id)) || validated.facts.some(fact => !sources.some(source => fact.sourceReference === source.id || fact.sourceReference === source.label))) throw conflict('Proposal sources are no longer shared; request a new proposal');
        const facts = new Map(brief.facts.map(fact => [fact.key, fact]));
        for (const fact of proposal.facts) facts.set(fact.key, fact);
        const merged = updateWorkforceBriefSchema.parse({ expectedRevision: brief.revision, sources: brief.sources, facts: [...facts.values()] });
        await publishBrief(connection, companyId, brief.revision, { sources: merged.sources, facts: merged.facts }, { userId: actor.userId! }, publications, beforeWrite);
      }
      const reviewed: WorkforceFactProposal = { ...proposal, status: parsed.decision === 'approve' ? 'approved' : 'rejected', reviewedByUserId: actor.userId!, reviewedAt: new Date().toISOString() };
      beforeWrite?.();
      await tx.update(companyContext).set({ value: JSON.stringify(reviewed), verifiedByUserId: actor.userId!, updatedAt: new Date() }).where(eq(companyContext.id, row.id));
      await audit(connection, companyId, proposal.id, `workforce.proposal_${reviewed.status}`, actor, publications);
      return reviewed;
    });
  }
  async function updateEnrollment(companyId: string, agentId: string, input: z.infer<typeof updateWorkforceEnrollmentSchema>, actor: Actor, acceptance?: ActivityAcceptance, beforeWrite?: () => void) {
    requireHuman(actor);
    const parsed = updateWorkforceEnrollmentSchema.parse(input);
    return accept(acceptance, async (tx, publications) => {
      const connection = tx;
      await company(companyId, connection, true);
      const { enrollment } = await requiredEnrollment(companyId, agentId, connection);
      if (parsed.goalId && !(await tx.select().from(goals).where(and(eq(goals.companyId, companyId), eq(goals.id, parsed.goalId))))[0]) throw notFound('Company goal not found');
      beforeWrite?.();
      const [updated] = await tx.update(workforceEnrollments).set({ ...parsed, updatedAt: new Date() }).where(eq(workforceEnrollments.id, enrollment.id)).returning();
      await audit(connection, companyId, enrollment.id, 'workforce.targets_updated', actor, publications);
      return updated;
    });
  }
  async function proposeFacts(companyId: string, agentId: string, input: z.infer<typeof proposeWorkforceFactsSchema>, acceptance?: ActivityAcceptance) {
    const parsed = proposeWorkforceFactsSchema.parse(input);
    return accept(acceptance, async (tx, publications) => {
      const connection = tx;
      await company(companyId, connection, true); await agent(companyId, agentId, connection);
      const brief = await readBrief(companyId, connection);
      if (parsed.sourceReferences.some(id => !brief.sources.some(source => source.id === id))) throw badRequest('Proposals must reference explicitly shared company sources');
      const permittedSources = brief.sources.filter(source => parsed.sourceReferences.includes(source.id));
      if (parsed.facts.some(fact => !permittedSources.some(source => source.id === fact.sourceReference || source.label === fact.sourceReference))) throw badRequest('Each proposed fact must cite a declared company source');
      const proposal: WorkforceFactProposal = { id: randomUUID(), companyId, agentId, status: 'proposed', briefRevision: brief.revision, ...parsed, sources: permittedSources, createdAt: new Date().toISOString(), reviewedByUserId: null, reviewedAt: null };
      await tx.insert(companyContext).values({ companyId, contextType: 'workforce_fact_proposal', key: proposal.id, value: JSON.stringify(proposal), confidence: '0.00' });
      await audit(connection, companyId, proposal.id, 'workforce.facts_proposed', { agentId }, publications);
      return proposal;
    });
  }
  async function enroll(companyId: string, agentId: string, input: z.infer<typeof enrollWorkforceSchema>, actor: Actor, acceptance?: ActivityAcceptance, beforeWrite?: () => void) {
    const parsed = enrollWorkforceSchema.parse(input);
    const template = resolveWorkforceTemplate(parsed.templateId)!;
    return accept(acceptance, async (tx, publications) => {
      const connection = tx;
      await company(companyId, connection, true);
      const [runtimeAgent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).for('update');
      if (!runtimeAgent) throw notFound('Agent not found');
      if (!supportsWorkforcePrompt(runtimeAgent.adapterType)) throw unprocessable('Unsupported workforce adapter: choose a native runtime with verified workforce prompt delivery');
      const existing = await getEnrollment(companyId, agentId, connection);
      if (existing) {
        if (existing.templateId !== parsed.templateId) throw conflict('Workforce template assignment is immutable');
        return existing;
      }
      if (parsed.goalId && !(await tx.select().from(goals).where(and(eq(goals.companyId, companyId), eq(goals.id, parsed.goalId))))[0]) throw notFound('Company goal not found');
      beforeWrite?.();
      const [row] = await tx.insert(workforceEnrollments).values({ companyId, agentId, templateId: template.id, templateVersion: template.version, objective: parsed.objective ?? null, metrics: parsed.metrics ?? template.suggestedMetrics, goalId: parsed.goalId ?? null }).returning();
      await audit(connection, companyId, row.id, 'workforce.enrolled', actor, publications);
      return row;
    });
  }
  async function startFirstJobWithCreation(companyId: string, agentId: string, actor: Actor, acceptance?: ActivityAcceptance, beforeWrite?: () => void) {
    requireHuman(actor);
    return accept(acceptance, async (tx, publications) => {
      const connection = tx;
      await company(companyId, connection, true);
      const { enrollment, template } = await requiredEnrollment(companyId, agentId, connection);
      if (!supportsWorkforcePrompt((await agent(companyId, agentId, connection)).adapterType)) throw unprocessable('Unsupported workforce adapter: choose a verified native runtime before starting work');
      if (enrollment.firstJobIssueId) {
        const [existing] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, enrollment.firstJobIssueId)));
        if (!existing) throw notFound('First job not found');
        return { issue: existing, created: false };
      }
      const job = await issueService(db).create(companyId, {
        title: template.starterJob.title, description: [template.starterJob.description, enrollment.objective && `Objective: ${enrollment.objective}`, `Declared targets (outcomes unknown until measured): ${enrollment.metrics.join('; ')}`].filter(Boolean).join('\n\n'),
        status: 'todo', assigneeAgentId: agentId, createdByUserId: actor.userId,
        goalId: enrollment.goalId, originKind: 'workforce_onboarding', originId: enrollment.id,
        definitionOfDone: { summary: 'Deliver an evidence-backed first job for neutral review', criteria: template.qualityChecks.map((text, i) => ({ id: `workforce-${i + 1}`, text, done: false })) },
      }, { executor: connection, publications }, beforeWrite);
      await tx.update(workforceEnrollments).set({ firstJobIssueId: job.id, updatedAt: new Date() }).where(eq(workforceEnrollments.id, enrollment.id));
      publications.push(await insertActivity(connection, {
        companyId,
        actorType: 'user',
        actorId: actor.userId!,
        action: 'issue.created',
        entityType: 'issue',
        entityId: job.id,
        details: { title: job.title, identifier: job.identifier },
      }));
      await audit(connection, companyId, job.id, 'workforce.first_job_started', actor, publications);
      return { issue: job, created: true };
    });
  }
  async function startFirstJob(companyId: string, agentId: string, actor: Actor, acceptance?: ActivityAcceptance, beforeWrite?: () => void) {
    return (await startFirstJobWithCreation(companyId, agentId, actor, acceptance, beforeWrite)).issue;
  }
  async function acknowledgeLearning(companyId: string, agentId: string, revision: number, actor: Actor, acceptance?: ActivityAcceptance, beforeWrite?: () => void) {
    requireSelfOrHuman(actor, agentId);
    return accept(acceptance, async (tx, publications) => {
      const connection = tx;
      await company(companyId, connection, true);
      const { enrollment } = await requiredEnrollment(companyId, agentId, connection);
      if (revision !== (await readBrief(companyId, connection)).revision) throw conflict('Acknowledge the current company brief revision');
      beforeWrite?.();
      const [updated] = await tx.update(workforceEnrollments).set({ learnedBriefRevision: revision, updatedAt: new Date() }).where(eq(workforceEnrollments.id, enrollment.id)).returning();
      await audit(connection, companyId, enrollment.id, 'workforce.learning_acknowledged', actor, publications);
      return updated;
    });
  }
  async function getReadiness(companyId: string, agentId: string, options?: { observeSources: (sources: WorkforceQuestionDependency[]) => void; observeEvidence?: (sources: { documentIds: string[]; workProductIds: string[]; verdictId: string | null }) => void }): Promise<WorkforceReadiness | null> {
    // AgentDash: buffer native identities; publish only dependencies of returned fields.
    const sources = new Map<string, WorkforceQuestionDependency>();
    const dependOn = (source: WorkforceQuestionSource, roles: WorkforceSourceRole[]) => {
      const existing = sources.get(source.interactionId);
      if (!existing) sources.set(source.interactionId, { ...source, roles: [...roles] });
      else for (const role of roles) if (!existing.roles.includes(role)) existing.roles.push(role);
    };
    const finish = (value: WorkforceReadiness | null) => { options?.observeSources([...sources.values()]); return value; };
    const enrollment = await getEnrollment(companyId, agentId);
    if (!enrollment) return finish(null);
    const template = resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
    if (!template) throw conflict('Pinned workforce template is unavailable');
    const brief = await getBrief(companyId);
    let inputSources: WorkforceInputObservation | undefined;
    const input = enrollment.firstJobIssueId ? await workforceIssueInputs(db, companyId, agentId, enrollment.firstJobIssueId, options ? { observeSources: observation => { inputSources = observation; } } : undefined) : { pendingQuestionIds: [], taskFacts: [] };
    const missingFactKeys: string[] = [];
    for (const key of template.requiredFactKeys) {
      if (brief.facts.some(f => f.key === key && f.value.trim())) continue;
      const fact = input.taskFacts.find(f => f.companyFactKey === key);
      if (!fact) missingFactKeys.push(key);
      else if (inputSources) {
        const source = inputSources.taskFactSources.find(candidate => candidate.companyFactKey === key && candidate.sourceReference === fact.sourceReference)!.source;
        dependOn(source, ['task_fact']);
      }
    }
    const result: WorkforceReadiness = { phase: 'learning', missingFactKeys, pendingQuestionIds: [], firstJobIssueId: enrollment.firstJobIssueId, acceptedVerdictId: null, briefRevision: brief.revision, learnedBriefRevision: enrollment.learnedBriefRevision, reason: 'Read the approved company brief and acknowledge learning.' };
    if (enrollment.firstJobIssueId) {
      const [job] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, enrollment.firstJobIssueId)));
      if (!job) throw notFound('First job not found');
      if (job.assigneeAgentId !== agentId) return finish({ ...result, phase: 'needs_input', reason: 'The first job is assigned to another worker; restore its assignment before accepting this enrollment.' });
      result.pendingQuestionIds = input.pendingQuestionIds;
      for (const source of inputSources?.pendingSources ?? []) dependOn(source, source.roles);
      const docs = await documentService(db).listIssueDocuments(job.id);
      const products = await workProductService(db).listForIssue(job.id);
      const artifactDocs = docs.filter(d => d.key !== 'plan' && Boolean(d.body?.trim()));
      const artifactProducts = products.filter(p => p.companyId === companyId && Boolean(p.url?.trim()) && !['failed', 'cancelled'].includes(p.status));
      const evidenceDates = [
        ...artifactDocs.map(d => new Date(d.updatedAt).getTime()),
        ...artifactProducts.map(p => new Date(p.updatedAt).getTime()),
      ];
      const history = await verdictsService(db).listForEntity(companyId, 'issue', job.id);
      const latest = history.at(-1);
      options?.observeEvidence?.({ documentIds: artifactDocs.map(value => value.id), workProductIds: artifactProducts.map(value => value.id), verdictId: latest?.id ?? null });
      const neutralReviewer = latest
        && latest.reviewerAgentId !== agentId
        && (!latest.reviewerAgentId || latest.reviewerAgentId !== job.assigneeAgentId)
        && (!latest.reviewerUserId || latest.reviewerUserId !== job.assigneeUserId);
      const reviewCoversArtifacts = latest
        && evidenceDates.length > 0
        && new Date(latest.createdAt).getTime() >= Math.max(...evidenceDates);
      if (
        job.status !== 'cancelled'
        && latest?.outcome === 'passed'
        && neutralReviewer
        && reviewCoversArtifacts
      ) {
        result.acceptedVerdictId = latest.id;
      }
      result.phase = evidenceDates.length ? 'awaiting_review' : 'working';
      if (job.status === 'cancelled') {
        result.reason = 'The first job was cancelled; reopen it before completing onboarding.';
      } else if (evidenceDates.length) {
        result.reason = 'Artifact available; a current neutral passed verdict is required.';
      } else {
        result.reason = 'Complete the first job and attach an inspectable artifact.';
      }
    }
    if (result.pendingQuestionIds.length || missingFactKeys.length) {
      return finish({ ...result, phase: 'needs_input', reason: 'Required company facts or dependent questions still need human input.' });
    }
    if (enrollment.learnedBriefRevision !== brief.revision) {
      return finish({
        ...result,
        phase: enrollment.learnedBriefRevision === null ? 'learning' : 'refresh_needed',
        reason: 'Read and acknowledge the current approved company brief.',
      });
    }
    // AgentDash: accepted work remains evidence, but setup is incomplete until
    // every pinned skill is installed and the most recent install succeeded.
    const missingSkills = template.skills.some(skill => !enrollment.installedSkillKeys.includes(`company/${companyId}/${skill.key}`));
    if (enrollment.skillInstallError || missingSkills) {
      return finish({ ...result, phase: 'learning', reason: enrollment.skillInstallError
        ? 'Workforce skill installation failed; retry installation before marking this worker ready.'
        : 'Install the pinned workforce skills before marking this worker ready.' });
    }
    if (result.acceptedVerdictId) {
      return finish({ ...result, phase: 'ready', reason: 'First-job evidence has a current neutral passed verdict.' });
    }
    return finish(result);
  }
  async function ensureSkillsInstalled(companyId: string, agentId: string, actor: Actor, stages?: WorkforceSkillStages) {
    requireSelfOrHuman(actor, agentId);
    const { enrollment, template } = await requiredEnrollment(companyId, agentId);
    // Filesystem work deliberately precedes the short assignment transaction.
    // This method must be called after hiring commits, never from its DB transaction.
    const publications: ActivityPublication[] = [];
    let assignmentCallbackCompleted = false;
    let result: Enrollment;
    try {
      const skills = companySkillService(db);
      const keys: string[] = [];
      for (const curated of template.skills) {
        const key = `company/${companyId}/${curated.key}`;
        let installed = await skills.getByKey(companyId, key);
        if (installed && installed.markdown !== curated.content) throw conflict('Pinned workforce skill content differs; restore the curated version before retrying');
        {
          // Re-materialize approved local content on retry, including missing files.
          try {
            installed = await skills.createLocalSkill(companyId, { slug: curated.key, name: curated.name, description: curated.description, markdown: curated.content }, stages);
          } catch (error) {
            // Concurrent agents can register the same immutable company skill.
            // Only a real unique conflict may converge on the winner's row.
            if (!isUniqueViolation(error)) throw error;
            installed = await skills.getByKey(companyId, key);
            if (!installed || installed.markdown !== curated.content) throw error;
          }
        }
        keys.push(installed.key);
      }
      result = await db.transaction(async tx => {
        const connection = tx as unknown as Db;
        const beforeWrite = stages ? await stages.stageAssignment(connection) : undefined;
        await company(companyId, connection, true);
        // Ordinary agent writers do not take the company lock. Compare the
        // JSON snapshot when assigning skills so a concurrent config edit is
        // re-read and merged, never replaced with a stale snapshot.
        let assigned = false;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const current = await agent(companyId, agentId, connection);
          const config = current.adapterConfig;
          const requested = readPaperclipSkillSyncPreference(config).desiredSkills;
          beforeWrite?.();
          const [updatedAgent] = await tx.update(agents)
            .set({
              adapterConfig: writePaperclipSkillSyncPreference(config, [...new Set([...requested, ...keys])]),
              updatedAt: new Date(),
            })
            .where(and(
              eq(agents.id, agentId),
              eq(agents.companyId, companyId),
              eq(agents.adapterConfig, config),
            ))
            .returning({ id: agents.id });
          if (updatedAgent) {
            assigned = true;
            break;
          }
        }
        if (!assigned) {
          throw conflict('Agent configuration kept changing; retry workforce skill installation');
        }
        const [updated] = await tx.update(workforceEnrollments).set({ installedSkillKeys: keys, skillInstallError: null, updatedAt: new Date() }).where(eq(workforceEnrollments.id, enrollment.id)).returning();
        await audit(connection, companyId, enrollment.id, 'workforce.skills_installed', actor, publications);
        assignmentCallbackCompleted = true;
        return updated;
      });
    } catch (error) {
      publications.length = 0;
      // AgentDash: a completed callback can commit before its acknowledgement is
      // lost. Do not overwrite that assignment with guessed failure or replay it.
      if (assignmentCallbackCompleted) {
        throw conflict('Skill assignment outcome is unknown; inspect the existing enrollment and agent configuration before retrying', {
          outcome: 'unknown', enrollmentId: enrollment.id, agentId,
        });
      }
      if (stages && ((error as { status?: number }).status === 401 || (error as { status?: number }).status === 403
        || (error as { details?: { persistenceOutcome?: string } }).details?.persistenceOutcome === 'unknown')) throw error;
      result = await db.transaction(async tx => {
        const connection = tx as unknown as Db;
        const beforeWrite = stages ? await stages.stageFailure(connection) : undefined;
        beforeWrite?.();
        const [updated] = await tx.update(workforceEnrollments).set({ skillInstallError: error instanceof Error ? error.message : 'Skill installation failed', updatedAt: new Date() }).where(and(eq(workforceEnrollments.companyId, companyId), eq(workforceEnrollments.id, enrollment.id))).returning();
        await audit(tx as unknown as Db, companyId, enrollment.id, 'workforce.skill_install_failed', actor, publications);
        return updated;
      });
    }
    for (const publication of publications) publishActivity(publication);
    return result;
  }
  // AgentDash: installation completion is durable catalog plus actual assignment,
  // independently re-read by protected human output after unlocked stages finish.
  async function getInstalledEnrollment(companyId: string, agentId: string) {
    const { enrollment, template } = await requiredEnrollment(companyId, agentId);
    if (enrollment.skillInstallError) throw conflict('Workforce skill installation failed; inspect the enrollment before retrying');
    const current = await agent(companyId, agentId);
    const assigned = readPaperclipSkillSyncPreference(current.adapterConfig).desiredSkills;
    for (const curated of template.skills) {
      const key = `company/${companyId}/${curated.key}`;
      const catalog = await companySkillService(db).getByKey(companyId, key);
      if (!catalog || catalog.markdown !== curated.content || !enrollment.installedSkillKeys.includes(key) || !assigned.includes(key)) throw conflict('Workforce skill installation is incomplete; inspect the current enrollment and catalog');
    }
    return enrollment;
  }
  async function getRuntimeContext(companyId: string, agentId: string, issueId?: string): Promise<WorkforceRuntimeContext | null> {
    const enrollment = await getEnrollment(companyId, agentId);
    if (!enrollment) return null;
    const template = resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
    if (!template) throw conflict('Pinned workforce template is unavailable');
    const brief = await getBrief(companyId);
    // Full authorized sources remain available over the scoped API. Runtime
    // content is bounded independently of the larger storage/input limits.
    const taskFacts = issueId ? (await workforceIssueInputs(db, companyId, agentId, issueId)).taskFacts : [];
    return { enrollment, template, taskFacts: taskFacts.map(f => ({ ...f, value: f.value.slice(0, 500) })), brief: { ...brief, sources: brief.sources.map(s => ({ ...s, content: s.content.slice(0, 500) })), facts: brief.facts.map(f => ({ ...f, value: f.value.slice(0, 500) })) }, readiness: (await getReadiness(companyId, agentId))!, sourceUrl: `/api/companies/${companyId}/workforce/brief` };
  }
  return { listProposals, reviewProposal, updateEnrollment, getBrief, updateBrief, proposeFacts, enroll, getEnrollment, getReadiness, startFirstJob, startFirstJobWithCreation, acknowledgeLearning, ensureSkillsInstalled, getInstalledEnrollment, getRuntimeContext };
}
