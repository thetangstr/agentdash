import { z } from 'zod';
export const workforceTemplateIdSchema = z.enum(['marketing-content', 'sales-support']);
const fact = z.object({ key: z.string().trim().min(1).max(120), value: z.string().trim().min(1).max(4000), sourceReference: z.string().trim().min(1).max(500) }).strict();
const facts = z.array(fact).max(40).refine(rows => new Set(rows.map(x => x.key)).size === rows.length, 'Duplicate fact keys');
const sources = z.array(z.object({ id: z.string().trim().min(1).max(120), label: z.string().trim().min(1).max(500), content: z.string().trim().min(1).max(12000) }).strict()).max(12).refine(rows => new Set(rows.map(x => x.id)).size === rows.length, 'Duplicate source IDs');
export const updateWorkforceBriefSchema = z.object({ expectedRevision: z.number().int().nonnegative(), sources, facts }).strict();
export const proposeWorkforceFactsSchema = z.object({ facts: facts.refine(rows => rows.length > 0, 'At least one fact is required'), sourceReferences: z.array(z.string().trim().min(1).max(120)).min(1).max(12) }).strict();
export const enrollWorkforceSchema = z.object({ templateId: workforceTemplateIdSchema, objective: z.string().trim().min(1).max(4000).optional(), metrics: z.array(z.string().trim().min(1).max(500)).max(20).optional(), goalId: z.string().uuid().optional() }).strict();
export const acknowledgeWorkforceLearningSchema = z.object({ revision: z.number().int().nonnegative() }).strict();
