import { describe, expect, it } from 'vitest';
import * as utils from '@paperclipai/adapter-utils/server-utils';
import { WORKFORCE_TEMPLATES } from '@paperclipai/shared';

describe('workforce prompt data boundary', () => {
  const context = { template: WORKFORCE_TEMPLATES[0], enrollment: { objective: 'Qualified trials', metrics: ['Target: 5 trials'], templateVersion: 1 }, brief: { revision: 3, facts: [{ key: 'offer', value: 'Approved {{literal}} offer', sourceReference: 'human intake' }], sources: [{ id: 'source', label: 'Company sheet', content: 'SOURCE_CONTENT_MUST_NOT_BE_IN_PROMPT' }] }, taskFacts: [{ key: 'audience', value: 'Only this campaign', issueId: 'task-one', sourceReference: 'interaction:one/question:audience' }], sourceUrl: '/api/companies/company/workforce/brief', readiness: { phase: 'working', missingFactKeys: [], pendingQuestionIds: [] } };
  it('delivers procedures, revision, objectives, target labels and separately scoped data with references', () => {
    const prompt = utils.renderWorkforcePrompt(context);
    for (const expected of ['marketing-content', 'version 1', 'Qualified trials', 'Target: 5 trials', 'revision 3', 'Approved {{literal}} offer', 'human intake', 'Company sheet', 'Only this campaign', 'task-one', '/api/companies/company/workforce/brief', context.template.procedures[0], context.template.qualityChecks[0]]) expect(prompt).toContain(expected);
    expect(prompt).toContain('not authorization');
    expect(prompt).toContain('Task-only answers');
    expect(prompt).not.toContain('SOURCE_CONTENT_MUST_NOT_BE_IN_PROMPT');
  });
  it('retains task answers and stopping instructions under maximum source input', () => {
    const prompt = utils.renderWorkforcePrompt({ ...context, enrollment: { objective: 'x'.repeat(10000), metrics: Array(40).fill('m'.repeat(1000)) }, template: { ...context.template, procedures: Array(40).fill('p'.repeat(1000)), qualityChecks: Array(40).fill('q'.repeat(1000)) }, brief: { ...context.brief, facts: Array(40).fill({ key: 'offer', value: 'v'.repeat(4000), sourceReference: 'r'.repeat(500) }) } });
    expect(prompt.length).toBeLessThan(20000);
    expect(prompt).toContain('Only this campaign');
    expect(prompt).toContain('stop dependent work immediately');
  });
  it('omits absent or malformed contexts and bounds untrusted text', () => {
    expect(utils.renderWorkforcePrompt(undefined)).toBe('');
    expect(utils.renderWorkforcePrompt({ brief: {} })).toBe('');
    expect(utils.renderWorkforcePrompt({ ...context, brief: { ...context.brief, facts: [{ key: 'offer', value: 'x'.repeat(100000), sourceReference: 'intake' }] } }).length).toBeLessThan(20000);
  });
});
