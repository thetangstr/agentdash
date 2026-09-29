// AgentDash: approved company knowledge and pinned workforce enrollment.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { agents, companies, companyContext, goals, issues, workforceEnrollments, type Db } from '@paperclipai/db';
import { resolveWorkforceTemplate, updateWorkforceBriefSchema, proposeWorkforceFactsSchema, enrollWorkforceSchema, type WorkforceBrief, type WorkforceReadiness, type WorkforceRuntimeContext } from '@paperclipai/shared';
import { readPaperclipSkillSyncPreference, writePaperclipSkillSyncPreference } from '@paperclipai/adapter-utils/server-utils';
import { isUniqueViolation } from '../lib/pg-error.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { issueService } from './issues.js';
import { documentService } from './documents.js';
import { verdictsService } from './verdicts.js';
import { workProductService } from './work-products.js';
import { issueThreadInteractionService } from './issue-thread-interactions.js';
import { companySkillService } from './company-skills.js';
import { logActivity } from './activity-log.js';

type Actor = { userId?: string | null; agentId?: string | null };
type Enrollment = typeof workforceEnrollments.$inferSelect;
const emptyBrief = (): WorkforceBrief => ({ revision: 0, sources: [], facts: [], confirmedByUserId: null, updatedAt: null });

export function workforceService(db: Db) {
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
  async function audit(connection: Db, companyId: string, entityId: string, action: string, actor: Actor) {
    await logActivity(connection, { companyId, entityType: 'workforce', entityId, action, actorType: actor.agentId ? 'agent' : actor.userId ? 'user' : 'system', actorId: actor.agentId ?? actor.userId ?? 'workforce', agentId: actor.agentId });
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
  async function updateBrief(companyId: string, input: z.infer<typeof updateWorkforceBriefSchema>, actor: { userId: string }) {
    requireHuman(actor);
    const parsed = updateWorkforceBriefSchema.parse(input);
    return db.transaction(async tx => {
      const connection = tx as unknown as Db;
      await company(companyId, connection, true);
      const prior = await readBrief(companyId, connection);
      if (prior.revision !== parsed.expectedRevision) throw conflict('Company brief revision changed');
      const brief: WorkforceBrief = { revision: prior.revision + 1, sources: parsed.sources, facts: parsed.facts, confirmedByUserId: actor.userId, updatedAt: new Date().toISOString() };
      const values = { companyId, value: JSON.stringify(brief), confidence: '1.00', verifiedByUserId: actor.userId };
      await tx.insert(companyContext).values({ ...values, contextType: 'workforce_brief_revision', key: String(brief.revision) });
      await tx.insert(companyContext).values({ ...values, contextType: 'workforce_brief', key: 'current' }).onConflictDoUpdate({ target: [companyContext.companyId, companyContext.contextType, companyContext.key], set: { value: values.value, verifiedByUserId: actor.userId, updatedAt: new Date() } });
      await audit(connection, companyId, companyId, 'workforce.brief_updated', actor);
      return brief;
    });
  }
  async function proposeFacts(companyId: string, agentId: string, input: z.infer<typeof proposeWorkforceFactsSchema>) {
    const parsed = proposeWorkforceFactsSchema.parse(input);
    return db.transaction(async tx => {
      const connection = tx as unknown as Db;
      await company(companyId, connection, true); await agent(companyId, agentId, connection);
      const brief = await readBrief(companyId, connection);
      if (parsed.sourceReferences.some(id => !brief.sources.some(source => source.id === id))) throw badRequest('Proposals must reference explicitly shared company sources');
      const permittedSources = brief.sources.filter(source => parsed.sourceReferences.includes(source.id));
      if (parsed.facts.some(fact => !permittedSources.some(source => source.id === fact.sourceReference || source.label === fact.sourceReference))) throw badRequest('Each proposed fact must cite a declared company source');
      const proposal = { id: randomUUID(), companyId, agentId, status: 'proposed' as const, briefRevision: brief.revision, ...parsed };
      await tx.insert(companyContext).values({ companyId, contextType: 'workforce_fact_proposal', key: proposal.id, value: JSON.stringify(proposal), confidence: '0.00' });
      await audit(connection, companyId, proposal.id, 'workforce.facts_proposed', { agentId });
      return proposal;
    });
  }
  async function enroll(companyId: string, agentId: string, input: z.infer<typeof enrollWorkforceSchema>, actor: Actor) {
    const parsed = enrollWorkforceSchema.parse(input);
    const template = resolveWorkforceTemplate(parsed.templateId)!;
    return db.transaction(async tx => {
      const connection = tx as unknown as Db;
      await company(companyId, connection, true);
      const existing = await getEnrollment(companyId, agentId, connection);
      if (existing) {
        if (existing.templateId !== parsed.templateId) throw conflict('Workforce template assignment is immutable');
        return existing;
      }
      if (parsed.goalId && !(await tx.select().from(goals).where(and(eq(goals.companyId, companyId), eq(goals.id, parsed.goalId))))[0]) throw notFound('Company goal not found');
      const [row] = await tx.insert(workforceEnrollments).values({ companyId, agentId, templateId: template.id, templateVersion: template.version, objective: parsed.objective ?? null, metrics: parsed.metrics ?? template.suggestedMetrics, goalId: parsed.goalId ?? null }).returning();
      await audit(connection, companyId, row.id, 'workforce.enrolled', actor);
      return row;
    });
  }
  async function startFirstJob(companyId: string, agentId: string, actor: Actor) {
    requireHuman(actor);
    return db.transaction(async tx => {
      const connection = tx as unknown as Db;
      await company(companyId, connection, true);
      const { enrollment, template } = await requiredEnrollment(companyId, agentId, connection);
      if (enrollment.firstJobIssueId) {
        const [existing] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, enrollment.firstJobIssueId)));
        if (!existing) throw notFound('First job not found');
        return existing;
      }
      const job = await issueService(connection).create(companyId, {
        title: template.starterJob.title, description: [template.starterJob.description, enrollment.objective && `Objective: ${enrollment.objective}`, `Declared targets (outcomes unknown until measured): ${enrollment.metrics.join('; ')}`].filter(Boolean).join('\n\n'),
        status: 'todo', assigneeAgentId: agentId, createdByUserId: actor.userId,
        goalId: enrollment.goalId, originKind: 'workforce_onboarding', originId: enrollment.id,
        definitionOfDone: { summary: 'Deliver an evidence-backed first job for neutral review', criteria: template.qualityChecks.map((text, i) => ({ id: `workforce-${i + 1}`, text, done: false })) },
      });
      await tx.update(workforceEnrollments).set({ firstJobIssueId: job.id, updatedAt: new Date() }).where(eq(workforceEnrollments.id, enrollment.id));
      await logActivity(connection, {
        companyId,
        actorType: 'user',
        actorId: actor.userId!,
        action: 'issue.created',
        entityType: 'issue',
        entityId: job.id,
        details: { title: job.title, identifier: job.identifier },
      });
      await audit(connection, companyId, job.id, 'workforce.first_job_started', actor);
      return job;
    });
  }
  async function acknowledgeLearning(companyId: string, agentId: string, revision: number, actor: Actor) {
    requireSelfOrHuman(actor, agentId);
    return db.transaction(async tx => {
      const connection = tx as unknown as Db;
      await company(companyId, connection, true);
      const { enrollment } = await requiredEnrollment(companyId, agentId, connection);
      if (revision !== (await readBrief(companyId, connection)).revision) throw conflict('Acknowledge the current company brief revision');
      const [updated] = await tx.update(workforceEnrollments).set({ learnedBriefRevision: revision, updatedAt: new Date() }).where(eq(workforceEnrollments.id, enrollment.id)).returning();
      await audit(connection, companyId, enrollment.id, 'workforce.learning_acknowledged', actor);
      return updated;
    });
  }
  async function getReadiness(companyId: string, agentId: string): Promise<WorkforceReadiness | null> {
    const enrollment = await getEnrollment(companyId, agentId);
    if (!enrollment) return null;
    const template = resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
    if (!template) throw conflict('Pinned workforce template is unavailable');
    const brief = await getBrief(companyId);
    const missingFactKeys = template.requiredFactKeys.filter(key => !brief.facts.some(f => f.key === key && f.value.trim()));
    const result: WorkforceReadiness = { phase: 'learning', missingFactKeys, pendingQuestionIds: [], firstJobIssueId: enrollment.firstJobIssueId, acceptedVerdictId: null, briefRevision: brief.revision, learnedBriefRevision: enrollment.learnedBriefRevision, reason: 'Read the approved company brief and acknowledge learning.' };
    if (enrollment.firstJobIssueId) {
      const [job] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, enrollment.firstJobIssueId)));
      if (!job) throw notFound('First job not found');
      const questions = await issueThreadInteractionService(db).listForIssue(job.id);
      result.pendingQuestionIds = questions.filter(q => q.companyId === companyId && q.kind === 'ask_user_questions' && q.status !== 'answered').map(q => q.id);
      const docs = await documentService(db).listIssueDocuments(job.id);
      const products = await workProductService(db).listForIssue(job.id);
      const evidenceDates = [
        ...docs.filter(d => d.key !== 'plan' && Boolean(d.body?.trim())).map(d => new Date(d.updatedAt).getTime()),
        ...products.filter(p => p.companyId === companyId && Boolean(p.url?.trim()) && !['failed', 'cancelled'].includes(p.status)).map(p => new Date(p.updatedAt).getTime()),
      ];
      const history = await verdictsService(db).listForEntity(companyId, 'issue', job.id);
      const latest = history.at(-1);
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
      return { ...result, phase: 'needs_input', reason: 'Required company facts or dependent questions still need human input.' };
    }
    if (enrollment.learnedBriefRevision !== brief.revision) {
      return {
        ...result,
        phase: enrollment.learnedBriefRevision === null ? 'learning' : 'refresh_needed',
        reason: 'Read and acknowledge the current approved company brief.',
      };
    }
    if (result.acceptedVerdictId) {
      return { ...result, phase: 'ready', reason: 'First-job evidence has a current neutral passed verdict.' };
    }
    return result;
  }
  async function ensureSkillsInstalled(companyId: string, agentId: string, actor: Actor) {
    requireSelfOrHuman(actor, agentId);
    const { enrollment, template } = await requiredEnrollment(companyId, agentId);
    // Filesystem work deliberately precedes the short assignment transaction.
    // This method must be called after hiring commits, never from its DB transaction.
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
            installed = await skills.createLocalSkill(companyId, { slug: curated.key, name: curated.name, description: curated.description, markdown: curated.content });
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
      return await db.transaction(async tx => {
        const connection = tx as unknown as Db;
        await company(companyId, connection, true);
        // Ordinary agent writers do not take the company lock. Compare the
        // JSON snapshot when assigning skills so a concurrent config edit is
        // re-read and merged, never replaced with a stale snapshot.
        let assigned = false;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const current = await agent(companyId, agentId, connection);
          const config = current.adapterConfig;
          const requested = readPaperclipSkillSyncPreference(config).desiredSkills;
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
        await audit(connection, companyId, enrollment.id, 'workforce.skills_installed', actor);
        return updated;
      });
    } catch (error) {
      const [updated] = await db.update(workforceEnrollments).set({ skillInstallError: error instanceof Error ? error.message : 'Skill installation failed', updatedAt: new Date() }).where(and(eq(workforceEnrollments.companyId, companyId), eq(workforceEnrollments.id, enrollment.id))).returning();
      await audit(db, companyId, enrollment.id, 'workforce.skill_install_failed', actor);
      return updated;
    }
  }
  async function getRuntimeContext(companyId: string, agentId: string): Promise<WorkforceRuntimeContext | null> {
    const enrollment = await getEnrollment(companyId, agentId);
    if (!enrollment) return null;
    const template = resolveWorkforceTemplate(enrollment.templateId, enrollment.templateVersion);
    if (!template) throw conflict('Pinned workforce template is unavailable');
    const brief = await getBrief(companyId);
    // Full authorized sources remain available over the scoped API. Runtime
    // content is bounded independently of the larger storage/input limits.
    return { enrollment, template, brief: { ...brief, sources: brief.sources.map(s => ({ ...s, content: s.content.slice(0, 500) })), facts: brief.facts.map(f => ({ ...f, value: f.value.slice(0, 500) })) }, readiness: (await getReadiness(companyId, agentId))!, sourceUrl: `/api/companies/${companyId}/workforce/brief` };
  }
  return { getBrief, updateBrief, proposeFacts, enroll, getEnrollment, getReadiness, startFirstJob, acknowledgeLearning, ensureSkillsInstalled, getRuntimeContext };
}
